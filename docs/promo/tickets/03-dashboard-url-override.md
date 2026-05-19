## Problem

`mcp-coordinator dashboard` opens a hardcoded URL:
`http://localhost:3100/dashboard`.

Users who run the coordinator behind a reverse proxy, on a remote
machine, or on a non-default port cannot use this command — they have
to type the URL by hand every time.

## What to do

Add a `--url <full-url>` flag to override the dashboard URL.
Resolution order:

1. `--url` flag value (highest priority)
2. `dashboard.url` key from `config.json` if present
3. The current hardcoded default `http://localhost:3100/dashboard`

## Acceptance criteria

- [ ] `mcp-coordinator dashboard --url https://my.host/dashboard` opens
      that URL
- [ ] When `dashboard.url` is set in `config.json`, that URL is used
      when `--url` is not passed
- [ ] Without either, the current default is preserved
- [ ] `--help` documents the flag and the resolution order

## Files

- `cli/dashboard.ts`
- `cli/config.ts` (add the `dashboard.url` config key with validation)

## Hints

Validate that the URL is well-formed (use the built-in `URL`
constructor and try/catch) and reject non-http(s) schemes before
opening.
