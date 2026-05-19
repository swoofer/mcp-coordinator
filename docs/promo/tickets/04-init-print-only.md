## Problem

`mcp-coordinator init` writes three things during first-time setup:
`~/.mcp-coordinator/config.json`, the MCP snippet for the client, and
optionally a `CLAUDE.md`. There's currently no way to preview what
would be written without actually writing.

This makes the command scary to run on machines where you're not sure
of the existing state — and frustrates anyone wanting to script `init`
in a CI dry-run.

## What to do

Add a `--print-only` flag (alias: `--dry-run`). With the flag set:

- Skip every `writeFileSync` / `mkdir` / similar mutation
- Print what *would* have been written to stdout, with each file
  preceded by a header line: `=== <absolute-path> ===`
- Exit 0 if the run would have succeeded

## Acceptance criteria

- [ ] No filesystem changes when `--print-only` is set (verify by
      removing `~/.mcp-coordinator/` first and confirming nothing
      reappears after the dry-run)
- [ ] Output is grep-friendly: each file is delimited by the
      `=== <path> ===` header
- [ ] Test: run `init --print-only` twice on a clean machine, confirm
      no state created between runs
- [ ] `--help` documents the flag

## Files

- `cli/init.ts`

## Hints

The `init` command has ~10 write actions. The cleanest pattern is a
small `writer` abstraction that either writes or prints. Don't refactor
the whole file — keep the change focused.
