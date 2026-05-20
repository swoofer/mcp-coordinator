import type { DatabaseAdapter } from "../../src/db-adapter.js";

/**
 * Insert (or ignore) the given org IDs into the `orgs` table. Use in test
 * setup/`beforeEach` for any suite that references org IDs other than the
 * built-in 'default' org — since v0.9 (issue #79), every coordinator table
 * with `org_id` declares `FOREIGN KEY (org_id) REFERENCES orgs(id) ON
 * DELETE RESTRICT`, so inserting into agents/threads/file_activity/etc.
 * with an unknown org_id now fails with a SQLITE_CONSTRAINT_FOREIGNKEY.
 *
 * Pre-v0.9 tests assumed `org-a`, `org-b`, etc. were free-form labels;
 * post-v0.9 they must exist as actual rows in `orgs`. This helper is the
 * single-line escape hatch — call `seedTestOrgs(db, ["org-a", "org-b"])`
 * once at the top of `beforeAll`/`beforeEach` to satisfy the FK.
 *
 * Idempotent via INSERT OR IGNORE — calling twice (or with overlapping
 * ID sets) yields the same row set.
 */
export function seedTestOrgs(db: DatabaseAdapter, orgIds: readonly string[]): void {
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO orgs (id, name) VALUES (?, ?)",
  );
  for (const id of orgIds) {
    stmt.run(id, id);
  }
}
