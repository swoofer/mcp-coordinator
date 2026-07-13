import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { OIDCProvider, extractGroupsFromClaims } from "../../src/auth/providers/oidc.js";
import { IdPTokenRevoked, IdPTransientError } from "../../src/auth/providers/errors.js";

const ISSUER = "https://idp.example.test/realms/main";
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const AUTHORIZATION_ENDPOINT = `${ISSUER}/protocol/openid-connect/auth`;
const TOKEN_ENDPOINT = `${ISSUER}/protocol/openid-connect/token`;
const JWKS_URI = `${ISSUER}/protocol/openid-connect/certs`;
const CLIENT_ID = "test-oidc-client";
const CLIENT_SECRET = "test-oidc-secret";
const REDIRECT_URI = "https://example.test/api/auth/oauth/callback";

const server = setupServer();

let privateKey: CryptoKey;
let kid: string;
let jwksBody: { keys: Array<Record<string, unknown>> };

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  kid = "oidc-test-kid-1";
  jwksBody = { keys: [{ ...jwk, alg: "RS256", use: "sig", kid }] };
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function mountDiscoveryAndJwks(overrides?: Partial<{ issuer: string }>): void {
  server.use(
    http.get(DISCOVERY_URL, () =>
      HttpResponse.json({
        issuer: overrides?.issuer ?? ISSUER,
        authorization_endpoint: AUTHORIZATION_ENDPOINT,
        token_endpoint: TOKEN_ENDPOINT,
        jwks_uri: JWKS_URI,
        response_types_supported: ["code"],
        id_token_signing_alg_values_supported: ["RS256"],
      }),
    ),
    http.get(JWKS_URI, () => HttpResponse.json(jwksBody)),
  );
}

interface IdTokenOverrides {
  sub?: string;
  email?: string;
  name?: string;
  preferred_username?: string;
  iss?: string;
  aud?: string;
  alg?: "RS256" | "HS256";
  kidOverride?: string;
  expSeconds?: number;
  /** T55: nonce claim baked into the id_token. */
  nonce?: string;
  /** T58: groups / role claims baked into the id_token at arbitrary
   *  dot-paths. Keys may be like "groups" or "realm_access". */
  extraClaims?: Record<string, unknown>;
}

async function makeIdToken(overrides: IdTokenOverrides = {}): Promise<string> {
  const claims: Record<string, unknown> = { sub: overrides.sub ?? "user-7" };
  if (overrides.email !== undefined) claims.email = overrides.email;
  if (overrides.name !== undefined) claims.name = overrides.name;
  if (overrides.preferred_username !== undefined) {
    claims.preferred_username = overrides.preferred_username;
  }
  if (overrides.nonce !== undefined) claims.nonce = overrides.nonce;
  if (overrides.extraClaims) {
    for (const [k, v] of Object.entries(overrides.extraClaims)) claims[k] = v;
  }
  return new SignJWT(claims)
    .setProtectedHeader({
      alg: overrides.alg ?? "RS256",
      kid: overrides.kidOverride ?? kid,
    })
    .setIssuer(overrides.iss ?? ISSUER)
    .setAudience(overrides.aud ?? CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + (overrides.expSeconds ?? 3600))
    .sign(privateKey);
}

function makeProvider(extra?: Partial<{ name: string }>): OIDCProvider {
  return new OIDCProvider({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    issuerUrl: ISSUER,
    ...(extra?.name !== undefined ? { name: extra.name } : {}),
  });
}

