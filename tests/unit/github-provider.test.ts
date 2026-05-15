import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { GitHubProvider } from "../../src/auth/providers/github.js";
import { IdPTokenRevoked, IdPTransientError } from "../../src/auth/providers/errors.js";

const CLIENT_ID = "client123";
const CLIENT_SECRET = "secret456";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeProvider(): GitHubProvider {
  return new GitHubProvider({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
}

describe("GitHubProvider.buildAuthUrl", () => {
  it("includes all required params and encodes redirectUri", () => {
    const p = makeProvider();
    const url = p.buildAuthUrl("state-xyz", "https://app.example.com/cb?x=1&y=2");
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(parsed.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(parsed.searchParams.get("state")).toBe("state-xyz");
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://app.example.com/cb?x=1&y=2");
    expect(parsed.searchParams.get("scope")).toBe("read:user user:email read:org");
    // Raw query string must be percent-encoded (URLSearchParams handles this).
    expect(url).toContain("redirect_uri=https%3A%2F%2Fapp.example.com%2Fcb%3Fx%3D1%26y%3D2");
  });

  it("includes code_challenge + code_challenge_method=S256 when codeChallenge provided", () => {
    const p = makeProvider();
    const url = p.buildAuthUrl("state-xyz", "https://app.example.com/cb", "CHALLENGE_VAL");
    const parsed = new URL(url);
    expect(parsed.searchParams.get("code_challenge")).toBe("CHALLENGE_VAL");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("omits PKCE params when codeChallenge absent", () => {
    const p = makeProvider();
    const url = p.buildAuthUrl("state-xyz", "https://app.example.com/cb");
    const parsed = new URL(url);
    expect(parsed.searchParams.has("code_challenge")).toBe(false);
    expect(parsed.searchParams.has("code_challenge_method")).toBe(false);
  });

  it("respects authBaseUrl override (GHES)", () => {
    const p = new GitHubProvider({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      authBaseUrl: "https://ghe.example.com",
    });
    const url = p.buildAuthUrl("s", "https://app/cb");
    expect(url.startsWith("https://ghe.example.com/login/oauth/authorize?")).toBe(true);
  });
});

describe("GitHubProvider.exchangeCode", () => {
  it("happy path: returns user with primary verified email", async () => {
    server.use(
      http.post("https://github.com/login/oauth/access_token", () =>
        HttpResponse.json({ access_token: "tok-abc", token_type: "bearer", scope: "read:user" }),
      ),
      http.get("https://api.github.com/user", () =>
        HttpResponse.json({ id: 42, login: "alice", email: null, name: "Alice Wonder" }),
      ),
      http.get("https://api.github.com/user/emails", () =>
        HttpResponse.json([
          { email: "other@example.com", primary: false, verified: true },
          { email: "alice@example.com", primary: true, verified: true },
          { email: "unver@example.com", primary: false, verified: false },
        ]),
      ),
    );
    const p = makeProvider();
    const result = await p.exchangeCode("code-xyz", "https://app/cb", "verifier");
    expect(result.accessToken).toBe("tok-abc");
    expect(result.user.idp_user_id).toBe("42");
    expect(result.user.email).toBe("alice@example.com");
    expect(result.user.name).toBe("Alice Wonder");
  });

  it("falls back to first verified email when no primary verified", async () => {
    server.use(
      http.post("https://github.com/login/oauth/access_token", () =>
        HttpResponse.json({ access_token: "tok-abc", token_type: "bearer" }),
      ),
      http.get("https://api.github.com/user", () =>
        HttpResponse.json({ id: 7, login: "bob", email: null, name: null }),
      ),
      http.get("https://api.github.com/user/emails", () =>
        HttpResponse.json([
          { email: "unver@example.com", primary: true, verified: false },
          { email: "ok@example.com", primary: false, verified: true },
        ]),
      ),
    );
    const p = makeProvider();
    const result = await p.exchangeCode("code-xyz", "https://app/cb");
    expect(result.user.email).toBe("ok@example.com");
    expect(result.user.name).toBeUndefined();
  });

  it("falls back to user.email when no verified email exists", async () => {
    server.use(
      http.post("https://github.com/login/oauth/access_token", () =>
        HttpResponse.json({ access_token: "tok-abc", token_type: "bearer" }),
      ),
      http.get("https://api.github.com/user", () =>
        HttpResponse.json({ id: 7, login: "bob", email: "public@example.com", name: null }),
      ),
      http.get("https://api.github.com/user/emails", () =>
        HttpResponse.json([
          { email: "unver@example.com", primary: true, verified: false },
        ]),
      ),
    );
    const p = makeProvider();
    const result = await p.exchangeCode("code-xyz", "https://app/cb");
    expect(result.user.email).toBe("public@example.com");
  });

  it("throws when no usable email", async () => {
    server.use(
      http.post("https://github.com/login/oauth/access_token", () =>
        HttpResponse.json({ access_token: "tok", token_type: "bearer" }),
      ),
      http.get("https://api.github.com/user", () =>
        HttpResponse.json({ id: 1, login: "x", email: null, name: null }),
      ),
      http.get("https://api.github.com/user/emails", () => HttpResponse.json([])),
    );
    const p = makeProvider();
    await expect(p.exchangeCode("c", "https://app/cb")).rejects.toThrow(/no verified email/);
  });

  it("4xx on token endpoint throws generic error (not transient/revoked)", async () => {
    server.use(
      http.post("https://github.com/login/oauth/access_token", () =>
        HttpResponse.json({ error: "bad_verification_code" }, { status: 400 }),
      ),
    );
    const p = makeProvider();
    await expect(p.exchangeCode("c", "https://app/cb")).rejects.toThrow(/GitHub HTTP 400/);
  });

  it("401 on /user throws IdPTokenRevoked", async () => {
    server.use(
      http.post("https://github.com/login/oauth/access_token", () =>
        HttpResponse.json({ access_token: "tok", token_type: "bearer" }),
      ),
      http.get("https://api.github.com/user", () => new HttpResponse(null, { status: 401 })),
    );
    const p = makeProvider();
    await expect(p.exchangeCode("c", "https://app/cb")).rejects.toBeInstanceOf(IdPTokenRevoked);
  });

  it("5xx on /user/emails throws IdPTransientError (after one retry)", async () => {
    let userEmailsCalls = 0;
    server.use(
      http.post("https://github.com/login/oauth/access_token", () =>
        HttpResponse.json({ access_token: "tok", token_type: "bearer" }),
      ),
      http.get("https://api.github.com/user", () =>
        HttpResponse.json({ id: 1, login: "x", email: null, name: null }),
      ),
      http.get("https://api.github.com/user/emails", () => {
        userEmailsCalls++;
        return new HttpResponse(null, { status: 503 });
      }),
    );
    const p = makeProvider();
    await expect(p.exchangeCode("c", "https://app/cb")).rejects.toBeInstanceOf(IdPTransientError);
    expect(userEmailsCalls).toBe(2);
  });
});

describe("GitHubProvider.listMemberships", () => {
  it("happy path: returns array of org logins", async () => {
    server.use(
      http.get("https://api.github.com/user/orgs", () =>
        HttpResponse.json([{ login: "org-a" }, { login: "Org-B" }]),
      ),
    );
    const p = makeProvider();
    const result = await p.listMemberships("tok");
    // Case-preserved per spec (lowercase normalization is membership-cache's job).
    expect(result).toEqual(["org-a", "Org-B"]);
  });

  it("paginates: follows Link rel=next header and concatenates", async () => {
    let calls = 0;
    server.use(
      http.get("https://api.github.com/user/orgs", () => {
        calls++;
        if (calls === 1) {
          return HttpResponse.json([{ login: "org-1" }], {
            headers: {
              Link: '<https://api.github.com/user/orgs?page=2&per_page=100>; rel="next", <https://api.github.com/user/orgs?page=3>; rel="last"',
            },
          });
        }
        if (calls === 2) {
          return HttpResponse.json([{ login: "org-2" }, { login: "org-3" }], {
            headers: {
              Link: '<https://api.github.com/user/orgs?page=3&per_page=100>; rel="next"',
            },
          });
        }
        return HttpResponse.json([{ login: "org-4" }]);
      }),
    );
    const p = makeProvider();
    const result = await p.listMemberships("tok");
    expect(result).toEqual(["org-1", "org-2", "org-3", "org-4"]);
    expect(calls).toBe(3);
  });

  it("no Link header => single page", async () => {
    server.use(
      http.get("https://api.github.com/user/orgs", () => HttpResponse.json([{ login: "solo" }])),
    );
    const p = makeProvider();
    const result = await p.listMemberships("tok");
    expect(result).toEqual(["solo"]);
  });

  it("Link header without rel=next => stops paging", async () => {
    server.use(
      http.get("https://api.github.com/user/orgs", () =>
        HttpResponse.json([{ login: "only" }], {
          headers: {
            Link: '<https://api.github.com/user/orgs?page=1>; rel="first"',
          },
        }),
      ),
    );
    const p = makeProvider();
    const result = await p.listMemberships("tok");
    expect(result).toEqual(["only"]);
  });

  it("listMemberships ignores malformed Link rel=next URL (URL parse failure)", async () => {
    // If the upstream serves a syntactically invalid URL in rel="next",
    // parseNextLink's `new URL()` throws — the catch must end pagination
    // rather than propagate. No second handler registered: msw's
    // onUnhandledRequest: "error" would fail the test on any extra request.
    let calls = 0;
    server.use(
      http.get("https://api.github.com/user/orgs", () => {
        calls++;
        return HttpResponse.json([{ login: "only-page" }], {
          headers: {
            Link: '<not a valid url>; rel="next"',
          },
        });
      }),
    );
    const p = makeProvider();
    const result = await p.listMemberships("tok");
    expect(result).toEqual(["only-page"]);
    expect(calls).toBe(1);
  });

  it("listMemberships ignores Link header pointing to a different host (SSRF guard)", async () => {
    // A compromised upstream (or MITM in a GHES deployment) could return a
    // cross-origin rel="next" URL. fetchWithRetry attaches the OAuth Bearer
    // token unconditionally, so following such a URL would leak the token.
    // No handler is registered for attacker.example.com — msw's
    // onUnhandledRequest: "error" setup fails the test if a request is made.
    let calls = 0;
    server.use(
      http.get("https://api.github.com/user/orgs", () => {
        calls++;
        return HttpResponse.json([{ login: "acme" }], {
          headers: {
            Link: '<https://attacker.example.com/collect>; rel="next"',
          },
        });
      }),
    );
    const p = makeProvider();
    const result = await p.listMemberships("tok");
    expect(result).toEqual(["acme"]);
    expect(calls).toBe(1);
  });

  it("401 throws IdPTokenRevoked", async () => {
    server.use(
      http.get("https://api.github.com/user/orgs", () => new HttpResponse(null, { status: 401 })),
    );
    const p = makeProvider();
    await expect(p.listMemberships("tok")).rejects.toBeInstanceOf(IdPTokenRevoked);
  });

  it("403 throws IdPTransientError", async () => {
    server.use(
      http.get("https://api.github.com/user/orgs", () => new HttpResponse(null, { status: 403 })),
    );
    const p = makeProvider();
    await expect(p.listMemberships("tok")).rejects.toBeInstanceOf(IdPTransientError);
  });

  it("404 throws generic Error (not transient/revoked)", async () => {
    server.use(
      http.get("https://api.github.com/user/orgs", () => new HttpResponse(null, { status: 404 })),
    );
    const p = makeProvider();
    await expect(p.listMemberships("tok")).rejects.toThrow(/GitHub HTTP 404/);
  });

  it("5xx with retry success: first 503, retry 200 => returns result", async () => {
    let calls = 0;
    server.use(
      http.get("https://api.github.com/user/orgs", () => {
        calls++;
        if (calls === 1) return new HttpResponse(null, { status: 503 });
        return HttpResponse.json([{ login: "after-retry" }]);
      }),
    );
    const p = makeProvider();
    const result = await p.listMemberships("tok");
    expect(result).toEqual(["after-retry"]);
    expect(calls).toBe(2);
  });

  it("5xx with retry fail: both 503 => throws IdPTransientError", async () => {
    let calls = 0;
    server.use(
      http.get("https://api.github.com/user/orgs", () => {
        calls++;
        return new HttpResponse(null, { status: 503 });
      }),
    );
    const p = makeProvider();
    await expect(p.listMemberships("tok")).rejects.toBeInstanceOf(IdPTransientError);
    expect(calls).toBe(2);
  });

  it("network error: retries once then surfaces", async () => {
    let calls = 0;
    server.use(
      http.get("https://api.github.com/user/orgs", () => {
        calls++;
        return HttpResponse.error();
      }),
    );
    const p = makeProvider();
    await expect(p.listMemberships("tok")).rejects.toThrow();
    expect(calls).toBe(2);
  });

  it("network error then success: retry recovers", async () => {
    let calls = 0;
    server.use(
      http.get("https://api.github.com/user/orgs", () => {
        calls++;
        if (calls === 1) return HttpResponse.error();
        return HttpResponse.json([{ login: "recovered" }]);
      }),
    );
    const p = makeProvider();
    const result = await p.listMemberships("tok");
    expect(result).toEqual(["recovered"]);
    expect(calls).toBe(2);
  });
});

describe("GitHubProvider.requestDeviceCode", () => {
  it("happy path: returns DeviceCodeResponse", async () => {
    server.use(
      http.post("https://github.com/login/device/code", () =>
        HttpResponse.json({
          device_code: "dev-123",
          user_code: "WDJB-MJHT",
          verification_uri: "https://github.com/login/device",
          verification_uri_complete: "https://github.com/login/device?user_code=WDJB-MJHT",
          expires_in: 900,
          interval: 5,
        }),
      ),
    );
    const p = makeProvider();
    const result = await p.requestDeviceCode();
    expect(result.device_code).toBe("dev-123");
    expect(result.user_code).toBe("WDJB-MJHT");
    expect(result.interval).toBe(5);
  });

  it("4xx throws generic Error", async () => {
    server.use(
      http.post("https://github.com/login/device/code", () =>
        new HttpResponse(null, { status: 400 }),
      ),
    );
    const p = makeProvider();
    await expect(p.requestDeviceCode()).rejects.toThrow(/GitHub HTTP 400/);
  });
});

describe("GitHubProvider.pollDeviceToken", () => {
  it("granted: fetches user info and returns user + token", async () => {
    server.use(
      http.post("https://github.com/login/oauth/access_token", () =>
        HttpResponse.json({ access_token: "dev-tok", token_type: "bearer" }),
      ),
      http.get("https://api.github.com/user", () =>
        HttpResponse.json({ id: 99, login: "dev-user", email: null, name: "Dev User" }),
      ),
      http.get("https://api.github.com/user/emails", () =>
        HttpResponse.json([{ email: "dev@example.com", primary: true, verified: true }]),
      ),
    );
    const p = makeProvider();
    const result = await p.pollDeviceToken("dev-code");
    expect(result.status).toBe("granted");
    if (result.status === "granted") {
      expect(result.accessToken).toBe("dev-tok");
      expect(result.user.email).toBe("dev@example.com");
      expect(result.user.idp_user_id).toBe("99");
      expect(result.user.name).toBe("Dev User");
    }
  });

  it("authorization_pending", async () => {
    server.use(
      http.post("https://github.com/login/oauth/access_token", () =>
        HttpResponse.json({ error: "authorization_pending" }),
      ),
    );
    const p = makeProvider();
    const result = await p.pollDeviceToken("dev-code");
    expect(result.status).toBe("authorization_pending");
  });

  it("slow_down with new interval", async () => {
    server.use(
      http.post("https://github.com/login/oauth/access_token", () =>
        HttpResponse.json({ error: "slow_down", interval: 10 }),
      ),
    );
    const p = makeProvider();
    const result = await p.pollDeviceToken("dev-code");
    expect(result.status).toBe("slow_down");
    if (result.status === "slow_down") {
      expect(result.new_interval).toBe(10);
    }
  });

  it("slow_down without server-provided interval falls back to 10", async () => {
    server.use(
      http.post("https://github.com/login/oauth/access_token", () =>
        HttpResponse.json({ error: "slow_down" }),
      ),
    );
    const p = makeProvider();
    const result = await p.pollDeviceToken("dev-code");
    expect(result.status).toBe("slow_down");
    if (result.status === "slow_down") {
      expect(result.new_interval).toBe(10);
    }
  });

  it("expired_token", async () => {
    server.use(
      http.post("https://github.com/login/oauth/access_token", () =>
        HttpResponse.json({ error: "expired_token" }),
      ),
    );
    const p = makeProvider();
    const result = await p.pollDeviceToken("dev-code");
    expect(result.status).toBe("expired_token");
  });

  it("access_denied", async () => {
    server.use(
      http.post("https://github.com/login/oauth/access_token", () =>
        HttpResponse.json({ error: "access_denied" }),
      ),
    );
    const p = makeProvider();
    const result = await p.pollDeviceToken("dev-code");
    expect(result.status).toBe("access_denied");
  });

  it("unknown error code throws", async () => {
    server.use(
      http.post("https://github.com/login/oauth/access_token", () =>
        HttpResponse.json({ error: "some_unknown_thing" }),
      ),
    );
    const p = makeProvider();
    await expect(p.pollDeviceToken("dev-code")).rejects.toThrow(/unknown error/);
  });

  it("HTTP 5xx throws IdPTransientError after retry", async () => {
    let calls = 0;
    server.use(
      http.post("https://github.com/login/oauth/access_token", () => {
        calls++;
        return new HttpResponse(null, { status: 503 });
      }),
    );
    const p = makeProvider();
    await expect(p.pollDeviceToken("dev-code")).rejects.toBeInstanceOf(IdPTransientError);
    expect(calls).toBe(2);
  });
});

describe("GitHubProvider GHES base URLs", () => {
  it("uses cfg.apiBaseUrl for API calls", async () => {
    let hit = false;
    server.use(
      http.get("https://ghe.example.com/api/v3/user/orgs", () => {
        hit = true;
        return HttpResponse.json([{ login: "ghes-org" }]);
      }),
    );
    const p = new GitHubProvider({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      apiBaseUrl: "https://ghe.example.com/api/v3",
      authBaseUrl: "https://ghe.example.com",
    });
    const result = await p.listMemberships("tok");
    expect(hit).toBe(true);
    expect(result).toEqual(["ghes-org"]);
  });
});
