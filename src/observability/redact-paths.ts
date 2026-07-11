/**
 * Shared secret-redaction allowlist.
 *
 * Extracted so it can be reused by BOTH loggers in this codebase:
 *  - `src/logger.ts` (Phase 1 — console + pino variants)
 *  - `src/observability/logger.ts` (Phase 2 — pino-only)
 *
 * This module is intentionally dependency-free (no `pino` import). Phase 1's
 * `createLogger()` picks a console-based logger when running as a
 * Bun-compiled binary specifically to avoid loading `pino` (its
 * thread-stream transport breaks under Bun) — `require("pino")` stays
 * lazy, inside `createPinoLogger`, so it is never touched on that path.
 * If this constant lived in `src/observability/logger.ts` (which does a
 * static top-level `import pino from "pino"`), importing it from
 * `src/logger.ts` would defeat that lazy-load and pull `pino` in eagerly
 * even on the Bun path. Keeping the list here avoids that coupling.
 *
 * NR4 / V4 §11.3 redaction allowlist (17 paths).
 */
export const REDACT_PATHS: readonly string[] = [
  // JWT + session secrets
  "req.headers.authorization",
  "req.headers.cookie",
  "headers.authorization",
  "headers.cookie",
  "*.access_token",
  "*.refresh_token",
  "*.id_token",
  "*.code_verifier",
  "*.client_secret",
  "*.idp_access_token",
  "*.idp_refresh_token",
  // Form bodies
  "body.code",
  "body.code_verifier",
  "body.client_secret",
  "body.refresh_token",
  // Internal request scope
  "req.idpAccessToken",
  "req.session",
];
