import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { GoogleProvider } from "../../src/auth/providers/google.js";
import { IdPTokenRevoked, IdPTransientError } from "../../src/auth/providers/errors.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUER = "https://accounts.google.com";
const CLIENT_ID = "test-google-client-id.apps.googleusercontent.com";
const CLIENT_SECRET = "test-google-client-secret";
const REDIRECT_URI = "https://example.test/api/auth/oauth/callback";

const server = setupServer();

let privateKey: CryptoKey;
let kid: string;
let jwksBody: { keys: Array<Record<string, unknown>> };

beforeAll(async () => {
  // Generate one RS256 key pair for all happy-path tests. kid binds the
  // signing key to the JWKS entry; the provider's jose verifier picks
  // the JWK by kid.
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  kid = "test-key-1";
  jwksBody = { keys: [{ ...jwk, alg: "RS256", use: "sig", kid }] };
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function mountJwks(): void {
  server.use(http.get(JWKS_URL, () => HttpResponse.json(jwksBody)));
}

interface IdTokenOverrides {
  sub?: string;
  email?: string;
  name?: string;
  hd?: string;
  iss?: string;
  aud?: string;
  alg?: "RS256" | "HS256";
  kidOverride?: string;
  expSeconds?: number;
  /** T55 parity: nonce claim baked into the id_token. */
  nonce?: string;
}

async function makeIdToken(overrides: IdTokenOverrides = {}): Promise<string> {
  const claims: Record<string, unknown> = {
    sub: overrides.sub ?? "111222333444555",
    email: overrides.email ?? "alice@example.com",
  };
  if (overrides.name !== undefined) claims.name = overrides.name;
  if (overrides.hd !== undefined) claims.hd = overrides.hd;
  if (overrides.nonce !== undefined) claims.nonce = overrides.nonce;
  const expSecondsFromNow = overrides.expSeconds ?? 3600;
  return new SignJWT(claims)
    .setProtectedHeader({
      alg: overrides.alg ?? "RS256",
      kid: overrides.kidOverride ?? kid,
    })
    .setIssuer(overrides.iss ?? ISSUER)
    .setAudience(overrides.aud ?? CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expSecondsFromNow)
    .sign(privateKey);
}

function makeProvider(): GoogleProvider {
  return new GoogleProvider({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
  });
}

describe("GoogleProvider.buildAuthUrl", () => {
  it("includes openid scope, S256 challenge, and online access_type", () => {
    const url = makeProvider().buildAuthUrl("state-abc", REDIRECT_URI, "challenge-xyz");
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(u.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(u.searchParams.get("state")).toBe("state-abc");
    expect(u.searchParams.get("scope")).toBe("openid email profile");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("access_type")).toBe("online");
    expect(u.searchParams.get("code_challenge")).toBe("challenge-xyz");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("omits code_challenge when no verifier provided", () => {
    const url = makeProvider().buildAuthUrl("state-abc", REDIRECT_URI);
    const u = new URL(url);
    expect(u.searchParams.has("code_challenge")).toBe(false);
    expect(u.searchParams.has("code_challenge_method")).toBe(false);
  });
});

describe("GoogleProvider.exchangeCode -- happy paths", () => {
  it("returns idp_user_id, email, name from id_token", async () => {
    const idToken = await makeIdToken({ name: "Alice Example" });
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json({
          access_token: "ya29.fake",
          id_token: idToken,
          token_type: "Bearer",
          expires_in: 3599,
        }),
      ),
    );
    mountJwks();

    const result = await makeProvider().exchangeCode("code-xyz", REDIRECT_URI, "verifier");
    expect(result.user).toEqual({
      idp_user_id: "111222333444555",
      email: "alice@example.com",
      name: "Alice Example",
    });
    expect(result.accessToken).toBe("ya29.fake");
  });

  it("surfaces hd claim as idp_org_id when present", async () => {
    const idToken = await makeIdToken({ hd: "example.com" });
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json({
          access_token: "ya29.fake",
          id_token: idToken,
          token_type: "Bearer",
        }),
      ),
    );
    mountJwks();

    const result = await makeProvider().exchangeCode("code-xyz", REDIRECT_URI);
    expect(result.user.idp_org_id).toBe("example.com");
  });

  it("omits name from IdpUserInfo when id_token has no name claim", async () => {
    const idToken = await makeIdToken();
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json({
          access_token: "ya29.fake",
          id_token: idToken,
          token_type: "Bearer",
        }),
      ),
    );
    mountJwks();

    const result = await makeProvider().exchangeCode("code-xyz", REDIRECT_URI);
    expect(result.user.name).toBeUndefined();
    expect(result.user.idp_org_id).toBeUndefined();
  });
});

