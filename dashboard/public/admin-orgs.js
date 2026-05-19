// admin-orgs.js — T11 v0.10.6 admin Orgs page.
//
// CRITICAL invariants (mirrors admin-common.js & admin-users.js):
//   - Zero innerHTML, zero insertAdjacentHTML, zero eval. All DOM is built
//     via createElement + textContent + appendChild (V3 PATCH 15 hard ban).
//   - Loaded as an external module — CSP `script-src 'self'` rejects any
//     inline JS, so this file MUST stay loadable as-is.
//   - Reuses ONLY T09 helpers (fetchJSON, renderTable, showToast,
//     redirectToLogin, formatTimestamp, t). No bespoke fetch / DOM helpers.
//
// Behavior:
//   - GET /api/admin/orgs on load, paint via renderTable().
//   - "+ New org" button + each row's "Edit" button open the same modal.
//   - POST (create) or PATCH (edit) on save; inline error for 409
//     ORG_NAME_TAKEN, toast for everything else.
//   - 401 is handled transparently by fetchJSON (redirects to /auth/login).

import {
  fetchJSON,
  renderTable,
  showToast,
  redirectToLogin,
  formatTimestamp,
  FetchError,
} from "./admin-common.js";
import { t, STRINGS } from "./admin-strings.js";

/** Truncate a long id (ULID/UUID) to a copy-friendly head for display. */
function truncateId(id) {
  if (typeof id !== "string") return "";
  return id.length > 12 ? id.slice(0, 8) + "…" : id;
}

/** Lookup helper: returns STRINGS.validation[code] or the t() fallback path. */
function validationMessage(code) {
  const tbl = STRINGS && STRINGS.validation;
  if (tbl && typeof tbl[code] === "string") return tbl[code];
  return t("validation." + code);
}

/**
 * Wire the create/edit modal. Returns an object with `open(org|null)` and
 * `close()` plus an internal `setError(fieldId, msg|null)` helper. Closing
 * always resets the form and clears errors.
 *
 * @param {() => Promise<void>} refresh re-fetch + repaint the orgs table
 */
