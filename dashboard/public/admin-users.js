// admin-users.js — T12 v0.10.6 admin Users page.
//
// CRITICAL invariants (mirrors admin-common.js & admin-orgs.js):
//   - Zero innerHTML, zero insertAdjacentHTML, zero eval. All DOM is built
//     via createElement + textContent + appendChild (V3 PATCH 15 hard ban).
//   - Loaded as an external module — CSP `script-src 'self'` rejects any
//     inline JS, so this file MUST stay loadable as-is.
//   - Last-admin proactive UX (V3 PATCH 14): the "member" <option> in a
//     row's role <select> is disabled when the target user has role=admin
//     AND server-reported meta.admin_count === 1. The server still enforces
//     the invariant (409 LAST_ADMIN) — this is purely UX polish so users
//     don't even see a disabled-feel click path.

import {
  fetchJSON,
  renderTable,
  showToast,
  redirectToLogin,
  formatTimestamp,
  FetchError,
} from "./admin-common.js";
import { t } from "./admin-strings.js";

/** Truncate a long id (e.g. ULID) to a copy-friendly head for display only. */
function truncateId(id) {
  if (typeof id !== "string") return "";
  return id.length > 12 ? id.slice(0, 8) + "…" : id;
}

/**
 * Build the role <select> cell. Returns the <select> element so the caller
 * can attach the change handler with access to the row + outer meta in
 * closure (avoids re-querying the DOM at change time).
 *
 * @param {{ id: string, email: string, role: string }} user
 * @param {number} adminCount
 * @param {(td: HTMLElement) => void} attachLastAdminNote
 *   Called with the cell when this row IS the last admin so the cell can
 *   render the inline "Last admin — cannot demote" hint.
 * @returns {HTMLSelectElement}
 */
function buildRoleSelect(user, adminCount, td, attachLastAdminNote) {
  const select = document.createElement("select");
  select.setAttribute("data-user-id", user.id);
  select.setAttribute("aria-label", t("pages.users.role_label") + ": " + user.email);

  const isLastAdmin = user.role === "admin" && adminCount === 1;

  const optMember = document.createElement("option");
  optMember.value = "member";
  optMember.textContent = "member";
  if (isLastAdmin) {
    // PATCH 14: proactively disable the demote path. The server is still
    // the source of truth (409 LAST_ADMIN); this only stops the click.
    optMember.disabled = true;
  }

  const optAdmin = document.createElement("option");
  optAdmin.value = "admin";
  optAdmin.textContent = "admin";

  select.appendChild(optMember);
  select.appendChild(optAdmin);
  select.value = user.role === "admin" ? "admin" : "member";

  td.appendChild(select);

  if (isLastAdmin) {
    attachLastAdminNote(td);
  }
  return select;
}

/** Append a small italic note next to the role <select> for the last-admin row.
 *  Reuses T09's `.empty-state` class for muted italic styling — we don't add
 *  new CSS rules (T09 admin.css is frozen) and don't write inline styles
 *  (CSP `style-src 'self'` would reject style attribute mutations anyway). */
function appendLastAdminNote(td) {
  const note = document.createElement("span");
  note.className = "empty-state";
  note.textContent = " Last admin — cannot demote";
  td.appendChild(note);
}

/**
 * Wire a role-select change to a PATCH /api/admin/users/:id call.
 *
 * @param {HTMLSelectElement} select
 * @param {{ id: string, email: string, role: string }} user
 * @param {() => Promise<void>} refresh — re-fetch the list to update admin_count
 */
function wireRoleChange(select, user, refresh) {
  let previousValue = select.value;

  select.addEventListener("change", async () => {
    const newRole = select.value;
    const oldRole = previousValue;
    if (newRole === oldRole) return;

    const ok = window.confirm(
      "Change " + user.email + " from " + oldRole + " to " + newRole + "?",
    );
    if (!ok) {
      select.value = oldRole;
      return;
    }

    select.disabled = true;
    // Provide a saving cue on the option labels — non-destructive.
    const savingLabel = t("actions.saving");
    select.setAttribute("data-saving", savingLabel);

    try {
      await fetchJSON("/api/admin/users/" + encodeURIComponent(user.id), {
        method: "PATCH",
        body: JSON.stringify({ role: newRole }),
      });
      showToast(t("toasts.user_role_changed"), "success");
      previousValue = newRole;
      // Refresh to pick up the new admin_count from the server (PATCH 14).
      await refresh();
    } catch (err) {
      const fe = /** @type {FetchError} */ (err);
      const status = fe && typeof fe.status === "number" ? fe.status : 0;
      const code = fe && typeof fe.code === "string" ? fe.code : null;
      const reqId = fe && typeof fe.request_id === "string" ? fe.request_id : null;

      if (status === 401) {
        // fetchJSON already kicked off the redirect; bail.
        return;
      }

      // Always revert the dropdown to the last-known-good value on failure
      // so the UI reflects server truth.
      select.value = oldRole;
      select.disabled = false;
      select.removeAttribute("data-saving");

      let msg;
      if (status === 409 && code === "LAST_ADMIN") {
        msg = t("errors.LAST_ADMIN");
      } else if (status === 404) {
        msg = t("errors.NOT_FOUND");
      } else if (status === 403) {
        msg = t("errors.FORBIDDEN");
      } else if (status === 429) {
        msg = t("errors.RATE_LIMITED");
      } else {
        msg = t("errors.SAVE_FAILED");
      }
      showToast(msg, "error", { request_id: reqId });
      return;
    }

    select.disabled = false;
    select.removeAttribute("data-saving");
  });
}

