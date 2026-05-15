# @mcp-coordinator/sdk-js

Minimal TypeScript SDK for the mcp-coordinator Phase 2 OAuth API.

This is the **T40 minimal** release. The package is `"private": true`; it is
**not** published to a registry. Consumers vendor it via:

```bash
npm install file:./path/to/mcp-coordinator/sdk
```

T40b (v0.8.x) added **file-based token persistence**, **proactive
refresh with jitter**, and a **single-flight refresh lock** for
multi-process CLI safety. See
[Persistent storage + proactive refresh](#persistent-storage--proactive-refresh-v08x).
T40c (this release) adds **named-profile TOML config** and a
**24h discovery-doc cache** so the SDK reads OAuth endpoints from the
coordinator's `.well-known/oauth-authorization-server` rather than
hardcoding them. See
[Named profiles + discovery cache](#named-profiles--discovery-cache-v08x).
T40d (this release) adds **opt-in OS keychain integration** via a
lazy-loaded `keytar` adapter (`KeytarTokenStore`). The SDK does not
bundle `keytar`; operators install it in their own project. See
[OS keychain via keytar (opt-in)](#os-keychain-via-keytar-opt-in).

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

`FileTokenStore` writes the JSON token set with `chmod 0600` on POSIX.
On Windows the default ACL applies; for encrypted-at-rest token storage
on Windows, use `KeytarTokenStore` (Credential Manager wraps DPAPI
internally -- see [OS keychain via keytar (opt-in)](#os-keychain-via-keytar-opt-in)).
The parent directory is created with `chmod 0700` on POSIX. Writes are
atomic via write-to-tmp + rename to prevent partial writes on crash.

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

### OS keychain via keytar (opt-in)

For CLI tools that want native OS keychain integration (Windows
Credential Manager, macOS Keychain, Linux libsecret), install `keytar`
separately and use `KeytarTokenStore`:

```bash
npm install keytar
```

```ts
import { McpCoordinatorClient, KeytarTokenStore } from "@mcp-coordinator/sdk-js";

const client = new McpCoordinatorClient({
  baseUrl: "https://coordinator.example.com",
  store: new KeytarTokenStore({ account: "prod" }), // one keychain entry per profile
});
```

If keytar isn't installed, the first `store.load()` call throws
`KeytarUnavailableError` with install instructions. Operators on
locked-down systems (no native compiler) should use `FileTokenStore`
instead -- no security compromise since `FileTokenStore` writes 0600 +
atomic rename.

The SDK does NOT bundle keytar (avoids cross-platform native-build pain
for users who don't need it). Token set is stored as a single JSON blob
under `(serviceName, account)`; default `serviceName = "mcp-coordinator"`
and `account = "default"`. Override `account` per profile for
multi-tenant CLI installs.

## Named profiles + discovery cache (v0.8.x)

### Named-profile TOML config

Operators can define multiple coordinator profiles (e.g. `default`,
`staging`, `prod`) in `~/.mcp-coordinator/config.toml`:

```toml
[profile.default]
base_url = "https://dev-coord.example.com"
client_id = "cli_dev"

[profile.staging]
base_url = "https://staging-coord.example.com"
client_id = "cli_staging"
tokens_path = "/var/lib/mcp/staging-tokens.json"  # custom per-profile

[profile.prod]
base_url = "https://coord.example.com"
client_id = "cli_prod"
```

Load a profile at startup and feed its fields into the client:

```ts
import { loadProfile, McpCoordinatorClient, FileTokenStore } from "@mcp-coordinator/sdk-js";

const profile = await loadProfile(); // env MCP_COORDINATOR_PROFILE || "default"
if (!profile) throw new Error("No ~/.mcp-coordinator/config.toml found");

const client = new McpCoordinatorClient({
  baseUrl: profile.base_url!,
  store: new FileTokenStore({ filePath: profile.tokens_path }),
});
```

Profile selection precedence (highest first):

1. `loadProfile({ profileName: "..." })` argument
2. `MCP_COORDINATOR_PROFILE` environment variable
3. `"default"`

The parser supports only a minimal subset of TOML: `[profile.NAME]`
sections containing `key = "string"` (double- or single-quoted) lines,
inline `#` comments, blank lines, and the escape sequences `\n`, `\t`,
`\r`, `\"`, `\\`. Arrays, nested tables, datetimes, numeric literals,
and multi-line strings are rejected with a `TomlParseError` carrying
the offending line number. Operators who need richer config can
pre-process with a real TOML library and emit the simple subset.

A missing config file returns `null` (operator simply isn't using profile
config). A missing named profile throws `ProfileNotFoundError`, exposing
`.profileName` and `.available` for friendly CLI error messages.

### Discovery doc 24h cache

`DiscoveryCache` wraps `GET ${baseUrl}/.well-known/oauth-authorization-server`
with an in-memory + on-disk cache (default 24h TTL,
`~/.mcp-coordinator/discovery-cache.json`). When passed to the client,
endpoint paths are resolved from the discovery document rather than
hardcoded -- so a future endpoint move on the coordinator won't break
existing SDK installs.

```ts
import { DiscoveryCache, McpCoordinatorClient } from "@mcp-coordinator/sdk-js";

const discovery = new DiscoveryCache({ baseUrl: "https://coord.example.com" });
const client = new McpCoordinatorClient({
  baseUrl: "https://coord.example.com",
  discovery,
});
```

Behavior:

- **First call** fetches over the network and persists to disk (atomic
  write-to-tmp + rename).
- **Subsequent calls within 24h** return the in-memory copy without
  network traffic.
- **After TTL expiry**, the next call refetches.
- **Network failure with a cached value**, even a stale one, returns the
  last-known doc (stale-on-error). With no cache, the error propagates.
- **Cache is keyed by `baseUrl`**, so switching profiles to a different
  coordinator triggers a fresh fetch and ignores stale entries from
  other deployments.

The client only delegates `token_endpoint`,
`device_authorization_endpoint`, `revocation_endpoint`, and
`userinfo_endpoint` (with hardcoded fallback when it's absent) to the
discovery doc. The browser-facing `/auth/login` and the
`/api/auth/logout` and `/api/auth/logout-all` paths (not part of the
OAuth metadata schema) remain hardcoded.

Opt-in: when `discovery` is unset on `McpCoordinatorClient`, the prior
hardcoded paths are used (no behavior change).

## Caveats

The following enhancements remain deferred:

- **Sliding-token-life heuristics.** No adaptive lead based on observed
  drift between successive refreshes.

Windows DPAPI is not implemented as a separate adapter -- `keytar` on
Windows already wraps the Credential Manager (which uses DPAPI
internally), so `KeytarTokenStore` covers that use case. For shared
filesystems / multi-user systems, prefer `KeytarTokenStore` (after
`npm install keytar`) over `FileTokenStore`.

## License

Apache-2.0 (same as the parent project).
