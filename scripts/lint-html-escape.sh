#!/usr/bin/env bash
# Forbids unescaped ${...} interpolations in src/auth/pages/**/*.ts.
# HTML rendered to the browser must go through escapeHtml() or render()
# (which auto-escapes). False positives are acceptable; false negatives
# (an unescaped interpolation slipping through) are not.
set -euo pipefail

SCAN_PATHS=("${@:-}")
if [[ -z "${SCAN_PATHS[*]}" ]]; then
  SCAN_PATHS=(src/auth/pages)
fi

found_paths=()
for path in "${SCAN_PATHS[@]}"; do
  [[ -d "$path" ]] || continue
  found_paths+=("$path")
done

if [[ ${#found_paths[@]} -eq 0 ]]; then
  echo "lint-html-escape: src/auth/pages not present yet; skipping" >&2
  exit 0
fi

echo "lint-html-escape: scanning ${found_paths[*]}"

# Collect every line containing a ${...} interpolation.
matches=$(grep -rnE --include='*.ts' '\$\{[^}]+\}' "${found_paths[@]}" || true)

violations=()
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  # line format: path:lineno:content
  content="${line#*:*:}"

  # Strip line-end comments to avoid flagging "// note: ${foo}".
  stripped="${content%%//*}"
  [[ "$stripped" =~ \$\{ ]] || continue

  # Allow lines that explicitly route through render(...) -- the
  # auto-escaping template renderer.
  if [[ "$stripped" =~ render\( ]]; then
    continue
  fi

  # Extract each ${...} expression and check each one calls escapeHtml(.
  expressions=$(printf '%s' "$stripped" | grep -oE '\$\{[^}]+\}' || true)
  bad=0
  while IFS= read -r expr; do
    [[ -z "$expr" ]] && continue
    if [[ "$expr" != *"escapeHtml("* ]]; then
      bad=1
      break
    fi
  done <<< "$expressions"

  if [[ "$bad" -eq 1 ]]; then
    violations+=("$line")
  fi
done <<< "$matches"

if [[ ${#violations[@]} -gt 0 ]]; then
  echo "lint-html-escape: FAIL (${#violations[@]} violation(s)):" >&2
  printf '  %s\n' "${violations[@]}" >&2
  echo "  -> Wrap interpolations with escapeHtml(...) or use render(template, vars)." >&2
  exit 1
fi

echo "lint-html-escape: OK (0 violations)"
