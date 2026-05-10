# Dependency Audit

**Score: 7.5/10**

Modern, well-maintained dep tree. Mostly current, MIT-friendly licenses, but a few aging or risky entries (vitest 4 RC, aedes 1.0.2, native bindings). 314 total packages, ~128 MB on disk - reasonable for the surface area.

## Versions Resolved (lockfile)

| Package | Declared | Resolved | Latest (knowledge) | Status |
|---|---|---|---|---|
| @modelcontextprotocol/sdk | ^1.12.0 | 1.29.0 | ~1.29.x | Current |
| aedes | ^1.0.2 | 1.0.2 | 1.0.2 (stale tip) | Pinned exact (caret-1 only) |
| better-sqlite3 | ^12.8.0 | 12.9.0 | 12.x | Current |
| commander | ^14.0.3 | 14.0.3 | 14.x | Current |
| jose | ^6.2.2 | 6.2.3 | 6.x | Current |
| mqtt | ^5.15.0 | 5.15.1 | 5.x | Current |
| pino | ^10.3.1 | 10.3.1 | 10.x | Current (major bump from 9) |
| ws | ^8.20.0 | 8.20.0 | 8.x (9 in alpha) | Current |
| zod | ^3.23.0 | 3.25.76 | 4.x available | One major behind |
| vitest (dev) | ^4.1.0 | 4.1.5 | 4.x | Early adopter |

## Concerns (5+)

1. **vitest 4.x — early-adopter risk.** vitest 4 is recently GA; ecosystem (coverage providers, `@vitest/ui`, plugin compat) still stabilizing. Bug reports against 4.x are common. Consider pinning to a known-good 4.1.x patch and watching for breakage on minor bumps.

2. **aedes 1.0.2 — apparent stagnation.** The MQTT broker resolved to 1.0.2 with no patch movement; `^1.0.2` will pull future 1.x but project velocity is low. Combined with `aedes-persistence` 10.2.2 transitive, security-fix latency is a real risk on a public-facing broker.

3. **better-sqlite3 12.x — native binding fragility.** Requires `prebuild-install` and falls back to `node-gyp` when prebuilds miss (Node 22 + Windows ARM64 + Bun + Alpine musl are common gaps). This breaks `npm i` on fresh machines and CI containers; it also conflicts with the implied Bun-compat claim - Bun's NAPI shim works for most prebuilds but `better-sqlite3` historically needs special handling (`bun:sqlite` is the Bun-native alternative).

4. **zod pinned to 3.x while 4 is current.** `^3.23.0` resolved to 3.25.76. Zod 4 ships meaningful perf and DX wins (and the v3 line will receive only critical fixes). Migration is non-trivial (error format, refinement API), but staying on 3 indefinitely accrues tech debt.

5. **pino 10 — fresh major.** Pino jumped 9 → 10 with transport/worker changes. Plugin ecosystem (transports, serializers, `pino-pretty` 13) still catching up. Risk of subtle log-shape regressions in prod.

6. **Open caret ranges everywhere.** Every direct dep uses `^`, so reproducibility depends entirely on the lockfile. Any consumer running `npm i` without lockfile (rare but possible) will float to new minors. For a coordinator/broker library, consider tighter pins (`~`) on at least `aedes`, `better-sqlite3`, and `vitest`.

7. **Bun-compat claim is at risk.** `better-sqlite3` (NAPI native) and `aedes` (uses Node `stream` internals) are both historically rough on Bun. If Bun is supported, it needs CI proof - claim should be qualified or removed otherwise.

## Licenses

All scanned licenses: MIT, ISC, Apache-2.0, BSD-2/3-Clause, 0BSD, MPL-2.0 (in `mqtt`/`mqtt-packet` family), `(MIT OR WTFPL)`, `(BSD-2 OR MIT OR Apache-2.0)`. **MPL-2.0** is weak-copyleft (file-level) - compatible with MIT distribution but worth noting for downstream consumers who modify those files.

## 3 Changes to Consider

1. **Drop `~` pins** on `aedes`, `better-sqlite3`, `vitest` (e.g. `~12.9.0`, `~4.1.0`) to limit surprise minor bumps on infra-critical deps.
2. **Plan zod 4 migration** in a tracked issue; the longer it sits, the harder it gets.
3. **Verify Bun runtime** in CI (matrix job) or remove the Bun-compat claim - currently it's untested marketing.

DONE: `C:\Users\gagno\projet\mcp-coordinator-new\docs\superpowers\working\audit\code\14-dependencies.md`
