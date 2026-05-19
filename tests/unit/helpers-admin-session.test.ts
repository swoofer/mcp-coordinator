import { describe, it, expect } from "vitest";
import { jwtVerify } from "jose";
import { makeAdminSession } from "../helpers/admin-session.js";
import { buildJwtKeyRegistry } from "../../src/auth/jwt-keys.js";

const SECRET = Buffer.alloc(32, 0x42);
const ISSUER = "http://localhost:3000";

function buildRegistry() {
  return buildJwtKeyRegistry(SECRET);
}

describe("makeAdminSession", () => {
  it("returns a JWT that verifies under the same registry", async () => {
    const registry = buildRegistry();
    const session = await makeAdminSession({
      userId: "u-alice",
      orgId: "org-acme",
      registry,
      issuer: ISSUER,
    });

    const { payload, protectedHeader } = await jwtVerify(
      session.jwt,
      registry.current.key,
      { algorithms: ["HS256"], issuer: ISSUER },
    );
    expect(protectedHeader.alg).toBe("HS256");
    expect(protectedHeader.kid).toBe("hs256-v1");
    expect(payload.sub).toBe("u-alice");
    expect(payload.active_org_id).toBe("org-acme");
  });

  it("defaults role to 'admin' when not specified", async () => {
    const registry = buildRegistry();
    const session = await makeAdminSession({
      userId: "u-1",
      orgId: "org-1",
      registry,
      issuer: ISSUER,
    });
    expect(session.role).toBe("admin");

    const { payload } = await jwtVerify(session.jwt, registry.current.key, {
      algorithms: ["HS256"],
      issuer: ISSUER,
    });
    expect(payload.role).toBe("admin");
  });

  it("honors role: 'member' when passed", async () => {
    const registry = buildRegistry();
    const session = await makeAdminSession({
      userId: "u-2",
      orgId: "org-2",
      registry,
      issuer: ISSUER,
      role: "member",
    });
    expect(session.role).toBe("member");

    const { payload } = await jwtVerify(session.jwt, registry.current.key, {
      algorithms: ["HS256"],
      issuer: ISSUER,
    });
    expect(payload.role).toBe("member");
  });

  it("generates a CSRF token that is base64url and 43 chars (256-bit unpadded)", async () => {
    const registry = buildRegistry();
    const session = await makeAdminSession({
      userId: "u-3",
      orgId: "org-3",
      registry,
      issuer: ISSUER,
    });
    expect(session.csrfCookieValue).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("csrfHeader equals csrfCookieValue (double-submit)", async () => {
    const registry = buildRegistry();
    const session = await makeAdminSession({
      userId: "u-4",
      orgId: "org-4",
      registry,
      issuer: ISSUER,
    });
    expect(session.csrfHeader).toBe(session.csrfCookieValue);
  });

  it("cookies use __Host- prefix and Secure + Path=/", async () => {
    const registry = buildRegistry();
    const session = await makeAdminSession({
      userId: "u-5",
      orgId: "org-5",
      registry,
      issuer: ISSUER,
    });
    expect(session.cookies.session.startsWith("__Host-coordinator_session=")).toBe(true);
    expect(session.cookies.csrf.startsWith("__Host-coordinator_csrf=")).toBe(true);
    // hostCookie enforces Secure + Path=/. cookie@1 lowercases attrs.
    expect(session.cookies.session).toMatch(/Secure/i);
    expect(session.cookies.session).toMatch(/Path=\//);
    expect(session.cookies.session).toMatch(/HttpOnly/i);
    expect(session.cookies.csrf).toMatch(/Secure/i);
    // CSRF cookie must NOT be HttpOnly (JS reads it to send in X-CSRF-Token).
    expect(session.cookies.csrf).not.toMatch(/HttpOnly/i);
  });

  it("cookieHeader includes both __Host- prefixed cookies as name=value pairs", async () => {
    const registry = buildRegistry();
    const session = await makeAdminSession({
      userId: "u-6",
      orgId: "org-6",
      registry,
      issuer: ISSUER,
    });
    expect(session.cookieHeader).toContain(`__Host-coordinator_session=${session.jwt}`);
    expect(session.cookieHeader).toContain(
      `__Host-coordinator_csrf=${session.csrfCookieValue}`,
    );
    // No Set-Cookie attributes leaking into the request Cookie header.
    expect(session.cookieHeader).not.toMatch(/Secure/i);
    expect(session.cookieHeader).not.toMatch(/Path=/i);
    expect(session.cookieHeader).not.toMatch(/HttpOnly/i);
  });

  it("returns the userId and orgId verbatim on the result", async () => {
    const registry = buildRegistry();
    const session = await makeAdminSession({
      userId: "u-verbatim",
      orgId: "org-verbatim",
      registry,
      issuer: ISSUER,
    });
    expect(session.userId).toBe("u-verbatim");
    expect(session.orgId).toBe("org-verbatim");
  });

  it("respects custom familyId and ttlSeconds", async () => {
    const registry = buildRegistry();
    const session = await makeAdminSession({
      userId: "u-7",
      orgId: "org-7",
      registry,
      issuer: ISSUER,
      familyId: "fam-custom",
      ttlSeconds: 60,
    });
    const { payload } = await jwtVerify(session.jwt, registry.current.key, {
      algorithms: ["HS256"],
      issuer: ISSUER,
    });
    expect(payload.family_id).toBe("fam-custom");
    // exp should be roughly iat + 60. Allow 5s of skew between mint and assert.
    expect(typeof payload.exp).toBe("number");
    expect(typeof payload.iat).toBe("number");
    const ttl = (payload.exp as number) - (payload.iat as number);
    expect(ttl).toBe(60);
  });
});
