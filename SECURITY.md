# Security Policy

This document is mcp-coordinator's vulnerability disclosure policy. It
follows the format GitHub recognizes for the repository's Security tab
and the RFC 9116 contact metadata at `.well-known/security.txt`.

## Supported versions

Security fixes are issued against the latest minor release. Older minors
receive a fix only if the issue is critical (CVSS >= 9.0) and a clean
backport exists.

| Version | Supported          |
| ------- | ------------------ |
| 0.8.x   | Yes                |
| 0.7.x   | Yes (current minor) |
| < 0.7   | No                 |

## Reporting a vulnerability

Email `security@example.com` (replace with the operator's mailbox before
publishing the repo) with:

- A short description of the issue.
- Reproduction steps, including the affected version (`mcp-coordinator
  --version`) and the relevant config (`COORDINATOR_OAUTH_ENABLED`,
  IdP, deployment mode).
- The impact you observed (auth bypass, data disclosure, privilege
  escalation, denial of service, etc.).
- Any proof-of-concept code or HTTP transcripts.

Please **do not** open a public GitHub issue, send a pull request that
discloses the vulnerability in its diff, or post details to public
channels (Discord, Slack, social media) before we have shipped a fix.

A PGP key for encrypting reports is at the URL listed in
`.well-known/security.txt` under `Encryption:` (placeholder until the
operator publishes a key — see RFC 9116 §2.5.4).

## Disclosure timeline

- **Acknowledgement**: we will reply within 7 days that the report was
  received and assigned a tracking ID.
- **Triage**: within 30 days of acknowledgement we will share the severity
  rating (CVSS v3.1), the affected components, and a target fix date.
- **Coordinated disclosure**: 90 days from acknowledgement is the default
  embargo. We will release a fixed version, a CHANGELOG entry, and (where
  applicable) a GitHub Security Advisory and CVE on or before that date.
  We may shorten the embargo for already-public vulnerabilities and may
  extend it (with the reporter's agreement) for fixes that need
  coordinated rollout.

## Scope

In scope:

- Source code under `src/`, `cli/`, `dashboard/`, `scripts/`.
- Dependencies declared in `package.json` (`dependencies` and
  `devDependencies`) when the vulnerability is exploitable through
  mcp-coordinator's documented surface.
- Default configuration as shipped (`.env.example`, `docker-compose.yml`,
  `Dockerfile`).
- Release artifacts on npm and the official container images.

Out of scope:

- Third-party identity providers (GitHub OAuth, future providers). Report
  those to the provider directly.
- Misconfigurations that violate the documented operator guidance
  (running with `COORDINATOR_JWT_SECRET` shorter than 32 bytes, exposing
  the coordinator's HTTP listener to the public internet without TLS
  termination, disabling cookie `Secure` via `COORDINATOR_INSECURE_COOKIES`
  in production).
- Local-machine attacks where the attacker already has filesystem read
  access to `~/.mcp-coordinator/` (see `docs/security/threat-model.md`
  for the trust boundary diagram).
- Denial-of-service via resource exhaustion on a publicly exposed instance
  that bypasses the documented rate limits.
- Vulnerabilities in user-authored MCP servers connected to the
  coordinator. Those have their own security boundaries.

## Hardening recommendations for operators

- Generate `COORDINATOR_JWT_SECRET` from `openssl rand -base64 32` and
  manage it through your secret manager (HashiCorp Vault, AWS Secrets
  Manager, GCP Secret Manager, sealed-secrets, etc.). See
  `docs/ops/key-rotation.md`.
- Front the coordinator with a TLS-terminating reverse proxy (nginx,
  Caddy, Cloudflare). Do **not** rely on `127.0.0.1` binding for
  production — the coordinator is a multi-user service in Phase 2.
- Enable audit log retention monitoring. Tier 1 events (default 365-day
  retention) are the security signal; alert on
  `auth.refresh.chain_revoked` and `auth.refresh.suspicious_replay`.
- Subscribe the operations team to GitHub Security Advisories for this
  repository.

## Threat model and runbooks

The full STRIDE-by-asset threat model is at
`docs/security/threat-model.md`. Incident-response runbooks live in
`docs/ops/`:

- `docs/ops/key-rotation.md` — JWT signing-key rotation procedure.
- `docs/ops/incident-refresh-leak.md` — suspected refresh-token theft.
- `docs/ops/incident-signing-key-leak.md` — compromised
  `COORDINATOR_JWT_SECRET`.

## Hall of fame

Researchers credited with valid disclosures will be listed here once we
have any. We do not currently run a paid bug-bounty program; this section
will be updated if that changes.

## Machine-readable contact

See `.well-known/security.txt` (RFC 9116) for machine-readable contact
metadata.
