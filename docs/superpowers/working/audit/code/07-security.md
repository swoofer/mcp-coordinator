# Security Audit — mcp-coordinator

**Score: 4 / 10** — JWT/HS256 setup is competent and registration-secret comparison is constant-time, but auth is bypassable when disabled, every MCP tool ships with no semantic input validation, the dashboard route has a path traversal, CORS is wide open with credentials-bearing endpoints, errors leak internals, and the embedded MQTT broker accepts anyone.

---

## Vulnerabilities

### V1 — Path Traversal in Dashboard Handler [HIGH]
`src/serve-http.ts:687-690`
```ts
const filePath = url === "/dashboard" || url === "/dashboard/"
  ? path.join(dashboardDir, "index.html")
  : path.join(dashboardDir, url.replace("/dashboard/", ""));
if (existsSync(filePath)) { ... readFileSync(filePath, "utf-8") ... }
```
`url.replace("/dashboard/", "")` strips one prefix then concatenates. `GET /dashboard/..%2F..%2F..%2Fdata%2Fdb.sqlite` (or, since URL is not decoded by the parser the same way, `/dashboard/../../package.json`) yields an absolute path outside `dashboardDir`. No `path.resolve` + `startsWith(dashboardDir)` guard. The handler runs **before** the AUTH_ENABLED gate (line 678 vs 759), so the leak is unauthenticated. **Exploit**: read JWT secret from a leaked `.env`, source files, SQLite DB.

### V2 — Auth Disabled by Default = Total Bypass [HIGH]
`src/serve-http.ts:43, 643, 712-717`
`AUTH_ENABLED` defaults to `false`. When false, `/api/auth/*` returns 501 (good) but every `/api/*` (including `/api/reset` which **wipes the database**, `/api/auth/revoke` semantics aside, plus all coordination endpoints) is reachable with zero credentials. The `ADMIN_ONLY_ROUTES` check in `auth.ts:81` is only consulted inside `authenticateRequest`, which is only called when `AUTH_ENABLED`. **Exploit**: anyone reaching the port can `curl -XPOST /api/reset` and erase agents/threads/events.

### V3 — Embedded MQTT Broker Has No Auth [HIGH]
`src/mqtt-broker.ts:59-92`
`Aedes.createBroker()` is used with no `authenticate`, `authorizePublish`, or `authorizeSubscribe` hooks. The TCP listener binds to 127.0.0.1 (mitigation), but the WebSocket bridge attaches to the **same** HTTP server (line 100-105) on whatever interface the HTTP listener uses (default `0.0.0.0`). Any WS client can subscribe to all coordination topics, publish forged `task_claimed` / `consultation` events, and impersonate agents — bypassing JWT entirely.

### V4 — No Input Validation Beyond Type Coercion on REST/MCP [HIGH]
`src/server-setup.ts:116-522` and `src/serve-http.ts:101-505`
MCP tools use `z.string()` / `z.array(z.string())` with no `.min()`, `.max()`, regex, or enum constraints (except `type` on `post_to_thread`). `set_dependency_map` does `JSON.parse(modules)` then `depMap.setMap(map)` — **prototype pollution** via `{"__proto__": {...}}` is fully open if `setMap` does any merge/assign. The REST handlers cast bodies with `as { ... }` and trust them; e.g. `handleRest` reads `agent_id` and passes it straight to SQL via prepared statements (parameterized — good), but `JSON.parse(t.expected_respondents)` (lines 199, 339, 408, 467) on DB-stored, originally-client-controlled JSON can throw and 500 if a prior write injected garbage.

### V5 — CORS Wildcard Combined with Bearer-Auth Endpoints [MEDIUM]
`src/serve-http.ts:68, 668-672`
`Access-Control-Allow-Origin: *` is set on every JSON response and the OPTIONS preflight allows `Authorization`. With wildcard origin browsers refuse to send cookies, but they will happily send `Authorization` headers from a malicious page once a token is in JS context (e.g. dashboard XSS). Combined with V1 (read source) and V6 (error leak) any cross-origin agent script can call `/api/reset`, `/api/auth/revoke`, etc.

### V6 — Error Responses Echo Internal Exception Messages [MEDIUM]
`src/serve-http.ts:774-777` and `:551`
```ts
} catch (err) {
  json(res, { error: (err as Error).message }, 500);
}
```
SQLite errors, file-system errors (`ENOENT /Users/gagno/...`), and stack-shaped messages reach the client. Helps map filesystem layout, DB schema, and confirm path-traversal hits. The `/api/auth/refresh` catch-all also collapses jose error variants into a single message but the generic 500 above does not.

### V7 — JWT Algorithm Not Pinned on Verify [MEDIUM]
`src/auth.ts:40, 56`
`jwtVerify(token, signingKey)` is called without `{ algorithms: ["HS256"] }`. jose v6 does default to enforcing the header, but explicit allow-listing is the contract. More importantly, `initAuth` accepts any secret length — the 32-char check is enforced **only** in the startup branch in `serve-http.ts:644`; programmatic callers (CLI, tests, future embedders) can call `initAuth("short")` and create downgrade conditions.

### V8 — `/api/auth/refresh` Accepts Expired Tokens Forever Within Grace [LOW-MEDIUM]
`src/auth.ts:47-68`
`gracePeriod = "1h"` is fixed, not enforced as a max age past `exp`. A leaked token can be refreshed indefinitely as long as the attacker keeps refreshing within the grace window — there's no `iat`-based absolute lifetime, and revocation only blocks the `sub` if explicitly listed in `revoked_agents`. Compounds because `/api/auth/revoke` requires a valid admin token (admin secret leak from V1 = game over).

---

## Three Must-Fix Patches

**P1 — Sandbox the dashboard handler (fixes V1):**
```ts
const decoded = decodeURIComponent(url.replace("/dashboard/", ""));
const filePath = path.resolve(dashboardDir, decoded);
if (!filePath.startsWith(path.resolve(dashboardDir) + path.sep)) {
  json(res, { error: "forbidden" }, 403); return;
}
```
Also move the dashboard branch **after** the auth gate, or keep it pre-auth but explicitly whitelist extensions (`.html .js .css`) and strip `..` segments.

**P2 — Fail closed when secrets are missing (fixes V2):**
Default `AUTH_ENABLED` to `true` in production builds, or refuse to start when `NODE_ENV=production` and any of `JWT_SECRET / REGISTRATION_SECRET / ADMIN_SECRET` is empty. Gate `/api/reset` behind admin auth even when `AUTH_ENABLED=false` (or remove it from prod entirely).

**P3 — Lock down the MQTT broker (fixes V3) and pin JWT alg (fixes V7):**
```ts
broker.authenticate = (client, username, password, cb) => {
  verifyToken(password?.toString() ?? "")
    .then(c => cb(null, !isRevoked(c.sub)))
    .catch(() => cb(new Error("Auth failed"), false));
};
broker.authorizePublish = (client, packet, cb) =>
  cb(packet.topic.startsWith(`agents/${client!.id}/`) ? null : new Error("forbidden"));
```
And in `auth.ts`: `jwtVerify(token, signingKey, { algorithms: ["HS256"] })` plus assert `secret.length >= 32` inside `initAuth`.

DONE: `C:\Users\gagno\projet\mcp-coordinator-new\docs\superpowers\working\audit\code\07-security.md`
