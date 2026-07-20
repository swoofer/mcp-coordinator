# Handoff — mcp-coordinator session continuation

> Read this end-to-end before doing anything. Then check `~/.claude/projects/C--Users-gagno-projet-mcp-coordinator-new/memory/MEMORY.md` for durable context (user profile, feedback, project state, references) — it's already loaded at session start. Don't re-litigate decisions captured in those memories.

## 1. Objectif

**Cut and verify v0.13.0**, then close out the Claude Code Channels integration epic (issue #130 was already closed; v0.13.0 ships Phase 2 reply tool + the chained-Docker workflow fix).

The strategic objective is to **prove the docker-publish workflow_call fix (#142) actually works on a real release**. v0.12.0 had a broken chained publish — had to dispatch manually. The fix in #142 should make v0.13.0 auto-publish to GHCR without intervention.

## 2. État actuel du code

- On `main`, HEAD around commit `071a234` ("surface polling-vs-push choice")
- **v0.12.0** is shipped on npm + GHCR (`ghcr.io/swoofer/mcp-coordinator:0.12.0` / `:0.12` / `:latest`)
- **PR #143** open and ready to merge: `chore(main): release 0.13.0` (release-please auto-PR)
  - Contents: Channels Phase 2 (#145), CI tag-gating fix (#142), docs PRs (#146, #147), contributor schema fix (#132/144 chain)
- No other PRs open
- Full test suite green: 173 files / ~2317 tests
- Lockfile is pnpm — `pnpm install --frozen-lockfile` from a clean clone is the canonical setup

### What just shipped (recent)

- **Channels Phase 1 (v0.12.0)** — `cli/channel.ts` stdio MCP server, subscribes to MQTT broker, pushes events as `notifications/claude/channel`
- **Channels Phase 2 (in #143 → v0.13.0)** — `post_to_thread` reply tool; channel is now bidirectional
- **Stdio mode tool calls fixed (#135)** — was throwing "MCP tool requires a session"; now wires synthetic claims
- **MCP integration harness (#134, #140)** — `tests/helpers/mcp-client-harness.ts` + `tests/helpers/channel-test-harness.ts` exercise the real MCP SDK
- **operating-modes.md** + landing-page callouts for the polling-vs-push choice

### Issue tracker shape

- ~22 open issues, all GFI or strategic. No urgent bugs.
- Issue #130 (Channels integration epic) — **closed** when Phase 1+2 landed
- Issue #133 (stdio mode tool calls) — **closed** by #135
- Phase 3 of Channels (permission relay) intentionally deferred per #139 reference-plugin study

## 3. Fichiers touchés récemment (et pourquoi)

| File | What changed |
|---|---|
| `cli/channel.ts` | Phase 1 push + Phase 2 `post_to_thread` reply tool. Declares `claude/channel` capability. Subscribes to 3 MQTT topic patterns. |
| `cli/index.ts` | Registered `createChannelCommand()` |
| `src/index.ts` | Stdio mode wires synthetic claims `{org: "default", ...}` so tool calls work |
| `src/tools/*-tools.ts` (6 files) | Collapsed 4-line session guard into 1 line: `const claims = getSessionClaims(extra.sessionId ?? "");` |
| `src/server-setup.ts` | JSDoc on `createMcpServer` updated to reflect the new contract (line ~152) |
| `tests/helpers/mcp-client-harness.ts` | Spawns HTTP or stdio MCP server, returns an SDK Client |
| `tests/helpers/channel-test-harness.ts` | Spawns channel CLI, captures notifications, exposes mock MQTT broker |
| `tests/integration/channel-smoke.test.ts` | End-to-end: spawn channel + broker + assert events flow |
| `tests/unit/cli-channel.test.ts` | Unit tests for `buildChannelNotification` + the reply tool publish |
| `.github/workflows/docker-publish.yml` | `type=match` `enable=` now gates on `inputs.tag != ''` instead of `github.event_name` |
| `.github/workflows/release.yml` | Calls `docker-publish.yml` as a reusable workflow when `release_created == 'true'` |
| `docs/operating-modes.md` | New comparison doc: polling vs push |
| `docs/index.html` | Added `start.modes` install-alt callout (6 locales). Roadmap card updated for Channels. |
| `README.md` | Added "🔀 Two ways" callout in Getting Started |

## 4. Tentatives échouées (à NE PAS refaire)

1. **Stdio mode synthetic-claims via centralized SDK shim** — first instinct was to monkey-patch `server.tool()` in `createMcpServer` to inject a sessionId. Rejected because the MCP SDK reads `extra.sessionId` on every handler call internally and isn't trivially overridable. The clean fix (#135) is the per-handler `extra.sessionId ?? ""` pattern.

2. **Docker workflow_call gating on `github.event_name`** — my original chain fix in #125 used `github.event_name == 'workflow_call'`. **This is always false** inside a called reusable workflow — `github.event_name` reflects the CALLER's event (`push`), not `workflow_call`. Fixed in #142 by switching to `inputs.tag != ''`. **Don't repeat this — it's not a `github.event_name` problem.**

3. **Postgres adapter spec** — closed #103 (and dependent #85, #104, #84) as YAGNI. Spec preserved at `docs/superpowers/specs/2026-05-16-postgres-adapter-design.md`. Don't reopen unless a real signal arrives (paying customer, multi-instance demand).

4. **Edit tool on UTF-8 BOM files** — silently reports success but doesn't persist changes (encountered on `cli/server/status.ts`). Fallback: rewrite via bash heredoc or `sed -i`. See `feedback_edit_tool_bom_gotcha.md` in memory.

5. **Channels Phase 3 (permission relay)** — intentionally deferred per #139's reference-plugin study. The `claude/channel/permission` capability needs a sender allowlist to be safe, and the loopback-MQTT trust model doesn't have one. Don't accidentally re-spike this without a concrete operator request.

6. **Pinning `tree-sitter-rust@^0.21.2`** — that version was never published to npm (line jumps from 0.21.0 to 0.23.0). pnpm's stricter resolver caught it; fixed to `^0.21.0` in the pnpm migration PR. Don't bump back.

## 5. Prochaine étape

**Immediate (next session)**:

1. **Merge PR #143** (release-please v0.13.0) → cuts the release tag, triggers `release.yml`, which should chain to `docker-publish.yml` via `workflow_call` and auto-publish to GHCR.

2. **Verify the chained Docker publish actually works this time**. The #142 fix should make it succeed without manual intervention. Check:
   - `gh run watch <release-run-id>` — both `release` and `docker` jobs should complete success
   - `npm view mcp-coordinator dist-tags` shows `latest: 0.13.0`
   - GHCR has `:0.13.0`, `:0.13`, and `:latest` pointing to v0.13.0 (verify via `curl -H "Authorization: Bearer $TOKEN" https://ghcr.io/v2/swoofer/mcp-coordinator/tags/list`)

3. **If the chain succeeds**: confirm by docker-pulling the new image (`docker pull ghcr.io/swoofer/mcp-coordinator:0.13.0` — not from this Windows terminal since Docker Desktop isn't always running). The chained docker workflow is the final verification of #142.

4. **If the chain fails**: read the failed run's `docker / build-and-push` job log. Check the `Derive image tags` step's `DOCKER_METADATA_OUTPUT_TAGS` output. If empty, the `inputs.tag` is somehow not flowing through `workflow_call`. Don't bandage — root-cause it.

**Manual fallback** (if anything goes sideways): `gh workflow run "Docker publish" -f tag=v0.13.0`

**After v0.13.0 is verified**:
- Update landing-page version refs from `0.11.0` / `0.12.0` to `0.13.0` (hero eyebrow, footer, JSON-LD softwareVersion, Docker callouts that pin to a specific version)
- Bump `examples/channels-quickstart/` and `examples/docker-compose/` to `:0.13.0` if they pin `:0.12.0`
- Add a v0.13.0 entry to the landing-page roadmap timeline (mirror the v0.11/v0.12 card shape — title, desc, date, link). Translate the 4 keys into the 5 non-EN locales (FR, ES, DE, ZH, JA) or rely on EN fallback.

**Strategic, not urgent**:
- Channels Phase 3 is deferred (don't spike it)
- Windows CI flakiness on `tests/integration/channel-smoke.test.ts` — monitor on next CI runs, file an issue if reproducible
- Node 20 actions deprecation (Sept 2026 cutoff) — wait for `actions/checkout@v5` / `actions/setup-node@v5` GA before migrating

## Communication style with the user

- **French casual.** Short replies ("ok", "go", "fait toi-même"). Doesn't waste words.
- **Bias toward autonomy.** When user says "go" or "sois autonome", just execute. Don't ask permission on tactical choices.
- **Push back when they push back.** When they say "fait toi-même le test, tu va voir" — they suspect I wrote off a real bug. Test concretely before dismissing.
- **Strategic vs tactical**: ask on strategic decisions (close an issue family? cut a major version? security trade-offs). Execute on tactical (which label, which file path, which assignee).

## Where to find more context

- **Durable memory**: `~/.claude/projects/C--Users-gagno-projet-mcp-coordinator-new/memory/MEMORY.md` (auto-loaded). 9 files behind it cover user profile, feedback patterns, project tooling state, release pipeline, repo layout, and gotchas.
- **Recent specs / catalogs**:
  - `docs/superpowers/specs/2026-05-23-channels-event-catalog.md` — every MQTT publish path with priority + sample payload
  - `docs/superpowers/working/channels-reference-plugins-study.md` — patterns from Anthropic's telegram/discord/imessage/fakechat
  - `docs/operating-modes.md` — polling vs push decision guide
- **CHANGELOG.md** — `git log v0.11.0..HEAD --oneline` for the full sequence of work since the last user-visible release
