import type Database from "better-sqlite3";

export interface AllowlistMatch {
  org_id: string;
  org_name: string;
  matched_org_login: string;
}

/**
 * Resolve the coordinator org for a user given their lowercase GitHub
 * org memberships. Returns null when none of the user's memberships
 * matches an `orgs.allowlist_github_org` entry.
 *
 * Tie-break (V4 FIX 22): alphabetical ASC on allowlist_github_org for
 * determinism. Phase 5 multi-tenant migration: this query stays valid;
 * the app-layer "exactly one row matches" assumption is what relaxes.
 *
 * The caller MUST pass already-lowercased memberships (T04 cache
 * normalizes to lowercase before populating). The SQL also LOWERs the
 * column for case-insensitive match in case admins enter mixed case.
 */
export function resolveOrgFromMemberships(
  db: Database.Database,
  memberships: string[],
): AllowlistMatch | null {
  if (memberships.length === 0) return null;

  const placeholders = memberships.map(() => "?").join(",");
  const row = db
    .prepare(`
      SELECT id, name, allowlist_github_org
      FROM orgs
      WHERE LOWER(allowlist_github_org) IN (${placeholders})
      ORDER BY allowlist_github_org ASC
      LIMIT 1
    `)
    .get(...memberships) as
    | { id: string; name: string; allowlist_github_org: string }
    | undefined;

  if (!row) return null;
  return {
    org_id: row.id,
    org_name: row.name,
    matched_org_login: row.allowlist_github_org,
  };
}
