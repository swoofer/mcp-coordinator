#!/usr/bin/env bash
# Forbids `UPDATE audit_log` / `DELETE FROM audit_log` outside the
# retention sweeper. Audit logs are append-only by design (spec §15.2);
# the only legitimate writers are INSERTs from audit() and the sweeper's
# bounded TTL deletion. The migration file may contain backfill writes.
set -euo pipefail

SCAN_PATHS=("${@:-}")
if [[ -z "${SCAN_PATHS[*]}" ]]; then
  SCAN_PATHS=(src)
fi

# Allowlist: paths permitted to mutate audit_log.
ALLOWLIST_PREFIXES=(
  "src/database.ts"
  "src/sweeper/"
)

is_allowlisted() {
  local file="$1"
  file="${file//\\//}"
  for prefix in "${ALLOWLIST_PREFIXES[@]}"; do
    if [[ "$file" == "$prefix"* || "$file" == *"/$prefix"* ]]; then
      return 0
    fi
  done
  return 1
}

found_paths=()
for path in "${SCAN_PATHS[@]}"; do
  [[ -d "$path" ]] || continue
  found_paths+=("$path")
done

if [[ ${#found_paths[@]} -eq 0 ]]; then
  echo "lint-no-audit-mutation: no scan paths exist; skipping" >&2
  exit 0
fi

echo "lint-no-audit-mutation: scanning ${found_paths[*]}"

matches=$(grep -rnE --include='*.ts' '(UPDATE[[:space:]]+audit_log|DELETE[[:space:]]+FROM[[:space:]]+audit_log)' "${found_paths[@]}" || true)

violations=()
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  file="${line%%:*}"
  if ! is_allowlisted "$file"; then
    violations+=("$line")
  fi
done <<< "$matches"

if [[ ${#violations[@]} -gt 0 ]]; then
  echo "lint-no-audit-mutation: FAIL (${#violations[@]} violation(s)):" >&2
  printf '  %s\n' "${violations[@]}" >&2
  echo "  -> audit_log is append-only; mutations only allowed in src/sweeper/." >&2
  exit 1
fi

echo "lint-no-audit-mutation: OK (0 violations)"
