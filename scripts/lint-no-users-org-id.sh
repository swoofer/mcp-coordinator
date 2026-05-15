#!/usr/bin/env bash
# Forbids `users.org_id` references outside the migration baseline.
# Phase 2 renamed users.org_id -> users.primary_org_id; the column
# `users.org_id` only legitimately appears in src/database.ts (migration
# DDL + `users_legacy_v0_7` compat view) and the migration test fixture.
set -euo pipefail

SCAN_PATHS=("${@:-}")
if [[ -z "${SCAN_PATHS[*]}" ]]; then
  SCAN_PATHS=(src tests)
fi

# Allowlist: paths permitted to contain `users.org_id`.
ALLOWLIST=(
  "src/database.ts"
  "tests/unit/migration-v07-to-v08.test.ts"
  "tests/unit/lint-scripts.test.ts"
)

is_allowlisted() {
  local file="$1"
  # Normalize backslashes for Windows Git Bash callers.
  file="${file//\\//}"
  for allowed in "${ALLOWLIST[@]}"; do
    if [[ "$file" == "$allowed" || "$file" == */"$allowed" ]]; then
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
  echo "lint-no-users-org-id: no scan paths exist; skipping" >&2
  exit 0
fi

echo "lint-no-users-org-id: scanning ${found_paths[*]}"

# grep -E for portable extended regex; -rn for recursive + line numbers.
matches=$(grep -rnE --include='*.ts' 'users\.org_id' "${found_paths[@]}" || true)

violations=()
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  file="${line%%:*}"
  if ! is_allowlisted "$file"; then
    violations+=("$line")
  fi
done <<< "$matches"

if [[ ${#violations[@]} -gt 0 ]]; then
  echo "lint-no-users-org-id: FAIL (${#violations[@]} violation(s)):" >&2
  printf '  %s\n' "${violations[@]}" >&2
  exit 1
fi

echo "lint-no-users-org-id: OK (0 violations)"
