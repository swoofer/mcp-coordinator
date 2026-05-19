## Problem

`src/logger.ts` uses pino with `pino-pretty` formatting in development.
In production (Docker, systemd, log aggregators like Loki / Datadog /
CloudWatch), users want raw JSON lines for parsing — but there's no
CLI flag to enable it. Control is only available through environment
variables, which is awkward for one-off runs and undiscoverable.

## What to do

Add a `--log-json` flag to `mcp-coordinator server start`. When set:

- Disable `pino-pretty`
- Emit one JSON object per log entry, one per line (newline-delimited
  JSON / NDJSON)
- Keep stderr / stdout split consistent with the current behavior

## Acceptance criteria

- [ ] `mcp-coordinator server start --log-json` produces NDJSON output
- [ ] Each emitted line is valid JSON (verify by piping into `jq`)
- [ ] Without the flag, the pretty output is unchanged
- [ ] `--help` documents the flag

## Files

- `cli/server/start.ts`
- `src/logger.ts`

## Hints

The pino transport is already abstracted in `src/logger.ts`. The change
is mostly about plumbing the flag through `start.ts` into the logger
factory — no new dependencies needed.
