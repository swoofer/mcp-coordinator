import type Database from "better-sqlite3";

/**
 * Phase 2 -> Phase 5 forward-compat config shim.
 *
 * Resolution order:
 *   1. orgs.<key> column for this orgId (Phase 5 per-org override)
 *   2. process.env.COORDINATOR_<UPPER_KEY> (Phase 2 default; single-tenant)
 *   3. supplied envDefault
 *
 * Phase 2 ships with only orgs.allowlist_github_org as a "config column".
 * Future migrations add more columns (jwt_access_ttl, auto_provision, etc.)
 * with no code changes here -- the introspection cache discovers them.
 *
 * Caller responsibility: pass a key that is a valid SQL identifier
 * (alphanumeric + underscore). The shim validates the key against the
 * cached column set; unknown keys skip the DB path silently.
 */

// Cache of (db -> Set of orgs column names). PRAGMA table_info is cheap but
// not free; cache for the lifetime of the db handle.
const columnCache = new WeakMap<Database.Database, Set<string>>();

function getOrgsColumns(db: Database.Database): Set<string> {
  const cached = columnCache.get(db);
  if (cached) return cached;
  const rows = db.prepare("PRAGMA table_info(orgs)").all() as Array<{ name: string }>;
  const set = new Set(rows.map((r) => r.name));
  columnCache.set(db, set);
  return set;
}

const VALID_KEY = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Read a config value for an org. See file header for resolution order.
 *
 * @param db         better-sqlite3 handle
 * @param orgId      org row id (UUID); pass null/undefined to skip the DB path
 *                   (e.g., for boot-time settings read before any org exists)
 * @param key        SQL identifier -- must match /^[a-zA-Z_][a-zA-Z0-9_]*$/
 * @param envDefault fallback when neither DB column nor env is set
 */
export function getOrgSetting(
  db: Database.Database,
  orgId: string | null | undefined,
  key: string,
  envDefault: string | undefined,
): string | undefined {
  if (!VALID_KEY.test(key)) {
    throw new Error(`getOrgSetting: invalid key ${JSON.stringify(key)}`);
  }

  if (orgId) {
    const columns = getOrgsColumns(db);
    if (columns.has(key)) {
      // Safe: key is validated against the schema-derived Set.
      const row = db
        .prepare(`SELECT ${key} AS value FROM orgs WHERE id = ?`)
        .get(orgId) as { value: string | null } | undefined;
      if (row && row.value !== null && row.value !== undefined) {
        return String(row.value);
      }
    }
  }

  const envKey = `COORDINATOR_${key.toUpperCase()}`;
  const envValue = process.env[envKey];
  if (envValue !== undefined) return envValue;
  return envDefault;
}

/**
 * Test helper: invalidate the cached orgs column set for a db. Use in
 * tests when you ADD a column at runtime and need the shim to re-read.
 */
export function invalidateOrgsColumnCache(db: Database.Database): void {
  columnCache.delete(db);
}
