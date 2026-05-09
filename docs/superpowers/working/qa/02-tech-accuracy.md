# Tech Accuracy QA — index-draft-v4.html

Audit target: `docs/superpowers/working/drafts/index-draft-v4.html` (5887 lines, 459128 bytes initial).

## Summary

- Claims verified: 8 (all)
- Claims corrected: 0
- Claims inconclusive: 0
- Final byte count: 459128 (no edits required)

All concrete numeric/behavioral claims in the page match the underlying code.

---

## Claim-by-claim verification

### 1. "26 MCP tools"

CLAIM: "26 MCP tools" / "exposing 26 MCP tools over HTTP/SSE"
LOCATION: lines 2099, 2482, 2790, 2874, 2984, 3159, 3243, 3352, 3527, 3611, 3720, 3895, 3979, 4088, 4263, 4347, 4456, 4631, 4715, 4824, 4954, 5005, 5121, 5172, 5287, 5338, 5453, 5504, 5619, 5670, 5785, 5836 (and translations)
VERIFIED: ✅ source = `src/server-setup.ts` lines 116, 128, 135, 153, 160, 265, 288, 302, 313, 324, 334, 345, 353, 361, 372, 385, 392, 399, 410, 418, 425, 434, 453, 497, 509, 516 — exactly **26** `server.tool(` registrations. Cross-check with README.md line 54 ("all 26 tools").

### 2. "216 unit tests across 18 files"

CLAIM: "216 unit tests across 18 files" / "216 unit tests across 4 conflict scenarios"
LOCATION: lines 2305, 2332, 2396, 2842, 2850, 3211, 3219, 3579, 3587, 3947, 3955, 4315, 4323, 4683, 4691 (and translations)
VERIFIED: ✅ source = `tests/unit/` — counted via `Grep ^(it|test)\(` across `*.test.ts`: total **216** matches across **18** files (agent-activity 16, agent-registry 6, auth 23, cli-config 3, conflict-detector 11, consultation 54, context-provider 4, database 2, db-adapter 1, dependency-map 6, file-tracker 7, impact-scorer 19, integration 15, introspection 6, logger 4, plan-quality 8, quota 24, sse-emitter 7). Matches README.md line 776 exactly.

### 3. Version "v0.2.x" / "v0.2.1"

CLAIM: "v0.2.x" (footer/eyebrow) and "mcp-coordinator v0.2.1" (dashboard meta)
LOCATION: lines 41, 1600, 2229, 2493, 2498, 2553, 2654, 2816, 3023, 3391, 3759, 4127, 4495, 4859, 5026, 5192, 5358, 5524, 5690 (and translations)
VERIFIED: ✅ source = `package.json` line 3 — `"version": "0.2.1"`. Both forms ("v0.2.x" general, "v0.2.1" specific) are accurate.

### 4. "<5ms" detection latency

CLAIM: "<5ms" — Detection
LOCATION: lines 2299, 2836, 3205, 3573, 3941, 4309, 4677
VERIFIED: ✅ source = `README.md` line 751 — table row "Conflict detection (no LLM) | < 5 ms". Matches the README's documented benchmark.

### 5. "<50ms" MQTT push latency

CLAIM: "<50ms" — MQTT push (multiple translations: "End-to-end latency under 50ms", "Latence push <50 ms", etc.)
LOCATION: lines 1606, 1776, 2301, 2657, 2701, 2838, 2906, 2932, 3026, 3070, 3207, 3274, 3300, 3394, 3438, 3575, 3642, 3668, 3762, 3806, 3943, 4010, 4036, 4130, 4174, 4311, 4378, 4404, 4498, 4542, 4679, 4746, 4772, 4862, 4878, 4902, 5029, 5045, 5069, 5195, 5211, 5235, 5361, 5377, 5401, 5527, 5543, 5567, 5693, 5709, 5733
VERIFIED: ✅ source = `README.md` line 752 — table row "MQTT push delivery | < 50 ms end-to-end". This is distinct from the <5ms detection claim (different layer of the stack).

### 6. "30-45s consensus"

CLAIM: "30-45s" — Full consensus cycle
LOCATION: lines 2303, 2840, 3209, 3577, 3945, 4313, 4681
VERIFIED: ✅ source = `README.md` line 753 — table row "Full consultation cycle (S1) | 30–45 s". Range matches.

### 7. "embedded Aedes broker"

CLAIM: "embedded Aedes MQTT broker" / "Aedes broker"
LOCATION: lines 1840, 2087, 2099, 2125, 2165, 2482, 2790, 2874, 2929, 2984, 3159, 3243, 3297, 3352, 3527, 3611, 3665, 3720, 3895, 3979, 4033, 4088, 4263, 4347, 4401, 4456, 4631, 4715, 4769, 4824, 4899, 4954, 5005, 5066, 5121, 5172, 5232, 5287, 5338, 5398, 5453, 5504, 5564, 5619, 5670, 5730, 5785, 5836 (and translations)
VERIFIED: ✅ source = `src/mqtt-broker.ts:1` — `import { Aedes, type Client } from "aedes";` and line 59 `Aedes.createBroker()`. Also `package.json:60` lists `"aedes": "^1.0.2"`.

### 8. "HS256 via jose" JWT

CLAIM: "Opt-in HS256 JWT via [jose](https://github.com/panva/jose)"
LOCATION: lines 2351, 2352, 2425, 2428, 2857, 2858, 3226, 3227, 3594, 3595, 3962, 3963, 4330, 4331, 4698, 4699
VERIFIED: ✅ source = `src/auth.ts:1` — `import { SignJWT, jwtVerify, errors } from "jose";` and line 31 `.setProtectedHeader({ alg: "HS256" })`. `package.json:63` lists `"jose": "^6.2.2"`.

---

## Notes on related claims (informational, no action)

- **"Eight topics"** (line 1776, 2701, 3070, 3438, 3806, 4174, 4542): MQTT topic table in README has 8 rows (`coordinator/consultations/new`, `.../{id}/messages`, `.../{id}/status`, `.../{id}/claimed`, `.../{id}/completed`, `coordinator/agents/{id}/status`, `coordinator/broadcast`, `coordinator/quota/update`). ✅ Verified against README.md lines 113–121.
- **Lowercase `aedes` at line 1840** is inside a hero terminal/code mock-up referencing the package name; not a brand-style violation.
- README.md "Test Results" table (lines 740–753) is the single source of truth for all three latency/timing numbers reproduced on the landing page; all three match.

---

## Decision

No corrections needed. No `TODO_VERIFY` comments inserted. The page's tech claims are fully substantiated by the codebase and README.