function wireModal(refresh) {
  const modal = document.getElementById("org-modal");
  const titleEl = document.getElementById("org-modal-title");
  const form = /** @type {HTMLFormElement|null} */ (
    document.getElementById("org-form")
  );
  const idField = /** @type {HTMLInputElement|null} */ (
    document.getElementById("org-edit-id")
  );
  const nameField = /** @type {HTMLInputElement|null} */ (
    document.getElementById("org-name")
  );
  const ghField = /** @type {HTMLInputElement|null} */ (
    document.getElementById("org-allow-github")
  );
  const idpField = /** @type {HTMLInputElement|null} */ (
    document.getElementById("org-allow-idp")
  );
  const saveBtn = /** @type {HTMLButtonElement|null} */ (
    document.getElementById("org-save-btn")
  );
  const cancelBtn = document.getElementById("org-cancel-btn");

  /* c8 ignore next 5 — defensive guard; the HTML ships these nodes. */
  if (!modal || !titleEl || !form || !idField || !nameField || !ghField ||
      !idpField || !saveBtn || !cancelBtn) {
    // eslint-disable-next-line no-console
    console.error("admin-orgs.js: modal nodes missing");
    return null;
  }

  /** Set or clear the inline error message under a field. */
  function setError(fieldId, msg) {
    const el = document.getElementById(fieldId + "-error");
    if (!el) return;
    if (msg == null || msg === "") {
      el.textContent = "";
      el.hidden = true;
    } else {
      el.textContent = msg;
      el.hidden = false;
    }
  }

  function clearAllErrors() {
    setError("org-name", null);
    setError("org-allow-github", null);
    setError("org-allow-idp", null);
  }

  function close() {
    modal.hidden = true;
    form.reset();
    idField.value = "";
    clearAllErrors();
    saveBtn.disabled = false;
    saveBtn.textContent = t("actions.save");
  }

  /**
   * @param {{ id: string, name: string,
   *           allowlist_github_org: string|null,
   *           allowlist_idp_org_id: string|null }|null} org
   *   null → create; otherwise pre-fill for edit.
   */
  function open(org) {
    clearAllErrors();
    if (org == null) {
      titleEl.textContent = "New org";
      idField.value = "";
      nameField.value = "";
      ghField.value = "";
      idpField.value = "";
    } else {
      titleEl.textContent = "Edit org";
      idField.value = org.id || "";
      nameField.value = org.name || "";
      ghField.value = org.allowlist_github_org || "";
      idpField.value = org.allowlist_idp_org_id || "";
    }
    saveBtn.disabled = false;
    saveBtn.textContent = t("actions.save");
    modal.hidden = false;
    // Focus the name field so the user can start typing immediately.
    nameField.focus();
  }

  cancelBtn.addEventListener("click", () => {
    close();
  });

  // Click on the backdrop (but not the modal body) also closes.
  modal.addEventListener("click", (ev) => {
    if (ev.target === modal) close();
  });

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    clearAllErrors();

    const editId = idField.value.trim();
    const name = nameField.value.trim();
    const ghRaw = ghField.value.trim();
    const idpRaw = idpField.value.trim();

    if (name.length === 0) {
      setError("org-name", validationMessage("MISSING_FIELD"));
      return;
    }

    // Build the body. On CREATE: only send fields the user provided
    // (omit empty optional fields). On EDIT (PATCH): send null for empty
    // optional fields to explicitly clear them, per the plan's
    // "allows null=clear" semantics.
    const isEdit = editId.length > 0;
    /** @type {Record<string, string|null>} */
    const body = { name: name };
    if (isEdit) {
      body.allowlist_github_org = ghRaw.length > 0 ? ghRaw : null;
      body.allowlist_idp_org_id = idpRaw.length > 0 ? idpRaw : null;
    } else {
      if (ghRaw.length > 0) body.allowlist_github_org = ghRaw;
      if (idpRaw.length > 0) body.allowlist_idp_org_id = idpRaw;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = t("actions.saving");

    try {
      if (isEdit) {
        await fetchJSON("/api/admin/orgs/" + encodeURIComponent(editId), {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        close();
        await refresh();
        showToast(t("toasts.org_updated"), "success");
      } else {
        await fetchJSON("/api/admin/orgs", {
          method: "POST",
          body: JSON.stringify(body),
        });
        close();
        await refresh();
        showToast(t("toasts.org_created"), "success");
      }
    } catch (err) {
      const fe = /** @type {FetchError} */ (err);
      const status = fe && typeof fe.status === "number" ? fe.status : 0;
      const code = fe && typeof fe.code === "string" ? fe.code : null;
      const reqId = fe && typeof fe.request_id === "string" ? fe.request_id : null;

      // 401: fetchJSON already triggered the login redirect; bail.
      if (status === 401) return;

      // Re-enable the save button so the user can retry / cancel.
      saveBtn.disabled = false;
      saveBtn.textContent = t("actions.save");

      if (status === 409 && code === "ORG_NAME_TAKEN") {
        setError("org-name", STRINGS.errors.ORG_NAME_TAKEN);
        return;
      }

      if (status === 404) {
        // Stale PATCH (org was deleted under us). Close + refresh + toast.
        close();
        await refresh();
        showToast(t("errors.NOT_FOUND"), "error", { request_id: reqId });
        return;
      }

      if (status === 400) {
        // Validation error — server sends { code, message }. Map by code.
        const msg = code ? validationMessage(code) : t("errors.SAVE_FAILED");
        // We don't know which field — surface under the name field as a
        // pragmatic default. Server-side messages are code-only (PATCH 11)
        // so this is the best we can do without echoing user input.
        setError("org-name", msg);
        return;
      }

      if (status === 403) {
        showToast(t("errors.FORBIDDEN"), "error", { request_id: reqId });
        return;
      }

      if (status === 429) {
        showToast(t("errors.RATE_LIMITED"), "error", { request_id: reqId });
        return;
      }

      showToast(t("errors.SAVE_FAILED"), "error", { request_id: reqId });
    }
  });

  return { open, close };
}

/**
 * Build an Edit <button> for a row cell.
 *
 * @param {HTMLElement} td
 * @param {object} org
 * @param {(org: object) => void} onEdit
 */
function appendEditButton(td, org, onEdit) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Edit";
  btn.setAttribute("data-org-id", org.id || "");
  btn.addEventListener("click", () => {
    onEdit(org);
  });
  td.appendChild(btn);
}

