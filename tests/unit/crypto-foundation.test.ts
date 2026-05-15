import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { jwtVerify } from "jose";
import {
  deriveKey,
  deriveStateBindingKey,
  STATE_BINDING_INFO,
} from "../../src/auth/crypto-keys.js";
import {
  ACCEPTED_KIDS,
  buildJwtKeyRegistry,
  isAcceptedKid,
} from "../../src/auth/jwt-keys.js";
import {
  mintAccessJWT,
  mintRefreshJWT,
  type AccessTokenClaims,
  type RefreshTokenClaims,
} from "../../src/auth/jwt-mint.js";
import { generateVerifier, computeChallenge } from "../../src/auth/pkce.js";
import { assertSecretEntropy } from "../../src/auth/entropy.js";

// Fixed 32-byte secret for deterministic JWT/HKDF tests. NOT used with
// assertSecretEntropy (only two distinct byte values; would fail the
// Shannon check). NEVER use these bytes in production.
const TEST_SECRET = Buffer.from(
  "a".repeat(16) + "B".repeat(16),
  "utf8",
);
// A high-entropy random secret for entropy tests below.
const RANDOM_32 = crypto.randomBytes(32);

function decodeJwtHeader(jwt: string): Record<string, unknown> {
  const [headerB64] = jwt.split(".");
  return JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

describe("crypto-keys: HKDF state-binding key derivation", () => {
  it("deriveStateBindingKey produces 32 bytes", () => {
    const k = deriveStateBindingKey(TEST_SECRET);
    expect(k).toBeInstanceOf(Buffer);
    expect(k.length).toBe(32);
  });

  it("same input -> same output (deterministic)", () => {
    const a = deriveStateBindingKey(TEST_SECRET);
    const b = deriveStateBindingKey(TEST_SECRET);
    expect(a.equals(b)).toBe(true);
  });

  it("different info labels -> different keys (domain separation)", () => {
    const a = deriveKey(TEST_SECRET, STATE_BINDING_INFO);
    const b = deriveKey(TEST_SECRET, "some-other-purpose-v1");
    expect(a.equals(b)).toBe(false);
    // Sanity: STATE_BINDING_INFO matches the dedicated helper.
    const c = deriveStateBindingKey(TEST_SECRET);
    expect(a.equals(c)).toBe(true);
  });
});

describe("jwt-keys: kid registry and allowlist", () => {
  it("buildJwtKeyRegistry returns a registry with current.kid === 'hs256-v1'", () => {
    const reg = buildJwtKeyRegistry(TEST_SECRET);
    expect(reg.current.kid).toBe("hs256-v1");
    expect(reg.current.key).toBeInstanceOf(Uint8Array);
    expect(reg.current.key.length).toBe(TEST_SECRET.length);
  });

  it("getKey('hs256-v1') returns the secret bytes", () => {
    const reg = buildJwtKeyRegistry(TEST_SECRET);
    const k = reg.getKey("hs256-v1");
    expect(k).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(k!).equals(TEST_SECRET)).toBe(true);
  });

  it("getKey('hs256-v0') returns undefined when no prev secret is provided", () => {
    // v0.8.1: hs256-v0 is allowlisted but the key only resolves when an
    // operator passes prev secret to buildJwtKeyRegistry. With no prev,
    // verify of an hs256-v0-signed token still fails (caller throws on the
    // undefined key — see verifyPhase2SessionCookie defense-in-depth).
    const reg = buildJwtKeyRegistry(TEST_SECRET);
    expect(reg.getKey("hs256-v0")).toBeUndefined();
    expect(reg.getKey("attacker-controlled-kid")).toBeUndefined();
  });

  it("isAcceptedKid returns true for allowlisted kids, false otherwise", () => {
    expect(isAcceptedKid("hs256-v1")).toBe(true);
    // v0.8.1: hs256-v0 is on the allowlist (verify-only during rotation
    // overlap). Resolution still depends on registry having a prev key.
    expect(isAcceptedKid("hs256-v0")).toBe(true);
    expect(isAcceptedKid("")).toBe(false);
    expect(isAcceptedKid("none")).toBe(false);
    // Allowlist sanity: ACCEPTED_KIDS reflects current registry.
    expect(ACCEPTED_KIDS).toEqual(["hs256-v1", "hs256-v0"]);
  });

  // ---- v0.8.1 prev-secret overlap cases --------------------------------
  it("buildJwtKeyRegistry(current, prev) registers prev under 'hs256-v0' for verify", () => {
    const prev = Buffer.from(
      "X".repeat(16) + "y".repeat(16),
      "utf8",
    );
    const reg = buildJwtKeyRegistry(TEST_SECRET, prev);
    const got = reg.getKey("hs256-v0");
    expect(got).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(got!).equals(prev)).toBe(true);
  });

  it("buildJwtKeyRegistry(current, prev) leaves current.kid === 'hs256-v1' (sign target unchanged)", () => {
    const prev = Buffer.from("Z".repeat(32), "utf8");
    const reg = buildJwtKeyRegistry(TEST_SECRET, prev);
    // current is always the sign target; the prev kid is verify-only.
    expect(reg.current.kid).toBe("hs256-v1");
    expect(Buffer.from(reg.current.key).equals(TEST_SECRET)).toBe(true);
  });

  it("buildJwtKeyRegistry(current, prev) still resolves 'hs256-v1' to current (both kids coexist)", () => {
    const prev = Buffer.from("Q".repeat(32), "utf8");
    const reg = buildJwtKeyRegistry(TEST_SECRET, prev);
    const v1 = reg.getKey("hs256-v1");
    expect(v1).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(v1!).equals(TEST_SECRET)).toBe(true);
    // And the prev kid resolves to the prev key, not the current.
    const v0 = reg.getKey("hs256-v0");
    expect(Buffer.from(v0!).equals(prev)).toBe(true);
    expect(Buffer.from(v0!).equals(TEST_SECRET)).toBe(false);
  });

  it("rotation round-trip: token minted under old secret verifies via prev kid after rotation", async () => {
    // 1. Mint a token under the "old" secret (this is the secret in use
    //    before rotation).
    const OLD_SECRET = Buffer.from("o".repeat(16) + "P".repeat(16), "utf8");
    const oldReg = buildJwtKeyRegistry(OLD_SECRET);
    const issuer = "https://coord.test.example";
    const oldJwt = await mintAccessJWT({
      claims: {
        sub: "user-rotate-1",
        active_org_id: "org-z",
        family_id: "fam-1",
        role: "member",
      },
      registry: oldReg,
      issuer,
      ttlSeconds: 900,
    });
    // Confirm the token was minted under hs256-v1.
    const header = decodeJwtHeader(oldJwt);
    expect(header.kid).toBe("hs256-v1");

    // 2. Now "rotate": the operator promotes OLD_SECRET to PREV and picks
    //    a NEW current secret. Build a registry that reflects post-rotation.
    const NEW_SECRET = Buffer.from("n".repeat(16) + "Q".repeat(16), "utf8");
    const rotatedReg = buildJwtKeyRegistry(NEW_SECRET, OLD_SECRET);

    // 3. The OLD token's header.kid is "hs256-v1", but its signature was
    //    produced with OLD_SECRET — which in the rotated registry is now
    //    registered under "hs256-v0". The verifier must resolve the prev
    //    kid to validate this token. Simulate the verify-with-resolver
    //    pattern used by verifyPhase2SessionCookie / refreshTokenGrant.
    const prevKey = rotatedReg.getKey("hs256-v0");
    expect(prevKey).toBeInstanceOf(Uint8Array);
    const { payload } = await jwtVerify(oldJwt, prevKey!, {
      algorithms: ["HS256"],
      issuer,
    });
    expect(payload.sub).toBe("user-rotate-1");

    // 4. Sanity check: the NEW-current key does NOT verify the old token.
    await expect(
      jwtVerify(oldJwt, rotatedReg.current.key, {
        algorithms: ["HS256"],
        issuer,
      }),
    ).rejects.toThrow();
  });
});

