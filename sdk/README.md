# @mcp-coordinator/sdk-js

Minimal TypeScript SDK for the mcp-coordinator Phase 2 OAuth API.

This is the **T40 minimal** release. The package is `"private": true`; it is
**not** published to a registry. Consumers vendor it via:

```bash
npm install file:./path/to/mcp-coordinator/sdk
```

T40b (this release, v0.8.x) adds **file-based token persistence**,
**proactive refresh with jitter**, and a **single-flight refresh lock**
for multi-process CLI safety. See
[Persistent storage + proactive refresh](#persistent-storage--proactive-refresh-v08x).
A future T40c release will add OS keychain integration (`keytar`) and
Windows DPAPI for the token file. See [Caveats](#caveats).

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

## Persistent storage + proactive refresh (v0.8.x)

By default the SDK keeps tokens in memory only. For long-lived CLI tools
and MCP servers, configure persistent storage and proactive refresh:

```ts
import {
  McpCoordinatorClient,
  FileTokenStore,
  ProactiveRefresh,
} from "@mcp-coordinator/sdk-js";

const client = new McpCoordinatorClient({
  baseUrl: "https://coordinator.example.com",
  store: new FileTokenStore(), // ~/.mcp-coordinator/tokens.json (chmod 0600)
  refreshStrategy: new ProactiveRefresh(120, 30), // refresh at T-2min +/- 30s
  refreshLockPath: "~/.mcp-coordinator/refresh.lock", // multi-process safe
});

await client.loadFromStore(); // restore tokens from disk on startup
// ... use client normally ...
client.dispose(); // cancel proactive-refresh timer on app shutdown
```

`FileTokenStore` writes the JSON token set with `chmod 0600` on POSIX
(no Windows DPAPI yet -- that's T40c). The parent directory is created
with `chmod 0700` on POSIX. Writes are atomic via write-to-tmp + rename
to prevent partial writes on crash.

`ProactiveRefresh(leadSeconds, jitterSeconds)` schedules a refresh at
`accessExpiresAt - leadSeconds +/- jitterSeconds`. The jitter prevents
thundering-herd refreshes when many CLI instances share a vendored
`tokens.json` and hit their first refresh simultaneously.

`refreshLockPath` enables a single-flight lock around the refresh call
(atomic `O_EXCL` file create + stale-lock recovery). After acquiring
the lock, the SDK re-reads the store and adopts a freshly-refreshed
TokenSet if another process beat it to the punch -- avoiding redundant
refresh round-trips and protecting against double-spending the refresh
token in racey CLI matrices.

A `MemoryTokenStore` is also exported for tests and ephemeral CLI runs:

```ts
import { MemoryTokenStore } from "@mcp-coordinator/sdk-js";
const store = new MemoryTokenStore();
```

## Caveats

The following features are deferred to T40c (a future release):

- **Keychain integration.** `keytar` / OS keychain backend.
- **Windows DPAPI.** Encrypted-at-rest token file on Windows.
- **Discovery doc 24h cache.** Not implemented.
- **Named-profile TOML config.** Not implemented; pass `baseUrl` directly.
- **Sliding-token-life heuristics.** No adaptive lead based on observed
  drift between successive refreshes.

For shared filesystems / multi-user systems, prefer `MemoryTokenStore`
plus an OS-keychain wrapper of your own until T40c lands.

## License

Apache-2.0 (same as the parent project).
