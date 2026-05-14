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

  it("getKey('hs256-v0') returns undefined (not yet registered)", () => {
    const reg = buildJwtKeyRegistry(TEST_SECRET);
    expect(reg.getKey("hs256-v0")).toBeUndefined();
    expect(reg.getKey("attacker-controlled-kid")).toBeUndefined();
  });

  it("isAcceptedKid returns true for allowlisted kids, false otherwise", () => {
    expect(isAcceptedKid("hs256-v1")).toBe(true);
    expect(isAcceptedKid("hs256-v0")).toBe(false);
    expect(isAcceptedKid("")).toBe(false);
    expect(isAcceptedKid("none")).toBe(false);
    // Allowlist sanity: ACCEPTED_KIDS reflects current registry.
    expect(ACCEPTED_KIDS).toEqual(["hs256-v1"]);
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
