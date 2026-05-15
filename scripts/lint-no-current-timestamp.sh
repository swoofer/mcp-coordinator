#!/usr/bin/env bash
# Forbids `CURRENT_TIMESTAMP` in Phase 2 source directories. Phase 2 SQL
# must use explicit `strftime('%s','now')` integers so all timestamp
# columns are unix seconds (epoch-int), not SQLite ISO strings. Phase 1
# baseline files (src/database.ts migration + src/agent-*.ts +
# src/consultation.ts) are out of scope -- this lint targets NEW code
# under src/auth/, src/quota/, src/security/, src/http/, src/tools/.
set -euo pipefail

SCAN_PATHS=("${@:-}")
if [[ -z "${SCAN_PATHS[*]}" ]]; then
  SCAN_PATHS=(src/auth src/quota src/security src/http src/tools)
fi

found_paths=()
for path in "${SCAN_PATHS[@]}"; do
  [[ -d "$path" ]] || continue
  found_paths+=("$path")
done

if [[ ${#found_paths[@]} -eq 0 ]]; then
  echo "lint-no-current-timestamp: no Phase 2 scan paths exist yet; skipping" >&2
  exit 0
fi

echo "lint-no-current-timestamp: scanning ${found_paths[*]}"

matches=$(grep -rnE --include='*.ts' 'CURRENT_TIMESTAMP' "${found_paths[@]}" || true)

if [[ -n "$matches" ]]; then
  count=$(printf '%s\n' "$matches" | grep -c . || true)
  echo "lint-no-current-timestamp: FAIL (${count} violation(s)):" >&2
  printf '%s\n' "$matches" | sed 's/^/  /' >&2
  echo "  -> Phase 2 must use strftime('%s','now') instead of CURRENT_TIMESTAMP." >&2
  exit 1
fi

echo "lint-no-current-timestamp: OK (0 violations)"
