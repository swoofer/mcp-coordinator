/**
 * Guard for the destructive `/api/reset` endpoint.
 *
 * `/api/reset` wipes every coordination table. When `COORDINATOR_AUTH_ENABLED`
 * is on, the upstream auth middleware enforces admin-role tokens for this route
 * (see `auth.ts` `ADMIN_ONLY_ROUTES`). When auth is OFF (the default), we still
 * need to prevent accidental data loss in production.
 *
 * Allowed when ANY of:
 *   - NODE_ENV === "test"          (vitest sets this automatically)
 *   - COORDINATOR_ALLOW_RESET=true (explicit opt-in for dev/CI scripts)
 *   - authEnabled === true         (handled by the auth middleware upstream)
 *
 * Otherwise rejected.
 */
export function canResetDb(env: NodeJS.ProcessEnv, authEnabled: boolean): boolean {
  if (authEnabled) return true;
  if (env.NODE_ENV === "test") return true;
  if (env.COORDINATOR_ALLOW_RESET === "true") return true;
  return false;
}
