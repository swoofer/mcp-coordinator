# Build & Tooling Audit

**Score: 5/10**

Functional but minimal. tsc-only build works for a Node CLI/lib, exports map is reasonable, prepublishOnly gates publishing. However: no source maps, no lint, no type-check in CI, no coverage, no security scanning, awkward `dist/src/` paths from rootDir misuse, and Vitest has no timeouts/coverage configured.

## Issues

### 1. `tsconfig.json:7` — `rootDir: "."` causes ugly `dist/src/` paths
With `include: ["src/**/*.ts", "cli/**/*.ts", "tests/**/*.ts"]` and `rootDir: "."`, output becomes `dist/src/`, `dist/cli/`, `dist/tests/`. This pollutes the package with compiled tests (only excluded by `files`), and forces `main: ./dist/src/index.js`. Tests are also compiled/emitted on every `npm run build` — wasted IO. Fix: exclude `tests/**` from build, or split into `tsconfig.build.json` (no tests) + `tsconfig.test.json`.

### 2. `tsconfig.json` — No `sourceMap`, no `declarationMap`
Library consumers cannot step into source. No `"sourceMap": true` / `"declarationMap": true` / `"inlineSources": true`. Stack traces in production point at compiled JS only. For an npm package this hurts debuggability.

### 3. `vitest.config.ts:5-7` — Missing timeouts, coverage, reporter config
No `testTimeout`, `hookTimeout`, no `coverage` block, no `reporters`. `fileParallelism: false` is noted but no comment explaining why (likely SQLite/MQTT port contention). Add v8 coverage with thresholds (e.g., 70% lines), `testTimeout: 30000` for MQTT/HTTP integration tests.

### 4. `.github/workflows/test.yml` — No lint, no type-check, no matrix, no coverage
- No ESLint / Prettier / Biome step
- No `tsc --noEmit` separate from build (build runs after tests, masking type errors during test cycle)
- Single Node 22 only; declared engines `>=20` is untested in CI
- No coverage upload (Codecov, etc.)
- No `npm audit` / `npm audit signatures` / Dependabot config
- No CodeQL / security scan

### 5. `package.json:38-40` — `bin` shebang + Windows compatibility
`"mcp-coordinator": "./dist/cli/index.js"` relies on `#!/usr/bin/env node` shebang. On Windows, npm generates `.cmd` shims, but only if the file has the shebang AND is emitted with executable bit (npm sets it on install). However, **TypeScript strips the shebang** unless explicitly preserved — verify `dist/cli/index.js` line 1 still has `#!/usr/bin/env node`. Also no LF line-ending enforcement (.gitattributes missing) — CRLF on the shebang will break execution on Linux/macOS.

### 6. `package.json:41-47` — `files` array gaps
- Includes `dashboard/` (entire dir incl. `Dockerfile`) instead of `dashboard/public/`
- Missing `CHANGELOG.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`
- Ships compiled `dist/cli/` but tests are not in dist (good, accidental — see issue #1)

### 7. `package.json:78-80` — `"node": ">=20"` is fine, but unenforced
No `.nvmrc` / `.node-version`. CI uses Node 22, dev may use 20, lock unclear. Add `.nvmrc` with `22` and consider `engineStrict` or `packageManager` field for npm version pinning.

### 8. `package.json:56` — `prepublishOnly` doesn't `clean` first
Stale `dist/` artifacts from removed source files will be published. Add `prebuild: "rm -rf dist"` (or `rimraf dist` for cross-platform).

## Top 3 Build Improvements

1. **Add `tsconfig.build.json` excluding tests, enable source/declaration maps, output to `dist/` directly** (not `dist/src/`). Update `main`/`exports`/`bin` paths accordingly. Add `prebuild` clean step.
2. **Harden CI**: matrix `[20, 22]` x `[ubuntu, windows, macos]`, separate `lint` + `typecheck` + `test` + `build` jobs, add Vitest coverage with v8 + Codecov upload, add `npm audit --omit=dev` + Dependabot + CodeQL.
3. **Add tooling**: ESLint (typescript-eslint) + Prettier (or Biome for one-tool combo), `.nvmrc`, `.gitattributes` enforcing LF on `*.ts`/`*.js`, `husky` + `lint-staged` for pre-commit, and a CI guard verifying `dist/cli/index.js` retains its shebang.

DONE: C:\Users\gagno\projet\mcp-coordinator-new\docs\superpowers\working\audit\code\15-build-tooling.md
