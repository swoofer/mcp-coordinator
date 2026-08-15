/**
 * issue #285: turning `PRAGMA foreign_key_check` output into a message that
 * names the right culprit.
 *
 * The v0.9 org_id migration ends with a `PRAGMA foreign_key_check` and aborts
 * boot on any result. Its comment assumed the only possible cause was the
 * migration itself — "this indicates a migration bug; orphan repair should
 * have prevented this". That is true only of `org_id -> orgs` violations on
 * the tables it just copied, which is what its up-front orphan repair covers.
 *
 * The pragma is not scoped to those. It reports EVERY violation in the
 * database, including ones the migration neither created nor is responsible
 * for — a `thread_messages.thread_id` pointing at a deleted thread, say. An
 * operator whose data is corrupt was being told to go hunt for a bug in the
 * coordinator, with no table, no constraint and no row count to go on.
 *
 * Because the boot sequence rewinds `user_version` to 8 on every start, that
 * check runs on every start too: in practice it is the coordinator's
 * whole-database integrity gate, not a migration self-check. Worth being
 * accurate about.
 */

/** One violated constraint, already resolved from `fkid` to real columns. */
export interface FkViolation {
  /** Child table holding the offending row. */
  table: string;
  /** Referenced table. */
  parent: string;
  /** Child column(s) forming the foreign key. */
  columns: string[];
}

export interface FkViolationReport {
  /** Violations of the very constraint the v9 migration adds. */
  migrationCaused: FkViolation[];
  /** Everything else — already illegal before this migration ran. */
  preExisting: FkViolation[];
  message: string;
}

function tally(violations: FkViolation[]): string {
  const counts = new Map<string, number>();
  for (const v of violations) {
    const key = `${v.table}.${v.columns.join("+")} -> ${v.parent}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, n]) => `${key} (${n} row${n === 1 ? "" : "s"})`)
    .join(", ");
}

/**
 * Split violations by who is answerable for them and build the abort message.
 *
 * `copiedTables` is the set of tables the migration recreated on this run; a
 * violation counts as migration-caused only when it is the `org_id -> orgs`
 * constraint on one of those.
 */
export function summarizeFkViolations(
  violations: FkViolation[],
  copiedTables: Set<string>,
): FkViolationReport {
  const migrationCaused: FkViolation[] = [];
  const preExisting: FkViolation[] = [];
  for (const v of violations) {
    const isOrgFk = v.parent === "orgs" && v.columns.length === 1 && v.columns[0] === "org_id";
    if (isOrgFk && copiedTables.has(v.table)) migrationCaused.push(v);
    else preExisting.push(v);
  }

  const parts: string[] = [];
  if (migrationCaused.length > 0) {
    parts.push(
      `v0.9 org_id FK migration: ${migrationCaused.length} row(s) violate the ` +
        `org_id -> orgs constraint it just created — ${tally(migrationCaused)}. ` +
        `This IS a bug in the migration: its up-front orphan repair should have ` +
        `re-parented them. Please report it with this message.`,
    );
  }
  if (preExisting.length > 0) {
    parts.push(
      `${migrationCaused.length > 0 ? "Additionally, the" : "The"} database has ` +
        `${preExisting.length} foreign key violation(s) this migration did not ` +
        `create and cannot repair — ${tally(preExisting)}. These rows already ` +
        `violate the current schema, so this is a data problem rather than a ` +
        `coordinator bug. Back up the data directory, list them with ` +
        `\`sqlite3 <data-dir>/coordinator.db 'PRAGMA foreign_key_check;'\`, then ` +
        `delete or re-point them and restart.`,
    );
  }
  parts.push("Aborting; the database is left unchanged.");

  return { migrationCaused, preExisting, message: parts.join(" ") };
}
