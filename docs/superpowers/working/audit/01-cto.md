# CTO Audit — mcp-coordinator

**Verdict: 4/10 adoption-readiness.** Interesting protocol idea, but materially wrong shape for a team buying decision today. Recommend "watch the repo" not "adopt."

## Concrete Blockers

### 1. Bus factor = 1, with a tip jar

README line 835: "Solo maintainer." Footer at index.html line 2530-2531 links GitHub Sponsors and Buy Me A Coffee. No company, no SLA, no second committer named, no governance doc. For a tool sitting in the **hot path of every agent action** (`announce_work` before code is written, per README line 86), a single point of failure in the maintainer is unacceptable. If swoofer disappears in 6 months, my team owns a forked Aedes broker, an embedded SQLite schema, and 26 MCP tool contracts. That is not "free."

### 2. Build-vs-buy fails the 2-day test

The actual coordination logic is a scoring table (README lines 148-156: 6 layers, max 100). For a small team I can ship the equivalent in a weekend: a Redis SET of `(file → agent)` plus a webhook that posts to Slack on overlap. The MQTT/Aedes/SQLite/dashboard/JWT stack (README lines 96, 632-639, 692-728) is **30+ moving parts** to solve "did anyone announce this file." The complexity-to-value ratio is inverted.

### 3. v0.2.x with breaking-API-allowed semantics

FAQ at index.html line 2316: "v1.0 freezes the public API." Translation: **everything before v1.0 is unstable**. Roadmap line 2502: "Date TBD" for v1.0. I am not asking my team to wire 26 MCP tools and a `CLAUDE.md` block (README lines 354-369) into our workflow when the contract can break in any minor release. The version banner shown in the page header is `v0.2.1` (line 2216).

### 4. The polling caveat undermines the headline pitch

Hero claims "<50ms push latency" (line 1604). But README lines 372-379 admit vanilla Claude Code **does not subscribe to MQTT** — it polls. The push-based architecture is only delivered if you also adopt **essaim**, the same maintainer's separate orchestrator (README line 379). That is a bait-and-switch: the marquee MQTT broker is dead weight for the most common deployment (Claude Code without essaim), yet I still pay its operational cost.

### 5. Lock-in via `CLAUDE.md` injection and 26-tool surface

The `init --write-claude-md` command (README line 352) modifies my project's `CLAUDE.md` with a coordination protocol my agents must follow. Twenty-six tools (`register_agent`, `announce_work`, `propose_resolution`, `approve_resolution`, `contest_resolution`, `claim_thread`, etc., README lines 174-228) become embedded in agent prompts and team conventions. The `uninstall` command removes the file, but it cannot remove the **behavioral dependency** my team will have built around the consultation cycle.

### 6. Hidden ops cost is non-trivial

The "zero sidecar" claim (line 1605) is misleading. I still operate: a Node.js daemon (PID file at `~/.mcp-coordinator/server.pid`, README line 637), an Aedes MQTT broker on TCP 1883 + WS, a SQLite database that grows unbounded (no retention/rotation policy in README), JWT secret rotation (README line 492 mentions 24h tokens but no automated refresh story), and a dashboard on port 3100. Add LAN/cloud TLS termination (README line 463 hand-waves "Front the server with TLS via nginx/Caddy"). This is sidecar-shaped infra rebadged as "embedded."

### 7. Governance / audit is absent

No mention in README or landing page of: append-only audit log of agent decisions, ability to export consultation history for a post-incident review, RBAC beyond a single shared `REGISTRATION_SECRET` (README line 701), or compliance posture (SOC2, GDPR for the SQLite store). For a tool gating production code, "structured Pino logs" (FAQ line 2316) is not an audit story.

## What Would Convince Me

1. **Adoption signal + second maintainer.** A named co-maintainer from a different org, plus 3+ public case studies of teams running it 90+ days. Until then it reads as a personal project.
2. **v1.0 with frozen API and a 12-month deprecation policy**, before I wire 26 tools into our `CLAUDE.md`.
3. **Native push for vanilla Claude Code** (the `tengu_harbor` integration on the roadmap, line 2511) actually shipped — eliminating the polling caveat and the essaim dependency.

DONE — `C:\Users\gagno\projet\mcp-coordinator-new\docs\superpowers\working\audit\01-cto.md`
