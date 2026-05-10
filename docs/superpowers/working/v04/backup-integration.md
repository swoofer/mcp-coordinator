# v0.4 Operability — `backup` / `restore` integration patch

## Audit context
- **Finding**: "SQLite + local FS with no documented backup/restore/migration story."
- **Files at risk** (all under `~/.mcp-coordinator/`):
  - `config.json`
  - `data/coordinator.db` (+ `-wal` / `-shm` when WAL is active)
  - `logs/server.log` (intentionally NOT included in backups — noise + PII)

## Files added (this task)
- `cli/server/backup.ts` — `backup` action + `getRunningCoordinatorPid` helper (re-exported, used by `restore.ts` and tests).
- `cli/server/restore.ts` — `restore` action.
- `tests/unit/backup-restore.test.ts` — verifies tar round-trip, safety helper, sandboxed `HOME`/`USERPROFILE` overrides.
- `package.json` — added `tar ^7.4.3` (runtime) and `@types/tar ^6.1.13` (dev).

## Wiring patch — `cli/server/index.ts`

Add the two imports and register the commands in `createServerProgram`:

```diff
 import { Command } from "commander";
 import { createServerStartCommand } from "./start.js";
 import { createServerStopCommand } from "./stop.js";
 import { createServerStatusCommand } from "./status.js";
 import { createServerLogsCommand } from "./logs.js";
+import { createServerBackupCommand } from "./backup.js";
+import { createServerRestoreCommand } from "./restore.js";

 export function createServerProgram(): Command {
   const server = new Command("server").description("Manage the coordination server");
   server.addCommand(createServerStartCommand());
   server.addCommand(createServerStopCommand());
   server.addCommand(createServerStatusCommand());
   server.addCommand(createServerLogsCommand());
+  server.addCommand(createServerBackupCommand());
+  server.addCommand(createServerRestoreCommand());
   return server;
 }
```

`cli/index.ts` requires no changes — the new commands hang off the existing `server` subcommand tree, so `mcp-coordinator server backup` and `mcp-coordinator server restore` light up automatically once `server/index.ts` is updated.

> The task brief says "build `mcp-coordinator backup` + `mcp-coordinator restore`". I scoped them under `server` to match the existing operability commands (`server start|stop|status|logs`). If you want top-level aliases, add to `cli/index.ts`:
> ```ts
> program.addCommand(createServerBackupCommand().name("backup"));
> program.addCommand(createServerRestoreCommand().name("restore"));
> ```

## Behaviour summary

### `mcp-coordinator server backup`
- Default output: `./mcp-coordinator-backup-YYYY-MM-DD-HHMMSS.tar.gz` (UTC timestamp).
- `--output <path>` overrides the destination file.
- `--data-dir <path>` overrides the data dir; if it lives outside `~/.mcp-coordinator`, a sibling `*.data.tar.gz` is emitted (tar-gzip cannot append).
- `--force` skips the running-coordinator safety check.
- Reads `~/.mcp-coordinator/server.pid`, sends signal 0 to the pid; aborts with a helpful error if alive (WAL writes may be in flight).
- Excludes `logs/` by design — logs are recreated by the daemon and may contain PII / IPs.
- Reports archive path, size, file count, and whether the data dir is custom.

### `mcp-coordinator server restore <tarball>`
- Same liveness safety check as `backup` (overridable with `--force`).
- Validates the tarball's top-level entries before touching anything; refuses unless `config.json` or `data/` is present.
- Defaults to snapshotting the existing `~/.mcp-coordinator/` to `~/.mcp-coordinator.bak-YYYY-MM-DD-HHMMSS` first; pass `--no-backup` to skip.
- Best-effort rollback on extraction failure.

## Live-backup roadmap (not done in v0.4)
The current implementation refuses while the daemon runs because `cp` of a WAL-mode SQLite file can miss uncommitted writes. For a true online backup, swap the file copy for SQLite's Online Backup API:

```ts
import Database from "better-sqlite3";
const live = new Database(dbPath, { readonly: true });
await live.backup(snapshotPath); // safe while writers are active
```

Then snapshot `config.json` separately and pack both into the tarball. This avoids the `--force` escape hatch but requires opening the DB from the CLI process (currently the daemon owns the file).

## Test plan
- `npm install` (picks up `tar` + `@types/tar`).
- `npm test -- backup-restore` runs the new vitest suite.
- Manual smoke once wired:
  - `mcp-coordinator server start --daemon`
  - `mcp-coordinator server backup` → expect refusal
  - `mcp-coordinator server stop`
  - `mcp-coordinator server backup` → tarball created
  - `rm -rf ~/.mcp-coordinator/data && mcp-coordinator server restore <tarball>` → data restored
