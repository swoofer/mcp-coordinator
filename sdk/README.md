# @mcp-coordinator/sdk-js

Minimal TypeScript SDK for the mcp-coordinator Phase 2 OAuth API.

This is the **T40 minimal** release. The package is `"private": true`; it is
**not** published to a registry. Consumers vendor it via:

```bash
npm install file:./path/to/mcp-coordinator/sdk
```

A future T40b release (Phase 5 / v0.8.x) will publish a full-featured client
to npm with keychain integration, file-based token persistence, proactive
refresh jitter, and a single-flight refresh lock. See [Caveats](#caveats).

## Install

From a consumer project, point `npm install` at the local checkout:

```bash
npm install file:../mcp-coordinator/sdk
```

The package ships compiled JS + `.d.ts` files in `dist/`. Build with:

```bash
cd sdk
npm install
npm run build
```

## Quick start

```ts
import { McpCoordinatorClient, UnauthorizedError } from "@mcp-coordinator/sdk-js";

const client = new McpCoordinatorClient({ baseUrl: "https://coord.example.com" });

// Supply tokens obtained via your auth flow (e.g. device flow below).
client.setTokens({
  accessToken: "...",
  refreshToken: "...",
  accessExpiresAt: 1700000000, // unix seconds
});

try {
  const me = await client.whoami();
  console.log(me.email, me.role, me.org.name);
} catch (err) {
  if (err instanceof UnauthorizedError) {
    console.error("Token rejected; re-authenticate.");
  } else {
    throw err;
  }
}
```

## Device-flow example

The SDK exposes one-shot helpers; the caller controls the poll loop so it can
integrate with its own UI / cancellation primitives.

```ts
import { McpCoordinatorClient, OAuthError } from "@mcp-coordinator/sdk-js";

const client = new McpCoordinatorClient({ baseUrl: "https://coord.example.com" });

const device = await client.deviceCodeStart();
console.log("Visit:", device.verification_uri_complete);
console.log("Code:", device.user_code);

let interval = device.interval;
const deadline = Date.now() + device.expires_in * 1000;

while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, interval * 1000));
  const result = await client.deviceCodePoll(device.device_code);

  if ("accessToken" in result) {
    console.log("Logged in");
    // tokens are now stored in the client; client.getTokens() to persist them
    break;
  }

  if (result.status === "pending") continue;
  if (result.status === "slow_down") {
    interval += 5;
    continue;
  }
  if (result.status === "expired" || result.status === "denied") {
    throw new Error(`Device flow ended: ${result.status}`);
  }
}
```

## Token refresh

The SDK refreshes proactively when an access token has under 60 seconds left,
on the next request that goes through `whoami()` (or any other authenticated
verb that calls `maybeRefresh()` internally).

You can also refresh on demand:

```ts
const newSet = await client.refresh();
// persist newSet.refreshToken + newSet.accessExpiresAt to your store
```

`refresh()` throws `OAuthError` (RFC 6749 §5.2) on `400` responses from the
token endpoint -- check `err.oauthError` for the RFC code (e.g.
`invalid_grant`).

## Error handling

Non-OAuth endpoints return the coordinator's `AppErrorEnvelope`
(`{ code, message, request_id, details? }`). The SDK maps these to typed
subclasses of `CoordinatorError`:

| `code`                  | Class                       |
|-------------------------|-----------------------------|
| `UNAUTHORIZED`          | `UnauthorizedError`         |
| `FORBIDDEN`             | `ForbiddenError`            |
| `RATE_LIMITED`          | `RateLimitedError`          |
| `NOT_IN_ALLOWLIST`      | `NotInAllowlistError`       |
| `USER_NOT_PROVISIONED`  | `UserNotProvisionedError`   |
| `LOGIN_LOCKED`          | `LoginLockedError`          |
| `IDP_UNAVAILABLE`       | `IdpUnavailableError`       |
| `IDP_TOKEN_REVOKED`     | `IdpTokenRevokedError`      |
| `INVALID_STATE`         | `InvalidStateError`         |
| `STATE_ALREADY_CONSUMED`| `StateAlreadyConsumedError` |
| `STATE_EXPIRED`         | `StateExpiredError`         |
| `CSRF_FAILED`           | `CsrfFailedError`           |
| `NOT_FOUND`             | `NotFoundError`             |

Any unknown `code` is wrapped in `UnknownCoordinatorError` with the raw code
preserved on `.code`.

`RateLimitedError` and `LoginLockedError` parse the `Retry-After` response
header into `.retryAfterSeconds`:

```ts
import { RateLimitedError } from "@mcp-coordinator/sdk-js";

try {
  await client.whoami();
} catch (err) {
  if (err instanceof RateLimitedError && err.retryAfterSeconds !== null) {
    await new Promise((r) => setTimeout(r, err.retryAfterSeconds! * 1000));
    // retry...
  }
}
```

OAuth token-endpoint errors are surfaced as `OAuthError`:

```ts
import { OAuthError } from "@mcp-coordinator/sdk-js";

try {
  await client.refresh();
} catch (err) {
  if (err instanceof OAuthError && err.oauthError === "invalid_grant") {
    // refresh token rotated out or revoked -- re-auth required
  }
}
```

## Caveats

This is the **minimal** SDK. The following features are deferred to T40b
(Phase 5 / v0.8.x):

- **Keychain integration.** Token persistence is in-memory only. Consumers
  must serialize `client.getTokens()` to their own store (file, OS keychain
  via `keytar`, etc.).
- **Proactive refresh jitter.** The minimal SDK refreshes at T-60s with no
  randomization; fleets of concurrent clients could stampede.
- **Single-flight refresh lock.** No OS-level lock means two concurrent
  refresh calls from the same machine may both spend the refresh token.
- **Discovery doc 24h cache.** Not implemented.
- **Named-profile TOML config.** Not implemented; pass `baseUrl` directly.

Use this SDK for in-repo integration tests or as a starting point for your
own client. For production agents, wait for T40b or extend the client
yourself.

## License

Apache-2.0 (same as the parent project).
