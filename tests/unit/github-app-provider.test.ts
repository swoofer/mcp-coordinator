import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { GitHubAppProvider } from "../../src/auth/providers/github-app.js";
import { IdPTokenRevoked, IdPTransientError } from "../../src/auth/providers/errors.js";

const CLIENT_ID = "Iv1.0123456789abcdef";
const CLIENT_SECRET = "github_pat_secret456";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeProvider(): GitHubAppProvider {
  return new GitHubAppProvider({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
}

describe("GitHubAppProvider basics", () => {
  it("registry name defaults to 'github-app'", () => {
    const p = makeProvider();
    expect(p.name).toBe("github-app");
  });

  it("registry name can be overridden", () => {
    const p = new GitHubAppProvider({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      name: "my-corp-app",
    });
    expect(p.name).toBe("my-corp-app");
  });
});

describe("GitHubAppProvider.buildAuthUrl", () => {
  it("includes client_id, redirect_uri, state, S256 challenge", () => {
    const p = makeProvider();
    const url = p.buildAuthUrl("state-xyz", "https://app/cb", "CHALLENGE");
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(parsed.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(parsed.searchParams.get("state")).toBe("state-xyz");
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://app/cb");
    expect(parsed.searchParams.get("code_challenge")).toBe("CHALLENGE");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("does NOT include a scope param (Apps reject it)", () => {
    const p = makeProvider();
    const url = p.buildAuthUrl("state-xyz", "https://app/cb");
    const parsed = new URL(url);
    expect(parsed.searchParams.has("scope")).toBe(false);
  });

  it("respects authBaseUrl override (GHES)", () => {
    const p = new GitHubAppProvider({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      authBaseUrl: "https://ghe.example.com",
    });
    const url = p.buildAuthUrl("s", "https://app/cb");
    expect(url.startsWith("https://ghe.example.com/login/oauth/authorize?")).toBe(true);
  });
});

describe("GitHubAppProvider.exchangeCode", () => {
  it("happy path returns user + access token + refresh fields", async () => {
    server.use(
      http.post("https://github.com/login/oauth/access_token", () =>
        HttpResponse.json({
          access_token: "ghu_abc",
          token_type: "bearer",
          expires_in: 28800,
          refresh_token: "ghr_xyz",
          refresh_token_expires_in: 15897600,
        }),
      ),
      http.get("https://api.github.com/user", () =>
        HttpResponse.json({ id: 42, login: "alice", email: null, name: "Alice" }),
      ),
      http.get("https://api.github.com/user/emails", () =>
        HttpResponse.json([{ email: "alice@example.com", primary: true, verified: true }]),
      ),
    );

    const result = await makeProvider().exchangeCode("code-xyz", "https://app/cb", "verifier");
    expect(result.accessToken).toBe("ghu_abc");
    expect(result.accessTokenExpiresIn).toBe(28800);
    expect(result.refreshToken).toBe("ghr_xyz");
    expect(result.refreshTokenExpiresIn).toBe(15897600);
    expect(result.user).toEqual({
      idp_user_id: "42",
      email: "alice@example.com",
      name: "Alice",
    });
  });

  it("omits refresh fields when GitHub does not return them", async () => {
    server.use(
      http.post("https://github.com/login/oauth/access_token", () =>
        HttpResponse.json({ access_token: "ghu_abc", token_type: "bearer" }),
      ),
      http.get("https://api.github.com/user", () =>
        HttpResponse.json({ id: 7, login: "bob", email: null, name: null }),
      ),
      http.get("https://api.github.com/user/emails", () =>
        HttpResponse.json([{ email: "bob@example.com", primary: true, verified: true }]),
      ),
    );

    const result = await makeProvider().exchangeCode("code", "https://app/cb");
    expect(result.accessToken).toBe("ghu_abc");
    expect(result.accessTokenExpiresIn).toBeUndefined();
    expect(result.refreshToken).toBeUndefined();
    expect(result.refreshTokenExpiresIn).toBeUndefined();
  });

  it("401 from token endpoint -> IdPTokenRevoked", async () => {
    server.use(
      http.post("https://github.com/login/oauth/access_token", () =>
        HttpResponse.json({}, { status: 401 }),
      ),
    );
    await expect(makeProvider().exchangeCode("code", "https://app/cb")).rejects.toBeInstanceOf(
      IdPTokenRevoked,
    );
  });

  it("503 from token endpoint -> IdPTransientError", async () => {
    server.use(
      http.post("https://github.com/login/oauth/access_token", () =>
        HttpResponse.json({}, { status: 503 }),
      ),
      http.post("https://github.com/login/oauth/access_token", () =>
        HttpResponse.json({}, { status: 503 }),
      ),
    );
    await expect(makeProvider().exchangeCode("code", "https://app/cb")).rejects.toBeInstanceOf(
      IdPTransientError,
    );
  });

  it("error label discriminates 'GitHub App' vs 'GitHub'", async () => {
    server.use(
      http.post("https://github.com/login/oauth/access_token", () =>
        HttpResponse.json({}, { status: 503 }),
      ),
      http.post("https://github.com/login/oauth/access_token", () =>
        HttpResponse.json({}, { status: 503 }),
      ),
    );
    try {
      await makeProvider().exchangeCode("code", "https://app/cb");
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as Error).message).toMatch(/GitHub App/);
    }
  });
});

describe("GitHubAppProvider.listMemberships", () => {
  it("returns org logins from /user/orgs", async () => {
    server.use(
      http.get("https://api.github.com/user/orgs", () =>
        HttpResponse.json([{ login: "acme" }, { login: "wile-e" }]),
      ),
    );
    const memberships = await makeProvider().listMemberships("tok-abc");
    expect(memberships).toEqual(["acme", "wile-e"]);
  });

  it("401 from /user/orgs -> IdPTokenRevoked", async () => {
    server.use(
      http.get("https://api.github.com/user/orgs", () => HttpResponse.json({}, { status: 401 })),
    );
    await expect(makeProvider().listMemberships("bad")).rejects.toBeInstanceOf(IdPTokenRevoked);
  });
});

describe("GitHubAppProvider.listMemberships -- T57 user_installations", () => {
  function makeAppFootprintProvider(): GitHubAppProvider {
    return new GitHubAppProvider({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      allowlistSource: "user_installations",
    });
  }

  it("user_installations: calls /user/installations and returns account.login values", async () => {
    server.use(
      http.get("https://api.github.com/user/installations", () =>
        HttpResponse.json({
          total_count: 2,
          installations: [
            { id: 1, account: { login: "acme", type: "Organization" } },
            { id: 2, account: { login: "wile-e", type: "Organization" } },
          ],
        }),
      ),
    );
    const memberships = await makeAppFootprintProvider().listMemberships("tok");
    expect(memberships).toEqual(["acme", "wile-e"]);
  });

  it("user_installations: returns empty list when user has access to no installations", async () => {
    server.use(
      http.get("https://api.github.com/user/installations", () =>
        HttpResponse.json({ total_count: 0, installations: [] }),
      ),
    );
    const memberships = await makeAppFootprintProvider().listMemberships("tok");
    expect(memberships).toEqual([]);
  });

  it("user_installations: includes User-type installations (personal-account install)", async () => {
    server.use(
      http.get("https://api.github.com/user/installations", () =>
        HttpResponse.json({
          total_count: 1,
          installations: [{ id: 99, account: { login: "alice", type: "User" } }],
        }),
      ),
    );
    const memberships = await makeAppFootprintProvider().listMemberships("tok");
    expect(memberships).toEqual(["alice"]);
  });

  it("user_installations: 401 -> IdPTokenRevoked", async () => {
    server.use(
      http.get("https://api.github.com/user/installations", () =>
        HttpResponse.json({}, { status: 401 }),
      ),
    );
    await expect(makeAppFootprintProvider().listMemberships("bad")).rejects.toBeInstanceOf(
      IdPTokenRevoked,
    );
  });

  it("user_installations: 503 -> IdPTransientError", async () => {
    server.use(
      http.get("https://api.github.com/user/installations", () =>
        HttpResponse.json({}, { status: 503 }),
      ),
      http.get("https://api.github.com/user/installations", () =>
        HttpResponse.json({}, { status: 503 }),
      ),
    );
    await expect(makeAppFootprintProvider().listMemberships("tok")).rejects.toBeInstanceOf(
      IdPTransientError,
    );
  });

  it("default allowlistSource (omitted) still hits /user/orgs (backward compat)", async () => {
    server.use(
      http.get("https://api.github.com/user/orgs", () => HttpResponse.json([{ login: "acme" }])),
    );
    // Explicit "no /user/installations handler" -- the request would
    // fail MSW's onUnhandledRequest:"error" check if the provider
    // accidentally hit it.
    const memberships = await makeProvider().listMemberships("tok");
    expect(memberships).toEqual(["acme"]);
  });
});

describe("GitHubAppProvider.refreshIdpToken", () => {
  it("returns fresh access + rotated refresh on success", async () => {
    server.use(
      http.post("https://github.com/login/oauth/access_token", () =>
        HttpResponse.json({
          access_token: "ghu_newer",
          token_type: "bearer",
          expires_in: 28800,
          refresh_token: "ghr_rotated",
          refresh_token_expires_in: 15897600,
        }),
      ),
    );

    const result = await makeProvider().refreshIdpToken("ghr_old");
    expect(result.accessToken).toBe("ghu_newer");
    expect(result.accessTokenExpiresIn).toBe(28800);
    expect(result.refreshToken).toBe("ghr_rotated");
    expect(result.refreshTokenExpiresIn).toBe(15897600);
  });

  it("posts grant_type=refresh_token to the token endpoint", async () => {
    let observedBody = "";
    server.use(
      http.post("https://github.com/login/oauth/access_token", async ({ request }) => {
        observedBody = await request.text();
        return HttpResponse.json({
          access_token: "ghu_x",
          token_type: "bearer",
        });
      }),
    );
    await makeProvider().refreshIdpToken("ghr_token");
    const params = new URLSearchParams(observedBody);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("ghr_token");
    expect(params.get("client_id")).toBe(CLIENT_ID);
    expect(params.get("client_secret")).toBe(CLIENT_SECRET);
  });

  it("401 -> IdPTokenRevoked", async () => {
    server.use(
      http.post("https://github.com/login/oauth/access_token", () =>
        HttpResponse.json({}, { status: 401 }),
      ),
    );
    await expect(makeProvider().refreshIdpToken("ghr_bad")).rejects.toBeInstanceOf(IdPTokenRevoked);
  });

  it("503 -> IdPTransientError", async () => {
    server.use(
      http.post("https://github.com/login/oauth/access_token", () =>
        HttpResponse.json({}, { status: 503 }),
      ),
      http.post("https://github.com/login/oauth/access_token", () =>
        HttpResponse.json({}, { status: 503 }),
      ),
    );
    await expect(makeProvider().refreshIdpToken("ghr_token")).rejects.toBeInstanceOf(
      IdPTransientError,
    );
  });

  it("200 body with `error` field -> IdPTokenRevoked", async () => {
    // GitHub sometimes returns 200 with a JSON error body for
    // bad_refresh_token; we treat that as revocation, not a parse
    // error or a transient.
    server.use(
      http.post("https://github.com/login/oauth/access_token", () =>
        HttpResponse.json({ error: "bad_refresh_token" }),
      ),
    );
    await expect(makeProvider().refreshIdpToken("ghr_old")).rejects.toBeInstanceOf(IdPTokenRevoked);
  });

  it("200 body missing access_token -> IdPTokenRevoked", async () => {
    server.use(
      http.post("https://github.com/login/oauth/access_token", () =>
        HttpResponse.json({ token_type: "bearer" }),
      ),
    );
    await expect(makeProvider().refreshIdpToken("ghr_old")).rejects.toBeInstanceOf(IdPTokenRevoked);
  });
});

describe("GitHubAppProvider device flow", () => {
  it("does not implement requestDeviceCode or pollDeviceToken", () => {
    const p = makeProvider();
    expect((p as unknown as { requestDeviceCode?: unknown }).requestDeviceCode).toBeUndefined();
    expect((p as unknown as { pollDeviceToken?: unknown }).pollDeviceToken).toBeUndefined();
  });
});
