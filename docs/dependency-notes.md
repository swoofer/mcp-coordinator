# Dependency notes

Operational notes on dependency management for this repo — coupling constraints, install-size trade-offs, and deferred major-version work. Companion to the [README](../README.md#development) for day-to-day install instructions.

## Supply-chain hardening: `onlyBuiltDependencies`

Since pnpm 10 (this repo pins an exact `10.x.y` via `packageManager` in `package.json`), no dependency's install/postinstall/preinstall script runs unless the package name is explicitly listed in `pnpm.onlyBuiltDependencies`. This closes the default-trust-everyone gap that made arbitrary `postinstall` scripts in any of the ~350 packages in the dependency graph a viable supply-chain vector.

The allowlist was derived empirically (not guessed): a clean install under pnpm 10 with no allowlist prints a `pnpm approve-builds`-style "Ignored build scripts" warning naming every package with a skipped script. Each candidate was then checked for whether the *feature it backs* actually breaks without its script running (not just "the script exists" — plenty of packages ship prebuilt native binaries via `prebuildify`/`node-gyp-build` and their install script is a no-op fallback path that's never reached on a supported platform).

Current allowlist and why each entry is there:

- **`better-sqlite3`** — the storage engine. Ships no bundled prebuild; `node-gyp-build` finds nothing and `new Database(...)` throws `Could not locate the bindings file` without this entry. Verified by removing it from the allowlist and confirming the break (adversarial check), then restoring it.
- **`tree-sitter-kotlin`** — one of the 15 optional tree-sitter grammars. Ships no `prebuilds/` directory for any platform (unlike the other 12 non-Swift grammars, which bundle `darwin-arm64`/`darwin-x64`/`linux-x64`/`win32-x64` prebuilds). Needs a local `node-gyp` build to produce a working `.node` binding.
- **`tree-sitter-swift`** — same situation as kotlin: no bundled prebuilds, needs a local build.
- **`tree-sitter-cli`** — not used directly by this project, but `tree-sitter-swift`'s `binding.gyp` shells out to the `tree-sitter` CLI at build time to regenerate `src/parser.c` from `grammar.js` (a `generate_header_files` gyp action). Without `tree-sitter-cli`'s own install script running, its CLI binary is never fetched/built and `tree-sitter-swift`'s build fails one step later with a `MODULE_NOT_FOUND` on `tree-sitter-cli`'s `cli.js`. Allowlisted purely as a build-time transitive need of `tree-sitter-swift`.

**Not** in the allowlist, despite appearing in the "Ignored build scripts" warning, because their actual runtime need was checked and doesn't require the script:
- `esbuild` — modern esbuild resolves its native binary through a platform-specific `optionalDependency` (e.g. `@esbuild/win32-x64`) that pnpm installs as an ordinary package; the `postinstall` is a fallback pnpm never needs to reach. Verified: `vitest` (which shells through esbuild for transforms) runs clean.
- `msw` — its `postinstall` (`msw init`) sets up a browser Service Worker mock file; irrelevant to this project's Node-side `msw/node` usage in tests. Verified: all `msw`-backed IdP provider tests pass.
- `tree-sitter` (core) and the other 12 grammars (`bash`, `c`, `c-sharp`, `cpp`, `go`, `java`, `javascript`, `php`, `python`, `ruby`, `rust`, `typescript`) — all ship `prebuilds/` for the platforms this project supports in CI (`linux-x64`, `darwin-x64`, `darwin-arm64`) plus `win32-x64` for local dev. `node-gyp-build` picks these up with no build step. Verified: `tests/unit/tree-sitter-extract.test.ts` passes and each grammar `require()`s cleanly.

Known environment-specific caveat (not a regression): on Windows, `tree-sitter-swift`'s install still fails even with `tree-sitter-cli` allowlisted — its `wait-for-tree-sitter.js` helper assumes a flat, npm-style-hoisted `node_modules` layout to locate the CLI's binary, which doesn't match pnpm's isolated `.pnpm` store layout. This was verified to be **pre-existing**: the identical failure reproduces under the old `pnpm@9.15.9` with scripts unrestricted, so it predates this migration. Because `tree-sitter-swift` is an `optionalDependency`, pnpm drops it gracefully on build failure — the overall install still succeeds (exit 0), and `tree-sitter-extractor.ts`'s `tryLoad()` already handles a missing grammar by skipping that language. Net effect: Swift extraction is unavailable on this Windows dev machine, same as before the migration; it is expected to build successfully on the Linux/macOS runners this project's CI and release pipeline actually use, since those aren't subject to the same `node_modules`-layout assumption in the way this failure manifests on Windows specifically (not independently verified on Linux/macOS in this pass — flagged as a follow-up if it turns out to affect CI too).

Deferred (not part of this hardening pass): `minimumReleaseAge` (a pnpm 10 setting that delays newly-published versions from being installable for N days, guarding against just-published supply-chain payloads). It's a genuinely useful additional layer, but wasn't added here to keep this change focused and because its interaction with `--frozen-lockfile` CI installs wasn't verified. Candidate for a follow-up PR.

## tree-sitter ABI 0.21 coupling

The tree-sitter core package and 14 of its 15 grammar packages in `optionalDependencies` are pinned to grammar-ABI `0.21` (`tree-sitter@^0.21.1`, most grammars at `^0.21.x`/`^0.22.x`; `tree-sitter-swift` is the outlier at `^0.6.0`, which targets the same ABI generation via its own versioning scheme). These packages are peer-coupled: the core `tree-sitter` package's native `Parser` and each grammar's compiled `node-types.json`/binding must agree on the same ABI generation, or parsing silently produces wrong trees or throws at binding-load time.

This is currently fine (YAGNI — nothing forces a move) and is left alone. A coordinated bump (core + all 15 grammars, in one branch, one PR) will be needed when either:
- A future Node LTS drops without `prebuildify` prebuilds for ABI 0.21 (grammars would then all fail to load without a local build, same failure mode as `tree-sitter-kotlin`/`tree-sitter-swift` today), or
- A newer language feature/grammar fix is needed from a grammar that only ships on a later ABI.

Non-regression harness for that future migration: `tests/unit/tree-sitter-extract.test.ts` exercises each language's node-type extraction end-to-end (not just "does it load") and is the signal to keep green through the bump.

## Install size: tree-sitter grammars are optional

The 15 tree-sitter grammar packages add roughly 292 MB to a full `pnpm install` / `npm install`, backing the optional cross-repo code-extraction feature (dependency-map building from source). Consumers who don't need this can skip it entirely: `npm install mcp-coordinator --omit=optional` (pnpm: `pnpm install --no-optional`). See the README's [Installation légère](../README.md#installation-légère-skip-tree-sitter-grammars) section for the consumer-facing version of this note. Every other capability (agent registry, consultation threads, MQTT broker, dashboard, IdP auth) is unaffected — the extractor's `tryLoad()` degrades a missing grammar to "that language isn't supported," not a hard failure.

## Backlog of major version bumps

Deliberately not migrated in this pass — YAGNI until one of these actually blocks something. Dependabot/Renovate-style automation is expected to keep minor/patch versions current in the meantime; this list is only the major-version jumps that need a human decision plus code changes.

| Package | Current | Latest major | Why deferred |
|---|---|---|---|
| `zod` | 3.25.76 | 4.x | Real migration work (schema API changes), but no urgency: `@modelcontextprotocol/sdk` already declares `"zod": "^3.25 \|\| ^4.0"`, so the upgrade window is open whenever it's prioritized — nothing here is blocking on the SDK side. |
| `typescript` | 5.9.3 | 7.x | TS 6 and 7 both shipped since this repo last bumped; jumping straight to the current major without an intermediate validation pass on this codebase's strict settings is riskier than it's worth outside a dedicated migration branch. |
| `commander` | 14.0.3 | 15.x | CLI-parsing library; low churn, low risk, but a major bump warrants its own smoke pass across every `cli/` subcommand rather than folding into a dependency-hygiene PR. |
| `cookie` | 1.1.1 | 2.x | Used in the OIDC/session-cookie path; a security-sensitive surface where a major bump deserves isolated review of any signature/parsing behavior changes, not a drive-by bump. |
| `fast-check` | 3.23.2 (dev) | 4.x | Property-based test generator; dev-only blast radius, but v4's API changes would touch every property test file — worth batching into one deliberate pass instead of scattering across unrelated PRs. |

> **Stale rows:** `commander`, `cookie` and `@types/node` have since been migrated (`package.json` pins `^15.0.0`, `^2.0.1` and `^26.1.1`). This table has not been pruned to match.

`aedes` was flagged in an earlier pass as lagging (1.0.2 → 1.1.1); `package.json` already pins `^1.1.1` and `pnpm outdated` shows no newer release, so this item is closed — no action needed.

## Node 20 EOL — floor raised to >=22

`package.json` now declares `"engines": { "node": ">=22" }` (and `sdk/package.json` matches). Node 20 reached end-of-life on **2026-04-30**.

This was deferred as a semver-breaking change until `better-sqlite3@13` forced the issue: it declares `engines: { "node": ">=22" }`, so holding the `>=20` floor meant either pinning better-sqlite3 to 12.x indefinitely or shipping a dependency that does not support our own stated minimum. Raising the floor was the deliberate choice.

CI runs the matrix on Node 22 and 24 (`.github/workflows/test.yml`); `sdk-test` runs on 22, the new floor.
