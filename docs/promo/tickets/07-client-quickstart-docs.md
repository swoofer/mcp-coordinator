## Problem

The README mentions Cursor, Cline, and Aider as supported MCP clients,
but it doesn't have a per-client quickstart. New users have to figure
out:

- Where the MCP config file lives for their client
- The exact JSON snippet to add (adapted from `mcp-coordinator init`)
- Any client-specific quirks (env vars, stdio vs SSE preference, …)

This friction probably costs us a non-trivial fraction of trial-users.

## What to do

Create `docs/clients/` with three quickstart files:

- `docs/clients/cursor.md`
- `docs/clients/cline.md`
- `docs/clients/aider.md`

Each file:

1. **Where to put the config** — exact file path on macOS / Linux /
   Windows for that client.
2. **The JSON snippet** — copy-paste-ready, adapted from
   `mcp-coordinator init` output.
3. **Client-specific gotchas** — env var quirks, prefer-stdio-vs-SSE
   advice, restart sequence after editing config, etc.
4. **Verify it works** — a single coordinator MCP tool call to make
   from inside the client and the expected response.

Aim for ~50-100 lines per file. **Don't duplicate the README** — link
back to it for the general setup. Tone: concise, action-oriented.

## Acceptance criteria

- [ ] The three files exist under `docs/clients/`
- [ ] Each has been tested by the contributor against the actual client
- [ ] The README's "Standalone use" section links to the three new
      pages
- [ ] No trailing TODOs or "this section coming soon"

## Files

- New directory: `docs/clients/`

## Hints

**One client per PR is welcome** — you don't have to tackle all three.
Start with the client you already use. Other clients can come from
other contributors.
