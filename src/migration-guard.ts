/**
 * Guard for the one repair a schema migration is not allowed to perform on its
 * own initiative.
 *
 * The v11 per-org-agent-ids migration (issue #231) aborts when a coordination
 * row references an agent id that exists nowhere in `agents`. Such a database
 * already violates its CURRENT foreign key, so the migration refuses to guess
 * and leaves the operator in charge.
 *
 * With this opt-in the migration instead recreates the missing `agents` rows,
 * in the org each referencing row already carries, and proceeds. It is opt-in
 * rather than automatic because it WRITES rows the operator never asked for:
 * a resurrected agent shows up in `list_agents`, and if the referencing row's
 * `org_id` was itself wrong the agent lands in the wrong org. Visible and
 * fixable, but not a decision to take silently on someone's database.
 *
 * It never deletes anything — deleting the offending rows is one SQL statement
 * an operator can run themselves, and is not worth a code path that could ever
 * fire by accident.
 *
 * Deliberately NOT allowed by `NODE_ENV === "test"` (unlike `canResetDb`):
 * the abort is the behaviour the suite must exercise by default, and a
 * test-mode escape hatch would hide it.
 */
export function canRepairMigrationOrphans(env: NodeJS.ProcessEnv): boolean {
  return env.COORDINATOR_ALLOW_MIGRATION_REPAIR === "true";
}
