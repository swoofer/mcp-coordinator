# Changelog

## [0.7.0] - 2026-05-13

### Breaking changes

- **JWT shape extended**: tokens now require `user_id` and `org` claims. v0.6 tokens (without these) are rejected when `AUTH_ENABLED=true`. Set `AUTH_ENABLED=false` for backward-compat mode.
- **`COORDINATOR_JWT_SECRET` is now strongly recommended in production**: when unset, the coordinator generates a random secret per boot — this invalidates ALL existing sessions on every restart. The behavior is unchanged from prior releases but documented explicitly for the first time. Set `COORDINATOR_JWT_SECRET` to a stable value (32+ chars) in any deployment where session persistence across restarts matters.
- **Database schema bumped to user_version=7**: new tables (`orgs`, `users`, `refresh_tokens`, `device_auth_requests`, `audit_log`) and `org_id` column added to 14 existing tables. Migration is automatic and idempotent on boot. **Downgrade to v0.6 binary is refused** by `PRAGMA user_version` check.
- **Composite primary keys migrated** for 7 tables: `agents`, `agent_activity_status`, `dependency_map`, `git_cochange`, `git_cochange_meta`, `revoked_agents`, `working_files`. Each now has `(org_id, ...)` as its PK instead of the v0.6 single-column key. Migration is performed via SQLite's create-new + copy + drop + rename pattern (no `ALTER PRIMARY KEY`) with `PRAGMA foreign_keys = OFF` around the transaction. **Rollback to v0.6 requires restoring from backup** — the schema change is one-way.
- **DB file mode tightened to 0600** on POSIX. Co-users can no longer read `coordinator.db` directly.
- **MQTT topic namespace changed** from `coordinator/agents/...` (and similar) to `coordinator/<org_id>/agents/...`. External MQTT consumers (dashboards, monitoring) must update subscription patterns. For Phase 1 single-org deployments, replace `coordinator/` with `coordinator/default/` everywhere. Wildcard subscribers: `coordinator/+/status` becomes `coordinator/+/+/status`. The internal bridge is updated automatically.
- **MCP transport: per-request JWT verification on every MCP request** (was: session-open only). Pre-v0.7 agents whose JWT expired mid-session could continue issuing tool calls indefinitely under the session-open bypass. v0.7 closes that hole. Agents must rotate their JWT within the TTL window or tool calls will fail mid-session with 401.
- **SSE endpoint `/api/events` now requires authentication** when `AUTH_ENABLED=true`. Browser clients using `EventSource` must send the token via query string: `new EventSource('/api/events?token=' + token)`. Server-side clients can use the standard `Authorization: Bearer` header.
- **`/api/auth/refresh` rejects v0.6 tokens when `AUTH_ENABLED=true`**: closes a bypass where a v0.6 token could be silently rotated to a v0.7-shape token via the refresh endpoint, sidestepping the AUTH_ENABLED=true reject-v0.6 invariant. Operators upgrading must either re-authenticate or use `/api/auth/refresh` while AUTH_ENABLED is still false (see Migration step 4 below).

### Added

- New env: `COORDINATOR_JWT_PREV_SECRET` for zero-downtime JWT secret rotation (set both `COORDINATOR_JWT_SECRET` and `COORDINATOR_JWT_PREV_SECRET`, restart, wait one JWT TTL, then remove `_PREV_`).
- `IdPProvider` interface + empty registry (Phase 2 will populate with GitHub OAuth).
- `EncryptionProvider` interface + `PassthroughEncryption` default (Phase v0.7.5 will replace with SQLCipher).
- `auditLog()` helper + `audit_log` table (Phase 2+ will emit events).
- All REST + SSE + MQTT operations scoped by `org_id` end-to-end. Default org is `'default'` until Phase 2 introduces real multi-tenancy via OAuth login.
- RFC 6750 `WWW-Authenticate` header on 401 responses.
- JWT algorithm pinning: `alg=none` and non-HS256 tokens rejected.
- `/healthz` now reports `auth_enabled` and `jwt_secret_set` flags for operability.

### Migration

