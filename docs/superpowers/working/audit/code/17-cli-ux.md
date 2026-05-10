# CLI UX Audit — mcp-coordinator

**Score: 6.5/10**

Solid commander setup, helpful next-steps after `init`, decent doctor output with hints. However: no `--json` output anywhere, no TTY detection, daemon flow has a race condition, exit codes inconsistent, and `uninstall --purge` confirmation read is fragile.

---

## UX Issues

### 1. No `--json` flag for any command — scripting impossible
`cli/server/status.ts:19-59`, `cli/doctor.ts:218-235`
All output is human-prose only. CI/wrapper scripts cannot reliably parse `Coordinator: running (PID 1234, port 3100)` or doctor's bracketed `[ OK ]` lines without regex. Modern CLIs (`gh`, `docker`, `kubectl`) ship `--json` / `--format` from day one.

### 2. Daemon `start --daemon` has race condition + no readiness check
`cli/server/start.ts:54-67`
The CLI spawns the child, immediately writes the PID file, prints "Coordinator started", and exits — without verifying the server actually bound to the port. If the child crashes (port in use, bad config, missing data dir) the user gets a "success" message but no listener. Should wait for `/health` to return 200 (with timeout) before declaring success and exit non-zero on failure.

### 3. PID file is written under spawning user's path even when child dies
`cli/server/start.ts:61-62`, `cli/server/stop.ts:25-31`
PID file is written unconditionally before the child establishes itself. `stop.ts:28` silently *returns 0* when the process is dead ("not running. Cleaning up"), which conflates "stop succeeded" with "wasn't running" — a script that calls `stop && start` cannot tell the difference. Should exit non-zero (or have explicit `--if-running`) when nothing was stopped.

### 4. `uninstall --purge` confirmation read is broken on many terminals
`cli/uninstall.ts:128-137`
Reads stdin via `process.stdin.once("data", ...)` without `setEncoding`, doesn't `pause()` stdin, and never resumes — on Windows PowerShell or piped input this can hang or read partial bytes. Also: prompt does not honor non-TTY (e.g., `< /dev/null` should auto-abort, not hang). Use `readline.createInterface` and check `process.stdin.isTTY`.

### 5. No TTY detection / color is never used but symbols aren't either
`cli/doctor.ts:222-227`
Uses literal `[ OK ]` / `[FAIL]` — fine for piping, but the CLI never adds color/symbols (✓/✗) when stdout is a TTY. Inversely, no codepath checks `process.stdout.isTTY` anywhere, so future color additions risk garbling logs. Establish the pattern now.

### 6. Inconsistent exit codes across destructive ops
`cli/uninstall.ts:155` exits 0 on "nothing to do"; `cli/init.ts:217-219` exits 0 unless dir-validation failed; `cli/server/stop.ts:31` returns 0 when server wasn't running. No documented convention. Recommend: 0=success/changed, 1=error, 2=usage error, 3=nothing to do (or document explicitly).

### 7. `init` is *not* idempotent for `--write-claude-md`
`cli/init.ts:181-198`
Re-running with the same `--write-claude-md` path will *replace* the sentineled section (good), but the surrounding whitespace differs each run (sep logic at line 191), causing churn in git diffs. Also no `--dry-run` flag — users can't preview which files will be touched.

### 8. `doctor` doesn't check log file rotation, disk space, or version drift
`cli/doctor.ts:99-216`
Excellent breadth (config, PID, TCP, /health, /mcp, /dashboard, MQTT) but misses: log file size, data_dir writability, npm package version vs. running daemon version (a stale daemon is a common foot-gun). Hints are good but no `--fix` action.

### 9. `uninstall` not symmetric with `init`
`init` writes config dir + optionally .mcp.json + CLAUDE.md. `uninstall` requires *separate flags* for each — there's no `uninstall --all <path>` to undo a typical `init --write-mcp-config X --write-claude-md X --purge` in one shot.

---

## Top 3 Highest-Impact Fixes

1. **Daemon readiness gate** (`cli/server/start.ts`): poll `/health` for up to ~5s after spawn; exit non-zero with "daemon failed to start, see logs at <path>" on timeout. Eliminates the silent-failure footgun. *High impact, ~30 LOC.*

2. **Add `--json` to `status` and `doctor`** (`cli/server/status.ts`, `cli/doctor.ts`): emit a stable schema (`{ok, checks: [{name, ok, detail, hint}]}`). Unblocks CI integration and monitoring. *Medium effort, transformative for ops.*

3. **Robust confirmation + TTY guard** (`cli/uninstall.ts:128`): use `readline`, refuse purge on non-TTY without `--force`, and standardize exit codes (document in `--help`). Prevents data loss from piped scripts. *Low effort, removes a real hazard.*
