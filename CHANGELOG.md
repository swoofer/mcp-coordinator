# Changelog

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
