#!/usr/bin/env bash
# Orchestrator: runs all Phase 2 lint scripts; exits non-zero if any fail.
# Each lint runs to completion so authors see every violation in one pass,
# not just the first failure.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

LINTS=(
  "lint-no-users-org-id.sh"
  "lint-no-current-timestamp.sh"
  "lint-no-audit-mutation.sh"
  "lint-html-escape.sh"
)

overall_status=0
for lint in "${LINTS[@]}"; do
  echo "::group::${lint}"
  if ! bash "${SCRIPT_DIR}/${lint}"; then
    overall_status=1
  fi
  echo "::endgroup::"
done

if [[ "$overall_status" -ne 0 ]]; then
  echo "lint-run-all: FAIL (one or more lints reported violations)" >&2
else
  echo "lint-run-all: OK (all lints clean)"
fi

exit "$overall_status"
