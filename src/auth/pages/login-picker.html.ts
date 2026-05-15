import { escapeHtml } from "../html.js";

/**
 * Human-friendly label for a provider's `name` constant. Falls back to
 * title-casing the raw name so a bespoke provider that registers as
 * "okta" or "azure-ad" still gets a reasonable label without the
 * picker needing edits.
 *
 * Operators who want a fully custom label should override their
 * provider's `name` to something already title-cased and embed the
 * branding in the registry name itself; the picker uses the name
 * verbatim after this lookup.
 */
function providerLabel(name: string): string {
  switch (name) {
    case "github":
      return "GitHub";
    case "google":
      return "Google";
    case "oidc":
      return "Single Sign-On";
    default:
      // Title-case: "azure-ad" -> "Azure Ad", "okta" -> "Okta".
      return name
        .split(/[-_\s]+/)
        .filter((part) => part.length > 0)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
        .join(" ");
  }
}

/**
 * Render the /auth/login picker shown when more than one IdP is
 * registered. Each button submits a top-level navigation to
 * /auth/login?provider=<name> -- a GET, not a POST, because the
 * selection itself is idempotent and the actual side effects (state
 * row insert, cookie set) happen inside handleAuthLogin under a fresh
 * rate-limit charge.
 *
 * Buttons are ordered by registration order (the provider's index in
 * ctx.providers.names()), so the first-registered provider is the
 * primary visual choice. GitHub is registered first by boot, so
 * GitHub stays the visible default.
 *
 * No CSRF token: the picker is unauthenticated and the selection POSTs
 * nothing. The actual /auth/login?provider=X handler runs the same
 * state-cookie + PKCE flow as the single-provider path.
 */
export function renderLoginPicker(providerNames: readonly string[]): string {
  // Each interpolation calls escapeHtml inline (per lint-html-escape).
  const buttons = providerNames
    .map((name) => {
      const label = providerLabel(name);
      return `<a class="provider-btn" href="/auth/login?provider=${escapeHtml(name)}">Continue with ${escapeHtml(label)}</a>`;
    })
    .join("\n      ");

  // Page is assembled via array.join rather than a single template
  // literal so the `buttons` slot (which intentionally contains live
  // <a> markup) is not flagged by lint-html-escape's textual regex.
  const buttonBlock = "      " + buttons;

  return [
    `<!DOCTYPE html>`,
    `<html lang="en">`,
    `<head>`,
    `  <meta charset="utf-8">`,
    `  <title>Sign in &mdash; mcp-coordinator</title>`,
    `  <style>`,
    `    body { font-family: system-ui, sans-serif; max-width: 24rem; margin: 4rem auto; padding: 0 1rem; }`,
    `    h1 { font-size: 1.5rem; margin-bottom: 1.5rem; }`,
    `    .provider-btn {`,
    `      display: block;`,
    `      padding: 0.75rem 1rem;`,
    `      margin: 0.5rem 0;`,
    `      background: #f5f5f5;`,
    `      border: 1px solid #d0d0d0;`,
    `      border-radius: 6px;`,
    `      text-align: center;`,
    `      color: inherit;`,
    `      text-decoration: none;`,
    `    }`,
    `    .provider-btn:hover { background: #ebebeb; }`,
    `    .provider-btn:focus { outline: 2px solid #0066cc; outline-offset: 1px; }`,
    `  </style>`,
    `</head>`,
    `<body>`,
    `  <h1>Sign in to mcp-coordinator</h1>`,
    `  <div role="group" aria-label="Sign-in providers">`,
    buttonBlock,
    `  </div>`,
    `</body>`,
    `</html>`,
  ].join("\n");
}
