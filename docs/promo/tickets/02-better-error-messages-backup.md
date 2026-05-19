## Problem

Several error messages in the backup / restore / logs CLI commands are
too generic. Example from `restore.ts`:

> `Tarball does not contain expected entries`

That message doesn't say what *was* found, which makes triage painful
for the user.

## What to do

Walk through `console.error` (and equivalent log) calls in:

- `cli/server/backup.ts`
- `cli/server/restore.ts`
- `cli/server/logs.ts`

Enrich each message with context: actual values observed, expected
values, file paths, sizes — whatever is available at that point in the
code.

Example of the kind of improvement we want:

> `Tarball has 7 top-level entries [data/, README.md, ...] — expected
> exactly: config.json, data/. Refusing to restore.`

## Acceptance criteria

- [ ] Each enriched error names the relevant entity (path, count, value)
- [ ] No new runtime dependencies
- [ ] Existing tests still pass
- [ ] 1-2 new tests verifying the new messages contain the expected
      context (don't over-test exact wording — assert on substrings)

## Files

- `cli/server/backup.ts`
- `cli/server/restore.ts`
- `cli/server/logs.ts`

## Hints

There are roughly ~10 messages worth enriching across the three files.
**Partial PRs are welcome** — pick one file, ship it, then we can take
the others in a follow-up. Don't feel obligated to tackle all three at
once.
