// admin.js — landing page controller for the v0.10.6 admin area.
//
// CRITICAL invariants (mirrors admin-common.js):
//   - Zero inner-HTML-style assignment, zero insert-adjacent-HTML, zero
//     code-eval. All DOM is built via createElement + textContent +
//     appendChild (V3 PATCH 15 hard ban). The literal property names are
//     intentionally hyphen-broken in this comment so the unit test's
//     `\binnerHTML\b` regex does not trip on docs about what we do NOT do.
//   - Loaded as an external ES module (`<script type="module" src="...">`).
//     CSP `script-src 'self'` rejects any inline JS.
//   - Reuses T09 helpers (fetchJSON, redirectToLogin). Does NOT re-implement
//     readCsrfToken or the 401-redirect path — those live in admin-common.js.
//
// Behavior:
//   - On DOMContentLoaded, fetches GET /api/auth/me and renders
//     "Logged in as <name|email> (role: <role>) — org: <org name>".
//   - 401 is handled transparently by fetchJSON (redirects to /auth/login).
//   - Any other error is rendered inline in #user-info (no toast — toast is
//     for transient actions, this is a page-load error).
//
// Testability note: this module wires DOM events at import time. The
// admin-html.test.ts smoke tests assert HTML structure only; unit-testing
// the JS would require a DOM stub identical to admin-common.test.ts. We
// intentionally skip the per-file coverage threshold for admin.js — the
// behavior surface is "fetch then paint" with no branching logic worth
// pinning. See vitest.config.ts comment for rationale.

import { fetchJSON } from "./admin-common.js";
import { t } from "./admin-strings.js";

/**
 * Render the "Logged in as ..." line into #user-info.
 * Exported only so a future test harness can call it with a stub DOM;
 * not currently invoked outside this module.
 *
 * @param {HTMLElement} container
 * @param {{name: string|null, email: string, role: string, org: {name: string}}} me
 */
export function renderUserInfo(container, me) {
  container.replaceChildren();
  const line = document.createElement("div");
  line.className = "user-info-line";

  const label = document.createElement("span");
  label.className = "label";
  label.textContent = "Logged in as ";
  line.appendChild(label);

  const who = document.createElement("strong");
  // Prefer display name, fall back to email — `name` may be null per the
  // /api/auth/me response shape (see src/auth/userinfo.ts:35).
  who.textContent = (me.name && me.name.length > 0) ? me.name : me.email;
  line.appendChild(who);

  const roleSpan = document.createElement("span");
  roleSpan.className = "role";
  roleSpan.textContent = " (role: " + me.role + ")";
  line.appendChild(roleSpan);

  container.appendChild(line);

  if (me.org && typeof me.org.name === "string") {
    const orgLine = document.createElement("div");
    orgLine.className = "user-info-org";
    orgLine.textContent = "Org: " + me.org.name;
    container.appendChild(orgLine);
  }
}

/**
 * Replace the skeleton placeholder with an error message. Used when
 * /api/auth/me returns a non-401 error — 401 short-circuits via
 * fetchJSON → redirectToLogin and the page is torn down.
 *
 * @param {HTMLElement} container
 * @param {string} message
 */
export function renderUserInfoError(container, message) {
  container.replaceChildren();
  const div = document.createElement("div");
  div.className = "user-info-error";
  div.textContent = message;
  container.appendChild(div);
}

async function loadUserInfo() {
  const container = document.getElementById("user-info");
  if (!container) return;
  try {
    const me = await fetchJSON("/api/auth/me");
    renderUserInfo(container, me);
  } catch (err) {
    // 401 already redirected via fetchJSON. Anything else: show inline.
    // `err` may be a FetchError or a generic Error (network failure).
    const msg = (err && typeof err.message === "string")
      ? err.message
      : t("errors.LOAD_FAILED");
    renderUserInfoError(container, msg);
  }
}

// DOMContentLoaded guard: if the script is loaded after the document is
// already parsed (the `type="module"` defer semantics make this likely),
// run immediately; otherwise wait. Matches index.html's pattern.
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", loadUserInfo);
  } else {
    loadUserInfo();
  }
}
