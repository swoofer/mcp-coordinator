// admin-common.js — shared client helpers for the v0.10.6 admin pages.
//
// CRITICAL invariants (enforced by tests + manual review):
//   - Zero innerHTML, zero insertAdjacentHTML, zero eval. All DOM is built
//     via createElement + textContent + appendChild. V3 PATCH 15 hard ban.
//   - Loaded as an external module (`<script type="module" src="...">`).
//     CSP `script-src 'self'` rejects any inline JS — this file MUST stay
//     loadable as-is, no string-templated HTML allowed.
//   - readCsrfToken() is defensive: returns null when the cookie is missing
//     instead of throwing (V3 PATCH 9). Callers handle the null path by
//     redirecting to /auth/login if a mutation was requested.

import { t } from "./admin-strings.js";

/** Literal cookie name (mirrors CSRF_COOKIE_NAME in src/auth/cookies.ts). */
const CSRF_COOKIE = "__Host-coordinator_csrf";

/**
 * Defensive cookie reader. Returns null if the CSRF cookie is missing
 * (e.g. the user landed on /dashboard/admin.html without a session — V3
 * PATCH 9 says we must NOT throw; the caller decides whether to redirect).
 *
 * @returns {string|null}
 */
export function readCsrfToken() {
  const raw = typeof document !== "undefined" ? document.cookie : "";
  if (!raw) return null;
  // Split on "; " — RFC 6265 cookie pair separator. We split on ";" then
  // trim to also tolerate the (technically wrong but seen-in-the-wild)
  // missing-space variant.
  const parts = raw.split(";");
  for (const part of parts) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq);
    if (name === CSRF_COOKIE) {
      return trimmed.slice(eq + 1);
    }
  }
  return null;
}

/**
 * Redirect to the login page, preserving the current URL as `return_to`.
 * Extracted so tests can spy on window.location assignment.
 */
export function redirectToLogin() {
  const here = window.location.pathname + window.location.search;
  window.location.href = "/auth/login?return_to=" + encodeURIComponent(here);
}

/**
 * Typed fetch error with the server's request_id when available. The
 * request_id lets users copy-paste a correlation token into a bug report
 * (V3 PATCH 16 — copy-to-clipboard button is added by showToast()).
 */
export class FetchError extends Error {
  /**
   * @param {number} status
   * @param {string|null} code
   * @param {string} message
   * @param {string|null} requestId
   */
  constructor(status, code, message, requestId) {
    super(message);
    this.name = "FetchError";
    this.status = status;
    this.code = code;
    this.request_id = requestId;
  }
}

/**
 * fetch wrapper:
 *   - credentials: 'include' so __Host- cookies ride along.
 *   - For non-GET, attaches X-CSRF-Token header from readCsrfToken(). If the
 *     cookie is missing on a mutation, we redirect to login (PATCH 9 path).
 *   - 401 → redirect to /auth/login; 403/429/5xx → throw FetchError so the
 *     page can showToast() a meaningful message.
 *
 * @param {string} url
 * @param {RequestInit} [options]
 * @returns {Promise<any>} parsed JSON body
 */
