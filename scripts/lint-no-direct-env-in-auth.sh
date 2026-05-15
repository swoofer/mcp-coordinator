#!/usr/bin/env bash
# Forbids direct process.env.COORDINATOR_ reads in auth/cli/admin code.
# Every Phase 2 config read must flow through src/auth/org-settings.ts
# (getOrgSetting), which provides per-org overrides + env fallback per
# V3 §4.4 SaaS-evolution requirement. Boot validation (T29) and the
# shim itself are exempt.
set -euo pipefail

SCAN_PATHS=("${@:-}")
if [[ -z "${SCAN_PATHS[*]}" ]]; then
  SCAN_PATHS=(src/auth src/cli src/admin)
fi

found_paths=()
for path in "${SCAN_PATHS[@]}"; do
  [[ -d "$path" ]] || continue
  found_paths+=("$path")
done

if [[ ${#found_paths[@]} -eq 0 ]]; then
  echo "lint-no-direct-env-in-auth: scan paths not present yet; skipping" >&2
  exit 0
fi

echo "lint-no-direct-env-in-auth: scanning ${found_paths[*]}"

# Allowed files (the shim itself, T29 boot validation, and the
# pre-shim getCookieSecureFlag() escape hatch which has no db handle
# in scope at its call sites; refactoring is out of scope for T44).
allowlist=(
  "src/auth/org-settings.ts"
  "src/auth/cookies.ts"
  "src/boot.ts"
)

matches=$(grep -rnE --include='*.ts' 'process\.env\.COORDINATOR_' "${found_paths[@]}" || true)

violations=()
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  # Strip trailing `:LINENO:content` to extract the file path. Using
  # `${line%%:*}` would break on Windows drive letters (`C:\...`).
  file="${line%:*}"
  file="${file%:*}"
  # Normalize Windows backslashes for cross-platform allowlist match.
  normalized="${file//\\//}"
  allowed=0
  for allow in "${allowlist[@]}"; do
    if [[ "$normalized" == "$allow" || "$normalized" == */"$allow" ]]; then
      allowed=1
      break
    fi
  done
  [[ "$allowed" -eq 1 ]] && continue
  violations+=("$line")
done <<< "$matches"

if [[ ${#violations[@]} -gt 0 ]]; then
  echo "lint-no-direct-env-in-auth: FAIL (${#violations[@]} violation(s)):" >&2
  printf '  %s\n' "${violations[@]}" >&2
  echo "  -> Use getOrgSetting(db, orgId, key, default) from src/auth/org-settings.ts instead." >&2
  exit 1
fi

echo "lint-no-direct-env-in-auth: OK (0 violations)"
