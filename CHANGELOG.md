# Changelog

## [1.3.0](https://github.com/swoofer/mcp-coordinator/compare/v1.2.1...v1.3.0) (2026-07-21)


### Features

* **init:** add Google provider support to the phase2 wizard ([#213](https://github.com/swoofer/mcp-coordinator/issues/213)) ([8884902](https://github.com/swoofer/mcp-coordinator/commit/888490242af67de3c4b6d5e87f55ea7269abf231))

## [1.2.1](https://github.com/swoofer/mcp-coordinator/compare/v1.2.0...v1.2.1) (2026-07-21)


### Bug Fixes

* **binaries:** mark tree-sitter grammars external in bun --compile (closes [#210](https://github.com/swoofer/mcp-coordinator/issues/210)) ([#212](https://github.com/swoofer/mcp-coordinator/issues/212)) ([c7d1252](https://github.com/swoofer/mcp-coordinator/commit/c7d12522de58e415e07e91de2ae4c9be26d70183))
* **docker:** install Corepack explicitly — Node 26 dropped the bundled one ([5c8b365](https://github.com/swoofer/mcp-coordinator/commit/5c8b3658a61d089696c0083a96f92f70fc57acc5))

## [1.2.0](https://github.com/swoofer/mcp-coordinator/compare/v1.1.0...v1.2.0) (2026-07-20)


### Features

* **auth:** make GitHub OAuth optional — Google-only Phase 2 boots ([#205](https://github.com/swoofer/mcp-coordinator/issues/205)) ([e5e08de](https://github.com/swoofer/mcp-coordinator/commit/e5e08dec6b13a1057ac7b09c22780c9e7885cedf))
* **doctor:** probe Google creds + treat GitHub as optional; guard cookie major ([e3bcce0](https://github.com/swoofer/mcp-coordinator/commit/e3bcce0e678b9a146eb881ae28c88e1c5303e46e))

## [1.1.0](https://github.com/swoofer/mcp-coordinator/compare/v1.0.1...v1.1.0) (2026-07-13)


### Features

* **cli:** --log-json NDJSON logging flag (adopts contributor PR [#151](https://github.com/swoofer/mcp-coordinator/issues/151)) ([0c4b79d](https://github.com/swoofer/mcp-coordinator/commit/0c4b79d5fe9fd60667cc39f55a6f9f5646f9adf5))
* **cli:** add --log-json flag for NDJSON logging (adopts [#151](https://github.com/swoofer/mcp-coordinator/issues/151)) ([a2c04b6](https://github.com/swoofer/mcp-coordinator/commit/a2c04b624f768c778da2db11b4daab3d691b6d57))
* **threads:** per-run scoping — stop leaking an aborted run into the next ([#32](https://github.com/swoofer/mcp-coordinator/issues/32)) ([#198](https://github.com/swoofer/mcp-coordinator/issues/198)) ([d83c49f](https://github.com/swoofer/mcp-coordinator/commit/d83c49f066cbd677bd8a1a60041143c9fb9c884f))


### Documentation

* **audit:** [#151](https://github.com/swoofer/mcp-coordinator/issues/151) closed with thanks (feature via [#196](https://github.com/swoofer/mcp-coordinator/issues/196)) ([31163d0](https://github.com/swoofer/mcp-coordinator/commit/31163d00c71c01ff8ddc58f48473582afa00778d))
* **audit:** close maintenabilite-01 (--log-json adopted from [#151](https://github.com/swoofer/mcp-coordinator/issues/151), [#196](https://github.com/swoofer/mcp-coordinator/issues/196)) — all 13 Highs done; 116→117 ([10bc081](https://github.com/swoofer/mcp-coordinator/commit/10bc081b7b9091b662916ca390f41ac7136d3ee2))

## [1.0.1](https://github.com/swoofer/mcp-coordinator/compare/v1.0.0...v1.0.1) (2026-07-13)


### Bug Fixes

* **dashboard:** convert inline onclick to addEventListener + apply script-src 'self' CSP (architecture-14 follow-up) ([9fdccd9](https://github.com/swoofer/mcp-coordinator/commit/9fdccd9e5bd040b0d2df807ca278eb1ffb1417dc))
* **dashboard:** strict script-src 'self' CSP + inline onclick → addEventListener (arch-14 follow-up) ([4a7102f](https://github.com/swoofer/mcp-coordinator/commit/4a7102fa88d23f7f5218f41a9daedeb51427b9ba))
* **sse:** flush headers immediately (EventSource opens without waiting for heartbeat) ([bfce26a](https://github.com/swoofer/mcp-coordinator/commit/bfce26a5132f90e1fad2eb2e39180f2bc38d8700))
* **sse:** flush headers immediately so EventSource opens without waiting for heartbeat ([416b640](https://github.com/swoofer/mcp-coordinator/commit/416b6404d764f236dd1184c7fb23e3c74f263455))


### Documentation

* **audit:** close ci-cd-03 (branch protection enabled); 111→112 ([195215f](https://github.com/swoofer/mcp-coordinator/commit/195215fad1b0c94d10c32755b8cb606022c28c16))
* **audit:** close qualite-code-01 (3 giant fns) + architecture-14 (dashboard script); 112→114 ([61dcd12](https://github.com/swoofer/mcp-coordinator/commit/61dcd1238d7f11613d86298fb530bd33e196bde9))
* **audit:** close qualite-code-03 + maintenabilite-05 (Prettier [#194](https://github.com/swoofer/mcp-coordinator/issues/194)); 114→116 ([e8fcd86](https://github.com/swoofer/mcp-coordinator/commit/e8fcd869890d3f7cbb8469753e16e48a2d906e24))
* **audit:** dashboard CSP hardening done ([#195](https://github.com/swoofer/mcp-coordinator/issues/195)) ([defa91c](https://github.com/swoofer/mcp-coordinator/commit/defa91c18fcb51842f6bf6ce11ddd12797573380))
* **audit:** v1.0.0 shipped — close maintenabilite-03, confirm binary/provenance R5 (110→111) ([1eb1787](https://github.com/swoofer/mcp-coordinator/commit/1eb17870b0e2878c00622dac39a7f93f3d2eb21f))
* **landing:** mark v1.0 shipped on roadmap, add post-1.0 future card, bump version refs ([3420c79](https://github.com/swoofer/mcp-coordinator/commit/3420c79930e0156de4c3a86a365eedc1aebf934d))
* **landing:** mark v1.0 shipped on roadmap; post-1.0 future card; version refs → 1.0.0 ([e96fcec](https://github.com/swoofer/mcp-coordinator/commit/e96fcec12e56b85cda5bdf6aef88b7c4eaa932db))


### Code Refactoring

* **auth:** extract numbered steps from refreshTokenGrant into helpers (qualite-code-01 2/3) ([0b92e54](https://github.com/swoofer/mcp-coordinator/commit/0b92e54fc7bb9c09560cddab4dab1fb00c4c62a5))
* **auth:** extract numbered steps from refreshTokenGrant into named helpers (qualite-code-01, 2/3) ([fd15e83](https://github.com/swoofer/mcp-coordinator/commit/fd15e83d1fdf5668fa9980a3c8ed64bee9284d3a))
* **dashboard:** extract inline script to external dashboard.js (architecture-14) ([546af34](https://github.com/swoofer/mcp-coordinator/commit/546af3464a0004645c4488c08d19d68896f2934d))
* **dashboard:** extract inline script to external dashboard.js (architecture-14) ([7674256](https://github.com/swoofer/mcp-coordinator/commit/7674256c58ac5c59c1ef2ed9f0e3827f4db451ce))
* **rest:** dispatch table for handleRest — extract 24 endpoint handlers (qualite-code-01, 1/3) ([3d36f63](https://github.com/swoofer/mcp-coordinator/commit/3d36f63508e12a2b7a1534717d90bf48973af61d))
* **rest:** dispatch table for handleRest — extract 28 endpoint handlers (qualite-code-01 1/3) ([262906f](https://github.com/swoofer/mcp-coordinator/commit/262906f4e864247cb3799ada2e8abe07e6e3124f))
* **server:** extract createHttpHandler/wireMqtt/wireShutdown from startServer (qualite-code-01 3/3) ([3d731a2](https://github.com/swoofer/mcp-coordinator/commit/3d731a25d9fbf33ae4f1d4f02c42affe1b64df26))

## [1.0.0](https://github.com/swoofer/mcp-coordinator/compare/v0.13.0...v1.0.0) (2026-07-12)


### ⚠ BREAKING CHANGES

* **ops:** JWTs now require a `typ` claim ("access"/"refresh"); sessions and refresh tokens issued before this release are rejected, forcing all active users to re-authenticate after upgrade.

### Features

* **boot:** fail-fast when OAuth is enabled on the Bun runtime (architecture-10) ([aabb272](https://github.com/swoofer/mcp-coordinator/commit/aabb2723a66acc596ea2482c56742a01dcdb595c))
* **boot:** warn on cwd-relative data dir fallback; fix README data-dir docs (architecture-06) ([f36d887](https://github.com/swoofer/mcp-coordinator/commit/f36d887a380195f73d72ce5318a29f9c2870bbfa))
* **rest:** validate request bodies with zod, return structured 400 (qualite-code-02, architecture-15) ([b39326b](https://github.com/swoofer/mcp-coordinator/commit/b39326bd0012895d29cea1f5f5ff2b2cf6290934))


### Bug Fixes

* **audit:** guard AuditQueue flush against a closed DB to stop CI teardown crashes ([2d5af73](https://github.com/swoofer/mcp-coordinator/commit/2d5af73f79ed6ff3e25929256ba261339f82de28))
* **audit:** guard AuditQueue flush against closed DB (stabilise la CI) ([34eab57](https://github.com/swoofer/mcp-coordinator/commit/34eab576c602142761176ec939244a20c45dda87))
* **ci:** make SDK tests self-contained so sdk-test job passes in clean CI (tests-02) ([1d8cd17](https://github.com/swoofer/mcp-coordinator/commit/1d8cd177895b6ac3f1bf9ac16bac59c9d1b3ffe5))
* **ci:** trigger release-binaries via workflow_call from release, fix tag derivation (ci-cd-01, maintenabilite-02) ([72e19c5](https://github.com/swoofer/mcp-coordinator/commit/72e19c526ba68027c3a8ca1613eeb8635ef2adab))
* **ci:** use npm ecosystem for Dependabot (pnpm is not a valid value) ([5d3bc8a](https://github.com/swoofer/mcp-coordinator/commit/5d3bc8a39ac4cef9b8913c925529ec3d5aeecfa5))
* **cli:** forward Phase 2/OAuth/bind env vars to daemon (architecture-05) ([11d101a](https://github.com/swoofer/mcp-coordinator/commit/11d101a398ac7555c82cce616e184314f1ac7068))
* **consultation:** parse SQLite created_at as UTC, not host-local ([809cc2f](https://github.com/swoofer/mcp-coordinator/commit/809cc2fd6f900ca3e03d792f0206aebb1e315acb))
* **dashboard:** split Clear (UI-only) from Reset Server (destructive, gated) ([94cd92d](https://github.com/swoofer/mcp-coordinator/commit/94cd92d0f73801f4c24491c58108eb196b4bffbb))
* **deps:** move overrides to pnpm format, refresh lockfile, add Dependabot (dependances-01/02/03) ([e0bace5](https://github.com/swoofer/mcp-coordinator/commit/e0bace59bebf854b2d2fdb6cfb4d56c11b727012))
* **http:** generic 500 with request_id instead of raw err.message (qualite-code-08) ([6b73e92](https://github.com/swoofer/mcp-coordinator/commit/6b73e924e39f739ea7aeb6ca903e0a61e8a254d5))
* **http:** mount /metrics/auth with optional bearer, wire COORDINATOR_METRICS_BEARER (documentation-02, securite-surface-02) ([c87ee56](https://github.com/swoofer/mcp-coordinator/commit/c87ee5675536f0ef54e86a8f3cdcf70d1a184c23))
* **http:** mount discovery + healthz/health-ready endpoints (architecture-01, protocole-mcp-03) ([6236a10](https://github.com/swoofer/mcp-coordinator/commit/6236a107c40814723443ba6af98cf024e7dc205c))
* **landing:** drop stale Channels-integration card + correct requestIdleCallback call ([#150](https://github.com/swoofer/mcp-coordinator/issues/150)) ([f5dc89b](https://github.com/swoofer/mcp-coordinator/commit/f5dc89b2fff30b482c95b119aeb2fdb1fef77a83))
* **mcp:** expose mcp-session-id via CORS; align serverInfo.name to registry name (protocole-mcp-11/13) ([dec5123](https://github.com/swoofer/mcp-coordinator/commit/dec51238b4f8d20eba404e223ad6bb03021751fe))
* **mcp:** improve tool ergonomics — annotations, descriptions, actionable errors, timeout caps (protocole-mcp-05/08/10/14) ([0f97fc3](https://github.com/swoofer/mcp-coordinator/commit/0f97fc3a3f73127f9e100511b2bd2b5d3a241a57))
* **mcp:** return isError from MQTT tools when bridge is not connected (stdio) (protocole-mcp-06) ([23c5098](https://github.com/swoofer/mcp-coordinator/commit/23c50981dcbdbed5adb454857d53a433fadcba1f))
* **mcp:** route stdio-mode logs to stderr, keep stdout for JSON-RPC (protocole-mcp-01) ([a470112](https://github.com/swoofer/mcp-coordinator/commit/a470112fb53bfa54245dd1e5a362c136a7507c1d))
* **mcp:** tool ergonomics — annotations, descriptions, actionable errors, timeout caps (5 constats) ([d3f3877](https://github.com/swoofer/mcp-coordinator/commit/d3f38774b49efb45d6e352fae6570bbb219ba22d))
* **mqtt:** reset connected on close/offline so isConnected() reflects outages ([3475b61](https://github.com/swoofer/mcp-coordinator/commit/3475b61658aa27ed5722e66a2ae4b36b0de4240b))
* **mqtt:** set explicit Duplex highWaterMark so WS read-backpressure is deterministic (fixes CI flake) ([14a5223](https://github.com/swoofer/mcp-coordinator/commit/14a5223b59ae1a6c290761175e2e1204c0abf38f))
* **perf:** add retention for 5 Phase 1 tables and run sweeper in Phase-1-only mode (performance-01) ([1ce158e](https://github.com/swoofer/mcp-coordinator/commit/1ce158ea6ab27f06925ac8bea916f72f5318a852))
* **perf:** bound Prometheus route-label cardinality (performance-03) ([609126d](https://github.com/swoofer/mcp-coordinator/commit/609126d6958daae215ed718210767a9aedc0ed84))
* **perf:** bound RateLimiter buckets and MqttBridge listener queues (performance-05, performance-06) ([1e4daf2](https://github.com/swoofer/mcp-coordinator/commit/1e4daf21fa3b6e36e34a7cc50a01ff229461c83e))
* **perf:** expire idle MCP StreamableHTTP sessions (performance-07, protocole-mcp-07) ([846d6f1](https://github.com/swoofer/mcp-coordinator/commit/846d6f1edc9e54b02a444fec2b9862e538a21eb2))
* **robustness:** guard JSON.parse on SQLite columns with safeJsonParse (qualite-code-07) ([22ae9ef](https://github.com/swoofer/mcp-coordinator/commit/22ae9ef250d40a3b9d175baffcc861b5da349a09))
* **security:** add baseline security headers to legacy dashboard and API responses (securite-surface-07) ([dc4bb3a](https://github.com/swoofer/mcp-coordinator/commit/dc4bb3a9a50e35b2ab942ee84f8401876e408604))
* **security:** add typ claim to distinguish access vs refresh tokens ([34a5ffa](https://github.com/swoofer/mcp-coordinator/commit/34a5ffa6ac1f737d45f129c4c54afed3763e1dad))
* **security:** bind HTTP server to 127.0.0.1 by default via COORDINATOR_BIND ([3671d7b](https://github.com/swoofer/mcp-coordinator/commit/3671d7b99108e4f307a440a7645445a68f88566f))
* **security:** rate-limit register, make insecure-cookies flag consistent, prevent ?token= log leak (securite-surface-05, securite-auth-05, securite-auth-03) ([177205b](https://github.com/swoofer/mcp-coordinator/commit/177205b8345db957ea2a0f68f6cfb640ceaeb87a))
* **security:** re-derive role from DB on refresh rotation (securite-auth-04) ([8e6ec78](https://github.com/swoofer/mcp-coordinator/commit/8e6ec78d2168f7a14df594c89253049a66f246d5))
* **security:** redact secrets in Phase 1 logger to match Phase 2 (securite-surface-04) ([6482528](https://github.com/swoofer/mcp-coordinator/commit/648252823f975e27de8a238555bee9cf8911869a))
* **security:** validate Origin and restrict CORS on /mcp (MCP spec MUST) ([f8f6227](https://github.com/swoofer/mcp-coordinator/commit/f8f62278d730d27ee628aa3f6122dafe38159aba))
* **security:** verify OIDC nonce in Google provider (securite-auth-02) ([eca4d2f](https://github.com/swoofer/mcp-coordinator/commit/eca4d2fedce6764961514b549f914d2a3714cef1))
* **server:** fail-closed on concurrent startServer(); correct multi-instance docstring (architecture-02) ([2ba5fb7](https://github.com/swoofer/mcp-coordinator/commit/2ba5fb7d87b280e70c340cc1cb146726bec71d2e))


### Performance Improvements

* **db:** index sweep predicates and set WAL synchronous=NORMAL (performance-09, performance-10) ([ba6bd4c](https://github.com/swoofer/mcp-coordinator/commit/ba6bd4cce05382e979998a5b87fa2943be4fed50))
* **mqtt:** add WS bridge backpressure and maxPayload (performance-04) ([5cb7296](https://github.com/swoofer/mcp-coordinator/commit/5cb72967b9a0771bae91c18f03b1400c8b2f87d3))
* **scorer:** batch Layer 4 co-change queries; fix rusted audit-queue bench (performance-11, performance-08) ([e874cf3](https://github.com/swoofer/mcp-coordinator/commit/e874cf3d78b99125ab38e692e7cd290dcae68151))
* **sse:** bound event history load at the SQL layer instead of loading all then slicing (performance-02) ([fc1d08b](https://github.com/swoofer/mcp-coordinator/commit/fc1d08bb58ba509ad7cbe11038dc2bc91c887cae))


### Documentation

* add ARCHITECTURE.md; document multi-org/logger-metrics status, perf-chaos & binary deferrals (architecture-13/08/09, qualite-code-06, tests-11, ci-cd-09) ([62fdf82](https://github.com/swoofer/mcp-coordinator/commit/62fdf82db98b3a964bf53aaf08dd03a0cbd19c8e))
* **audit:** add full audit, remediation spec, plan and 119-finding tracking matrix ([1c4f736](https://github.com/swoofer/mcp-coordinator/commit/1c4f7365ac52335a3705d3827b90d0feab0384a9))
* **audit:** close architecture-02/03 + tests-05 (107→110) ([55cf389](https://github.com/swoofer/mcp-coordinator/commit/55cf389e061568985dc7d59d588930fe2aaecbf9))
* **audit:** close architecture-04/11/12 (66→69) ([4cda748](https://github.com/swoofer/mcp-coordinator/commit/4cda74883cff56fa582f5122f9ccb2504d1cf255))
* **audit:** close architecture-08/09/10/13 + qualite-code-06 + tests-11 + ci-cd-09 (96→103) ([71b6fa9](https://github.com/swoofer/mcp-coordinator/commit/71b6fa93b78ae90ce32af67af71c52dde3a599da))
* **audit:** close ci-cd-05/07/10/11 (CI supply-chain hardening) ([cbbb54d](https://github.com/swoofer/mcp-coordinator/commit/cbbb54d074ea11b644483cd07b119a7a81b3eb0d))
* **audit:** close dependances-04..10 (pnpm 10 + deps docs); counter 73→80 ([981448f](https://github.com/swoofer/mcp-coordinator/commit/981448fc2ca8a562b603814b4812057aa6b01642))
* **audit:** close maintenabilite-04/06/07/10/11/12; flag 01/03/08/09 as maintainer-action (80→86) ([51e1520](https://github.com/swoofer/mcp-coordinator/commit/51e1520a748c15217ce58de05075c27c3ed312e0))
* **audit:** close protocole-mcp-06 + tests-08 (86→88) ([d951beb](https://github.com/swoofer/mcp-coordinator/commit/d951bebcb4278dfba675dba1ad16c695323bd11a))
* **audit:** close protocole-mcp-11/12/13 + architecture-06 (92→96) ([23b4aa5](https://github.com/swoofer/mcp-coordinator/commit/23b4aa52258f3fd6978f264eac3f5421c643fa9e))
* **audit:** close qualite-code-02/08 + architecture-07/15 (REST hardening; 88→92) ([dfac844](https://github.com/swoofer/mcp-coordinator/commit/dfac84418d44df360a22098f6308b37f4f4a426c))
* **audit:** close tests-03/06/09 + disposition tests-10 (103→107) ([a43d4b5](https://github.com/swoofer/mcp-coordinator/commit/a43d4b5c35cd1cdda1a0a95dd092c04b3df16f3f))
* **audit:** final reconciliation — 110/119 treated; 5 maintainer-action + 4 deferred refactors ([ea18a3f](https://github.com/swoofer/mcp-coordinator/commit/ea18a3f5a3c54f1162215fdcfabf1d16c53a6eea))
* **audit:** repair corrupted TRACKING.md H1 (stray row fragments from a merge) ([b4908cc](https://github.com/swoofer/mcp-coordinator/commit/b4908ccfdf22fe97d16a43ef4529a41e7843feee))
* **deps:** document tree-sitter coupling, light install, major-version backlog, Node 22+ (dependances-05/06/07/09) ([6eee2d4](https://github.com/swoofer/mcp-coordinator/commit/6eee2d4109916f1eb06cf92c4edf45f59e0ce0a2))
* document backup/restore CLI and fix custom-idp example (documentation-10, documentation-11) ([1083f18](https://github.com/swoofer/mcp-coordinator/commit/1083f184e480b03979cc0192d160b51a774e1e47))
* document single-instance-per-process DB/model; DB injection deferred (architecture-03) ([4ba93d4](https://github.com/swoofer/mcp-coordinator/commit/4ba93d4d42cb4a60b119faf08b3989e85f704969))
* fix false/stale claims in README and SECURITY (documentation-05/06/07/13/15) ([5484ba7](https://github.com/swoofer/mcp-coordinator/commit/5484ba7598d62528ba92561e5a99e8f1df29eaf5))
* fix usage/env/contributing accuracy (documentation-03/04/08/09/14) ([8fbb5e1](https://github.com/swoofer/mcp-coordinator/commit/8fbb5e132b68e9aaee3c72b7c62086af79821f6e))
* freeze Phase 2, document coverage pins + landing i18n policy (maintenabilite-07/11/12) ([1125e1f](https://github.com/swoofer/mcp-coordinator/commit/1125e1fbd1608e296c338c3c960c18c5035b5631))
* MCP auth discovery limitation, eventStore + registry deferral (protocole-mcp-12/11/13) ([6dc241d](https://github.com/swoofer/mcp-coordinator/commit/6dc241dba8286801290b2c891cf20c66b748a75c))
* **ops:** note typ-enforcement breaking change (mass re-login on upgrade) ([5c6fa04](https://github.com/swoofer/mcp-coordinator/commit/5c6fa045d6e0d3c780df8f24cde2c10164203094))
* **plan:** correct PR1 marquee tasks against real code ([45242cb](https://github.com/swoofer/mcp-coordinator/commit/45242cb48594630fa7845f80a26f8f28a5856e33))
* post-v0.13.0 polish — landing version refs + v0.12 / v0.13 roadmap cards + examples ([#148](https://github.com/swoofer/mcp-coordinator/issues/148)) ([340ca14](https://github.com/swoofer/mcp-coordinator/commit/340ca14437f36023b8b3b7696a67a7d930b31791))
* **security:** document intra-org agent trust model, defer per-agent authz ([bed5486](https://github.com/swoofer/mcp-coordinator/commit/bed5486ff90d7525998d9be46e8f58de52e91189))
* stop publishing internal docs/superpowers to Pages, drop 2MB HTML backups (documentation-12) ([b0c3517](https://github.com/swoofer/mcp-coordinator/commit/b0c3517a5696eeecaaa95edd94813d1faa02ab6e))
* **tracking:** close architecture-01 + protocole-mcp-03 (mount ghost endpoints, 6236a10) ([f864dd1](https://github.com/swoofer/mcp-coordinator/commit/f864dd1eb38849584b4d38fcd9b9ed6223ca9e46))
* **tracking:** close architecture-05 (daemon env allowlist, 11d101a) ([e6dd25a](https://github.com/swoofer/mcp-coordinator/commit/e6dd25a7c588adf6896d92238795e893f2fae197))
* **tracking:** close ci-cd-01 + maintenabilite-02 (release-binaries workflow_call, 72e19c5) ([45158ec](https://github.com/swoofer/mcp-coordinator/commit/45158ec5992f386e3a0e077e28e43a9670e0e4ab))
* **tracking:** close ci-cd-02/04/06/08 + tests-02 (CI batch, f2767da) ([e1e94f3](https://github.com/swoofer/mcp-coordinator/commit/e1e94f35dfffbbb111c680328889b6d4ba8a3f45))
* **tracking:** close dependances-01/02/03 (deps refresh + Dependabot, e0bace5) ([371416b](https://github.com/swoofer/mcp-coordinator/commit/371416bee150a0ab8b7e09df0a882c421b35011f))
* **tracking:** close documentation-02 + securite-surface-02 (mount /metrics/auth, c87ee56) ([e2cee99](https://github.com/swoofer/mcp-coordinator/commit/e2cee998312654fc8d94151873455e7e1fc8a062))
* **tracking:** close documentation-03/04/08/09/14 (usage/env/contributing, 8fbb5e1) ([645dbb1](https://github.com/swoofer/mcp-coordinator/commit/645dbb10e90b6727f940e687223f6a5363f0d0c5))
* **tracking:** close documentation-05/06/07/13/15 (README/SECURITY truth, 5484ba7) ([d4dcfce](https://github.com/swoofer/mcp-coordinator/commit/d4dcfce6e498c7a27552042d6b40f28566bb17ef))
* **tracking:** close documentation-10/11 (backup/restore docs + idp example, 1083f18) ([d78be7e](https://github.com/swoofer/mcp-coordinator/commit/d78be7e7ab4a796c9ebdace199e393d9cde0b51d))
* **tracking:** close documentation-12 — Docs theme complete (13/13) ([e9879ac](https://github.com/swoofer/mcp-coordinator/commit/e9879ac14469cf7f56032164ed7e5e6d80537338))
* **tracking:** close performance-01 (Phase 1 retention + sweeper wiring, 1ce158e) ([5f13ae5](https://github.com/swoofer/mcp-coordinator/commit/5f13ae53235866cbc8a5b410dd60eacfaeeb1286))
* **tracking:** close performance-02 (bounded SSE load, fc1d08b) ([bb38d7c](https://github.com/swoofer/mcp-coordinator/commit/bb38d7c38b987fca40143d0bbc8a292d036aebb3))
* **tracking:** close performance-03 (Prometheus cardinality, 609126d) ([5502694](https://github.com/swoofer/mcp-coordinator/commit/5502694a3499bae85bf0503076ed5fef75ba5f71))
* **tracking:** close performance-04 (WS backpressure + maxPayload, 5cb7296) ([fbdf19f](https://github.com/swoofer/mcp-coordinator/commit/fbdf19fe11d7e8d499238d84d590eb118b9822b3))
* **tracking:** close performance-05 + performance-06 (bounded structures, 1e4daf2) ([1c438ba](https://github.com/swoofer/mcp-coordinator/commit/1c438ba0cc4ea2bda1826aab2691ea694cedfa99))
* **tracking:** close performance-07 + protocole-mcp-07 (idle MCP session expiry, 846d6f1) ([792c920](https://github.com/swoofer/mcp-coordinator/commit/792c92034414f2577d0b56da8554c260059fcce2))
* **tracking:** close performance-09/10 (sweep indexes + synchronous NORMAL, ba6bd4c) ([815a3d9](https://github.com/swoofer/mcp-coordinator/commit/815a3d948376fcf2edb6d9b9fb7313bd1b6891e4))
* **tracking:** close performance-11/08 (scorer batching + bench fix, e874cf3) ([c18fa20](https://github.com/swoofer/mcp-coordinator/commit/c18fa207377a68cf568134e68049261e7d60b0a8))
* **tracking:** close protocole-mcp-01 (stdio logs to stderr, a470112) ([5781c32](https://github.com/swoofer/mcp-coordinator/commit/5781c32eb8d2b2f141e17e3e12a9b1377ee775f8))
* **tracking:** close protocole-mcp-02 + securite-surface-06 (Task 1.2, f8f6227) ([dac5004](https://github.com/swoofer/mcp-coordinator/commit/dac500432c05b5c4869740348a28a5bfd9d6e722))
* **tracking:** close protocole-mcp-05/08/09/10/14 (MCP ergonomics, 0f97fc3) ([e490f36](https://github.com/swoofer/mcp-coordinator/commit/e490f363fed9f4c7cc2be98d727ded430055bf66))
* **tracking:** close qualite-code-04/05 (dedupe helpers, b58688d) ([5248a15](https://github.com/swoofer/mcp-coordinator/commit/5248a15215a70086393a3ebc23fc340093b03ac5))
* **tracking:** close qualite-code-07 (safe JSON.parse, 22ae9ef) ([6ffb6fb](https://github.com/swoofer/mcp-coordinator/commit/6ffb6fbccc7f1ac0f19ce273a4decf7fffe4496f))
* **tracking:** close securite-auth-01 (Task 1.3, 34a5ffa + breaking-change note 5c6fa04) ([2e4232d](https://github.com/swoofer/mcp-coordinator/commit/2e4232d5ba8c09c800b1ad963bb83257accc44ae))
* **tracking:** close securite-auth-02 (Google OIDC nonce, eca4d2f) ([9db89fd](https://github.com/swoofer/mcp-coordinator/commit/9db89fdee593aa019ee33f3dd299cb2a471d8f0a))
* **tracking:** close securite-auth-04 (8e6ec78); disposition protocole-mcp-04 + securite-surface-03 as documented-deferred (bed5486) ([6b9ad8f](https://github.com/swoofer/mcp-coordinator/commit/6b9ad8f3d2f0c62bb4b734a81a6d5f159492b991))
* **tracking:** close securite-surface-01 + documentation-01 (Task 1.1, 3671d7b) ([203518d](https://github.com/swoofer/mcp-coordinator/commit/203518dddbc1ae453a84fd7092f8c5bcf4ca7d45))
* **tracking:** close securite-surface-04 (Phase 1 log redaction, 6482528) ([0bac057](https://github.com/swoofer/mcp-coordinator/commit/0bac057bb0d59574d760ade328c21dbceb4510dd))
* **tracking:** close securite-surface-05 + securite-auth-05 + securite-auth-03 (177205b) ([66f0bd6](https://github.com/swoofer/mcp-coordinator/commit/66f0bd6ba9a4b8a7aa54d9d999d549e5a7fa5c7e))
* **tracking:** close securite-surface-07 (security headers, dc4bb3a) ([3f02a29](https://github.com/swoofer/mcp-coordinator/commit/3f02a29e108ac6effe70314d37804b1669fd5926))
* **tracking:** close tests-01 — coverage gate wired + ratcheted green (fa96fca, c47aed6) ([87698a4](https://github.com/swoofer/mcp-coordinator/commit/87698a4b72e4d954c29965c942c60f32ca8d9d15))
* **tracking:** close tests-07 + tests-04 (test reliability, 1d414bb) ([3a46655](https://github.com/swoofer/mcp-coordinator/commit/3a466558e92811597beacd3631ece487c87117f8))


### Code Refactoring

* **arch:** graceful CLI shutdown + fix layer inversion + drop dead config fields ([3099822](https://github.com/swoofer/mcp-coordinator/commit/30998229fe922d4a79f0a920ddefbb00c0ed3071))
* **arch:** graceful CLI shutdown, remove src-&gt;cli layer inversion, drop dead config fields (architecture-04/11/12) ([33ab89b](https://github.com/swoofer/mcp-coordinator/commit/33ab89b4c3b9a895c0ab3edb681663446a9f72b1))
* dedupe safeEqual/decodeJwtPayload and admin helpers (qualite-code-04, qualite-code-05) ([b58688d](https://github.com/swoofer/mcp-coordinator/commit/b58688dbe3ac779febd3b978e78b494b952c3ee7))
* **register:** shared runRegisterFlow for REST/MCP parity incl. MQTT retained status (architecture-07) ([868406e](https://github.com/swoofer/mcp-coordinator/commit/868406ebd4933d7937afb5b74870b07e3dd0cd58))

## [0.13.0](https://github.com/swoofer/mcp-coordinator/compare/v0.12.0...v0.13.0) (2026-05-23)


### Features

* **channels:** Phase 2 reply tool — `post_to_thread` over MQTT ([#130](https://github.com/swoofer/mcp-coordinator/issues/130)) ([#145](https://github.com/swoofer/mcp-coordinator/issues/145)) ([5f9a861](https://github.com/swoofer/mcp-coordinator/commit/5f9a861d395368e5ec8b29f4d1756d6f82185bcc))


### Bug Fixes

* **ci:** docker-publish tag gating works for workflow_call (chained release path) ([#142](https://github.com/swoofer/mcp-coordinator/issues/142)) ([4b8df67](https://github.com/swoofer/mcp-coordinator/commit/4b8df67e928178b978f06bb1ca01c9406b6c7a5b))
* **mcp:** correct list_threads status enum to match ThreadStatus type ([#144](https://github.com/swoofer/mcp-coordinator/issues/144)) ([afb390d](https://github.com/swoofer/mcp-coordinator/commit/afb390d0a60d3d690604ec785208fe4d70e8fd9c))


### Documentation

* add operating-modes guide (polling vs push) + README pointer ([#146](https://github.com/swoofer/mcp-coordinator/issues/146)) ([0f0c90c](https://github.com/swoofer/mcp-coordinator/commit/0f0c90ce4226616113dfdf4675692937ba8f5fdd))
* surface "polling vs push" choice in README + HTML landing ([#147](https://github.com/swoofer/mcp-coordinator/issues/147)) ([071a234](https://github.com/swoofer/mcp-coordinator/commit/071a234d3126bce5c409f1e05885b9591dd0bbc2))

## [0.12.0](https://github.com/swoofer/mcp-coordinator/compare/v0.11.0...v0.12.0) (2026-05-23)


### Features

* **channels:** Phase 1 push-only channel CLI ([#130](https://github.com/swoofer/mcp-coordinator/issues/130)) ([#141](https://github.com/swoofer/mcp-coordinator/issues/141)) ([ffe4c38](https://github.com/swoofer/mcp-coordinator/commit/ffe4c3869441217024c075f788d3bd76fd79553c))


### Bug Fixes

* **stdio:** MCP tool calls work in stdio mode (closes [#133](https://github.com/swoofer/mcp-coordinator/issues/133)) ([#135](https://github.com/swoofer/mcp-coordinator/issues/135)) ([ce54a85](https://github.com/swoofer/mcp-coordinator/commit/ce54a850530282da2cbb1fca1ae1efb98a6d56f2))
* validate list_threads status ([#132](https://github.com/swoofer/mcp-coordinator/issues/132)) ([e7cedad](https://github.com/swoofer/mcp-coordinator/commit/e7cedad3fc59f91b92ff748b8500f2c9f587e9e0))


### Documentation

* bump example pins to mcp-coordinator:0.11.0 ([#123](https://github.com/swoofer/mcp-coordinator/issues/123)) ([a6e3b19](https://github.com/swoofer/mcp-coordinator/commit/a6e3b19b086a2a6fb2cb1aad8fa1bd0510c31b0e))
* **channels:** event catalog for [#130](https://github.com/swoofer/mcp-coordinator/issues/130) Phase 1 scoping ([#138](https://github.com/swoofer/mcp-coordinator/issues/138)) ([418235d](https://github.com/swoofer/mcp-coordinator/commit/418235da06663450931214a4eeaff486d6103a41))
* **channels:** quickstart example + README section for [#130](https://github.com/swoofer/mcp-coordinator/issues/130) ([#137](https://github.com/swoofer/mcp-coordinator/issues/137)) ([a5f03df](https://github.com/swoofer/mcp-coordinator/commit/a5f03dfc25d989092a0c343f1a96c122b978af54))
* **channels:** reference plugin patterns study for [#130](https://github.com/swoofer/mcp-coordinator/issues/130) ([#139](https://github.com/swoofer/mcp-coordinator/issues/139)) ([c369ac3](https://github.com/swoofer/mcp-coordinator/commit/c369ac347d09d94718882e2ba75020f00c326648))
* **html:** bump landing page to v0.11.0, update outdated roadmap cards ([#127](https://github.com/swoofer/mcp-coordinator/issues/127)) ([208ecc2](https://github.com/swoofer/mcp-coordinator/commit/208ecc21fb74340800894f5dce7b8dd8d11b42ff))
* **html:** correct harbor roadmap card — tengu_harbor shipped as Channels ([#131](https://github.com/swoofer/mcp-coordinator/issues/131)) ([4df99fa](https://github.com/swoofer/mcp-coordinator/commit/4df99fab412d22997926e9f808a3290a0a97dae7))
* **html:** translate encrest roadmap card into FR, ES, DE, ZH, JA ([#129](https://github.com/swoofer/mcp-coordinator/issues/129)) ([8028a2c](https://github.com/swoofer/mcp-coordinator/commit/8028a2cf0262b4587d042b714ef82668fa6be0c5))
* **html:** translate v0.11 roadmap card into FR, ES, DE, ZH, JA ([#128](https://github.com/swoofer/mcp-coordinator/issues/128)) ([86495ad](https://github.com/swoofer/mcp-coordinator/commit/86495ad9e00b0736576a20798033cd308729b590))
* **readme:** rework as pitch — extract usage walkthroughs, drop CHANGELOG dupes ([#136](https://github.com/swoofer/mcp-coordinator/issues/136)) ([4b29afd](https://github.com/swoofer/mcp-coordinator/commit/4b29afd1f1a56baebd6891cf42f7b218c6b511fc))
* surface Docker install option in README and landing page ([#126](https://github.com/swoofer/mcp-coordinator/issues/126)) ([1d94c92](https://github.com/swoofer/mcp-coordinator/commit/1d94c92c768d50f30d1e663f26f67a68a566f616))

## [0.11.0](https://github.com/swoofer/mcp-coordinator/compare/v0.10.9...v0.11.0) (2026-05-23)


### Bug Fixes

* **ci:** docker-publish emits correct semver tags on workflow_dispatch ([#121](https://github.com/swoofer/mcp-coordinator/issues/121)) ([c93f8ea](https://github.com/swoofer/mcp-coordinator/commit/c93f8ea4d2e6f92c3f8155fb2153122ea2182406))
* **cli:** wrap loadConfig at doctor + init call sites (closes [#109](https://github.com/swoofer/mcp-coordinator/issues/109)) ([#118](https://github.com/swoofer/mcp-coordinator/issues/118)) ([93d8d07](https://github.com/swoofer/mcp-coordinator/commit/93d8d07c5d2f13adf7355f8f33b11b28842a1a54))


### Documentation

* clarify global install + warn against npm install in empty folder ([#115](https://github.com/swoofer/mcp-coordinator/issues/115)) ([6725cab](https://github.com/swoofer/mcp-coordinator/commit/6725cab215f8f791b2f05daee7dc26593cee6a8f))
* complete pnpm migration in ops + onboarding (followup to [#117](https://github.com/swoofer/mcp-coordinator/issues/117)) ([#120](https://github.com/swoofer/mcp-coordinator/issues/120)) ([f0456fb](https://github.com/swoofer/mcp-coordinator/commit/f0456fbe83aaaa554f344909da256f0425a668b0))
* pin docker-compose example to ghcr.io/.../mcp-coordinator:0.10.9 ([#122](https://github.com/swoofer/mcp-coordinator/issues/122)) ([2af90ab](https://github.com/swoofer/mcp-coordinator/commit/2af90ab4a5473f5e4220bf7045bc88a709d52996))


### Maintenance

* bump to v0.11.0 — aggregate of pnpm + docker + tooling work ([1f1e4c8](https://github.com/swoofer/mcp-coordinator/commit/1f1e4c8e0ce2bf1bd0e5c924639ad95b937298e3))

## [0.10.9](https://github.com/swoofer/mcp-coordinator/compare/v0.10.8...v0.10.9) (2026-05-22)


### Bug Fixes

* **cli:** accept /health {status:'alive'} response shape in server status ([#112](https://github.com/swoofer/mcp-coordinator/issues/112)) ([06d1cb7](https://github.com/swoofer/mcp-coordinator/commit/06d1cb71a413bfcde7441a360c08bea0e1f67c96))

## [0.10.8](https://github.com/swoofer/mcp-coordinator/compare/v0.10.7...v0.10.8) (2026-05-21)


### Bug Fixes

* **activity:** thread real org_id into reportWaiting/heartbeat (closes [#77](https://github.com/swoofer/mcp-coordinator/issues/77)) ([#105](https://github.com/swoofer/mcp-coordinator/issues/105)) ([c2a42f9](https://github.com/swoofer/mcp-coordinator/commit/c2a42f927d48999d4dff5e9221b02e076c9d3f9a))
* **cli:** server status exits 1 when daemon is stopped or unhealthy (closes [#78](https://github.com/swoofer/mcp-coordinator/issues/78)) ([#107](https://github.com/swoofer/mcp-coordinator/issues/107)) ([0cde8c2](https://github.com/swoofer/mcp-coordinator/commit/0cde8c26b364479a0863f47d2f5b6c4f9e7a6dbd))
* **cli:** throw descriptive error on invalid config JSON (closes [#80](https://github.com/swoofer/mcp-coordinator/issues/80)) ([#108](https://github.com/swoofer/mcp-coordinator/issues/108)) ([3dd20bb](https://github.com/swoofer/mcp-coordinator/commit/3dd20bb9b30d0da09744f52858899be234260ff1))
* **db:** add FK to orgs(id) on coordinator tables (closes [#79](https://github.com/swoofer/mcp-coordinator/issues/79)) ([#106](https://github.com/swoofer/mcp-coordinator/issues/106)) ([96e7a80](https://github.com/swoofer/mcp-coordinator/commit/96e7a8033f4800ae23f684c0dd34199f463537ba))
* extend the seed list to include both casings. ([ca9fc38](https://github.com/swoofer/mcp-coordinator/commit/ca9fc3824db3d06b32057ac131724aa6b9395d14))


### Reverts

* remove internal promo notes from public repo ([aa11bb0](https://github.com/swoofer/mcp-coordinator/commit/aa11bb052f6e67e1a3c3ac774788bcaa002208b0))


### Documentation

* add Python MQTT subscriber example ([#74](https://github.com/swoofer/mcp-coordinator/issues/74)) ([c633413](https://github.com/swoofer/mcp-coordinator/commit/c6334132e29854aac372b36034cecf06388e44e3))

## [0.10.7](https://github.com/swoofer/mcp-coordinator/compare/v0.10.6...v0.10.7) (2026-05-19)

Documentation clarification — no code changes. v0.10.6 never reached npm
(publish workflow misfired); v0.10.7 ships the v0.10.6 admin UI feature
PLUS the doc fix described below.

### Documentation

* **README + onboarding-self-host:** clarify the 3 install styles (`npx` /
  global / local-project). Explicit table + note that `npm install
  mcp-coordinator` (without `-g`) does NOT extract files into the current
  directory — they live in `node_modules/mcp-coordinator/`, and the
  binary is at `node_modules/.bin/mcp-coordinator` (invoke via `npx
  mcp-coordinator <cmd>` from the project root). Resolves common
  first-user confusion when the "Getting started" example was misread
  as "install + cd into the package".

### Note

The feature changelog for the included admin UI is under the v0.10.6
entry below; this v0.10.7 entry is purely the doc patch.

## [0.10.6](https://github.com/swoofer/mcp-coordinator/compare/v0.10.5...v0.10.6) (2026-05-19)

Admin web UI for orgs + users. Operators no longer need raw SQL to manage
org allowlists or change user roles — point a browser at
`/dashboard/admin.html` (logged in as `role: "admin"`) and use the UI.
Equivalent REST surface available at `/api/admin/{orgs,users}` for scripts.
All mutations are audit-logged, rate-limited, and protected against the
last-admin-self-lockout footgun.

### Features

* **admin:** 5 REST endpoints under `/api/admin/*`:
    - `GET /api/admin/orgs` — list (5000-row hard cap)
    - `POST /api/admin/orgs` — create with name + `allowlist_github_org` +
      `allowlist_idp_org_id`
    - `PATCH /api/admin/orgs/:id` — update name / allowlists (null clears)
    - `GET /api/admin/users[?org=ID]` — list (excludes agent/service roles)
    - `PATCH /api/admin/users/:id` — change role admin↔member
  All require JWT with `role: "admin"`, CSRF double-submit on mutations,
  per-IP rate limit (30 mutations/min). Tier-1 audit on every mutation.
* **admin/last-admin:** TOCTOU-safe protection via `BEGIN IMMEDIATE` +
  admin-count check. Refuses to demote the only admin; frontend proactively
  disables the demote option via `meta.admin_count` from server-truth.
* **dashboard:** 3 new CSP-compliant static admin pages:
    - `/dashboard/admin.html` — landing with role chip, nav to Orgs/Users
    - `/dashboard/admin-orgs.html` — CRUD form + table, modal-driven
    - `/dashboard/admin-users.html` — filter by org, role dropdown
  Vanilla HTML/CSS/JS, no framework. Shared infra: `admin.css` +
  `admin-common.js` (fetchJSON / renderTable / showToast / readCsrfToken /
  redirectToLogin / formatTimestamp) + `admin-strings.js` (centralized
  STRINGS table + `t(path, vars)` for future i18n). Zero `innerHTML`;
  every cell built via `createElement` + `textContent`.
* **security/static-handler:** admin pages get CSP `script-src 'self'` +
  `X-Frame-Options: DENY` + `Cache-Control: no-store`; `Access-Control-
  Allow-Origin: *` DROPPED for admin paths only. `index.html` and other
  legacy assets retain existing headers.
* **schema:** `orgs.name` UNIQUE INDEX added (`idx_orgs_name`). Pre-flight
  boot guard refuses startup when existing deployments contain duplicate
  org names; override via `COORDINATOR_ALLOW_DUPLICATE_ORG_NAMES=1` (audited).
* **auth/cookies:** `SESSION_COOKIE_NAME` + `CSRF_COOKIE_NAME` constants
  exported from `src/auth/cookies.ts` and consumed by all 5 prior duplicate
  literal sites (auth.ts, logout.ts, oauth-finalize.ts, device-flow.ts).
* **observability:** 5 new Tier-1 audit events (`admin.org.created`,
  `admin.org.updated`, `admin.user.role_changed`,
  `admin.orgs.duplicate_names_accepted`); flat-scalar metadata; HMAC-
  pseudonymized `user_id_hash` (label `mcc-audit-pseudonym-v1`).
  `request_id` auto-injected in every error envelope.

### Documentation

* **ops/admin-ui:** new runbook covering bootstrap, daily usage,
  allowlist semantics, rate-limit behavior, last-admin protection +
  safe self-demote procedure, audit-log queries, disaster recovery
  (SQL fallback for admin role).
* **onboarding-self-host:** Admin UI section with bootstrap behavior +
  endpoint table + cross-link to runbook.
* **security/threat-model:** new Asset 7 (operator surface) with STRIDE
  walk of /api/admin/* + static admin pages.
* **README:** Compliance matrix marks Admin UI Shipped.

### Backward compatibility

Fully additive. Existing v0.10.5 deployments upgrade with no config changes
required. The single boot guard (orgs.name UNIQUE INDEX) only fires on
deployments that have pre-existing duplicate org names — extremely rare;
override env var provided. CSRF / session cookie names unchanged. Existing
service-token admin endpoints untouched.

## [0.10.5](https://github.com/swoofer/mcp-coordinator/compare/v0.10.4...v0.10.5) (2026-05-17)

Column-level encryption at-rest for OAuth IdP tokens. Closes the residual
risk on plaintext `users.idp_access_token` / `users.idp_refresh_token` flagged
in `docs/security/threat-model.md`. Bun runtime preserved (zero native deps;
`node:crypto` only — SQLCipher rejected to keep Bun first-class).

### Features

* **security:** column-level AES-256-GCM envelope encryption with
  length-prefixed binary AAD bound to `(org_id, column, user_id)`. Per-row
  random DEK wrapped with master key. Forward-compat `enc:v\d+:` version
  parser with three typed error classes (`MalformedCiphertext`,
  `DEKUnwrapFailed`, `DataDecryptFailed`) + `UnknownCipherVersion`. Storage
  format pinned via deterministic test vector.
* **security/master-key:** `decodeMasterKey` accepts hex / base64 /
  base64url (unambiguous by length+alphabet), refuses entropy < 3.0
  bits/byte (catches passphrases / constants), warns 3.0-4.5. HMAC-SHA256
  fingerprint with label `mcc-fingerprint-v1`, 16 hex chars.
* **boot:** strict-mode guards prevent silent data loss:
    - encrypted rows + no key → refuse boot (override via
      `COORDINATOR_ALLOW_TOKEN_LOSS=1` + `COORDINATOR_TOKEN_LOSS_CONFIRM=
      I_UNDERSTAND_THIS_NULLS_<N>_ROWS`; stashes ciphertexts to
      `encryption_invalidated_tokens` for forensic recovery; per-user
      audit)
    - fingerprint mismatch → refuse boot (override via
      `COORDINATOR_ALLOW_KEY_ROTATION=1`)
    - key fingerprint persisted to `system_config` on first encrypt via
      wrapped provider; verified at boot
  GLOB-based prefix matching (`enc:v[0-9]*:*`) — never the LIKE
  underscore-wildcard trap.
* **auth:** `oauth-finalize.ts` + `refresh-rotation.ts` encrypt/decrypt
  on read+write paths via `encryptNullable` / `decryptNullable` helpers
  (NULL and empty-string → SQL NULL). Decrypt failures map to existing
  `IdPTokenRevoked` path: `bumpTokenEpoch` + 401 via `bearerAuthHeader`.
  `provisionUser` refactored to options-object signature for clean
  encryption threading.
* **cli:** `mcp-coordinator encryption migrate [--direction encrypt|decrypt]
  [--batch-size N] [--force]` — CAS-protected batched migration with
  cross-platform PID-in-content file lock + stale-PID recovery + SIGINT
  cleanup. `mcp-coordinator encryption verify [--samples N]` — fingerprint
  check + sampled decrypt with per-class counts. `mcp-coordinator
  encryption fingerprint` — 16-hex fingerprint output (no DB access).
* **cli/server/start:** `--daemon` now forwards
  `COORDINATOR_ENCRYPTION_KEY`, `COORDINATOR_ALLOW_TOKEN_LOSS`,
  `COORDINATOR_TOKEN_LOSS_CONFIRM`, `COORDINATOR_ALLOW_KEY_ROTATION` to
  the spawned child (without this, daemon would silently run plaintext).
* **observability:** new prom metrics `coordinator_idp_encryption_enabled`
  (gauge), `coordinator_idp_decrypt_failures_total` (counter, labeled by
  `error_class`), `coordinator_idp_plaintext_rows` (gauge). Five new audit
  events with HMAC-pseudonymized `user_id_hash` (label
  `mcc-audit-pseudonym-v1`). `/health/ready` payload extends with
  `encryption: {enabled, key_source, key_fingerprint, decrypt_failures_total}`
  block. `*.idp_refresh_token` added to logger `REDACT_PATHS`.
* **schema:** `system_config (key TEXT PRIMARY KEY, value TEXT NOT NULL,
  updated_at TEXT)` table added — generic key/value store. Stores
  `encryption.key_fingerprint`.
* **boot:** `bootPhase2(opts, deps?)` accepts optional `db`/`env`/`logger`
  injection for testability of fail-loud boot guards without child-process
  spawning.

### Documentation

* **ops/encryption-key-management:** new runbook covering key generation,
  storage (env vs Docker secret + `docker inspect` exposure), backup-the-key
  (fingerprint alongside DB backup), migration runbook, verification,
  rotation (with explicit plaintext-on-disk-during-decrypt-all warning),
  disaster recovery via `ALLOW_TOKEN_LOSS`, recovery from
  `encryption_invalidated_tokens` stash table.
* **onboarding-self-host:** Encryption section under §3 Configure
  environment + post-restore gotcha + backup-the-key note.
* **security/threat-model:** closes residual risk on plaintext IdP
  credentials.
* **README:** Compliance matrix marks IdP token encryption Shipped.
* **.env.example** + **examples/docker-compose/.env.example:**
  `COORDINATOR_ENCRYPTION_KEY=` entry with `openssl rand -base64 32` hint
  and `docker inspect` exposure note.

### Backward compatibility

Existing v0.10.4 deployments without `COORDINATOR_ENCRYPTION_KEY` continue
to run unchanged (PassthroughEncryption fallback). Boot logs at ERROR level
in `NODE_ENV=production` (WARN otherwise) and reminds every 24h. Operators
opt in by generating a key (`openssl rand -base64 32`) and setting the env
var. Lazy migration encrypts existing rows on read/write; `encryption migrate`
forces full migration.

## [0.10.4](https://github.com/swoofer/mcp-coordinator/compare/v0.10.3...v0.10.4) (2026-05-16)

OIDC group-claim allowlist release. `OIDCProvider` learns to read
group / role memberships from a configurable id_token claim path and
feed them into the allowlist match. Existing OIDC deployments stay
deny-by-default; the new behaviour is opt-in via the new
`COORDINATOR_OIDC_GROUPS_CLAIM` env var. GitHub OAuth App / GitHub
App / Google flows behaviour-unchanged.

### Features

* **auth/providers/oidc:** `OIDCProviderConfig` gains a
  `groupsClaim?: string` field (dot-notation path into the
  id_token). When set, `allowlistStrategy` switches from `"none"`
  to `"id_token_groups"`, `exchangeCode` extracts the array at
  that path, and `IdpUserInfo.groups` is populated. Common values:
    - `groups` -- Okta, Auth0, Authentik
    - `realm_access.roles` -- Keycloak
    - `roles` -- Azure AD App Roles
  Missing path / non-array value / non-string entries fail closed
  (user.groups undefined or filtered). (T58)
* **auth/providers/types:** `AllowlistStrategy` gains
  `"id_token_groups"`. `IdpUserInfo` gains optional `groups`.
* **auth/oauth-callback + oauth-token:** new strategy branch
  matches `user.groups` (lowercased) against
  `orgs.allowlist_github_org` via the existing
  `resolveOrgFromMemberships`.
* **boot:** new `COORDINATOR_OIDC_GROUPS_CLAIM` env var threads
  into `OIDCProvider` config when the OIDC provider is
  registered. No env var = original deny-by-default behaviour.

### Documentation

* **docs/idp-providers.md:** new "Allowlist via id_token groups
  claim" subsection with the per-IdP path table, example SQL,
  and the sign-in-only refresh caveat. The previous "listMemberships
  throws" gotcha is rewritten to point at the new strategy.
* **.env.example:** `COORDINATOR_OIDC_GROUPS_CLAIM` block with the
  common-IdP table.

### Test posture

* **+16 tests** vs v0.10.3 (1740 total):
  - 6 new OIDCProvider integration cases (allowlistStrategy
    switch, top-level groups, nested `realm_access.roles`,
    missing claim, non-string entries filtered, non-array value
    handled)
  - 9 new `extractGroupsFromClaims` pure-unit cases (top-level /
    nested / deeply nested / missing / traversal-through-non-object
    / non-object payload / non-array terminal / non-string entries
    filtered / empty array)
  - 1 `allowlistStrategy` defaulting case

### Operator notes

Drop-in upgrade. Existing OIDC deployments need no env-var change to
stay deny-by-default. To enable group-claim allowlist:

1. Set `COORDINATOR_OIDC_GROUPS_CLAIM` to the path that holds the
   groups in your IdP's id_token.
2. Provision `orgs` rows with `allowlist_github_org` set to the
   group names you want to allow (the column is historical;
   semantically it's just a string match).
3. Restart the coordinator.

### Caveats (also in the docs)

- Groups captured at sign-in only; refresh-rotation does not
  re-fetch from the IdP. A user removed from a group keeps their
  session until next full sign-in (`token_epoch` is the operator
  kill switch in the meantime).
- Group match is case-insensitive.
- Misconfiguration (wrong path / non-array value) fails closed.

## [0.10.3](https://github.com/swoofer/mcp-coordinator/compare/v0.10.2...v0.10.3) (2026-05-16)

GitHub App installation-footprint allowlist release. Adds an opt-in
mode to `GitHubAppProvider` where the org allowlist is driven by the
App's installation footprint rather than the user's own GitHub-org
memberships. Default behaviour (`allowlistSource="user_orgs"`) is
unchanged; existing deployments are behaviour-compatible.

### Features

* **auth/providers/github-app:** `GitHubAppProviderConfig` gains an
  `allowlistSource: "user_orgs" | "user_installations"` field. When
  `"user_installations"`, `listMemberships` calls
  `GET /user/installations` with the user's user-to-server token
  and returns the `installation.account.login` values. Each becomes
  a candidate match against `orgs.allowlist_github_org`. The
  semantics are "is the App installed in an org/account the user
  has access to?" -- uninstalling the App from an org immediately
  stops surfacing it in `/user/installations` responses, so the
  allowlist match fails on the next refresh-rotation (within 8h
  max). A hard revoke without any coordinator config change. (T57)
* **auth/providers/github-shared:** new
  `listGitHubAppInstallations(apiBaseUrl, accessToken)` helper + the
  zod schemas (`GitHubInstallationSchema`,
  `GitHubInstallationsResponseSchema`). Pagination via RFC 5988
  Link headers, same SSRF-guard as `listGitHubOrgs`.
* **boot:** new `COORDINATOR_GITHUB_APP_ALLOWLIST_SOURCE` env var
  (`user_orgs` default, `user_installations` opt-in). Invalid
  value -> `BootValidationError`.

### Why this matters

- "Install the App" becomes the operator's vetting gesture; the
  coordinator's allowlist tracks the App-install lifecycle
  automatically.
- **No App RSA private key needed** -- `/user/installations` is
  scoped to the user's own user-to-server token (Design B from the
  2026-05-16-github-app-design spec, simpler variant). The
  full installation-token-with-private-key path remains future
  work for the App-as-itself scenario.
- Personal-account installs work: `installation.account.type` can
  be `"User"`, which lets operators allowlist individual user
  accounts where the App is installed.

### Documentation

* **docs/idp-providers.md:** new "Allowlist source: orgs vs
  installations" subsection with the pick-which guidance.
* **.env.example:** `COORDINATOR_GITHUB_APP_ALLOWLIST_SOURCE`
  block.

### Test posture

* **+10 tests** vs v0.10.2 (1724 total):
  - 6 new GitHubAppProvider cases (`user_installations` happy /
    empty / User-type install / 401 / 503 / backward-compat default
    still hits `/user/orgs`)
  - 4 new boot wiring cases (`user_installations` accepted /
    explicit `user_orgs` / invalid value -> `BootValidationError` /
    env var moot when App not registered)

### Operator notes

Drop-in upgrade. To enable installation-footprint allowlist on an
existing deployment with the App provider registered, set
`COORDINATOR_GITHUB_APP_ALLOWLIST_SOURCE=user_installations` and
restart the coordinator. The next sign-in will drive off the
installation footprint instead of `/user/orgs`. Existing users keep
their `users.idp_provider` association and will see allowlist
verdicts based on the new source on their next refresh-rotation.

## [0.10.2](https://github.com/swoofer/mcp-coordinator/compare/v0.10.1...v0.10.2) (2026-05-16)

Google Workspace allowlist release. Introduces a per-provider allowlist
strategy + a new `orgs.allowlist_idp_org_id` column so Google
Workspace deployments can drive sign-in off the Workspace
hosted-domain (`hd`) claim without overloading `allowlist_github_org`.
GitHub OAuth App + GitHub App deployments are behaviour-unchanged.

### Features

* **auth/providers:** new `IdPProvider.allowlistStrategy` field
  declaring how the callback resolves the user's org match:
  - `"memberships"` -- call `listMemberships`, match against
    `orgs.allowlist_github_org` (GitHub OAuth App + GitHub App;
    default when omitted)
  - `"idp_org_id"` -- match `IdpUserInfo.idp_org_id` directly
    against `orgs.allowlist_idp_org_id` (GoogleProvider; the `hd`
    claim is the canonical case)
  - `"none"` -- deny by default; deployments wanting to use the
    provider for allowlist must vendor a subclass (generic
    `OIDCProvider`'s default since OIDC has no portable model)
* **auth/allowlist:** new `resolveOrgFromIdpOrgId(db, value)`
  helper does case-insensitive lookup against the new column. (T56)
* **db:** `ALTER TABLE orgs ADD COLUMN allowlist_idp_org_id TEXT`
  idempotent migration + `idx_orgs_allowlist_idp` index. Nullable;
  rows tagged for the `"memberships"` strategy keep this column NULL
  forever.
* **auth/oauth-callback + oauth-token:** dispatch on
  `provider.allowlistStrategy` instead of unconditionally calling
  `listMemberships`. `GoogleProvider` no longer crashes the sign-in
  flow when configured -- the previous behaviour relied on the
  `listMemberships` throw, which prevented Google sign-in entirely.
* **auth/refresh-rotation:** skips the IdP-side allowlist recheck
  for non-`"memberships"` providers. At-sign-in match is
  authoritative; `token_epoch` is the manual kill switch.

### Documentation

* **docs/idp-providers.md:** Google section gains the hd-allowlist
  setup walkthrough (with example `INSERT INTO orgs`) plus the
  explicit no-refresh-recheck caveat.

### Test posture

* **+6 tests** vs v0.10.1 (1714 total): `resolveOrgFromIdpOrgId`
  unit cases (match / case-insensitive / miss / empty table /
  stored-casing preserved / orthogonality with
  `allowlist_github_org`). `orgs-migration.test.ts` expected
  column list updated.

### Operator notes

The schema migration is idempotent so the upgrade is drop-in.
Existing GitHub OAuth App / GitHub App / OIDC deployments need no
configuration change. To enable Google Workspace sign-in for the
first time, provision an `orgs` row with `allowlist_idp_org_id` set
to the Workspace hosted-domain (e.g. `acme.com`).

## [0.10.1](https://github.com/swoofer/mcp-coordinator/compare/v0.10.0...v0.10.1) (2026-05-16)

OIDC defense-in-depth release. Implements OpenID Connect Core 1.0
§3.1.2.1 nonce verification: the relying party (this coordinator)
generates a random nonce per authorize request, includes it in the
URL, and verifies the returned `id_token`'s `nonce` claim against it
at exchange time. Guards against id_token replay across authorize
requests issued for the same client. GitHub OAuth App / Google /
GitHub App flows are behaviour-unchanged.

### Features

* **auth/providers/oidc:** OIDC `nonce` is now generated, persisted,
  and verified. `buildAuthUrl` emits the `nonce` query param when
  supplied; `exchangeCode` verifies `id_token.nonce` against the
  passed value. Mismatch (including an id_token with no nonce
  claim at all) is mapped to `IdPTokenRevoked`. The CLI auth-code
  grant path passes no nonce; OIDC providers skip the check there
  (PKCE + state binding still apply). (T55)
* **auth/oauth-state:** `createOAuthStateWithVerifier` accepts an
  optional `nonce` parameter; `consumeOAuthState` surfaces it in
  `ConsumedOAuthState`. Non-OIDC flows leave the column `NULL`.
* **db:** `ALTER TABLE oauth_state ADD COLUMN nonce TEXT` idempotent
  migration; nullable so non-OIDC rows stay clean.
* **auth/oauth-login:** generates a 256-bit base64url nonce per
  request, persists it via `createOAuthStateWithVerifier`, threads
  it to `provider.buildAuthUrl`.
* **auth/oauth-callback:** reads `row.nonce` and threads it to
  `provider.exchangeCode`.

### Interface widening

`IdPProvider.buildAuthUrl(state, redirectUri, codeChallenge?, nonce?)`
+ `IdPProvider.exchangeCode(code, redirectUri, codeVerifier?, nonce?)`.
Existing providers (GitHub OAuth App, GitHub App, Google) ignore the
new parameter; only `OIDCProvider` uses it. Source-compatible for
custom providers vendored by operators.

### Test posture

* **+8 tests** vs v0.10.0 (1708 total): 2 new oauth-state cases
  (T55 nonce persistence + NULL when omitted), 5 new oidc-provider
  cases (buildAuthUrl emits/omits nonce, happy path id_token match,
  mismatch -> `IdPTokenRevoked`, missing-nonce-claim ->
  `IdPTokenRevoked`, null-nonce skips check). Updated
  `oauth_state` schema in 5 test files + `migration-v07-to-v08`
  expected column list.

### What this changes for operators

Nothing in the existing deployment requires action. The migration
is idempotent and the nonce field is nullable, so rolling onto
v0.10.1 from v0.10.0 is a drop-in upgrade. OIDC deployments
benefit automatically -- the first `/auth/login` after the
restart starts emitting nonce-bearing authorize URLs and
verifying them.

## [0.10.0](https://github.com/swoofer/mcp-coordinator/compare/v0.9.2...v0.10.0) (2026-05-16)

GitHub App release. Adds a `GitHubAppProvider` sibling to the existing
OAuth App provider, with built-in user-to-server token refresh
handling. Existing OAuth App and Google / OIDC deployments are
behaviour-compatible -- the new provider is opt-in via env vars.

### Features

* **auth/providers/github-app:** new `GitHubAppProvider` implementing
  the user-to-server OAuth flow for GitHub Apps. Differences from
  `GitHubProvider` (OAuth App):
  - `buildAuthUrl` omits the `scope` param (GitHub Apps declare
    permissions at registration time)
  - `exchangeCode` surfaces optional `accessTokenExpiresIn`,
    `refreshToken`, `refreshTokenExpiresIn` from the IdP response
    (App user-to-server tokens are 8h + auto-rotating refresh)
  - `refreshIdpToken(refreshToken)` -- new optional `IdPProvider`
    method that exchanges a refresh token for a fresh
    access+refresh pair via `grant_type=refresh_token`. Maps
    GitHub's "200-with-error-body" failure mode to
    `IdPTokenRevoked`.
  - No device flow (GitHub Apps don't support RFC 8628)
  - Registry name defaults to `"github-app"` but is overridable via
    `COORDINATOR_GITHUB_APP_NAME`. (T53)
* **auth/refresh-rotation:** IdP refresh-token recovery. On
  `IdPTokenRevoked` from `/user/orgs` AND the provider implements
  `refreshIdpToken` AND the user has a stored refresh token, the
  handler exchanges the refresh token for a fresh access+refresh
  pair, persists both to `users.idp_access_token` /
  `users.idp_refresh_token`, emits a Tier 2
  `auth.idp.token_refreshed` audit, and retries the membership
  check before declaring the row evicted. Failures fall through to
  the existing Tier 1 `auth.idp.token_revoked` path. (T54)
* **db:** `ALTER TABLE users ADD COLUMN idp_refresh_token TEXT`
  idempotent migration. Nullable; OAuth App / Google / OIDC users
  keep `NULL` forever; only GitHub App provisioned users populate
  it. Same plaintext + never-in-logs posture as
  `idp_access_token`.
* **boot:** `COORDINATOR_GITHUB_APP_CLIENT_ID` +
  `COORDINATOR_GITHUB_APP_CLIENT_SECRET` env vars register the new
  provider when both are set (partial config fails closed at
  boot, matching the Google/OIDC pattern). Shares GHES base URLs
  with `GitHubProvider`. Optional
  `COORDINATOR_GITHUB_APP_NAME` overrides the registry key.

### Documentation

* **docs/superpowers/specs/2026-05-16-github-app-design.md:**
  design spec covering motivation, scope, identity model, OAuth
  flow specifics, refresh-token lifecycle, allowlist semantics,
  threat model, env vars, coexistence with OAuth App, and open
  questions (encryption-at-rest for `idp_refresh_token`,
  installation-list-based allowlist as v0.10.x exploration).
* **docs/idp-providers.md:** new "Configuring GitHub App" section
  with setup walkthrough, differences-vs-OAuth-App matrix,
  refresh-token recovery model, coexistence + migration story,
  gotchas (IdP refresh-token replay detection NOT implemented in
  v0.10.0; App must be installed in user's org; no App-as-itself
  installation flow in v0.10.0).
* **.env.example:** `COORDINATOR_GITHUB_APP_*` env-var block.

### Test posture

* **+45 tests** vs v0.9.2 (1700 total):
  - 19 GitHubAppProvider unit tests (buildAuthUrl no-scope / S256 /
    GHES; exchangeCode happy + missing-refresh / 401 / 503 /
    error-label; listMemberships; refreshIdpToken happy + wire
    format / 401 / 503 / 200-with-error / 200-missing-access_token;
    device-flow absence)
  - 7 boot wiring tests (unset / both-set / partial / custom NAME /
    GHES / 4-provider coexistence)
  - 5 refresh-rotation recovery tests (refresh-ok + rotation
    continues, provider returns access-only, refresh-fails -> 401,
    no-refresh-token-stored -> 401, no-refreshIdpToken-method ->
    401)
  - 14 shared HTTP transport tests (already covered indirectly by
    the existing GitHubProvider suite; `github-shared.ts`
    refactored without behaviour change so 35 OAuth App tests
    still pass)

### Out of scope for v0.10.0

- **App-as-itself installation tokens for membership queries.** The
  v1 implementation uses the user-to-server token to call
  `/user/orgs`, functionally identical to OAuth App. v0.10.x will
  evaluate App-JWT-signed installation token flow that builds the
  allowlist from the App's installation footprint rather than user
  org memberships.
- **Device flow.** GitHub Apps do not support RFC 8628.
- **Webhook-driven membership cache invalidation.** v1.0 work.
- **IdP refresh-token replay detection.** The coordinator's
  reuse-detection logic covers ITS OWN refresh family only;
  GitHub-side refresh-token replay is detected by GitHub at its
  discretion.

## [0.9.2](https://github.com/swoofer/mcp-coordinator/compare/v0.9.1...v0.9.2) (2026-05-15)

Operations release. New `mcp-coordinator rotate-jwt-secret` CLI
helper + auto-rotation runbook close the manual gap noted in v0.8.1's
key-rotation procedure. No code paths in the hot request path changed;
existing deployments continue running unchanged.

### Features

* **cli:** `mcp-coordinator rotate-jwt-secret` generates a fresh
  base64 secret with crypto.randomBytes (default 256 bits, 128
  minimum), validates entropy against the boot-time floor, and prints
  the operator rotation workflow. Three output formats: `env`
  (default, copy-pasteable block + workflow comments), `json`
  (machine-readable for cron pipelines), `secret-only` (raw secret
  only). Stateless -- never reads the current secret, never writes to
  any secrets manager, never restarts a coordinator instance. (T52)

### Documentation

* **docs/ops/auto-rotation.md:** new operator runbook covering
  systemd-timer + Vault automation and Kubernetes CronJob automation
  around the `rotate-jwt-secret` helper. Explicit out-of-scope notes
  for service-token rotation (admin-driven by design) and IdP client
  secrets (rotate through the IdP's own admin UI).

### Test posture

* **+14 tests** vs v0.9.1 (1669 total): plan determinism with
  injected clock + RNG, base64 length invariants, entropy floor
  rejection at boundary, broken-RNG rejection, CLI exit codes for
  invalid args, all three output formats parseable.

## [0.9.1](https://github.com/swoofer/mcp-coordinator/compare/v0.9.0...v0.9.1) (2026-05-15)

Audit log tamper-evidence release. Adds a SHA-256 hash chain over every
`audit_log` row and an operator script to verify it. SOC 2 Type II
deployments now have built-in in-place-tamper detection, with a
documented external tip-attestation workflow for full deletion +
timestamp coverage. Single-instance, single-IdP behaviour is
unchanged.

### Features

* **audit:** SHA-256 hash chain on every `audit_log` row -- new
  `prev_hash` + `row_hash` columns; `row_hash = SHA-256(prev_hash ||
  canonicalRowFields(row))`. Tier 1 sync, Tier 2 batched, and the
  shutdown `audit_loss` row all chain inside the same SQLite
  transaction as the tip lookup. Canonical serialization is JSON with
  alphabetical keys + explicit nulls -- ambiguity between "absent"
  and "explicitly null" is impossible. `GENESIS_HASH` (`"0".repeat(64)`)
  seeds the chain on an empty table. Migration backfills pre-existing
  rows in id-order; idempotent + crash-safe. (T50)
* **scripts/verify-audit-chain.ts:** operator CLI that walks the chain
  and reports `wrong_row_hash` / `wrong_prev_hash` / `missing_hash` /
  `id_gap_before` findings. Robust to front-deletion (legitimate
  sweeper retention); accepts the first observed row's `prev_hash` as
  the entry point. JSON output for monitoring; exit 0 OK, 1 findings,
  2 operational error. (T51)

### Documentation

* **docs/ops/audit-integrity.md:** new SOC 2 Type II runbook -- what
  the chain proves (in-place tamper detection + middle-row insertion
  detection), what it doesn't (timestamp integrity, deletion
  detection without external tip-attestation), how to run the
  verifier, the tip-attestation workflow, monitoring integration,
  incident recovery.
* **docs/security/threat-model.md:** new residual risk #10 records
  the tamper-evidence feature with explicit `created_at` + deletion
  gaps. Review cadence updated to v0.10.

### Limitations (intentional, documented)

* `created_at` is set by SQLite default and is NOT in the hash --
  timestamp rewrites are not detected by the chain alone.
* Deletion of recent rows is indistinguishable from legitimate
  sweeper retention without the external tip-attestation workflow.
* The backfill assumes pre-migration rows are pristine; this is
  forward evidence only.

### Test posture

* **+32 tests** vs v0.9.0 (1655 total): 12 chain-pure unit tests
  (canonical serialization determinism, hash chain construction,
  per-field tamper detection), 10 end-to-end integration tests (Tier
  1, Tier 2 batched, interleaved 1/2, backfill idempotence +
  crash-recovery, in-place tamper), 10 verifier-script tests (valid
  chain, content tamper, prev_hash forgery, missing hash, front vs
  middle deletion, bad args, missing DB, human + JSON output).

## [0.9.0](https://github.com/swoofer/mcp-coordinator/compare/v0.8.1...v0.9.0) (2026-05-15)

Multi-IdP release. The single-provider GitHub-only login surface that shipped
in Phase 2 opens up to GitHub + Google + generic OIDC, selected via a picker
UI when more than one provider is registered. Phase 2 deployments that stay
on GitHub-only see no behavioural change.

### Features

* **auth/providers/registry:** `ProviderRegistry` class -- per-server registry
  instance attached to `AuthHandlerContext.providers`. First registration
  becomes the implicit default; `setDefault()`, `has()`, `list()`, `names()`,
  `size()`, and `clear()` complete the API. Replaces the Phase 1 module-level
  `Map` skeleton. (T45)
* **auth/handlers:** every OAuth handler resolves the IdP through the registry
  (`oauth-login`: `getDefault()`; `oauth-callback`: `get(row.provider)`;
  `oauth-token`: `get(body.provider ?? default)`; `refresh-rotation`:
  `get(users.idp_provider)`). The legacy `ctx.githubProvider` alias is removed.
  Mix-up defense audit `auth.state.mixup` now records `registered_providers`
  instead of a hardcoded `expected_provider`. (T46)
* **auth/providers/google:** first-class `GoogleProvider`. id_token signature
  is mandatory: jose `createRemoteJWKSet` + RS256 + `iss=https://accounts.google.com`
  + `aud=client_id`. Identity claims read from the verified id_token (no
  extra `/userinfo` round-trip). Workspace `hd` claim surfaces as
  `idp_org_id`. Opt-in via `COORDINATOR_GOOGLE_CLIENT_ID` +
  `COORDINATOR_GOOGLE_CLIENT_SECRET` (both required or neither). (T47)
* **auth/providers/oidc:** generic `OIDCProvider` for Okta / Auth0 /
  Azure AD / Keycloak / Authentik. Auto-discovers `authorization_endpoint`,
  `token_endpoint`, and `jwks_uri` from
  `<issuer>/.well-known/openid-configuration`. id_token verified with the
  configured issuer, client_id audience, RS256. Discovery doc's own
  `issuer` field is cross-checked against config (catches redirect attacks
  on the discovery URL). Email-claim fallback chain: `email` →
  `preferred_username` → `sub`. Opt-in via `COORDINATOR_OIDC_ISSUER_URL` +
  `COORDINATOR_OIDC_CLIENT_ID` + `COORDINATOR_OIDC_CLIENT_SECRET`. (T48)
* **auth/login:** picker UI on GET `/auth/login` when `providers.size() > 1`.
  Each button is a top-level GET to `/auth/login?provider=<name>`; the
  flow itself is unchanged. Friendly built-in labels for `github` / `google`
  / `oidc`; title-cased fallback for custom provider names. Unknown
  `?provider=X` returns 400 `UNKNOWN_PROVIDER` -- no silent fallback. (T49)

### Bug Fixes

* **auth/refresh-rotation:** the IdP-membership recheck now uses the user's
  stored `idp_provider` column rather than assuming GitHub, so multi-provider
  users get their allowlist re-evaluated against the IdP they actually signed
  in with.

### Configuration

* **env:** `.env.example` updated -- the previously "Phase 4 preview" section
  for Google + OIDC is now live with usage notes.

### Test posture

* **+61 tests** vs v0.8.1 (1623 total): 10 ProviderRegistry, 16 GoogleProvider
  (id_token verification, JWKS rotation, cross-tenant rejection, transport
  failures), 21 OIDCProvider (discovery validation, issuer mismatch, expired
  tokens), 8 login-picker (rendering + escaping), 6 picker integration
  (oauth-login behavior with 1 vs N providers), boot wiring for both new
  IdPs.

### BREAKING CHANGES

* **AuthHandlerContext.githubProvider** removed -- handlers resolve the IdP
  via `ctx.providers` now. Downstream consumers that embed the coordinator
  and constructed contexts by hand must update; the test helper
  `singleProviderRegistry(provider)` in `tests/helpers/` shows the pattern.
* **IdPProvider.buildAuthUrl** return type widened from `string` to
  `string | Promise<string>`. Built-in providers stay synchronous; only
  `OIDCProvider` is async (lazy discovery on first call). Handlers
  `await` the result. Custom provider implementations stay source-compatible.
* **provisionUser** signature gained a required `providerName: string`
  parameter as the 6th argument. Internal helper; only relevant if you
  call it from custom code.
* **auth.state.mixup audit:** `{ observed_provider, expected_provider: "github" }`
  → `{ observed_provider, registered_providers: string[] }`. Log-pipeline
  consumers that parsed `expected_provider` need to update.

## [0.8.1](https://github.com/swoofer/mcp-coordinator/compare/v0.8.0...v0.8.1) (2026-05-15)

Patches + extended test coverage + SDK enhancements + documentation. No new public API beyond v0.8.0; closes gaps that were honestly flagged in v0.8.0's docs.

### Features

* **auth:** JWT key rotation overlap via `COORDINATOR_JWT_SECRET_PREV` + `COORDINATOR_JWT_SECRET_PREV_ROTATED_AT`. New kid `"hs256-v0"` verifies old tokens during the overlap window; `"hs256-v1"` signs new tokens. Tier 1 audit `config.key_rotation` emitted at boot when prev is configured. Closes the caveat in `docs/ops/key-rotation.md`.
* **auth/providers/github:** GHES env vars `COORDINATOR_GITHUB_AUTH_BASE_URL` + `COORDINATOR_GITHUB_API_BASE_URL` now flow through `bootPhase2` to `GitHubProvider`. Both optional; unset = github.com defaults. Closes the caveat in `examples/ghes-config/README.md`.
* **sdk:** `FileTokenStore` persists tokens to `~/.mcp-coordinator/tokens.json` with `chmod 0600` (POSIX) + atomic write-rename. `MemoryTokenStore` for ephemeral use cases.
* **sdk:** `ProactiveRefresh` schedules refresh at `accessExpiresAt - 120s ± 30s jitter`, preventing thundering-herd when many CLI instances share a vendored tokens.json.
* **sdk:** Single-flight refresh lock via atomic O_EXCL file lock + stale-lock recovery (30s mtime threshold) for multi-process CLI safety.
* **sdk:** `McpCoordinatorClient` accepts optional `store` + `refreshStrategy` + `refreshLockPath`. `dispose()` cancels the timer on app shutdown.

### Tests

* **tests/e2e/:** Playwright E2E suite covering full browser OAuth + device flow + refresh-on-401 (5 scenarios, ~12s, zero flakes over 5 runs). Uses v0.8.1-P2's GHES env wiring to point GitHubProvider at a local mock-github HTTP server (no fetch monkey-patching).
* **tests/integration/d1-d10-matrix.test.ts:** 10 cross-cutting scenarios (20 cases) exercising component-interaction seams where Phase 2 bugs are most likely. Covers V3 §B-NEW-2 chain revocation, V4 FIX 7 grace-branch allowlist re-check, V4 FIX 18 device-poll CAS, V4 FIX 23 commit-then-audit, V4 FIX 24 idle-first ordering.
* **tests/perf/:** 3 benches + 2 chaos scripts (refresh rotation: p50 0.8ms / p99 15ms / 841 ops/s ; token-epoch: p50 8µs / 98k ops/s ; audit queue: 0 drops at 20K burst, exact 5000-drop accounting at 15K overflow ; IdP 50% failure: stale-on-error keeps 0 hard failures). NOT wired into CI — operator-only tooling. See `docs/ops/perf-bench.md`.

### Documentation

* **README.md:** "What's New in v0.8.0 (Phase 2 OAuth)" section + Phase 2 quick-start under Authentication + SDK subsection + Roadmap rewrite + top-nav anchors. README went from 962 → 1132 lines (+192 / -11 net).
* **docs/ops/key-rotation.md:** "planned v0.8.x patch" caveat removed; procedure documented end-to-end with the now-working `_PREV` env var.
* **docs/security/threat-model.md:** residual risk #6 marked "addressed in v0.8.1".
* **examples/ghes-config/README.md:** caveat removed; example ships as-is for GHES deployments.
* **docs/onboarding-self-host.md:** new GHES subsection pointing to `examples/ghes-config/`.
* **docs/ops/perf-bench.md:** new operator runbook for perf + chaos scripts.
* **.env.example:** 4 new optional env vars documented (2 for key rotation, 2 for GHES).

### Configuration

New optional environment variables:

* `COORDINATOR_JWT_SECRET_PREV` — previous JWT secret during rotation overlap; verify-only.
* `COORDINATOR_JWT_SECRET_PREV_ROTATED_AT` — optional ISO timestamp for `config.key_rotation` audit correlation.
* `COORDINATOR_GITHUB_AUTH_BASE_URL` — GHES authorize/token endpoint (e.g., `https://github.example.com`). Unset = `https://github.com`.
* `COORDINATOR_GITHUB_API_BASE_URL` — GHES API endpoint (e.g., `https://github.example.com/api/v3`). Unset = `https://api.github.com`.

### Test posture

1555 individual tests passing across 116 vitest files + 5 Playwright E2E scenarios + 46 SDK tests + 5 standalone perf/chaos scripts. 100% branch coverage enforced on every security-critical module. 6 pre-existing Windows EBUSY teardown flakes ignored per project convention.

## [0.8.0](https://github.com/swoofer/mcp-coordinator/compare/v0.7.0...v0.8.0) (2026-05-14)

Phase 2 of the auth roadmap: OAuth 2.1 + RFC 8628 device flow + cookie sessions + service tokens + audit pipeline + sweeper. Feature-flagged behind `COORDINATOR_OAUTH_ENABLED=true` (default false). Phase 1 deployments are byte-identical when the flag is unset.

37 of 52 plan tasks shipped (Phase A foundation + B helpers + C endpoints + D integration). Phase E (extended test suites + SDK + docs) deferred. Spec, decisions, and plan docs live under `docs/superpowers/specs/` and `docs/superpowers/plans/` for traceability; every commit message cites the spec § or FIX number it implements.

### ⚠ BREAKING CHANGES

* **auth/providers:** `IdPProvider.exchangeCode` return type changed from `Promise<IdpUserInfo>` to `Promise<ExchangeCodeResult>` (`{ user, accessToken }`). External provider implementations need updating. Phase 1 shipped with an empty registry, so no in-tree consumers break. (V4 FIX 25)
* **db:** `audit_log` columns renamed: `user_id → actor_user_id`, `org_id → actor_org_id`, `ip → actor_ip`, `user_agent → actor_user_agent`, `metadata → metadata_json`. Phase 1 `auditLog()` helper continues to work via in-helper translation; direct SQL consumers need updating. (V4 FIX 1)
* **db:** `users.org_id` renamed to `users.primary_org_id`. The `users_legacy_v0_7` compat view exposes the old name as `org_id` for read-only consumers; `lint-no-users-org-id.sh` enforces the migration in app code.

### Features

#### OAuth 2.1 + Device Flow (RFC 6749 + RFC 8628)

* **auth/oauth:** `GET /auth/login` — initiates OAuth flow with PKCE S256 + HMAC-bound state cookie per V4 FIX 19 ([T15](https://github.com/swoofer/mcp-coordinator/commit/062e312))
* **auth/oauth:** `GET /api/auth/oauth/callback` — state CAS + mix-up defense + IdP exchange + provisioning TX + JWT mint + cookie emission + 302 to `/auth/success` ([T16a](https://github.com/swoofer/mcp-coordinator/commit/6b23c46) + [T16b](https://github.com/swoofer/mcp-coordinator/commit/7e9132b) + [T16c](https://github.com/swoofer/mcp-coordinator/commit/b1cce31))
* **auth/oauth:** `POST /api/auth/oauth/token` — unified grant dispatcher (authorization_code + refresh_token + device_code) with RFC 6749 §5.2 envelope ([T18](https://github.com/swoofer/mcp-coordinator/commit/eebfbe2))
* **auth/oauth:** `POST /api/auth/oauth/device_authorization` — RFC 8628 §3.1 device init with collision retry + per-IP rate limit ([T17](https://github.com/swoofer/mcp-coordinator/commit/6056585))
* **auth/oauth:** GET pages `/auth/device`, `/auth/device/confirm`, `/auth/success` with CSP-locked HTML + per-user_code CSRF ([T21](https://github.com/swoofer/mcp-coordinator/commit/a3f58ce))
* **auth/oauth:** `POST /auth/device/approve` with CSRF + V4 FIX 21 brute-force lockout ([T20](https://github.com/swoofer/mcp-coordinator/commit/93b3d87))
* **auth/oauth:** `/.well-known/oauth-authorization-server` RFC 8414 discovery doc ([T14](https://github.com/swoofer/mcp-coordinator/commit/ef64850))
* **auth/providers:** concrete `GitHubProvider` implementing IdPProvider — buildAuthUrl + exchangeCode + listMemberships + requestDeviceCode + pollDeviceToken; AbortController 5s timeout + 1 retry on 5xx ([T05](https://github.com/swoofer/mcp-coordinator/commit/6b1d5f7))

#### Refresh-token rotation (V3 §B-NEW-2 stolen-token detection)

* **auth/refresh:** rotation happy path with HS256-pinned kid-allowlisted JWT verify + atomic UPDATE WHERE revoked_at IS NULL (V4 FIX 5) ([T19a](https://github.com/swoofer/mcp-coordinator/commit/827556f))
* **auth/refresh:** reuse detection with 10s grace window + fingerprint binding + replay_count threshold 3 + family revoke (V3 §B-NEW-2) ([T19b](https://github.com/swoofer/mcp-coordinator/commit/620a3c6))
* **auth/refresh:** idle timeout + IdP membership refresh + allowlist re-check (V4 FIX 7) + IdPTokenRevoked → 401 + service-token rejection ([T19c](https://github.com/swoofer/mcp-coordinator/commit/ddda48f))

#### Service tokens (V4 §5.5)

* **auth/service-tokens:** issuance with 90d hardcoded TTL ceiling + ≥10-char reason + admin-only POST endpoint + CLI verb `mcp-coordinator service-token issue` ([T25](https://github.com/swoofer/mcp-coordinator/commit/c518449))
* **auth/service-tokens:** DB-lookup verification override for `service_account=true` JWTs (overrides §9.5 trust-signature; admin force-revoke wins immediately)

#### Cookie sessions (Scenario 5)

* **auth:** `authenticateRequest` extended with Scenario 5 — `__Host-coordinator_session` cookie auth via jose v6, HS256-pinned + kid-allowlisted + token_epoch check ([T27](https://github.com/swoofer/mcp-coordinator/commit/68f2d04))
* **auth:** `POST /api/auth/logout` (local), `/logout-all` (token_epoch bump invalidates all sessions instantly), `/revoke` (RFC 7009 §2.2 anti-enumeration) ([T23](https://github.com/swoofer/mcp-coordinator/commit/068ee3e))
* **auth:** `GET /api/auth/me` userinfo helper with 600/min rate limit ([T24](https://github.com/swoofer/mcp-coordinator/commit/dce5141))

#### Audit infrastructure (V3 NR13 two-tier durability)

* **security/audit:** `audit(action, options)` with optional `tier: 1 | 2` (default 2). Tier 1 = synchronous direct INSERT; Tier 2 = bounded queue (10K cap, 50-row / 100ms batch). 35 audit events catalogued per spec §11.2 ([T11a](https://github.com/swoofer/mcp-coordinator/commit/78b6798) + [T11b](https://github.com/swoofer/mcp-coordinator/commit/c9036b9))
* **auth/audit-context:** `withAuditContext(actor, request, fn)` AsyncLocalStorage propagation — audit() auto-reads actor + request without explicit threading ([T11a](https://github.com/swoofer/mcp-coordinator/commit/78b6798))
* **auth/request-id:** `withRequestId` ALS for cross-async-chain request_id propagation; inbound `X-Request-Id` honored when matching `/^[A-Za-z0-9._:-]{1,128}$/` ([T10](https://github.com/swoofer/mcp-coordinator/commit/2608a18))

#### Crypto foundation

* **auth/crypto:** HKDF-SHA256 domain-separated key derivation; mintAccessJWT + mintRefreshJWT (jose v6, HS256 pinned, kid header); PKCE S256 per RFC 7636 §4.2; entropy validation rejecting all-same-byte + dictionary words + low-Shannon secrets ([T08b](https://github.com/swoofer/mcp-coordinator/commit/c4b5609))
* **auth/csrf:** random double-submit token + length pre-check + `crypto.timingSafeEqual`; HMAC binding cut per V4 CUT 2 (SameSite=Strict + `__Host-` + CSP carry the defense) ([T08](https://github.com/swoofer/mcp-coordinator/commit/57741a1))
* **auth/cookies:** `__Host-` prefix helpers with Secure + Path=/ + no Domain enforcement; array Set-Cookie append for Node http ([T07](https://github.com/swoofer/mcp-coordinator/commit/67da436))

#### Operational

* **sweeper:** background sweeper deleting expired/revoked rows across 6 tables (oauth_state, device_auth_requests, refresh_tokens × 2 retention buckets, audit_log Tier 1/Tier 2). 60s cadence, adaptive chained passes (max 3), circuit breaker after 5 consecutive errors ([T28](https://github.com/swoofer/mcp-coordinator/commit/f1e5523))
* **boot:** `bootPhase2(opts)` validates env, derives keys via HKDF, performs NR12 restore detection (refuses to start if audit_log timestamps lag wall-clock >5min unless `COORDINATOR_ALLOW_RESTORE=true` → token_epoch global bump), composes ServerContext, starts sweeper, wires SIGTERM drain. Phase 1 deployments bypass entirely when `COORDINATOR_OAUTH_ENABLED` is unset. ([T29](https://github.com/swoofer/mcp-coordinator/commit/85f116d))
* **auth/rate-limit:** in-memory token-bucket per (endpoint, identifier) per V4 NR11 table; login-lockout with purpose-keyed SHA-256 identifier hashing ([T12](https://github.com/swoofer/mcp-coordinator/commit/4eea591))
* **auth/membership-cache:** LRU 10K with 60s positive TTL + 10min stale-on-error for IdP transient failures (V3 §B-NEW-5) ([T04](https://github.com/swoofer/mcp-coordinator/commit/8ac74f9))
* **auth/oauth-state:** PKCE state table CRUD with atomic CAS via UPDATE ... RETURNING (V3 §B-NEW-12 #15) ([T06](https://github.com/swoofer/mcp-coordinator/commit/0b14635))
* **auth/token-epoch:** direct DB read per request (no cache per V4 CUT 1); monotonic `MAX(now, current+1)` bump for NTP-rollback safety per V4 FIX 20 ([T03](https://github.com/swoofer/mcp-coordinator/commit/08b779f))
* **auth/allowlist:** `resolveOrgFromMemberships(db, lowercase_memberships)` with deterministic alphabetical tie-break per V4 FIX 22 ([T09](https://github.com/swoofer/mcp-coordinator/commit/58f7134))

#### Observability + HTTP infrastructure

* **observability/metrics:** Phase 2 prom-client registry — 29 metrics across auth activity, refresh chain, device flow, service tokens, IdP, audit queue, sweeper, rate limit, request duration histogram. `/metrics/auth` endpoint with localhost-only default + optional Bearer ([T37](https://github.com/swoofer/mcp-coordinator/commit/3e46720))
* **observability/logger:** Pino with 16 redact paths from V4 §11.3 ([T36](https://github.com/swoofer/mcp-coordinator/commit/263354a))
* **http/response-contract:** `bearerAuthHeader` per RFC 6750 §3, `oauthError` per RFC 6749 §5.2, `appError` envelope with auto-injected `request_id` from T10 ALS ([T36](https://github.com/swoofer/mcp-coordinator/commit/263354a))
* **http/health:** `/healthz` liveness + `/health/ready` readiness — 503 when sweeper circuit-open OR audit queue depth > 80% OR DB unreachable OR draining ([T36](https://github.com/swoofer/mcp-coordinator/commit/263354a))

#### Schema migration

* **db:** v7 → v8 migration with column renames per V4 FIX 1, `users.primary_org_id` rename, `user_orgs` join table for Phase 5 readiness, `oauth_state` table, refresh_tokens fingerprint + family_id + replay_count + parent_jti, device_auth_requests forensics columns + `denied_at`/`denied_reason`/`last_polled_at`/`interval`/`approved_at`/`failed_approval_attempts`, `system_state` table, `users_legacy_v0_7` compat view (3742a68 + 9dd6043 + 93b3d87 follow-ups)

### Bug Fixes (security)

* **auth/providers/github:** validate `Link: rel="next"` URL origin matches `apiBaseUrl` before following — prevents cross-origin SSRF leaking the GitHub OAuth Bearer token to attacker-controlled hosts ([T05 followup](https://github.com/swoofer/mcp-coordinator/commit/467db43))
* **auth/oauth-callback:** hash `idp_user_id` in audit metadata via new purpose-keyed `hashIdpUserId(s)` instead of storing PII raw (consistent with the codebase's identifier_hash discipline) ([T16b followup](https://github.com/swoofer/mcp-coordinator/commit/f3ce4bb))
* **auth/jwt-mint:** pin BOTH `iat` and `exp` numerically when `iatOverride` is set — jose's `setExpirationTime("Xs")` resolves against wall time, breaking deterministic re-mint within the 10s grace window otherwise ([T19b](https://github.com/swoofer/mcp-coordinator/commit/620a3c6))

### Tests

* 1444 individual tests pass (1300 new in this release + 144 from Phase 1). 6 pre-existing Windows EBUSY file-handle teardown flakes ignored per project convention.
* **Per-file 100% branch coverage enforced** via vitest thresholds on every security-critical module (csrf, token-epoch, oauth-state, jwt-mint, membership-cache, refresh-rotation, service-tokens, plus most Phase 2 helpers).
* **Phase 1 backcompat suite** under `tests/backcompat/` — 31 cases proving the upgrade path is non-destructive and Phase 2 wiring is opt-in only ([T43](https://github.com/swoofer/mcp-coordinator/commit/1b5f92b))
* **Cross-tenant isolation suite** under `tests/integration/` — 22 cases proving org-scoped data cannot leak across tenant boundaries via any Phase 2 endpoint ([T31](https://github.com/swoofer/mcp-coordinator/commit/7ac9ba6))
* **CI lint scripts** under `scripts/` — 5 grep-based bash lints catching: `users.org_id` references, `CURRENT_TIMESTAMP` in Phase 2 columns, `UPDATE/DELETE audit_log` outside sweeper, unescaped `${...}` in HTML pages, direct `process.env.COORDINATOR_*` reads in auth/cli/admin (everything must go through T44 `getOrgSetting`) ([T01b](https://github.com/swoofer/mcp-coordinator/commit/d1c9a79) + [T44](https://github.com/swoofer/mcp-coordinator/commit/e05cade))

### Deprecated

* `auditLog(ev)` (Phase 1 helper) — superseded by `audit(action, options)` with explicit tier routing. The Phase 1 helper continues to work for backward compat; new callers use `audit()`.

### Configuration

New environment variables (required when `COORDINATOR_OAUTH_ENABLED=true`):

* `COORDINATOR_OAUTH_ENABLED` — `true` to activate Phase 2 (default `false`)
* `COORDINATOR_JWT_SECRET` — ≥32 bytes; entropy-validated at boot
* `COORDINATOR_GITHUB_CLIENT_ID` / `COORDINATOR_GITHUB_CLIENT_SECRET`
* `COORDINATOR_GITHUB_ORG` — seeds the bootstrap `orgs.allowlist_github_org` row
* `COORDINATOR_PUBLIC_URL` — must be `http://` or `https://`; `http://` non-localhost requires `COORDINATOR_INSECURE_COOKIES=true` override

Optional environment variables (all routed through T44 `getOrgSetting` so Phase 5 can override per-org via the `orgs` table):

* `COORDINATOR_JWT_ACCESS_TTL` (default `15m`, max `60m`)
* `COORDINATOR_JWT_REFRESH_TTL` (default `30d`, max `90d`)
* `COORDINATOR_SESSION_IDLE_TIMEOUT` (unset = no idle check; `15m` recommended for regulated)
* `COORDINATOR_AUTO_PROVISION` (`true`|`false`, default `true`)
* `COORDINATOR_LOGIN_LOCKOUT_THRESHOLD` (default 5), `_WINDOW` (default 15m), `_DURATION` (default 15m)
* `COORDINATOR_REFRESH_RETENTION_DAYS` (default 180)
* `COORDINATOR_AUDIT_RETENTION_DAYS` (default 365) — Tier 1
* `COORDINATOR_AUDIT_TIER2_RETENTION_DAYS` (default 90)
* `COORDINATOR_ALLOW_RESTORE` (boot-only override after a DB restore; unset after boot per NR12)
* `COORDINATOR_INSECURE_COOKIES` (`true` required for `http://` non-localhost; not for production)
* `COORDINATOR_METRICS_BEARER` (optional Bearer token for `/metrics/auth` from non-loopback IPs)

### Migration notes (v0.7.0 → v0.8.0)

1. **Phase 1 deployments** (most existing installs): no action required. Leave `COORDINATOR_OAUTH_ENABLED` unset. The schema migration runs automatically on first start; existing data is preserved with column renames + backfills (token_epoch=0, family_id=random, outcome='legacy_unknown'). Phase 1 behavior is byte-identical.
2. **Enabling Phase 2**: set the 5 required env vars above, set `COORDINATOR_OAUTH_ENABLED=true`, restart. The bootstrap flow assigns admin role to the first user who signs in via OAuth (atomic — concurrent first-time logins resolve to exactly one admin).
3. **Custom IdPProvider implementations**: update `exchangeCode` return type from `Promise<IdpUserInfo>` to `Promise<ExchangeCodeResult>` (`{ user, accessToken }`).
4. **Direct audit_log SQL consumers**: update column names per V4 FIX 1.
5. **Direct users.org_id SQL consumers**: read from `users_legacy_v0_7` view, OR update to `users.primary_org_id`.

### Deferred (planned for v0.8.x or v0.9.0)

* Reference SDK (`@mcp-coordinator/sdk-js`) — T40
* `mcp-coordinator init` interactive wizard — T41
* `mcp-coordinator doctor` Phase 2 probes — T42
* Playwright E2E suite — T39
* OpenAPI spec generated from zod schemas — T34
* Grafana dashboard JSON + Prometheus alert YAML — T37b
* Security/compliance/operations runbook docs — T35a/b/c
* `service-token list` and `revoke` CLI subcommands (currently stubbed with SQL workarounds)
* Perf bench + chaos suite — T33

## [0.7.0](https://github.com/swoofer/mcp-coordinator/compare/v0.6.1...v0.7.0) (2026-05-13)


### Features

* **auth:** add IdPProvider interface + empty registry (Phase 2 hangs OAuth) ([f8b6548](https://github.com/swoofer/mcp-coordinator/commit/f8b65487a86208a62388645b51b41f7561488c68))
* **auth:** emit WWW-Authenticate header on 401 per RFC 6750 ([46c45ab](https://github.com/swoofer/mcp-coordinator/commit/46c45ab53e27beb7293c23482ad61fc58e085fd5))
* **auth:** extend AuthClaims with user_id, org, jti and add member role ([6a2bd70](https://github.com/swoofer/mcp-coordinator/commit/6a2bd70ba07cd088fd63e4b1681d23051ba9d525))
* **auth:** four-scenario backward-compat for AUTH_ENABLED toggle ([577cae0](https://github.com/swoofer/mcp-coordinator/commit/577cae0bebb51b1798b12014c469f7397ddfdd10))
* **auth:** support COORDINATOR_JWT_PREV_SECRET for zero-downtime rotation ([4c3387f](https://github.com/swoofer/mcp-coordinator/commit/4c3387fc8b1e51128b2cfc13ee40c55f6d854177))
* **db:** add orgs table + seed default org ([9b634b7](https://github.com/swoofer/mcp-coordinator/commit/9b634b7451161d02470aadf8ccaa31428ad297a8))
* **db:** add refresh_tokens, device_auth_requests, audit_log tables ([1d21384](https://github.com/swoofer/mcp-coordinator/commit/1d2138420666e9b4a493793aceaac0f2f8f7b891))
* **db:** add users table + UNIQUE(idp_provider,idp_user_id) + org index ([93d34e7](https://github.com/swoofer/mcp-coordinator/commit/93d34e7c802a1332d923d64ffb6a5021d55c0c14))
* **db:** ALTER 14 tables for org_id + events(org_id,id) index + PRAGMA bump ([a992411](https://github.com/swoofer/mcp-coordinator/commit/a992411f19f6dfdc86fb0bb3a4d296c3de5e6062))
* **db:** chmod coordinator.db to 0600 on init (POSIX) ([949575a](https://github.com/swoofer/mcp-coordinator/commit/949575a5b2afefc1898e483ca2e54b76834a4250))
* **db:** migrate cross-org-collision tables to composite PK (org_id, ...) ([e709296](https://github.com/swoofer/mcp-coordinator/commit/e709296ffacdb9454551821b0a0117d88d786c29))
* **health:** /healthz reports auth_enabled and jwt_secret_set with warnings ([fc2e1da](https://github.com/swoofer/mcp-coordinator/commit/fc2e1da29c95044208c341d54aaa5054f432ee5c))
* **http:** thread AuthClaims through RestContext into REST handlers ([bf38050](https://github.com/swoofer/mcp-coordinator/commit/bf38050eae2cc580aabf5c68c743495822ce563e))
* **mcp:** per-session claims map; tool handlers scope by claims.org via getter ([6141b78](https://github.com/swoofer/mcp-coordinator/commit/6141b78758fb1086cb96ddeb57196a920e594a00))
* **mcp:** verify JWT on every MCP request (new + existing sessions) ([2b94bc8](https://github.com/swoofer/mcp-coordinator/commit/2b94bc8f8629918da1e42344d7bbe3ad0b8cbd45))
* **mqtt:** scope subscribe/publish/LWT to coordinator/&lt;org_id&gt;/ prefix ([d48752c](https://github.com/swoofer/mcp-coordinator/commit/d48752c808b1f0eb9d3bdff3306d9c0c212a9ea8))
* **security:** add auditLog helper for audit_log table ([0947397](https://github.com/swoofer/mcp-coordinator/commit/09473974e2c656cce915f1bc1101db52a7042585))
* **security:** add EncryptionProvider interface + Passthrough default ([56ad863](https://github.com/swoofer/mcp-coordinator/commit/56ad863194a31b0fda0e0be693f850bdcb83c492))
* **sse:** authenticate /api/events handler and scope listener by claims.org ([5a47d5b](https://github.com/swoofer/mcp-coordinator/commit/5a47d5b74c62fbe6841c8b561994d5e16a21d04b))
* **sse:** scope listeners + events by org_id ([7555cf7](https://github.com/swoofer/mcp-coordinator/commit/7555cf7d9eb8972cc92069f36bb9049dd038dd3f))
* v0.7.0 Phase 1 auth foundation (multi-tenant, JWT hardening, org scoping) ([e36c3bb](https://github.com/swoofer/mcp-coordinator/commit/e36c3bb19f098b1706c3f73dc6ff866607f25d21))


### Bug Fixes

* **agent-activity:** scope getActivity/listAll by org_id (plan line 3378) ([49d239c](https://github.com/swoofer/mcp-coordinator/commit/49d239c27b5a7130d25352153d740f43d7675c21))
* **auth:** add WWW-Authenticate to /api/auth/refresh 401 responses ([d642410](https://github.com/swoofer/mcp-coordinator/commit/d642410cfe258d65bed20b683142b9c06e269d4d))
* **auth:** make refreshToken options required (no silent bypass) ([29a51da](https://github.com/swoofer/mcp-coordinator/commit/29a51daf837a3fac7144117c730ff858fd6d5829))
* **auth:** pin HS256 in refreshToken grace-period jwtVerify (defense-in-depth) ([6e609fe](https://github.com/swoofer/mcp-coordinator/commit/6e609fe6fa0f7139cdb00999b5fadecaec2ecff4))
* **db:** restore agent_activity_status FK to agents(id) lost in 5.5 migration ([adbad6d](https://github.com/swoofer/mcp-coordinator/commit/adbad6d31bbd094042aa64bd552323cbc82fa8a1))
* **dependency-map:** scope getMap/setMap/getModuleInfo/getBlastRadius by org_id ([bc32a5a](https://github.com/swoofer/mcp-coordinator/commit/bc32a5ac5885bd70a7a7ecd83b67df077a8dac20))
* **health:** restore /health status alive + uptime_seconds (regression) ([299c10f](https://github.com/swoofer/mcp-coordinator/commit/299c10f330c08050c712b321221a6a8c60f184f7))
* **mqtt:** move consultations + broadcast subscribes inside on(connect) ([648bc22](https://github.com/swoofer/mcp-coordinator/commit/648bc224899faae14dc3f2f922471001d723d6bd))
* **security:** close 3 cross-org leaks discovered by 32-agent audit ([af48d7c](https://github.com/swoofer/mcp-coordinator/commit/af48d7c26e6f522e15404c0b746e5a0b0e4dd091))
* **security:** make ConflictDetector.detect.org_id required + retag MCP TODOs to Task 23.5 ([a2f8211](https://github.com/swoofer/mcp-coordinator/commit/a2f821146752c8d2d7ffa6ea5f2cf81de917514e))
* **security:** scope raw UPDATE threads by org_id (cross-tenant leak) ([2a7cefa](https://github.com/swoofer/mcp-coordinator/commit/2a7cefa5fa51f5d2e4542097d135bba2d8590304))
* **test:** use ThreadMessage.content (not .subject) in cross-org leak test ([7a3397a](https://github.com/swoofer/mcp-coordinator/commit/7a3397a97d444a69ca8f4c93193458a37ed9beaa))


### Documentation

* **plan:** v0.7.0 Phase 1 auth foundation implementation plan (4-round review) ([#21](https://github.com/swoofer/mcp-coordinator/issues/21)) ([a8e6fa1](https://github.com/swoofer/mcp-coordinator/commit/a8e6fa1289c2ee8c241278899d4e55a0758d537b))
* **v0.7:** amend specs with 55 findings from 40-agent review ([#18](https://github.com/swoofer/mcp-coordinator/issues/18)) ([24e441a](https://github.com/swoofer/mcp-coordinator/commit/24e441a84cb33989dd0a6d1f01edf151a6a093e9))
* **v0.7:** document Phase 1 breaking changes + migration guide ([d8e0e7f](https://github.com/swoofer/mcp-coordinator/commit/d8e0e7f6e1e93d26057fe84a296290e2e9857c62))


### Code Refactoring

* **agent-activity:** scope status writes/reads by org_id ([66349ae](https://github.com/swoofer/mcp-coordinator/commit/66349aef75d7d59729eb77f003cc09c72c26856b))
* **agent-registry:** scope all queries by org_id ([701167e](https://github.com/swoofer/mcp-coordinator/commit/701167ee3b043f977b4465c0338bc790c0a533f1))
* **consultation:** scope thread/message/introspection queries by org_id ([44dccc5](https://github.com/swoofer/mcp-coordinator/commit/44dccc5ce4d6e482e1c0a6ab6ac080df391adcc2))
* **dependency-map:** scope set/get/listOwners by org_id ([0c95104](https://github.com/swoofer/mcp-coordinator/commit/0c95104a72643a2540e4896de021f547989a4217))
* **file-tracker:** scope all queries by org_id ([6c5e2f5](https://github.com/swoofer/mcp-coordinator/commit/6c5e2f54138923b1e7db62ee52dbfb4df97e893c))
* **git-cochange:** scope build/query by org_id ([2db5172](https://github.com/swoofer/mcp-coordinator/commit/2db51721f8204867b3ba399a02369061fa1a907a))
* **impact-scorer:** scope direct SQL blocks by org_id (3 sites) ([c4de948](https://github.com/swoofer/mcp-coordinator/commit/c4de948fb954c9a0c72cb0a66f54ea481f934169))
* **introspection:** scope create/respond/list/getPending by org_id ([94dae4d](https://github.com/swoofer/mcp-coordinator/commit/94dae4df62b3ac31cfe66d12003874c397491de5))
* **working-files:** scope claim/list/release by org_id ([d76e45d](https://github.com/swoofer/mcp-coordinator/commit/d76e45d095f89aec29be882c6fdfcf19dcedd128))

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
