# 04 — Brand voice (mcp-coordinator landing redesign)

Authoritative voice spec for Layer 2 section leads. Every quoted glossary term and forbidden phrase below is binding.

## 1. Voice axes (current → target)

| Axis | Current README/index | Target redesign | Why |
|------|---------------------|-----------------|-----|
| Technical depth (1=ELI5 / 10=spec) | **8** | **7** | Keep credibility for tech evaluators, but Pain/Solution/FAQ must land for the team-lead persona without a glossary lookup. |
| Formality (1=DM-style / 10=academic) | **5** | **5** | Stay where the README already lives — engineer-to-engineer, no exclamation marks, no academic hedging. |
| Assertiveness (1=hedged / 10=opinionated) | **6** | **8** | The current page hedges ("none of them know what the others are doing"). Redesign should make claims with evidence ("Worktrees solve files. We solve intent."). |
| Density (1=spacious / 10=packed) | **8** | **6** | Density is the #1 problem flagged in the design spec. Lower it via shorter sentences, more whitespace, progressive disclosure. |

## 2. Sentence-length budget

- **Target average**: ~16 words per sentence (decrease from README's ~22).
- **Maximum**: 28 words. Anything longer must be split or turned into a list.
- **Rationale**: README is a reference doc, the landing is a conversion surface. Shorter sentences read on mobile and survive translation into 6 languages.
- **Hard rule**: No sentence may contain more than one em-dash. The current page abuses em-dashes as a substitute for paragraph breaks.

## 3. Glossary (15 terms)

Section leads MUST use the PREFER form verbatim.

```
PREFER: "agent" / DON'T USE: "AI agent", "Claude instance", "LLM agent", "bot"
PREFER: "consultation thread" / DON'T USE: "discussion", "chat thread", "conversation"
PREFER: "MQTT broker" / DON'T USE: "message bus", "event bus", "pub/sub layer"
PREFER: "mcp-coordinator" / DON'T USE: "MCP Coordinator" (capitalized), "the Coordinator", "MCP-coordinator"
PREFER: "MCP client" / DON'T USE: "agent runtime", "AI tool", "MCP-compatible IDE"
PREFER: "announce work" (verb) / "announcement" (noun) / DON'T USE: "register intent", "declare task", "post job"
PREFER: "impact score" / DON'T USE: "conflict score", "risk score", "overlap rating"
PREFER: "consultation" (the protocol step) / DON'T USE: "negotiation", "sync", "handshake"
PREFER: "consensus" / DON'T USE: "agreement", "approval", "sign-off"
PREFER: "between turns" / DON'T USE: "asynchronously", "in the background", "out-of-band"
PREFER: "self-hosted" / DON'T USE: "on-prem", "private cloud", "self-managed"
PREFER: "MCP tool" (the 26 of them) / DON'T USE: "API endpoint", "function", "RPC method"
PREFER: "dashboard" / DON'T USE: "UI", "console", "control panel", "web app"
PREFER: "coordination pattern" (Section 5) / DON'T USE: "template", "blueprint", "recipe"
PREFER: "essaim" (lowercase, the orchestrator) / DON'T USE: "Essaim", "ESSAIM", "swarm framework"
```

## 4. Forbidden phrases

Hard ban — section leads who use these will be flagged by the consistency reviewer.

- **"revolutionary"**, **"game-changing"**, **"next-generation"**, **"best-in-class"**, **"world-class"** — empty marketing.
- **"AI-powered"**, **"AI-native"**, **"intelligent coordination"** — agents are already AI; the adjective adds nothing.
- **"seamless", "seamlessly"** — every product claims this. Show the seam-lessness instead.
- **"unleash", "supercharge", "turbocharge", "rocket"** — verbs from a different genre.
- **"effortlessly", "magically", "out of the box magic"** — engineers don't want magic, they want predictability.
- **"the only X that..."**, **"the first X to..."** — unverifiable; tech-accuracy will reject.
- **"empower(s)", "empowering"** — vague benefit-speak.

## 5. Five voice examples (wrong → right)

**1 — Pain card** (`docs/index.html:1466-1467`):
> "Two agents touch the same file at the same time. One silently overwrites the other. The bug surfaces in review — or in production."

Voice-off: abstract; passive ("the bug surfaces"); two em-dashes inside three sentences. No concrete actor, no time signature.

Rewrite: *"Tuesday 3pm. Alice's agent ships `updated_at`. Four minutes later, Bob's agent renames `User.id`. Tests pass. Prod breaks at 2am."*

**2 — Solution claim** (`docs/index.html:1448-1449`):
> "A multi-layer scorer (file paths, dependency graph, module boundaries, recent edits) ranks every intent in under 50 ms and pushes the verdict to each agent before they touch the filesystem."

Voice-off: 32 words, parenthetical list, two clauses joined by "and". Density too high. "Verdict" is dramatic.

Rewrite: *"Every announcement is scored across six layers in under 5ms. The impact score reaches every concerned agent before any file is opened."*

**3 — FAQ-style answer** (`docs/index.html:1641-1642`, "…git worktrees?"):
> "Worktrees isolate at the filesystem level — two agents can't overwrite the same file. But they CAN produce logically incompatible changes that merge cleanly and break at runtime. Worktrees solve file access; the coordinator solves intent. Use both."

Voice-off: ALL-CAPS "CAN" is shouty; em-dash overuse; punchline buried at sentence 3.

Rewrite: *"No. Worktrees isolate filesystems. mcp-coordinator coordinates intent. A clean merge of two incompatible designs still ships a broken runtime. Use both."*

**4 — CTA / install nudge** (`docs/index.html:1849`):
> "Self-hosted, no cloud dependency. From npm install to a coordinated session in under a minute."

Voice-off: two fragments stacked; no verb in sentence 1; "coordinated session" is jargon for the reader who hasn't met the mechanism yet.

Rewrite: *"Install in 60 seconds. One npm package, embedded broker, no cloud. Your laptop is the team."*

**5 — Step description** (`docs/index.html:1506-1507`, "Consult"):
> "The coordinator opens a thread (a structured conversation between affected agents) and publishes it on MQTT. Each agent picks up the event between turns and posts context, constraints, or a fix proposal — no extra sidecar process."

Voice-off: 38 words in sentence 1, parenthetical glossing of "thread", em-dash dump at the end.

Rewrite: *"The coordinator opens a consultation thread and publishes it to the MQTT broker. Each concerned agent reads the event between turns and posts context, constraints, or a resolution. No sidecar process required."*

---

**Word count**: ~790 (within cap).

DONE — file written at `C:\Users\gagno\projet\mcp-coordinator-new\docs\superpowers\working\strategy\04-brand-voice.md`.
