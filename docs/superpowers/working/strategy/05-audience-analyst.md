# 05 — Audience Analyst

## 1. Personas

### Solo Sam — "2-3 Claude sessions on my own repo"
- **Role**: Independent dev / freelancer / OSS maintainer.
- **Workflow**: 1-3 Claude/Cursor windows on a monorepo, hand-rolled tmux.
- **Depth**: CLI, npm, MCP configs. Reads READMEs.
- **Pain**: Two agents trampled each other this morning. 30 min lost on a bad merge. Searches "claude code multi session conflict".
- **Converts on**: 4-line install, local-only / zero-cloud / zero-account, visual proof conflicts caught BEFORE writing code, `npm i -g`, MIT.
- **Bored by**: Enterprise rhetoric, JWT setup, governance language, multi-tenant flows.
- **Assumption (unverified)**: Likely largest segment for an early OSS tool; no analytics yet.

### Team-lead Tara — "Three of us run agents on the same repo"
- **Role**: Tech lead at a 3-15 person team adopting AI coding.
- **Workflow**: Reviews PRs from teammates' agents, fields "who's editing auth?" pings, maintains the shared `.mcp.json`.
- **Depth**: LAN, JWT, env vars, daemons, Caddy/nginx fronting.
- **Pain**: Last sprint two agents shipped overlapping refactors; one was reverted. Wants shared awareness without buying SaaS.
- **Converts on**: Team-mode walkthrough with JWT + registration secret + doctor. Self-hosted passes legal. "Detection <5 ms, push <50 ms". 216 tests, MIT.
- **Bored by**: Hobbyist tone, missing auth story, vague "production-ready", undocumented failure modes.
- **Assumption (unverified)**: Fewer visitors than Sam, higher conversion intent.

### Architect Alex — "Should we standardize on this?"
- **Role**: Staff/principal evaluating coordination patterns for wider rollout.
- **Workflow**: Reads RFCs, compares 3-5 tools, writes one-page recs. Installs on day 4.
- **Depth**: MCP spec, MQTT semantics, vendor lock-in, blast radius.
- **Pain**: Mandate to figure out the team's multi-agent strategy. Already saw essaim/AutoGen/CrewAI; needs to know if mcp-coordinator is the protocol beneath.
- **Converts on**: Architecture diagram (broker / scoring / dashboard), honest "BENEATH essaim, not vs" framing, roadmap with dates, public scoring algorithm, license clarity.
- **Bored by**: Marketing fluff, "AI-powered" hand-waving, no roadmap.
- **Assumption (unverified)**: Smallest by count, biggest by downstream influence.

## 2. Persona × Section Value Matrix

| # | Section | Sam | Tara | Alex |
|---|---|---|---|---|
| 1 | Hero | HIGH | HIGH | MED |
| 2 | Pain | HIGH | HIGH | LOW |
| 3 | Solution | HIGH | HIGH | MED |
| 4 | Mechanism | MED | HIGH | HIGH |
| 5 | Templates | LOW | MED | HIGH |
| 6 | Compare | MED | MED | HIGH |
| 7 | Tech | LOW | HIGH | HIGH |
| 8 | Start | HIGH | HIGH | LOW |
| 9 | Results | LOW | HIGH | HIGH |
| 10 | FAQ | MED | HIGH | HIGH |
| 11 | Roadmap | LOW | MED | HIGH |

- **Spine**: §1, §3. **Persona-critical**: §5 → Alex; §8 → Sam; §7/§9 → Tara/Alex. No LOW/LOW/LOW sections; §5 weakest for Sam — keep after §4.

## 3. Five Audience Objections (FAQ feed)

1. **"Yet another tool to maintain."** → One `npm i -g`. Embedded broker + SQLite + dashboard. Zero sidecar. `uninstall` is symmetric.
2. **"I don't run multiple agents — does this matter?"** → One agent + you = two actors. Dashboard surfaces what your agent touched and when. Adding teammates later is config-only.
3. **"Production-ready or hobby?"** → 216 unit tests across 4 conflict scenarios, MIT, semver, `doctor` command, Pino logs per component.
4. **"Will my team adopt YET ANOTHER coordination tool?"** → Surface = one `.mcp.json` + a CLAUDE.md block scaffolded by `init --write-claude-md`. No new chat tool, no login, no dashboard to babysit.
5. **"What if the coordinator goes down?"** → Agents fail open — keep working as if uninstalled. Local SQLite; restart resumes.

## 4. Persona-aware CTA Placement

- **"Get Started"** → **Sam**. Primary in hero + §8.
- **"See it live"** → **Tara**. Secondary in hero → #solution; tertiary near §7.
- **"GitHub"** → **Alex**. Persistent in nav + hero + footer.

**Recommendation**: One unified triplet covers all three personas via layered placement. Persona-specific CTAs would fragment the page. Repeat in hero + §8.