export async function fetchJSON(url, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const headers = new Headers(options.headers || {});
  headers.set("Accept", "application/json");

  if (method !== "GET" && method !== "HEAD") {
    const csrf = readCsrfToken();
    if (csrf == null) {
      // No CSRF cookie + mutation = no session. PATCH 9 says: redirect,
      // don't throw — the user should land at login with return_to set.
      redirectToLogin();
      // Throwing keeps the calling code's await-chain short-circuited
      // even though the redirect will tear down the page momentarily.
      throw new FetchError(401, "NO_CSRF", t("errors.UNAUTHORIZED"), null);
    }
    headers.set("X-CSRF-Token", csrf);
    if (options.body != null && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
  }

  const resp = await fetch(url, {
    ...options,
    method,
    headers,
    credentials: "include",
  });

  const requestId = resp.headers.get("X-Request-Id");

  if (resp.status === 401) {
    redirectToLogin();
    throw new FetchError(401, "UNAUTHORIZED", t("errors.UNAUTHORIZED"), requestId);
  }

  let body = null;
  const ct = resp.headers.get("Content-Type") || "";
  if (ct.includes("application/json")) {
    try {
      body = await resp.json();
    } catch {
      body = null;
    }
  }

  if (!resp.ok) {
    const code = (body && typeof body.code === "string") ? body.code : null;
    const msg = (body && typeof body.message === "string") ? body.message : mapStatusToString(resp.status);
    throw new FetchError(resp.status, code, msg, requestId);
  }

  return body;
}

/**
 * Map a HTTP status to a default user-facing string key. Extracted so
 * tests can exercise each branch without spinning up a mock server.
 *
 * @param {number} status
 * @returns {string}
 */
export function mapStatusToString(status) {
  if (status === 403) return t("errors.FORBIDDEN");
  if (status === 404) return t("errors.NOT_FOUND");
  if (status === 429) return t("errors.RATE_LIMITED");
  if (status >= 500) return t("errors.GENERIC");
  return t("errors.GENERIC");
}

/**
 * Render a table body from a row array.
 *
 * V3 PATCH 15: this is the ONLY sanctioned way to populate admin tables.
 * Every cell value is set via textContent (never innerHTML), and interactive
 * widgets (selects, buttons) are attached via the cellBuilder hook which
 * receives the already-created `<td>` and the row datum.
 *
 * @template T
 * @param {HTMLElement} tbody
 * @param {T[]} rows
 * @param {Array<{ render?: (row: T) => string, cellBuilder?: (td: HTMLElement, row: T) => void }>} columns
 */
export function renderTable(tbody, rows, columns) {
  tbody.replaceChildren();
  if (rows.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = columns.length || 1;
    td.className = "empty-state";
    td.textContent = t("actions.no_data");
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const col of columns) {
      const td = document.createElement("td");
      if (typeof col.cellBuilder === "function") {
        col.cellBuilder(td, row);
      } else if (typeof col.render === "function") {
        td.textContent = col.render(row);
      } else {
        td.textContent = "";
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

/**
 * Toast notification. Appended to <body>, fades out after 4s.
 * For errors carrying a request_id, a copy-to-clipboard button is added
 * (V3 PATCH 16) so users can paste the correlation id into bug reports.
 *
 * @param {string} text
 * @param {"success"|"error"} [kind]
 * @param {{ request_id?: string|null }} [opts]
 */
export function showToast(text, kind = "success", opts = {}) {
  const toast = document.createElement("div");
  toast.className = "toast " + (kind === "error" ? "toast-error" : "toast-success");
  toast.setAttribute("role", kind === "error" ? "alert" : "status");

  const msg = document.createElement("div");
  msg.textContent = text;
  toast.appendChild(msg);

  const reqId = opts.request_id;
  if (kind === "error" && typeof reqId === "string" && reqId.length > 0) {
    const idLine = document.createElement("div");
    idLine.className = "request-id";
    idLine.textContent = "request_id: " + reqId;
    toast.appendChild(idLine);

    const copyBtn = document.createElement("button");
    copyBtn.className = "copy-btn";
    copyBtn.type = "button";
    copyBtn.textContent = "Copy id";
    copyBtn.addEventListener("click", () => {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        navigator.clipboard.writeText(reqId);
      }
      copyBtn.textContent = "Copied";
    });
    toast.appendChild(copyBtn);
  }

  document.body.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("fade-out");
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

/**
 * Format a SQLite-flavored "YYYY-MM-DD HH:MM:SS" timestamp into the user's
 * locale. Returns the input untouched if parsing fails — we'd rather show
 * the raw string than blank a cell.
 *
 * @param {string} iso
 * @returns {string}
 */
export function formatTimestamp(iso) {
  if (typeof iso !== "string" || iso.length === 0) return "";
  // SQLite default format lacks the T and Z that Date.parse() prefers.
  // Normalize "YYYY-MM-DD HH:MM:SS" → "YYYY-MM-DDTHH:MM:SSZ" (UTC) so all
  // browsers parse it identically.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(iso)
    ? iso.replace(" ", "T") + "Z"
    : iso;
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}
