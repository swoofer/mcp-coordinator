# Contributing to mcp-coordinator

Thanks for considering a contribution.

## Contributor License Grant

By submitting a pull request, comment with code suggestion, or any other contribution to this repository, you certify that:

1. The contribution is your original work, **or** you have explicit permission from the rights holder to submit it.
2. Your contribution is licensed under the [MIT License](./LICENSE), same as the rest of the project.
3. You grant the project maintainer (Maxime Gagnon) and successors a **perpetual, irrevocable, worldwide, royalty-free right** to relicense your contribution under different terms in future versions of the project, including more restrictive or commercial licenses (e.g. BSL, AGPL, source-available, dual-license).

### Why the relicense grant?

The project is MIT today and is expected to stay MIT for the foreseeable future. The grant preserves the **option** to dual-license or pivot to a source-available license later if adoption sustains a commercial track. It does **not** change the terms under which you can use, fork, or redistribute the project as it exists today — all released versions remain MIT, forever.

If your employer's IP policy or your own preference makes this grant unacceptable, please open an issue **before** opening a PR so we can discuss.

This grant is on the same model used by Sentry, HashiCorp, and similar projects before they pivoted to source-available licenses. It is functionally a lightweight inbound-license-grant — no separate CLA signature required; acceptance is by act of contribution.

## Reporting bugs

Open an issue with the "bug" template. Include the version (`mcp-coordinator --version`) and a minimal reproduction (preferably with the server logs and your client config).

## Suggesting features

Open an issue with the "feature" template. Explain the use case before proposing implementation.

## Pull requests

This repo uses [pnpm](https://pnpm.io/) (>=9). Corepack picks the right version automatically from the `packageManager` field in `package.json` — `corepack enable` once and you're set.

1. Fork the repo and create a branch off `main`.
2. Run `pnpm install` then `pnpm test` to confirm baseline passes.
3. Add tests for any new behavior. We use Vitest.
4. Keep commits scoped and follow [Conventional Commits](https://www.conventionalcommits.org/).
5. Open a PR against `main`. CI must pass before review.

## Development

- `pnpm install` (or `pnpm install --frozen-lockfile` to mirror CI exactly)
- `pnpm test` — vitest suite (server + integration).
- `pnpm build` — TypeScript compile to `dist/`.
- `pnpm cli -- server start` — start the server in foreground (port 3100, MQTT 1883 by default).
- `bash scripts/lint-run-all.sh` — runs the same custom lint scripts as CI's `Lint` job (`.github/workflows/lint.yml`): no-users-org-id, no-current-timestamp, no-audit-mutation, html-escape, no-direct-env-in-auth.
- `pnpm exec tsc --noEmit` — the type-check step of the same `Lint` job.

## Architecture

See `README.md` for the high-level model. The server is in `src/`, the CLI in `cli/`, and the static dashboard in `dashboard/public/`. The MQTT broker is embedded (Aedes) and ships with the server.
