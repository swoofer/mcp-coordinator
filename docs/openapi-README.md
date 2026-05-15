# OpenAPI spec — Phase 2 Auth API

`docs/openapi.yaml` is a hand-written OpenAPI 3.1 description of the
Phase 2 auth surface (16 routes — OAuth, device flow, sessions, admin,
HTML pages, ops).

## Why hand-written?

V2 §C.13 originally specified "hand-write from per-endpoint zod schemas".
The actual handlers don't use zod for HTTP request/response bodies (zod
is used in T05 only for parsing IdP responses), so there is no
runtime-derivable schema to project from. The spec is written directly
from the source, and each operation's `description` cites the
implementing task ID and source file.

## Scope

In scope: every Phase 2 route registered in `src/http/auth-routes.ts`
plus T36 health probes, T37 metrics, and T14 discovery.

Out of scope:
- Phase 1 REST + MCP routes (documented elsewhere).
- Per-org-scoped endpoint variants (Phase 5).
- Code samples per language (belong in SDK docs).

## How to render

Any standards-compliant viewer works:

```bash
# Quick local preview (one of):
npx @redocly/cli preview-docs docs/openapi.yaml
npx swagger-ui-watcher docs/openapi.yaml

# Or open in any OpenAPI 3.1-aware tool: Stoplight Studio, Insomnia,
# Postman, Swagger Editor, etc.
```

## How to validate

```bash
# Schema validation (recommended):
npx @apidevtools/swagger-cli validate docs/openapi.yaml

# Or basic YAML parse only:
python -c "import yaml; yaml.safe_load(open('docs/openapi.yaml'))"
node -e "require('js-yaml').load(require('fs').readFileSync('docs/openapi.yaml','utf8'))"
```

## How to regenerate

Currently this is a hand-maintained artifact. When a Phase 2 handler
changes its response shape, status code set, or path, update the
corresponding operation block in `docs/openapi.yaml` and bump
`info.version` if the change is observable to clients.

A future auto-generation pass (deferred per V2 §C.13 out-of-scope
list) would derive request/response shapes from runtime introspection
of the handler functions.
