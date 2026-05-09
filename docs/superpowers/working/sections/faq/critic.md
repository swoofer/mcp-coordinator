# FAQ — critic notes

**Reviewer**: agent-faq-critic
**Verdict**: Strong overall. JSON-LD valid (10 Q/A, parseable). Six fixes below.

---

## Validation summary

- **Q/A count**: 10 in HTML accordion, 10 in JSON-LD `mainEntity[]`. Match. No 11th.
- **JSON-LD parse**: clean (Python `json.loads` confirms).
- **Word budget**: all ten answers ≤ 24 words (max budget 45). Pass.
- **Native pattern**: `<details>/<summary>`, no JS. Pass.
- **Glossary verbatim** (mcp-coordinator, MCP client, MQTT broker, between turns, self-hosted): used correctly throughout.
- **i18n keys**: `data-i18n` on every Q and A. Pass.

---

## Issue 1 — A2 doesn't answer the question (lead's open Q1)

The question asks "Is it production-ready?" — the answer ships evidence but never says "yes". Spec §4.10 starts with a stance ("v0.2.x is stable for solo and team use"). Add the lead-in.

```search
<div class="faq-a" data-i18n="faq.a2">216 unit tests across 4 conflict scenarios, MIT-licensed, semver, <code>doctor</code> command, structured Pino logs.</div>
```
```replace
<div class="faq-a" data-i18n="faq.a2">Stable for solo and team use; v1.0 freezes the public API. 216 unit tests across 4 conflict scenarios, MIT-licensed, <code>doctor</code> command, structured Pino logs.</div>
```
Mirror the change in JSON-LD `text` for Q2.

---

## Issue 2 — A8 overstates uninstall scope (lead's open Q5)

README §535 confirms `--mcp-config` and `--claude-md` are surgical (delimited block only); full wipe requires `--purge`. "Removes everything cleanly" is too absolute. Match the README's actual surface.

```search
Symmetric <code>uninstall</code> removes everything cleanly.
```
```replace
Symmetric <code>uninstall</code> reverses the <code>init</code> actions; <code>--purge</code> wipes the data dir.
```
Update JSON-LD Q8 `text` to match.

---

## Issue 3 — A9 "no replay required" is unverifiable

README never mentions replay (presence or absence). Spec §14.5 only commits to "fail open + restart resumes". Drop the unsupported clause.

```search
<div class="faq-a" data-i18n="faq.a9">Agents fail open and keep working as if uninstalled. Local SQLite resumes on restart, no replay required.</div>
```
```replace
<div class="faq-a" data-i18n="faq.a9">Agents fail open and keep working as if uninstalled. Local SQLite resumes on restart.</div>
```
Update JSON-LD Q9 `text` to match.

---

## Issue 4 — A7 "single-process" claim unverified (lead's implicit concern)

README/synthesis say agents work "in isolation"; neither uses "single-process" about Aider or Cline specifically. Reframe in language the spec actually commits to.

```search
Aider and Cline are single-process with no cross-session awareness. mcp-coordinator gives them shared state via the MQTT broker.
```
```replace
Aider and Cline have no cross-session awareness. mcp-coordinator gives them shared state via the MQTT broker.
```
Update JSON-LD Q7 `text` to match.

---

## Issue 5 — A6 mode names don't match README terminology

README uses LAN-host / internet-facing terminology, not "Local mode" vs "Team or cloud mode" as named modes. Tighten to the auth axis (the actual switch).

```search
<div class="faq-a" data-i18n="faq.a6">Local mode: no. Team or cloud mode: opt-in HS256 JWT via <a href="https://github.com/panva/jose">jose</a>.</div>
```
```replace
<div class="faq-a" data-i18n="faq.a6">Not by default. Opt-in HS256 JWT via <a href="https://github.com/panva/jose">jose</a> for shared or internet-facing deployments.</div>
```
Update JSON-LD Q6 `text` to match.

---

## Issue 6 — Lead's open Q2 (cite GitHub issues)

Recommendation: do NOT add issue links for "roadmap (v1.0)" (Q5) or "fail open" (Q9). The repo at `swoofer/mcp-coordinator` has no public issue tracker entries verified for these claims; dead-link risk outweighs SEO gain. Lead's instinct is right; close the question.

---

## DO NOT TOUCH

- **Q1, Q3, Q4, Q5, Q10**: claims fully verified against README (§§30, 91, 776, 846, 91 push/poll narrative). Wording is crisp.
- **FAQ ordering**: lead's conversion-funnel rationale (filters → sizing → durability) is sound. Reordering would regress.
- **Native `<details>/<summary>` pattern**: meets spec §4.10 a11y + no-JS requirement.
- **Inline `<code>` styling and CSS block**: matches existing tokens. Do not add new CSS variables.
- **Anchor strategy**: spec §4.10 confirms FAQ has no legacy aliases. Do not add `<span class="anchor-alias">`.
- **Decision to drop spec Q8 + Q9**: ownership-table compliant (§2 synthesis). Templates section owns customization; Q3/Q6 cover laptop-only.
- **Glossary terms**: `mcp-coordinator` (lowercase), `MCP client`, `MQTT broker`, `between turns`, `self-hosted` are all verbatim. Preserve.
- **JSON-LD structure**: schema correct. After edits 1-5, only update `text` strings; do not change keys or nesting.

---

**Word count**: 555 / 600.
