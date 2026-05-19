## Problem

`mcp-coordinator server status` currently prints human-readable text.
There's no way to consume the status from a script, CI step, or
monitoring agent.

## What to do

Add a `--json` flag that outputs a structured JSON object on stdout
instead of human text. The JSON should include at minimum:

- `status`: `"running"` or `"stopped"`
- `pid` (number, omitted when stopped)
- `port` (number)
- `agents_online` (number)
- `threads_open` (number)
- `version` (string, from `package.json`)

## Acceptance criteria

- [ ] `mcp-coordinator server status --json` exits with code 0 and prints
      a single JSON object to stdout when the server is running
- [ ] Same command exits non-zero and prints `{"status":"stopped"}` when
      the server is not running
- [ ] Without `--json`, the existing text output is unchanged
- [ ] A Vitest test covers both paths

## Files

- `cli/server/status.ts`

## Hints

The current status command already inspects pid / port / DB. Reuse those
values — don't query a second time. Help text is in the same file.

Questions? Comment on the issue.