/**
 * Populate the org filter <select> from /api/admin/orgs.
 *
 * Keeps the existing "All orgs" entry as the first option.
 *
 * @param {HTMLSelectElement} sel
 * @param {Array<{ id: string, name: string }>} orgs
 */
function populateOrgFilter(sel, orgs) {
  // Drop everything except the first "All orgs" entry.
  while (sel.children.length > 1) {
    sel.removeChild(sel.lastChild);
  }
  for (const org of orgs) {
    const opt = document.createElement("option");
    opt.value = org.id;
    opt.textContent = org.name;
    sel.appendChild(opt);
  }
}

/**
 * Render the users table from a server payload.
 *
 * @param {HTMLElement} tbody
 * @param {{ users: Array<any>, meta: { admin_count: number } }} payload
 * @param {() => Promise<void>} refresh
 * @param {HTMLElement|null} noticeEl — banner toggled when admin_count===1
 */
function renderUsersTable(tbody, payload, refresh, noticeEl) {
  const users = Array.isArray(payload.users) ? payload.users : [];
  const adminCount =
    payload.meta && typeof payload.meta.admin_count === "number"
      ? payload.meta.admin_count
      : 0;

  if (noticeEl) {
    if (adminCount === 1) {
      noticeEl.hidden = false;
    } else {
      noticeEl.hidden = true;
    }
  }

  renderTable(tbody, users, [
    { render: (u) => truncateId(u.id) },
    { render: (u) => u.email || "" },
    { render: (u) => u.name || "" },
    {
      cellBuilder: (td, u) => {
        const sel = buildRoleSelect(u, adminCount, td, appendLastAdminNote);
        wireRoleChange(sel, u, refresh);
      },
    },
    { render: (u) => u.primary_org_id || "" },
    { render: (u) => formatTimestamp(u.last_login_at || "") },
  ]);
}

/**
 * Top-level boot. Fetches orgs + users in parallel, wires the filter, and
 * paints the initial table. All callbacks close over the live `currentOrg`
 * variable so the filter change handler can re-fetch with the latest value.
 *
 * Exported for testability — modules wanting to unit-test boot logic in
 * a jsdom-equipped environment can call init() against a stub DOM.
 */
export async function init() {
  const tbody = document.getElementById("users-tbody");
  const orgSelect = /** @type {HTMLSelectElement|null} */ (
    document.getElementById("org-filter")
  );
  const notice = document.getElementById("last-admin-notice");
  if (tbody == null || orgSelect == null) {
    // Page markup is broken — fail loud in console; nothing else we can do.
    // eslint-disable-next-line no-console
    console.error("admin-users.js: required DOM nodes missing");
    return;
  }

  let currentOrg = "";

  /** Re-fetch users for the current filter and re-render. */
  async function refresh() {
    const url =
      currentOrg.length > 0
        ? "/api/admin/users?org=" + encodeURIComponent(currentOrg)
        : "/api/admin/users";
    try {
      const payload = await fetchJSON(url);
      renderUsersTable(tbody, payload, refresh, notice);
    } catch (err) {
      const fe = /** @type {FetchError} */ (err);
      const status = fe && typeof fe.status === "number" ? fe.status : 0;
      if (status === 401) return; // fetchJSON already redirected
      const reqId = fe && typeof fe.request_id === "string" ? fe.request_id : null;
      showToast(t("errors.LOAD_FAILED"), "error", { request_id: reqId });
    }
  }

  orgSelect.addEventListener("change", () => {
    currentOrg = orgSelect.value || "";
    // Fire-and-forget; refresh() handles its own errors.
    void refresh();
  });

  // Initial parallel load. If orgs fail we still try users (degraded but
  // useful — admin can see users even if the filter list is empty).
  const [orgsResult, usersResult] = await Promise.allSettled([
    fetchJSON("/api/admin/orgs"),
    fetchJSON("/api/admin/users"),
  ]);

  if (orgsResult.status === "fulfilled" && orgsResult.value) {
    const orgs = Array.isArray(orgsResult.value.orgs)
      ? orgsResult.value.orgs
      : [];
    populateOrgFilter(orgSelect, orgs);
  } else if (orgsResult.status === "rejected") {
    const fe = /** @type {FetchError} */ (orgsResult.reason);
    if (fe && fe.status === 401) {
      redirectToLogin();
      return;
    }
    const reqId = fe && typeof fe.request_id === "string" ? fe.request_id : null;
    showToast(t("errors.LOAD_FAILED"), "error", { request_id: reqId });
  }

  if (usersResult.status === "fulfilled" && usersResult.value) {
    renderUsersTable(tbody, usersResult.value, refresh, notice);
  } else if (usersResult.status === "rejected") {
    const fe = /** @type {FetchError} */ (usersResult.reason);
    if (fe && fe.status === 401) {
      redirectToLogin();
      return;
    }
    const reqId = fe && typeof fe.request_id === "string" ? fe.request_id : null;
    showToast(t("errors.LOAD_FAILED"), "error", { request_id: reqId });
  }
}

// Auto-boot when loaded as a normal page script. The `typeof document`
// guard keeps the module importable in a Node test runner without a DOM.
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      void init();
    });
  } else {
    void init();
  }
}