1. Stop coordinator.
2. **Backup `coordinator.db`** (the migration is one-way per session — restore is needed if rolling back to v0.6).
3. **Set `COORDINATOR_JWT_SECRET`** to a stable 32+ char value if not already set (otherwise every restart invalidates all sessions).
4. Deploy v0.7.0 binary.
5. Start coordinator. Migration runs on first boot (idempotent). The PRAGMA user_version bump happens AFTER all ALTERs succeed — a mid-migration crash leaves the DB at user_version=6 and the next boot retries cleanly.
6. Existing clients keep working under `AUTH_ENABLED=false` (synthetic legacy claims).
7. **Rotate v0.6 tokens BEFORE flipping `AUTH_ENABLED=true`**: each agent must either (a) call `/api/auth/refresh` while `AUTH_ENABLED=false` is still set (v0.7.0 lifts the 501 gate for this endpoint specifically so v0.6 clients can rotate to v0.7-shape tokens), OR (b) call `/api/auth/register` to obtain a fresh v0.7 token. Once `AUTH_ENABLED=true`, `/api/auth/refresh` rejects v0.6 tokens with an explicit error.
8. Flip `AUTH_ENABLED=true` and restart. Agents that completed step 7 continue working; agents that didn't will get 401s and must re-register.

## [0.6.1](https://github.com/swoofer/mcp-coordinator/compare/v0.6.0...v0.6.1) (2026-05-12)


### Bug Fixes

