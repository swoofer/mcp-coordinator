# Contributing to mcp-coordinator

Thanks for considering a contribution.

## Reporting bugs

Open an issue with the "bug" template. Include the version (`mcp-coordinator --version`) and a minimal reproduction (preferably with the server logs and your client config).

## Suggesting features

Open an issue with the "feature" template. Explain the use case before proposing implementation.

## Pull requests

1. Fork the repo and create a branch off `main`.
2. Run `npm install` then `npm test` to confirm baseline passes.
3. Add tests for any new behavior. We use Vitest.
4. Keep commits scoped and follow [Conventional Commits](https://www.conventionalcommits.org/).
5. Open a PR against `main`. CI must pass before review.

## Development

- `npm install`
- `npm test` — vitest suite (server + integration).
- `npm run build` — TypeScript compile to `dist/`.
- `npm run cli -- server start` — start the server in foreground (port 3100, MQTT 1883 by default).

## Architecture

See `README.md` for the high-level model. The server is in `src/`, the CLI in `cli/`, and the static dashboard in `dashboard/public/`. The MQTT broker is embedded (Aedes) and ships with the server.
