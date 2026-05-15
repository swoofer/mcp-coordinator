import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

/**
 * Minimal mock GitHub OAuth IdP for Playwright E2E tests.
 *
 * Why a real HTTP server (not msw / monkey-patched fetch)?
 *   The coordinator runs in a SEPARATE child process (spawned via `tsx
 *   src/serve-http.ts`). We can't reach into its fetch() — we have to point
 *   it at a network endpoint. v0.8.1-P2 added COORDINATOR_GITHUB_AUTH_BASE_URL
 *   and COORDINATOR_GITHUB_API_BASE_URL precisely for this.
 *
 * Endpoints implemented (matches src/auth/providers/github.ts):
 *   - GET  /login/oauth/authorize         → 302 to callback with code+state
 *   - POST /login/oauth/access_token      → JSON token (or pending/granted for device grant)
 *   - GET  /user                          → user info
 *   - GET  /user/emails                   → primary verified email
 *   - GET  /user/orgs                     → org memberships
 *
 * Note: device-flow endpoints are NOT mocked. The coordinator's device-flow
 *   implementation stores device codes in its OWN database and never calls
 *   GitHub's /login/device/code endpoint — the user_code is approved by a
 *   browser-authenticated user via /auth/device/approve (which DOES hit
 *   GitHub for the approver's browser login).
 *
 * Per-test mutable state lives on the returned MockGithub object via setters
 * (setMembershipsResponse, failNextWith) so tests can adjust behaviour
 * without restarting the server.
 */

interface UserResponse {
  id: number;
  login: string;
  email: string | null;
  name: string;
}

interface EmailResponse {
  email: string;
  primary: boolean;
  verified: boolean;
}

interface OrgResponse {
  login: string;
}

interface FailureSpec {
  status: number;
  body: unknown;
}

export interface MockGithub {
  /** Base URL for /login/oauth/* endpoints (passed as COORDINATOR_GITHUB_AUTH_BASE_URL). */
  authBaseUrl: string;
  /** Base URL for /user, /user/emails, /user/orgs (passed as COORDINATOR_GITHUB_API_BASE_URL). */
  apiBaseUrl: string;
  /** Override user info returned by GET /user. */
  setUserResponse: (user: UserResponse) => void;
  /** Override emails returned by GET /user/emails. */
  setEmailsResponse: (emails: EmailResponse[]) => void;
  /** Override orgs returned by GET /user/orgs (default: [{login:"acme"}]). */
  setMembershipsResponse: (orgs: OrgResponse[]) => void;
  /**
   * Inject a one-shot HTTP failure on the next request to any endpoint.
   * Cleared after firing once.
   */
  failNextWith: (status: number, body: unknown) => void;
  /** Gracefully shut down the listener. Safe to call multiple times. */
  close: () => Promise<void>;
}

const DEFAULT_USER: UserResponse = {
  id: 42,
  login: "testuser",
  email: "test@example.com",
  name: "Test User",
};

const DEFAULT_EMAILS: EmailResponse[] = [
  { email: "test@example.com", primary: true, verified: true },
];

const DEFAULT_ORGS: OrgResponse[] = [{ login: "acme" }];

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

/**
 * Start a mock GitHub server on an OS-assigned port and return a handle.
 * The same listener serves both auth and api endpoints; we expose them as
 * separate base URLs because the coordinator's env wiring takes two distinct
 * variables (matches real-world GHES where they CAN diverge).
 */
export async function startMockGithub(): Promise<MockGithub> {
  let user = { ...DEFAULT_USER };
  let emails = [...DEFAULT_EMAILS];
  let orgs = [...DEFAULT_ORGS];
  let oneShotFailure: FailureSpec | null = null;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // One-shot failure injection: consume on first match to any endpoint.
    if (oneShotFailure) {
      const failure = oneShotFailure;
      oneShotFailure = null;
      sendJson(res, failure.status, failure.body);
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    // --- /login/oauth/authorize ---
    // GitHub redirects back to redirect_uri with ?code=<code>&state=<state>.
    // We auto-approve (no user prompt) so the browser flow short-circuits.
    if (path === "/login/oauth/authorize" && method === "GET") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      if (!redirectUri || !state) {
        sendJson(res, 400, { error: "missing redirect_uri or state" });
        return;
      }
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", "mock-code-123");
      callback.searchParams.set("state", state);
      res.writeHead(302, { Location: callback.toString() });
      res.end();
      return;
    }

    // --- /login/oauth/access_token ---
    // Returns a fixed access token. Body params are ignored; the coordinator
    // immediately follows up with /user + /user/emails + /user/orgs.
    if (path === "/login/oauth/access_token" && method === "POST") {
      // Drain the request body — must consume it before responding or Node's
      // client may not see the response (rarely; better safe than sorry).
      req.on("data", () => {});
      req.on("end", () => {
        sendJson(res, 200, {
          access_token: "mock-access-token",
          token_type: "bearer",
          scope: "read:user user:email read:org",
        });
      });
      return;
    }

    // --- /user ---
    if (path === "/user" && method === "GET") {
      sendJson(res, 200, user);
      return;
    }

    // --- /user/emails ---
    if (path === "/user/emails" && method === "GET") {
      sendJson(res, 200, emails);
      return;
    }

    // --- /user/orgs ---
    if (path === "/user/orgs" && method === "GET") {
      sendJson(res, 200, orgs);
      return;
    }

    sendJson(res, 404, { error: "not found", path });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);
    // Listen on 127.0.0.1 (NOT 0.0.0.0) — Windows can sometimes return a 0.0.0.0
    // socket the coordinator child can't fetch back to deterministically.
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    authBaseUrl: baseUrl,
    apiBaseUrl: baseUrl,
    setUserResponse(next) {
      user = next;
    },
    setEmailsResponse(next) {
      emails = next;
    },
    setMembershipsResponse(next) {
      orgs = next;
    },
    failNextWith(status, body) {
      oneShotFailure = { status, body };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