describe("OIDCProvider.buildAuthUrl", () => {
  it("fetches discovery doc and points at authorization_endpoint", async () => {
    mountDiscoveryAndJwks();
    const url = await makeProvider().buildAuthUrl("state-x", REDIRECT_URI, "challenge-y");
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe(AUTHORIZATION_ENDPOINT);
    expect(u.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(u.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(u.searchParams.get("state")).toBe("state-x");
    expect(u.searchParams.get("scope")).toBe("openid email profile");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("code_challenge")).toBe("challenge-y");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("custom name parameter is used", () => {
    const p = makeProvider({ name: "okta" });
    expect(p.name).toBe("okta");
  });

  it("defaults name to 'oidc'", () => {
    const p = makeProvider();
    expect(p.name).toBe("oidc");
  });

  it("caches discovery doc across calls (single GET)", async () => {
    let discoveryCalls = 0;
    server.use(
      http.get(DISCOVERY_URL, () => {
        discoveryCalls += 1;
        return HttpResponse.json({
          issuer: ISSUER,
          authorization_endpoint: AUTHORIZATION_ENDPOINT,
          token_endpoint: TOKEN_ENDPOINT,
          jwks_uri: JWKS_URI,
        });
      }),
    );
    const p = makeProvider();
    await p.buildAuthUrl("s1", REDIRECT_URI);
    await p.buildAuthUrl("s2", REDIRECT_URI);
    expect(discoveryCalls).toBe(1);
  });
});

describe("OIDCProvider discovery validation", () => {
  it("rejects discovery doc whose `issuer` does not match config", async () => {
    mountDiscoveryAndJwks({ issuer: "https://impostor.example.test" });
    await expect(makeProvider().buildAuthUrl("s1", REDIRECT_URI)).rejects.toThrow(
      /discovery issuer mismatch/,
    );
  });

  it("maps 503 discovery responses to IdPTransientError", async () => {
    server.use(http.get(DISCOVERY_URL, () => HttpResponse.json({}, { status: 503 })));
    await expect(makeProvider().buildAuthUrl("s1", REDIRECT_URI)).rejects.toBeInstanceOf(
      IdPTransientError,
    );
  });

  it("maps 4xx discovery responses to a generic Error (config issue)", async () => {
    server.use(http.get(DISCOVERY_URL, () => HttpResponse.json({}, { status: 404 })));
    await expect(makeProvider().buildAuthUrl("s1", REDIRECT_URI)).rejects.toThrow(/HTTP 404/);
  });
});

describe("OIDCProvider.exchangeCode -- happy paths", () => {
  it("returns idp_user_id + email + name from verified id_token", async () => {
    const idToken = await makeIdToken({
      email: "alice@example.test",
      name: "Alice",
    });
    mountDiscoveryAndJwks();
    server.use(
      http.post(TOKEN_ENDPOINT, () =>
        HttpResponse.json({
          access_token: "oidc-access-1",
          id_token: idToken,
          token_type: "Bearer",
          expires_in: 3600,
        }),
      ),
    );

    const result = await makeProvider().exchangeCode("code-1", REDIRECT_URI, "verifier");
    expect(result.user).toEqual({
      idp_user_id: "user-7",
      email: "alice@example.test",
      name: "Alice",
    });
    expect(result.accessToken).toBe("oidc-access-1");
  });

  it("falls back to preferred_username when id_token lacks email", async () => {
    const idToken = await makeIdToken({ preferred_username: "alice" });
    mountDiscoveryAndJwks();
    server.use(
      http.post(TOKEN_ENDPOINT, () =>
        HttpResponse.json({
          access_token: "oidc-access-2",
          id_token: idToken,
          token_type: "Bearer",
        }),
      ),
    );

    const result = await makeProvider().exchangeCode("code-2", REDIRECT_URI);
    expect(result.user.email).toBe("alice");
  });

  it("falls back to sub when id_token lacks email and preferred_username", async () => {
    const idToken = await makeIdToken({ sub: "fallback-sub" });
    mountDiscoveryAndJwks();
    server.use(
      http.post(TOKEN_ENDPOINT, () =>
        HttpResponse.json({
          access_token: "oidc-access-3",
          id_token: idToken,
          token_type: "Bearer",
        }),
      ),
    );

    const result = await makeProvider().exchangeCode("code-3", REDIRECT_URI);
    expect(result.user.email).toBe("fallback-sub");
  });
});

describe("OIDCProvider.exchangeCode -- id_token verification", () => {
  it("rejects wrong issuer (cross-tenant)", async () => {
    const idToken = await makeIdToken({ iss: "https://evil.example/" });
    mountDiscoveryAndJwks();
    server.use(
      http.post(TOKEN_ENDPOINT, () =>
        HttpResponse.json({
          access_token: "x",
          id_token: idToken,
          token_type: "Bearer",
        }),
      ),
    );
    await expect(makeProvider().exchangeCode("c", REDIRECT_URI)).rejects.toBeInstanceOf(
      IdPTokenRevoked,
    );
  });

  it("rejects wrong audience", async () => {
    const idToken = await makeIdToken({ aud: "another-rp" });
    mountDiscoveryAndJwks();
    server.use(
      http.post(TOKEN_ENDPOINT, () =>
        HttpResponse.json({
          access_token: "x",
          id_token: idToken,
          token_type: "Bearer",
        }),
      ),
    );
    await expect(makeProvider().exchangeCode("c", REDIRECT_URI)).rejects.toBeInstanceOf(
      IdPTokenRevoked,
    );
  });

  it("rejects unknown signing kid (key rotation gap)", async () => {
    const idToken = await makeIdToken({ kidOverride: "rotated-key" });
    mountDiscoveryAndJwks();
    server.use(
      http.post(TOKEN_ENDPOINT, () =>
        HttpResponse.json({
          access_token: "x",
          id_token: idToken,
          token_type: "Bearer",
        }),
      ),
    );
    await expect(makeProvider().exchangeCode("c", REDIRECT_URI)).rejects.toBeInstanceOf(
      IdPTransientError,
    );
  });

  it("rejects expired id_token", async () => {
    const idToken = await makeIdToken({ expSeconds: -10 });
    mountDiscoveryAndJwks();
    server.use(
      http.post(TOKEN_ENDPOINT, () =>
        HttpResponse.json({
          access_token: "x",
          id_token: idToken,
          token_type: "Bearer",
        }),
      ),
    );
    await expect(makeProvider().exchangeCode("c", REDIRECT_URI)).rejects.toBeInstanceOf(
      IdPTokenRevoked,
    );
  });
});

describe("OIDCProvider.exchangeCode -- token endpoint failures", () => {
  it("maps 401 to IdPTokenRevoked", async () => {
    mountDiscoveryAndJwks();
    server.use(http.post(TOKEN_ENDPOINT, () => HttpResponse.json({}, { status: 401 })));
    await expect(makeProvider().exchangeCode("c", REDIRECT_URI)).rejects.toBeInstanceOf(
      IdPTokenRevoked,
    );
  });

  it("maps 502 to IdPTransientError", async () => {
    mountDiscoveryAndJwks();
    server.use(http.post(TOKEN_ENDPOINT, () => HttpResponse.json({}, { status: 502 })));
    await expect(makeProvider().exchangeCode("c", REDIRECT_URI)).rejects.toBeInstanceOf(
      IdPTransientError,
    );
  });

  it("maps 400 invalid_grant to a generic Error", async () => {
    mountDiscoveryAndJwks();
    server.use(
      http.post(TOKEN_ENDPOINT, () =>
        HttpResponse.json({ error: "invalid_grant" }, { status: 400 }),
      ),
    );
    await expect(makeProvider().exchangeCode("c", REDIRECT_URI)).rejects.toThrow(/HTTP 400/);
  });
});

describe("OIDCProvider.listMemberships", () => {
  it("throws -- generic OIDC has no portable group model", async () => {
    await expect(makeProvider().listMemberships("token")).rejects.toThrow(/vendor a subclass/);
  });
});

describe("OIDCProvider issuer URL normalization", () => {
  it("strips trailing slash from issuer before building discovery URL", async () => {
    let discoveryUrlSeen: string | null = null;
    server.use(
      http.get(
        "https://idp.example.test/realms/main/.well-known/openid-configuration",
        ({ request }) => {
          discoveryUrlSeen = request.url;
          return HttpResponse.json({
            issuer: "https://idp.example.test/realms/main/",
            authorization_endpoint: AUTHORIZATION_ENDPOINT,
            token_endpoint: TOKEN_ENDPOINT,
            jwks_uri: JWKS_URI,
          });
        },
      ),
    );
    const p = new OIDCProvider({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      issuerUrl: "https://idp.example.test/realms/main/",
    });
    await p.buildAuthUrl("s", REDIRECT_URI);
    expect(discoveryUrlSeen).toBe(
      "https://idp.example.test/realms/main/.well-known/openid-configuration",
    );
  });
});

describe("OIDCProvider nonce (T55)", () => {
  it("buildAuthUrl emits the nonce param when one is supplied", async () => {
    mountDiscoveryAndJwks();
    const url = await makeProvider().buildAuthUrl(
      "state-x",
      REDIRECT_URI,
      "challenge-y",
      "n-test-12345",
    );
    expect(new URL(url).searchParams.get("nonce")).toBe("n-test-12345");
  });

  it("buildAuthUrl omits nonce param when none supplied", async () => {
    mountDiscoveryAndJwks();
    const url = await makeProvider().buildAuthUrl("state-x", REDIRECT_URI);
    expect(new URL(url).searchParams.has("nonce")).toBe(false);
  });

  it("exchangeCode happy path: id_token nonce matches supplied -> success", async () => {
    const nonceValue = "n-good-1";
    const idToken = await makeIdToken({ email: "a@x.test", nonce: nonceValue });
    mountDiscoveryAndJwks();
    server.use(
      http.post(TOKEN_ENDPOINT, () =>
        HttpResponse.json({
          access_token: "oidc-a",
          id_token: idToken,
          token_type: "Bearer",
        }),
      ),
    );
    const result = await makeProvider().exchangeCode("code-x", REDIRECT_URI, undefined, nonceValue);
    expect(result.user.idp_user_id).toBe("user-7");
  });

  it("exchangeCode: id_token has a DIFFERENT nonce -> IdPTokenRevoked", async () => {
    const idToken = await makeIdToken({ nonce: "n-IMPOSTOR" });
    mountDiscoveryAndJwks();
    server.use(
      http.post(TOKEN_ENDPOINT, () =>
        HttpResponse.json({
          access_token: "oidc-a",
          id_token: idToken,
          token_type: "Bearer",
        }),
      ),
    );
    await expect(
      makeProvider().exchangeCode("code-x", REDIRECT_URI, undefined, "n-EXPECTED"),
    ).rejects.toBeInstanceOf(IdPTokenRevoked);
  });

  it("exchangeCode: id_token MISSING nonce claim entirely -> IdPTokenRevoked", async () => {
    const idToken = await makeIdToken(); // no nonce baked in
    mountDiscoveryAndJwks();
    server.use(
      http.post(TOKEN_ENDPOINT, () =>
        HttpResponse.json({
          access_token: "oidc-a",
          id_token: idToken,
          token_type: "Bearer",
        }),
      ),
    );
    await expect(
      makeProvider().exchangeCode("code-x", REDIRECT_URI, undefined, "n-EXPECTED"),
    ).rejects.toBeInstanceOf(IdPTokenRevoked);
  });

  it("exchangeCode: caller passes null nonce -> nonce check is skipped (CLI auth-code grant path)", async () => {
    const idToken = await makeIdToken({ email: "a@x.test" });
    mountDiscoveryAndJwks();
    server.use(
      http.post(TOKEN_ENDPOINT, () =>
        HttpResponse.json({
          access_token: "oidc-a",
          id_token: idToken,
          token_type: "Bearer",
        }),
      ),
    );
    const result = await makeProvider().exchangeCode("code-x", REDIRECT_URI, undefined, null);
    expect(result.user.idp_user_id).toBe("user-7");
  });
});

describe("OIDCProvider groups claim (T58)", () => {
  function makeGroupsProvider(groupsClaim: string): OIDCProvider {
    return new OIDCProvider({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      issuerUrl: ISSUER,
      groupsClaim,
    });
  }

  it("allowlistStrategy is 'id_token_groups' when groupsClaim is set", () => {
    expect(makeGroupsProvider("groups").allowlistStrategy).toBe("id_token_groups");
  });

  it("allowlistStrategy stays 'none' when groupsClaim is omitted", () => {
    expect(makeProvider().allowlistStrategy).toBe("none");
  });

  it("exchangeCode populates user.groups from top-level 'groups' claim", async () => {
    const idToken = await makeIdToken({
      extraClaims: { groups: ["engineering", "platform-admins"] },
    });
    mountDiscoveryAndJwks();
    server.use(
      http.post(TOKEN_ENDPOINT, () =>
        HttpResponse.json({
          access_token: "oidc-a",
          id_token: idToken,
          token_type: "Bearer",
        }),
      ),
    );
    const result = await makeGroupsProvider("groups").exchangeCode("code-x", REDIRECT_URI);
    expect(result.user.groups).toEqual(["engineering", "platform-admins"]);
  });

  it("exchangeCode resolves nested path (realm_access.roles for Keycloak)", async () => {
    const idToken = await makeIdToken({
      extraClaims: { realm_access: { roles: ["admin", "developer"] } },
    });
    mountDiscoveryAndJwks();
    server.use(
      http.post(TOKEN_ENDPOINT, () =>
        HttpResponse.json({
          access_token: "oidc-a",
          id_token: idToken,
          token_type: "Bearer",
        }),
      ),
    );
    const result = await makeGroupsProvider("realm_access.roles").exchangeCode(
      "code-x",
      REDIRECT_URI,
    );
    expect(result.user.groups).toEqual(["admin", "developer"]);
  });

  it("missing groups claim -> user.groups undefined (deny by default)", async () => {
    const idToken = await makeIdToken();
    mountDiscoveryAndJwks();
    server.use(
      http.post(TOKEN_ENDPOINT, () =>
        HttpResponse.json({
          access_token: "oidc-a",
          id_token: idToken,
          token_type: "Bearer",
        }),
      ),
    );
    const result = await makeGroupsProvider("groups").exchangeCode("code-x", REDIRECT_URI);
    expect(result.user.groups).toBeUndefined();
  });

  it("non-string entries in groups array are filtered out", async () => {
    const idToken = await makeIdToken({
      extraClaims: { groups: ["valid-group", 42, null, "another-group"] },
    });
    mountDiscoveryAndJwks();
    server.use(
      http.post(TOKEN_ENDPOINT, () =>
        HttpResponse.json({
          access_token: "oidc-a",
          id_token: idToken,
          token_type: "Bearer",
        }),
      ),
    );
    const result = await makeGroupsProvider("groups").exchangeCode("code-x", REDIRECT_URI);
    expect(result.user.groups).toEqual(["valid-group", "another-group"]);
  });

  it("groups claim is a non-array value -> user.groups undefined", async () => {
    const idToken = await makeIdToken({
      extraClaims: { groups: "not-an-array" },
    });
    mountDiscoveryAndJwks();
    server.use(
      http.post(TOKEN_ENDPOINT, () =>
        HttpResponse.json({
          access_token: "oidc-a",
          id_token: idToken,
          token_type: "Bearer",
        }),
      ),
    );
    const result = await makeGroupsProvider("groups").exchangeCode("code-x", REDIRECT_URI);
    expect(result.user.groups).toBeUndefined();
  });
});

describe("extractGroupsFromClaims (T58)", () => {
  it("top-level string array", () => {
    expect(extractGroupsFromClaims({ groups: ["a", "b"] }, "groups")).toEqual(["a", "b"]);
  });

  it("nested path", () => {
    expect(
      extractGroupsFromClaims({ realm_access: { roles: ["admin"] } }, "realm_access.roles"),
    ).toEqual(["admin"]);
  });

  it("deeply nested path", () => {
    expect(extractGroupsFromClaims({ a: { b: { c: ["x"] } } }, "a.b.c")).toEqual(["x"]);
  });

  it("missing path returns empty array", () => {
    expect(extractGroupsFromClaims({}, "groups")).toEqual([]);
    expect(extractGroupsFromClaims({ other: "x" }, "groups")).toEqual([]);
  });

  it("path traversal through non-object returns empty array", () => {
    expect(extractGroupsFromClaims({ realm_access: "broken" }, "realm_access.roles")).toEqual([]);
  });

  it("non-object payload returns empty array", () => {
    expect(extractGroupsFromClaims(null, "groups")).toEqual([]);
    expect(extractGroupsFromClaims("string", "groups")).toEqual([]);
    expect(extractGroupsFromClaims(42, "groups")).toEqual([]);
  });

  it("non-array terminal value returns empty array", () => {
    expect(extractGroupsFromClaims({ groups: "admin" }, "groups")).toEqual([]);
    expect(extractGroupsFromClaims({ groups: 42 }, "groups")).toEqual([]);
    expect(extractGroupsFromClaims({ groups: { admin: true } }, "groups")).toEqual([]);
  });

  it("non-string array entries are filtered", () => {
    expect(
      extractGroupsFromClaims({ groups: ["a", 1, null, "b", undefined, "c"] }, "groups"),
    ).toEqual(["a", "b", "c"]);
  });

  it("empty array stays empty", () => {
    expect(extractGroupsFromClaims({ groups: [] }, "groups")).toEqual([]);
  });
});
