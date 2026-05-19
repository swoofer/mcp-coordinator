// admin-strings.js — centralized UI strings for the v0.10.6 admin area.
//
// Per V3 PATCH 18: every user-visible string is funneled through `t()` so
// future i18n is a one-file edit rather than a grep-and-replace across all
// admin pages. The lookup intentionally returns the path itself on miss
// (e.g. `t("typo.key") === "typo.key"`) so typos surface visually in the
// UI rather than silently producing `undefined`.
//
// Loaded as an ES module (`<script type="module">`) — CSP `script-src 'self'`
// requires zero inline JS.

export const STRINGS = {
  pages: {
    admin: { title: "mcp-coordinator — Admin" },
    orgs: {
      title: "Orgs",
      new_button: "New org",
      name_label: "Name",
      slug_label: "Slug",
      created_label: "Created",
      actions_label: "Actions",
      empty: "No orgs yet.",
    },
    users: {
      title: "Users",
      filter_org: "Filter by org:",
      email_label: "Email",
      role_label: "Role",
      org_label: "Org",
      joined_label: "Joined",
      empty: "No users in this org.",
    },
  },
  errors: {
    LOAD_FAILED: "Failed to load data.",
    SAVE_FAILED: "Save failed.",
    LAST_ADMIN: "Cannot demote the last admin. Promote another user first.",
    ORG_NAME_TAKEN: "An org with that name already exists.",
    NOT_FOUND: "Resource not found.",
    UNAUTHORIZED: "Session expired. Redirecting to login.",
    FORBIDDEN: "Permission denied. Admin role required.",
    RATE_LIMITED: "Too many requests. Try again in a moment.",
    GENERIC: "Something went wrong. Check console for details.",
  },
  validation: {
    MISSING_FIELD: "Field is required.",
    TOO_LONG: "Value is too long.",
    TOO_SHORT: "Value cannot be empty.",
    CONTROL_BYTES: "Value contains invalid characters.",
    INVALID_ROLE: "Role must be 'admin' or 'member'.",
    UNKNOWN_FIELD: "Unexpected field.",
    EMPTY_BODY: "No changes to save.",
    BAD_ID: "Invalid id.",
    BAD_PATH: "Invalid URL.",
  },
  actions: {
    save: "Save",
    cancel: "Cancel",
    delete: "Delete",
    loading: "Loading...",
    saving: "Saving...",
    no_data: "No data.",
  },
  toasts: {
    org_created: "Org created.",
    org_updated: "Org updated.",
    user_role_changed: "Role changed.",
    // Interpolated example — assert tested in admin-strings.test.ts.
    welcome: "Welcome, {name}.",
  },
};

/**
 * Tiny path-based lookup. Supports interpolation via `{name}` placeholders.
 * Returns the path itself if the key is missing — this helps catch typos
 * during development because the missing key appears verbatim in the UI.
 *
 * @param {string} path dotted key path, e.g. "pages.orgs.title"
 * @param {Record<string,string|number>} [vars] interpolation vars
 * @returns {string}
 */
export function t(path, vars = {}) {
  const parts = path.split(".");
  let v = STRINGS;
  for (const p of parts) {
    if (v == null || typeof v !== "object") return path;
    v = v[p];
  }
  if (typeof v !== "string") return path;
  return v.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : `{${k}}`));
}