describe("GoogleProvider.exchangeCode -- id_token verification", () => {
  it("rejects id_token signed by an unknown key (no matching kid in JWKS)", async () => {
    const idToken = await makeIdToken({ kidOverride: "rotated-out-key" });
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json({
          access_token: "ya29.fake",
          id_token: idToken,
          token_type: "Bearer",
        }),
      ),
    );
    mountJwks();

    await expect(makeProvider().exchangeCode("code-xyz", REDIRECT_URI)).rejects.toBeInstanceOf(
      IdPTransientError,
    );
  });

  it("rejects id_token with wrong issuer (cross-tenant attack)", async () => {
    const idToken = await makeIdToken({ iss: "https://evil.example/" });
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json({
          access_token: "ya29.fake",
          id_token: idToken,
          token_type: "Bearer",
        }),
      ),
    );
    mountJwks();

    await expect(makeProvider().exchangeCode("code-xyz", REDIRECT_URI)).rejects.toBeInstanceOf(
      IdPTokenRevoked,
    );
  });

  it("rejects id_token with wrong audience (token meant for another RP)", async () => {
    const idToken = await makeIdToken({ aud: "other-client.apps.googleusercontent.com" });
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json({
          access_token: "ya29.fake",
          id_token: idToken,
          token_type: "Bearer",
        }),
      ),
    );
    mountJwks();

    await expect(makeProvider().exchangeCode("code-xyz", REDIRECT_URI)).rejects.toBeInstanceOf(
      IdPTokenRevoked,
    );
  });

  it("rejects expired id_token", async () => {
    const idToken = await makeIdToken({ expSeconds: -60 });
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json({
          access_token: "ya29.fake",
          id_token: idToken,
          token_type: "Bearer",
        }),
      ),
    );
    mountJwks();

    await expect(makeProvider().exchangeCode("code-xyz", REDIRECT_URI)).rejects.toBeInstanceOf(
      IdPTokenRevoked,
    );
  });
});

describe("GoogleProvider.exchangeCode -- token endpoint failures", () => {
  it("maps 401 to IdPTokenRevoked", async () => {
    server.use(http.post(TOKEN_URL, () => HttpResponse.json({}, { status: 401 })));

    await expect(makeProvider().exchangeCode("bad-code", REDIRECT_URI)).rejects.toBeInstanceOf(
      IdPTokenRevoked,
    );
  });

  it("maps 502 to IdPTransientError", async () => {
    server.use(http.post(TOKEN_URL, () => HttpResponse.json({}, { status: 502 })));

    await expect(makeProvider().exchangeCode("code-xyz", REDIRECT_URI)).rejects.toBeInstanceOf(
      IdPTransientError,
    );
  });

  it("maps 4xx other than 401 to a generic Error", async () => {
    server.use(
      http.post(TOKEN_URL, () => HttpResponse.json({ error: "invalid_grant" }, { status: 400 })),
    );

    await expect(makeProvider().exchangeCode("code-xyz", REDIRECT_URI)).rejects.toThrow(/HTTP 400/);
  });

  it("rejects token responses missing id_token", async () => {
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json({ access_token: "ya29.fake", token_type: "Bearer" }),
      ),
    );

    // Schema parse failure -- not categorized as Token-Revoked because
    // the upstream is misbehaving, not the user.
    await expect(makeProvider().exchangeCode("code-xyz", REDIRECT_URI)).rejects.toThrow();
  });
});

describe("GoogleProvider.listMemberships", () => {
  it("throws -- Google requires hd-based allowlist", async () => {
    await expect(makeProvider().listMemberships("any-token")).rejects.toThrow(/hd-based allowlist/);
  });
});

describe("GoogleProvider nonce (securite-auth-02)", () => {
  it("buildAuthUrl emits the nonce param when one is supplied", () => {
    const url = makeProvider().buildAuthUrl(
      "state-abc",
      REDIRECT_URI,
      "challenge-xyz",
      "n-test-12345",
    );
    expect(new URL(url).searchParams.get("nonce")).toBe("n-test-12345");
  });

  it("buildAuthUrl omits nonce param when none supplied", () => {
    const url = makeProvider().buildAuthUrl("state-abc", REDIRECT_URI);
    expect(new URL(url).searchParams.has("nonce")).toBe(false);
  });

  it("exchangeCode happy path: id_token nonce matches supplied -> success", async () => {
    const nonceValue = "n-good-1";
    const idToken = await makeIdToken({ nonce: nonceValue });
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json({
          access_token: "ya29.fake",
          id_token: idToken,
          token_type: "Bearer",
        }),
      ),
    );
    mountJwks();

    const result = await makeProvider().exchangeCode(
      "code-xyz",
      REDIRECT_URI,
      undefined,
      nonceValue,
    );
    expect(result.user.idp_user_id).toBe("111222333444555");
  });

  it("exchangeCode: id_token has a DIFFERENT nonce -> IdPTokenRevoked (replay/injection blocked)", async () => {
    const idToken = await makeIdToken({ nonce: "n-IMPOSTOR" });
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json({
          access_token: "ya29.fake",
          id_token: idToken,
          token_type: "Bearer",
        }),
      ),
    );
    mountJwks();

    await expect(
      makeProvider().exchangeCode("code-xyz", REDIRECT_URI, undefined, "n-EXPECTED"),
    ).rejects.toBeInstanceOf(IdPTokenRevoked);
  });

  it("exchangeCode: id_token MISSING nonce claim entirely -> IdPTokenRevoked", async () => {
    const idToken = await makeIdToken(); // no nonce baked in
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json({
          access_token: "ya29.fake",
          id_token: idToken,
          token_type: "Bearer",
        }),
      ),
    );
    mountJwks();

    await expect(
      makeProvider().exchangeCode("code-xyz", REDIRECT_URI, undefined, "n-EXPECTED"),
    ).rejects.toBeInstanceOf(IdPTokenRevoked);
  });

  it("exchangeCode: caller passes null nonce -> nonce check is skipped (CLI auth-code grant path)", async () => {
    const idToken = await makeIdToken();
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json({
          access_token: "ya29.fake",
          id_token: idToken,
          token_type: "Bearer",
        }),
      ),
    );
    mountJwks();

    const result = await makeProvider().exchangeCode("code-xyz", REDIRECT_URI, undefined, null);
    expect(result.user.idp_user_id).toBe("111222333444555");
  });
});
