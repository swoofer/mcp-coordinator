# Operations -- automated `COORDINATOR_JWT_SECRET` rotation

This runbook describes how to automate the JWT signing secret rotation
procedure documented in `docs/ops/key-rotation.md`. The coordinator
deliberately does NOT rotate its own secret at runtime -- doing so would
require write access to the operator's secrets manager from inside the
process, which is exactly the privilege escalation rotation is supposed
to prevent.

Instead, automation runs **outside** the coordinator process: a
scheduled job invokes the `mcp-coordinator rotate-jwt-secret` CLI
helper, applies the resulting env values to the secrets manager, and
restarts the coordinator instances.

## The `rotate-jwt-secret` helper

```sh
mcp-coordinator rotate-jwt-secret [--bits 256] [--format env|json|secret-only]
```

What it does:

1. Reads `--bits` (default 256) of crypto-random entropy via
   `crypto.randomBytes` and base64-encodes it.
2. Validates the result against the same entropy floor enforced at boot
   (`assertSecretEntropy`, 128-bit minimum). A broken random source
   that produces all-zero bytes is rejected here rather than slipping
   through to boot.
3. Prints an env-format block containing the new value plus the
   operator workflow steps. Exit 0 on success, 2 on invalid args or
   entropy failure.

What it does NOT do:

- Write to your secrets manager.
- Touch any running coordinator process.
- Read the current secret. The helper is stateless -- you provide the
  current value yourself in step 1 of the workflow it prints.

This separation keeps the helper safe to run from any CI / cron host;
it sees no live secret and writes no files.

## End-to-end automation patterns

### Pattern 1 -- systemd timer + ansible/terraform vault integration

```ini
# /etc/systemd/system/coordinator-jwt-rotate.service
[Unit]
Description=Rotate mcp-coordinator JWT signing secret
After=network.target

[Service]
Type=oneshot
ExecStart=/opt/mcp-coordinator/scripts/rotate-and-apply.sh
User=coordinator-rotator
```

```ini
# /etc/systemd/system/coordinator-jwt-rotate.timer
[Unit]
Description=Rotate mcp-coordinator JWT signing secret every 90 days
[Timer]
OnCalendar=*-*-01 03:00:00
Persistent=true
RandomizedDelaySec=4h
[Install]
WantedBy=timers.target
```

```bash
#!/usr/bin/env bash
# /opt/mcp-coordinator/scripts/rotate-and-apply.sh
set -euo pipefail

# 1. Generate plan as JSON for scripting.
PLAN=$(mcp-coordinator rotate-jwt-secret --format json)
NEW_SECRET=$(echo "$PLAN" | jq -r '.new_secret')
ROTATED_AT=$(echo "$PLAN" | jq -r '.rotated_at_iso')

# 2. Read the current value from the secrets manager.
CURRENT_SECRET=$(vault kv get -field=jwt_secret secret/mcp-coordinator)

# 3. Write _PREV + new value + timestamp.
vault kv put secret/mcp-coordinator \
    jwt_secret="$NEW_SECRET" \
    jwt_secret_prev="$CURRENT_SECRET" \
    jwt_secret_prev_rotated_at="$ROTATED_AT"

# 4. Trigger a rolling restart (your orchestrator's mechanism).
systemctl --user restart coordinator.service

# 5. Schedule the _PREV cleanup for after the refresh-TTL window.
#    Default refresh TTL is 30d; bump to 35d for safety margin.
at now + 35 days <<EOF
vault kv patch secret/mcp-coordinator \
    jwt_secret_prev= \
    jwt_secret_prev_rotated_at=
systemctl --user restart coordinator.service
EOF
```

### Pattern 2 -- Kubernetes CronJob

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: coordinator-jwt-rotate
spec:
  schedule: "0 3 1 */3 *"           # 03:00 UTC, 1st of every 3rd month
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: coordinator-rotator
          restartPolicy: OnFailure
          containers:
          - name: rotator
            image: ghcr.io/swoofer/mcp-coordinator:0.11.0
            command: ["/bin/sh", "-c"]
            args:
            - |
              set -e
              PLAN=$(mcp-coordinator rotate-jwt-secret --format json)
              NEW=$(echo "$PLAN" | jq -r '.new_secret')
              ROTATED=$(echo "$PLAN" | jq -r '.rotated_at_iso')
              CURRENT=$(kubectl get secret coordinator-jwt -o jsonpath='{.data.value}' | base64 -d)
              kubectl create secret generic coordinator-jwt \
                --from-literal=value="$NEW" \
                --from-literal=prev="$CURRENT" \
                --from-literal=prev_rotated_at="$ROTATED" \
                --dry-run=client -o yaml | kubectl apply -f -
              kubectl rollout restart deployment/coordinator
```

A second CronJob (`coordinator-jwt-cleanup`) runs 35 days later to
unset `prev` + `prev_rotated_at` and trigger another rollout.

## Detecting a stuck rotation

A `_PREV` that has been live longer than the refresh-token TTL is
harmless but it widens the window where a leaked old secret could
still produce verifying tokens. The recommended check:

```sh
mcp-coordinator doctor --phase2
```

`doctor` flags rotations where `COORDINATOR_JWT_SECRET_PREV_ROTATED_AT`
is older than `(refresh_ttl + 7d)`. Operators can also alert on the
`config.key_rotation` Tier 1 audit row's `metadata.rotated_at`
timestamp via their log pipeline.

## What this doesn't automate

- **Service-token rotation.** Service tokens have their own admin-driven
  lifecycle (`mcp-coordinator service-token issue`) and a 90-day cap.
  Pipelines that consume service tokens should track their own
  expiration; we have not built a re-issuance helper because the
  expected blast radius of a leaked service token is one CI pipeline,
  and admin re-issuance is intentional friction.
- **State-binding key.** Derived from `COORDINATOR_JWT_SECRET` via
  HKDF; rotates implicitly with the secret.
- **Idp client secrets.** `COORDINATOR_GITHUB_CLIENT_SECRET`,
  `COORDINATOR_GOOGLE_CLIENT_SECRET`, `COORDINATOR_OIDC_CLIENT_SECRET`
  rotate through the IdP's own admin UI; the coordinator just reads
  whatever the secrets manager provides at boot.

## References

- `cli/rotate-jwt-secret.ts` -- the CLI helper.
- `docs/ops/key-rotation.md` -- the underlying manual procedure.
- `src/auth/entropy.ts` -- the 128-bit floor enforced by both boot
  and the helper.
- `docs/security/threat-model.md` -- residual risk #6 (JWT signing
  key rotation) is addressed by this combined workflow.