/**
 * Paint a one-row skeleton so the table doesn't flash empty before the
 * first fetch resolves. Replaced by renderTable() on success.
 *
 * @param {HTMLElement} tbody
 */
function paintSkeleton(tbody) {
  tbody.replaceChildren();
  const tr = document.createElement("tr");
  for (let i = 0; i < 6; i++) {
    const td = document.createElement("td");
    const sk = document.createElement("div");
    sk.className = "skeleton";
    td.appendChild(sk);
    tr.appendChild(td);
  }
  tbody.appendChild(tr);
}

/**
 * Render the orgs table from a server payload.
 *
 * @param {HTMLElement} tbody
 * @param {{ orgs: Array<any> }} payload
 * @param {(org: object) => void} onEdit
 */
function renderOrgsTable(tbody, payload, onEdit) {
  const orgs = Array.isArray(payload.orgs) ? payload.orgs : [];
  renderTable(tbody, orgs, [
    { render: (o) => truncateId(o.id) },
    { render: (o) => o.name || "" },
    { render: (o) => o.allowlist_github_org || "" },
    { render: (o) => o.allowlist_idp_org_id || "" },
    { render: (o) => formatTimestamp(o.created_at || "") },
    {
      cellBuilder: (td, o) => {
        appendEditButton(td, o, onEdit);
      },
    },
  ]);
}

/**
 * Top-level boot. Exported for future testability.
 */
export async function init() {
  const tbody = document.getElementById("orgs-tbody");
  const newBtn = document.getElementById("new-org-btn");
  /* c8 ignore next 4 — defensive; HTML ships these nodes. */
  if (tbody == null || newBtn == null) {
    // eslint-disable-next-line no-console
    console.error("admin-orgs.js: required DOM nodes missing");
    return;
  }

  /** Re-fetch + repaint. Toasts on failure (other than 401, which redirects). */
  async function refresh() {
    try {
      const payload = await fetchJSON("/api/admin/orgs");
      renderOrgsTable(tbody, payload, (org) => {
        if (modal) modal.open(org);
      });
    } catch (err) {
      const fe = /** @type {FetchError} */ (err);
      const status = fe && typeof fe.status === "number" ? fe.status : 0;
      if (status === 401) return; // fetchJSON already redirected
      const reqId = fe && typeof fe.request_id === "string" ? fe.request_id : null;
      showToast(t("errors.LOAD_FAILED"), "error", { request_id: reqId });
    }
  }

  const modal = wireModal(refresh);

  newBtn.addEventListener("click", () => {
    if (modal) modal.open(null);
  });

  paintSkeleton(tbody);

  // Initial load. 401 is handled inside fetchJSON; any other error is
  // surfaced via the catch in refresh().
  try {
    const payload = await fetchJSON("/api/admin/orgs");
    renderOrgsTable(tbody, payload, (org) => {
      if (modal) modal.open(org);
    });
  } catch (err) {
    const fe = /** @type {FetchError} */ (err);
    const status = fe && typeof fe.status === "number" ? fe.status : 0;
    if (status === 401) {
      redirectToLogin();
      return;
    }
    const reqId = fe && typeof fe.request_id === "string" ? fe.request_id : null;
    // Clear the skeleton so the user sees the empty-state row.
    renderOrgsTable(tbody, { orgs: [] }, () => {});
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