* **deps:** override ip-address to ^10.2.0 (resolves dependabot [#1](https://github.com/swoofer/mcp-coordinator/issues/1)) ([f65f441](https://github.com/swoofer/mcp-coordinator/commit/f65f441954f6860a70c23ef64bd332ef6d7a0c2b))
* **deps:** override ip-address to ^10.2.0 (resolves GHSA-v2v4-37r5-5v8g) ([38bd705](https://github.com/swoofer/mcp-coordinator/commit/38bd705ad79473bc95dc2b8290ab868392d73aae))
* **http:** enforce repo-relative path contract in v0.6 endpoints ([0aaaaf8](https://github.com/swoofer/mcp-coordinator/commit/0aaaaf88465633dc51739ac80fe5d8a1476f8974))
* **http:** enforce repo-relative path contract in v0.6 endpoints ([eb9dbea](https://github.com/swoofer/mcp-coordinator/commit/eb9dbea05174c11a8381508ae1d6d74f17bce06c))


### Documentation

* add Contributor License Grant (relicense optionality) ([779c7d9](https://github.com/swoofer/mcp-coordinator/commit/779c7d9f62afad762ed870d5c3ddf96e47075e89))
* **contributing:** add Contributor License Grant for relicense optionality ([60acb03](https://github.com/swoofer/mcp-coordinator/commit/60acb03f667168d5943cede152ac91999644459b))

## [0.6.0](https://github.com/swoofer/mcp-coordinator/compare/v0.5.0...v0.6.0) (2026-05-10)


### Features

* **dashboard:** aggregate real outcomes in /api/scoring-stats ([eeb6f10](https://github.com/swoofer/mcp-coordinator/commit/eeb6f1008423b9bf79da8580ad5d73a3b5fc2803))


### Documentation

* **changelog:** remove orphan v0.6.0 entry pre-dating release-please ([4da39af](https://github.com/swoofer/mcp-coordinator/commit/4da39afe6652cca9a4e615dd2aadf6c78bae08ec))
* **i18n:** add fr/es/de/ja/zh translations for v0.5.0 landing additions ([858cf63](https://github.com/swoofer/mcp-coordinator/commit/858cf63e0c618dba89c8fbd978512637dd9848d2))
* **landing:** update for v0.5.0 — 15 languages, 6 scoring layers, dashboard signals ([4d122a8](https://github.com/swoofer/mcp-coordinator/commit/4d122a869849f47a80bd5137cdb008335281ccf9))
* **readme:** update for v0.5.0 — features shipped + LLM Reasoner roadmap ([5635497](https://github.com/swoofer/mcp-coordinator/commit/56354976f7a5a355d4857ef4545319e6d3a5a0cf))
* **v0.5.0:** follow-up polish — CHANGELOG, dashboard outcomes, i18n ([450ed07](https://github.com/swoofer/mcp-coordinator/commit/450ed0740e524b5c31ae5f94dfc82cbdcf24aa31))

## [0.5.0](https://github.com/swoofer/mcp-coordinator/compare/v0.4.0...v0.5.0) (2026-05-10)


### Features

* v0.6.0 Semantic Conflict Detection (server-anchored) ([aaf47fc](https://github.com/swoofer/mcp-coordinator/commit/aaf47fc8ec6f5a271c2d60331e2dd2e6e9e4b302))
* **v0.6:** /api/file-activity accepts content; parses symbols_touched via tree-sitter ([b6794f9](https://github.com/swoofer/mcp-coordinator/commit/b6794f95e6fbd04575d24abe49b4851028322d2d))
* **v0.6:** /api/scoring-stats + dashboard 'Conflict signals' panel ([defd5e0](https://github.com/swoofer/mcp-coordinator/commit/defd5e011b419ab5d265a6c0dac3f63736eb83d2))
* **v0.6:** /api/working-files/{start,stop} endpoints ([cbf8f93](https://github.com/swoofer/mcp-coordinator/commit/cbf8f9365f761a73a80b0c5f2221288504ed7329))
* **v0.6:** /readyz reports tree_sitter + git_cochange (optional, non-gating) ([6896635](https://github.com/swoofer/mcp-coordinator/commit/68966356a6e97df686ffa562a933e51d659e7786))
* **v0.6:** add normalizePath utility for symmetric path matching ([b6bfa6f](https://github.com/swoofer/mcp-coordinator/commit/b6bfa6f27bc328ec90e65e9c8ea55623ae90c013))
* **v0.6:** add working_files, git_cochange, layer_firings tables + user_version=6 ([4450458](https://github.com/swoofer/mcp-coordinator/commit/4450458293f07e60e0043c05dfd9271565ac450d))
* **v0.6:** env-var CLI flags, README docs, Prometheus counters ([0c932bb](https://github.com/swoofer/mcp-coordinator/commit/0c932bbbe778b9afc11441721611cca01ffd7c4f))
* **v0.6:** GitCochangeBuilder — bounded git log, denylist, retry-on-timeout ([8eadb1d](https://github.com/swoofer/mcp-coordinator/commit/8eadb1d151b8c6fd354acfd6ef5969b20e1e4e62))
* **v0.6:** Layer 0.5 annotation — same file, disjoint symbols flagged in reason ([ef64a50](https://github.com/swoofer/mcp-coordinator/commit/ef64a50f33ee38ab4733b7362c4caf9ea12a8dff))
* **v0.6:** Layer 4 git co-change scoring with canonical pair lookup ([994c9c8](https://github.com/swoofer/mcp-coordinator/commit/994c9c87410b7f3ed8d6f68efdaeeaafbb583c8a))
* **v0.6:** refactor TreeSitterExtractor to language-handler registry; add C#/C/C++/Ruby/PHP/Kotlin/Swift/Bash ([e1b9874](https://github.com/swoofer/mcp-coordinator/commit/e1b987474f3b38a7b3763389225e8ea28c044052))
* **v0.6:** refuse downgrade — PRAGMA user_version guard ([fe9893c](https://github.com/swoofer/mcp-coordinator/commit/fe9893cb1ff7457ebb1e9640ba398358d239cd77))
* **v0.6:** scorer Layer 1 unions working_files; offline hook clears working_files ([c736812](https://github.com/swoofer/mcp-coordinator/commit/c7368122f0a514ff42e408d22171bed0a638972e))
* **v0.6:** TreeSitterExtractor with per-language symbol qualification ([e54e5df](https://github.com/swoofer/mcp-coordinator/commit/e54e5dfc1dfe949c64a830149a8e7a3f9cb02ee6))
* **v0.6:** WorkingFilesTracker — UPSERT/DELETE/sweeper/index ([41d00ba](https://github.com/swoofer/mcp-coordinator/commit/41d00ba6f610a38a2a6ce81c7bba253225be7c5a))


### Bug Fixes

* **http:** cap parseBody at 1 MB with 413 response ([c820115](https://github.com/swoofer/mcp-coordinator/commit/c820115157eec6468d43be0817745191f88d689c))
* **http:** wire /livez /readyz /metrics + recordHttpRequest counters ([55f5ff4](https://github.com/swoofer/mcp-coordinator/commit/55f5ff45be770d5d0ab31c4b199ea78a9dd3d594))
* **path-normalize:** detect Windows-style paths from input shape, not process.platform ([f4cf7f0](https://github.com/swoofer/mcp-coordinator/commit/f4cf7f0c396f36ae779ec73b89e793a51c535b48))


### Documentation

* **v0.6:** add design spec + implementation plan + handoff ([ec35949](https://github.com/swoofer/mcp-coordinator/commit/ec359495b8edb4b10344f1bc7e34a4a158f10c3f))
* **v0.6:** add tree-sitter handler registry refactor plan ([4e3bba6](https://github.com/swoofer/mcp-coordinator/commit/4e3bba64ef7d0b7697085e1d7331459d6b92a556))

## [0.4.0](https://github.com/swoofer/mcp-coordinator/compare/v0.3.0...v0.4.0) (2026-05-10)


### Features

* v0.4 Operability + v0.5 Performance (autonomous 9-agent sprint) ([#8](https://github.com/swoofer/mcp-coordinator/issues/8)) ([76b4f38](https://github.com/swoofer/mcp-coordinator/commit/76b4f3875bc06b945c3dc9fba64cb354bd1da129))

## [0.3.0](https://github.com/swoofer/mcp-coordinator/compare/v0.2.1...v0.3.0) (2026-05-10)


### Features

* **server:** B6 - graceful shutdown + ServerHandle return ([95da83d](https://github.com/swoofer/mcp-coordinator/commit/95da83da1e9660cb146196b3610f6498e53b6d2b))


### Bug Fixes

* **consistency:** B1 - transactions in announceWork + CAS in approveResolution ([e4348e2](https://github.com/swoofer/mcp-coordinator/commit/e4348e23a0085985e0ac83f56429d35c5609e93e))
* **consistency:** B2 - move checkTimeouts to background sweeper ([231675c](https://github.com/swoofer/mcp-coordinator/commit/231675c729c25f90e9e71b4821bb5aad6d96b9fe))
* **landing:** hamburger visible on desktop ([4b7c79a](https://github.com/swoofer/mcp-coordinator/commit/4b7c79a24f98090c6c19af078c63a7194ebe5bd0))
* **landing:** remove orphan i18n block leaking past translations close ([79d2aa9](https://github.com/swoofer/mcp-coordinator/commit/79d2aa9fa61c8a5e7d3ee42749a914bc777c1623))
* **security:** B3 - opt-in MQTT JWT auth (preserves anonymous default) ([45dc203](https://github.com/swoofer/mcp-coordinator/commit/45dc203011cde6425920051533b5bb06f7c95ea1))
* **security:** B4 - gate /api/reset when AUTH is disabled ([969370f](https://github.com/swoofer/mcp-coordinator/commit/969370f3e45f38177dbc260f1152b0fca8da92d6))
* **security:** B5 - dashboard path traversal guard ([43e880d](https://github.com/swoofer/mcp-coordinator/commit/43e880df2c00dd4ae2bd88459b3ec36d133cc4f7))


### Documentation

* **audit:** code audit by 20 critical experts (avg 4.85/10) ([e59838f](https://github.com/swoofer/mcp-coordinator/commit/e59838fe578b37a8dae429717dc1ca657165eb69))
* **landing:** redesign — 11 sections, narrative arc, +templates +FAQ ([7f4e6dd](https://github.com/swoofer/mcp-coordinator/commit/7f4e6dd54ec9900191bedf593ae33ec3db0bbf23))
* **landing:** redesign for clarity, fix DOM/version/BCE bugs, expand a11y/SEO/i18n ([0f35f49](https://github.com/swoofer/mcp-coordinator/commit/0f35f492a21258d3053ea405c38a6ffc53523e02))
* **landing:** reframe templates section to lead with mcp-coordinator ([21af5c0](https://github.com/swoofer/mcp-coordinator/commit/21af5c04923c5b7bd19ee138b4075155da6f7247))
* **landing:** translate 1010 placeholders across 5 locales ([318bef2](https://github.com/swoofer/mcp-coordinator/commit/318bef24ff482bbc1e1171df9fa24dbb0d2b0e8b))
* **redesign:** integration draft v1 (11 sections merged) ([ee5de20](https://github.com/swoofer/mcp-coordinator/commit/ee5de20949f5ddafadfc67f1448caf314ac862bf))
* **redesign:** integration draft v2 (Layer 3 audits applied) ([29121fc](https://github.com/swoofer/mcp-coordinator/commit/29121fc0efb3b12ab635095a2e36923f20539be6))
* **redesign:** Layer 1 strategy briefs (5 agents) ([657f4d4](https://github.com/swoofer/mcp-coordinator/commit/657f4d476d1826158b768e203c70412e018f4266))
* **redesign:** Layer 2 section fragments (22 agents, 11 pairs) ([5574100](https://github.com/swoofer/mcp-coordinator/commit/55741007fb6c62a52fdf8582aa30dc3bf369d2e6))
* **redesign:** Layer 3 discipline audits (6 agents) ([c3693cf](https://github.com/swoofer/mcp-coordinator/commit/c3693cf01e4953cad069cee966969755500e6c26))
* **redesign:** Layer 4 QA finale (3 agents sequential) ([755a197](https://github.com/swoofer/mcp-coordinator/commit/755a197e5b1e502f46832821a9b934e3b3d1b351))
* **seo:** add Open Graph + Twitter Cards + sitemap + robots.txt ([55b6ec6](https://github.com/swoofer/mcp-coordinator/commit/55b6ec65e31d0f85d30cfac5fa4c09175309350e))


### Code Refactoring

* structural fixes S1/S2/S3 (god files split, duplication, network tests) ([#7](https://github.com/swoofer/mcp-coordinator/issues/7)) ([900ab9a](https://github.com/swoofer/mcp-coordinator/commit/900ab9a2ce5ee917a24d764507dba7f9b9909998))

## [0.2.1](https://github.com/swoofer/mcp-coordinator/compare/v0.2.0...v0.2.1) (2026-05-06)


### Bug Fixes

* **landing:** missing commas in i18n dict broke JS parsing ([0d62c44](https://github.com/swoofer/mcp-coordinator/commit/0d62c44f13fcdf5f37df6142f4b23ab5e7242ece))


### Documentation

* add Buy Me A Coffee + GitHub Sponsors links across surfaces ([5e5d2d1](https://github.com/swoofer/mcp-coordinator/commit/5e5d2d10e47bbaa15d2e808041f264b0de10c36c))
* **landing:** remove essaim/v3 spillover from why blocks ([2e1c399](https://github.com/swoofer/mcp-coordinator/commit/2e1c3991fc436127fc30502adf8389e54ace827f))
* **landing:** roadmap reflects what was actually shipped in 0.2.0 ([84d8510](https://github.com/swoofer/mcp-coordinator/commit/84d85101ff25f9eb33701cc61f377f32f8847204))

## [0.2.0](https://github.com/swoofer/mcp-coordinator/compare/v0.1.0...v0.2.0) (2026-05-05)


### Features

* **cli:** add doctor, server logs, and init --write-claude-md ([95b1505](https://github.com/swoofer/mcp-coordinator/commit/95b15051c06f308161defc33b1a7d91dab1f3c77))
* **cli:** add init command + document standalone use ([5bb2da8](https://github.com/swoofer/mcp-coordinator/commit/5bb2da88c9830ab27f752b191d137ff66c0fe58d))
* **cli:** add uninstall command + expand release-please CHANGELOG sections ([d4330ed](https://github.com/swoofer/mcp-coordinator/commit/d4330ed381cd43b31c7103779d6847280dcc7183))


### Bug Fixes

* **ci:** disable component prefix in release-please tags ([85fadf1](https://github.com/swoofer/mcp-coordinator/commit/85fadf1efb67dc4f48fef5d638799980ebdfacd6))


### Documentation

* clarify push vs polling — vanilla Claude Code is polling-based, not push ([5a097da](https://github.com/swoofer/mcp-coordinator/commit/5a097daedb09eb7ebb015aaaa0b06eae977fa2d2))
* expand standalone use with team walkthrough, e2e example, logs/debug, multi-instance ([98fa71a](https://github.com/swoofer/mcp-coordinator/commit/98fa71a401ecb587dc281f71b849e55392591981))
* **landing:** hero subtitle now signals standalone use + essaim pairing ([049d6f5](https://github.com/swoofer/mcp-coordinator/commit/049d6f5a05f1a6d57daac7d207b87e65c71b0a95))
* **landing:** reflect 0.2.0 surface — init flow, polling vs push, fix dashboard port ([00b3404](https://github.com/swoofer/mcp-coordinator/commit/00b34040fd2cabea543710f7d4c0b6f52085536e))
* **landing:** replace minimal placeholder with epurated source landing page ([812fee7](https://github.com/swoofer/mcp-coordinator/commit/812fee770085686b66ef794d0be7891415d752f6))
* replace README with epurated source (preserve all server-pure sections) ([4cb9930](https://github.com/swoofer/mcp-coordinator/commit/4cb9930cf4a1ab5730c010022a5810734c77e479))