describe("jwt-mint: access and refresh token minting", () => {
  const ISSUER = "https://coord.test.example";
  const baseAccessClaims: AccessTokenClaims = {
    sub: "user-abc",
    active_org_id: "org-xyz",
    family_id: "fam-1",
    role: "member",
  };
  const baseRefreshClaims: RefreshTokenClaims = {
    sub: "user-abc",
    active_org_id: "org-xyz",
    family_id: "fam-1",
  };

  it("mintAccessJWT returns a JWT (3 dot-separated parts)", async () => {
    const reg = buildJwtKeyRegistry(TEST_SECRET);
    const jwt = await mintAccessJWT({
      claims: baseAccessClaims,
      registry: reg,
      issuer: ISSUER,
      ttlSeconds: 900,
    });
    expect(typeof jwt).toBe("string");
    expect(jwt.split(".")).toHaveLength(3);
  });

  it("header has alg=HS256 and kid=hs256-v1", async () => {
    const reg = buildJwtKeyRegistry(TEST_SECRET);
    const jwt = await mintAccessJWT({
      claims: baseAccessClaims,
      registry: reg,
      issuer: ISSUER,
      ttlSeconds: 900,
    });
    const header = decodeJwtHeader(jwt);
    expect(header.alg).toBe("HS256");
    expect(header.kid).toBe("hs256-v1");
  });

  it("payload contains all input claims plus auto-injected jti, iat, exp, iss", async () => {
    const reg = buildJwtKeyRegistry(TEST_SECRET);
    const jwt = await mintAccessJWT({
      claims: baseAccessClaims,
      registry: reg,
      issuer: ISSUER,
      ttlSeconds: 900,
    });
    const payload = decodeJwtPayload(jwt);
    expect(payload.sub).toBe(baseAccessClaims.sub);
    expect(payload.active_org_id).toBe(baseAccessClaims.active_org_id);
    expect(payload.family_id).toBe(baseAccessClaims.family_id);
    expect(payload.role).toBe(baseAccessClaims.role);
    expect(typeof payload.jti).toBe("string");
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
    expect(payload.iss).toBe(ISSUER);
    // exp - iat == ttl (within 1s tolerance)
    expect((payload.exp as number) - (payload.iat as number)).toBe(900);
  });

  it("jti is a UUID format (length 36, hyphens at canonical positions)", async () => {
    const reg = buildJwtKeyRegistry(TEST_SECRET);
    const jwt = await mintAccessJWT({
      claims: baseAccessClaims,
      registry: reg,
      issuer: ISSUER,
      ttlSeconds: 900,
    });
    const payload = decodeJwtPayload(jwt);
    const jti = payload.jti as string;
    expect(jti).toHaveLength(36);
    expect(jti).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("mintRefreshJWT returns { jwt, jti } and produces a valid JWT shape", async () => {
    const reg = buildJwtKeyRegistry(TEST_SECRET);
    const { jwt, jti } = await mintRefreshJWT({
      claims: baseRefreshClaims,
      registry: reg,
      issuer: ISSUER,
      ttlSeconds: 30 * 86400,
    });
    expect(typeof jwt).toBe("string");
    expect(jwt.split(".")).toHaveLength(3);
    expect(typeof jti).toBe("string");
    expect(jti).toHaveLength(36);
    const payload = decodeJwtPayload(jwt);
    expect(payload.jti).toBe(jti);
    expect(payload.sub).toBe(baseRefreshClaims.sub);
    expect(payload.family_id).toBe(baseRefreshClaims.family_id);
  });

  it("mintRefreshJWT accepts a pre-set jti and uses it", async () => {
    const reg = buildJwtKeyRegistry(TEST_SECRET);
    const preset = "11111111-2222-3333-4444-555555555555";
    const { jwt, jti } = await mintRefreshJWT({
      claims: { ...baseRefreshClaims, parent_jti: "00000000-0000-0000-0000-000000000000" },
      registry: reg,
      issuer: ISSUER,
      ttlSeconds: 30 * 86400,
      jti: preset,
    });
    expect(jti).toBe(preset);
    const payload = decodeJwtPayload(jwt);
    expect(payload.jti).toBe(preset);
    expect(payload.parent_jti).toBe("00000000-0000-0000-0000-000000000000");
  });

  it("service-token claims round-trip in the payload", async () => {
    const reg = buildJwtKeyRegistry(TEST_SECRET);
    const serviceClaims: AccessTokenClaims = {
      sub: "svc-token-id",
      active_org_id: "org-xyz",
      family_id: "fam-svc-1",
      role: "service",
      service_account: true,
      scope: "write",
      issued_by: "admin-user-id",
    };
    const jwt = await mintAccessJWT({
      claims: serviceClaims,
      registry: reg,
      issuer: ISSUER,
      ttlSeconds: 3600,
    });
    const payload = decodeJwtPayload(jwt);
    expect(payload.role).toBe("service");
    expect(payload.service_account).toBe(true);
    expect(payload.scope).toBe("write");
    expect(payload.issued_by).toBe("admin-user-id");
  });

  it("mintAccessJWT iatOverride pins iat deterministically (T19b re-mint)", async () => {
    const reg = buildJwtKeyRegistry(TEST_SECRET);
    const pinned = 1_700_000_000;
    const jwtA = await mintAccessJWT({
      claims: baseAccessClaims,
      registry: reg,
      issuer: ISSUER,
      ttlSeconds: 900,
      iatOverride: pinned,
      jti: "11111111-2222-3333-4444-555555555555",
    });
    const jwtB = await mintAccessJWT({
      claims: baseAccessClaims,
      registry: reg,
      issuer: ISSUER,
      ttlSeconds: 900,
      iatOverride: pinned,
      jti: "11111111-2222-3333-4444-555555555555",
    });
    // Byte-identical when iat + jti + claims + issuer + ttl all pinned.
    expect(jwtA).toBe(jwtB);
    const payload = decodeJwtPayload(jwtA);
    expect(payload.iat).toBe(pinned);
    expect(payload.exp).toBe(pinned + 900);
  });

  it("mintAccessJWT without iatOverride uses now (default behavior unchanged)", async () => {
    const reg = buildJwtKeyRegistry(TEST_SECRET);
    const before = Math.floor(Date.now() / 1000);
    const jwt = await mintAccessJWT({
      claims: baseAccessClaims,
      registry: reg,
      issuer: ISSUER,
      ttlSeconds: 900,
    });
    const after = Math.floor(Date.now() / 1000);
    const payload = decodeJwtPayload(jwt);
    expect(payload.iat).toBeGreaterThanOrEqual(before);
    expect(payload.iat).toBeLessThanOrEqual(after);
  });

  it("mintRefreshJWT iatOverride pins iat deterministically (T19b re-mint)", async () => {
    const reg = buildJwtKeyRegistry(TEST_SECRET);
    const pinned = 1_700_000_500;
    const { jwt: jwtA, jti: jtiA } = await mintRefreshJWT({
      claims: baseRefreshClaims,
      registry: reg,
      issuer: ISSUER,
      ttlSeconds: 30 * 86400,
      iatOverride: pinned,
      jti: "22222222-3333-4444-5555-666666666666",
    });
    const { jwt: jwtB, jti: jtiB } = await mintRefreshJWT({
      claims: baseRefreshClaims,
      registry: reg,
      issuer: ISSUER,
      ttlSeconds: 30 * 86400,
      iatOverride: pinned,
      jti: "22222222-3333-4444-5555-666666666666",
    });
    expect(jwtA).toBe(jwtB);
    expect(jtiA).toBe(jtiB);
    const payload = decodeJwtPayload(jwtA);
    expect(payload.iat).toBe(pinned);
    expect(payload.exp).toBe(pinned + 30 * 86400);
  });

  it("mintRefreshJWT without iatOverride uses now (default behavior unchanged)", async () => {
    const reg = buildJwtKeyRegistry(TEST_SECRET);
    const before = Math.floor(Date.now() / 1000);
    const { jwt } = await mintRefreshJWT({
      claims: baseRefreshClaims,
      registry: reg,
      issuer: ISSUER,
      ttlSeconds: 30 * 86400,
    });
    const after = Math.floor(Date.now() / 1000);
    const payload = decodeJwtPayload(jwt);
    expect(payload.iat).toBeGreaterThanOrEqual(before);
    expect(payload.iat).toBeLessThanOrEqual(after);
  });

  it("token signed with the registry's current.key — verifiable via jose.jwtVerify", async () => {
    const reg = buildJwtKeyRegistry(TEST_SECRET);
    const jwt = await mintAccessJWT({
      claims: baseAccessClaims,
      registry: reg,
      issuer: ISSUER,
      ttlSeconds: 900,
    });
    const { payload, protectedHeader } = await jwtVerify(jwt, reg.current.key, {
      algorithms: ["HS256"],
      issuer: ISSUER,
    });
    expect(protectedHeader.alg).toBe("HS256");
    expect(protectedHeader.kid).toBe("hs256-v1");
    expect(payload.sub).toBe(baseAccessClaims.sub);
    expect(payload.active_org_id).toBe(baseAccessClaims.active_org_id);
    expect(payload.role).toBe("member");

    // Cross-check: verifying with a different key fails.
    const wrongKey = new Uint8Array(TEST_SECRET.length).fill(0xff);
    await expect(
      jwtVerify(jwt, wrongKey, { algorithms: ["HS256"] }),
    ).rejects.toThrow();
  });
});

describe("pkce: verifier and S256 challenge", () => {
  it("generateVerifier returns a 43-char base64url string", () => {
    const v = generateVerifier();
    expect(v).toHaveLength(43);
    expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("computeChallenge is deterministic (same verifier -> same challenge)", () => {
    const v = generateVerifier();
    const c1 = computeChallenge(v);
    const c2 = computeChallenge(v);
    expect(c1).toBe(c2);
    expect(c1).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("RFC 7636 §4.2 test vector", () => {
    // The verifier and expected challenge from the RFC's appendix example.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(computeChallenge(verifier)).toBe(expected);
  });
});

describe("entropy: assertSecretEntropy boot check", () => {
  it("random 32-byte buffer passes default minBits=128", () => {
    expect(() => assertSecretEntropy(RANDOM_32)).not.toThrow();
  });

  it("all-zero 32-byte buffer throws", () => {
    expect(() => assertSecretEntropy(Buffer.alloc(32))).toThrow(
      /all bytes identical/,
    );
  });

  it("empty buffer throws with explicit message", () => {
    expect(() => assertSecretEntropy(Buffer.alloc(0))).toThrow(/empty buffer/);
  });

  it("dictionary word 'change-me' encoded as UTF-8 throws", () => {
    expect(() => assertSecretEntropy(Buffer.from("change-me", "utf8"))).toThrow(
      /dictionary word/,
    );
  });

  it("dictionary word substring inside a longer buffer also throws", () => {
    // High-byte-diversity buffer that *contains* "password" in ASCII still fails.
    const buf = Buffer.from("xK7q!password#9Lm", "utf8");
    expect(() => assertSecretEntropy(buf)).toThrow(/dictionary word/);
  });

  it("ASCII-only 32-byte string with very low byte diversity throws", () => {
    // 32 bytes alternating between two values -> Shannon entropy = 1 bit/byte
    // * 32 = 32 total bits, well below the 128 minimum.
    const buf = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) buf[i] = i % 2 === 0 ? 0x41 : 0x42;
    expect(() => assertSecretEntropy(buf)).toThrow(/bits estimated/);
  });

  it("minBits parameter governs the threshold", () => {
    // Same low-diversity buffer (~32 bits) passes when minBits=16.
    const buf = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) buf[i] = i % 2 === 0 ? 0x41 : 0x42;
    expect(() => assertSecretEntropy(buf, 16)).not.toThrow();
  });
});
