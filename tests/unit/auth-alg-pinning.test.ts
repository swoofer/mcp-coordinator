import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SignJWT, generateKeyPair } from "jose";
import { initDatabase, closeDb } from "../../src/database.js";
import { initAuth, verifyToken } from "../../src/auth.js";
import fs from "fs";

const DIR = "data-test-alg";
const SECRET = "test-secret-at-least-32-characters-long!";

beforeAll(() => {
  fs.mkdirSync(DIR, { recursive: true });
  initDatabase(DIR);
  initAuth(SECRET);
});
afterAll(() => { closeDb(); fs.rmSync(DIR, { recursive: true, force: true }); });

describe("JWS algorithm pinning", () => {
  // IMPORTANT: BOTH cases below MUST stay in the suite. Without the `{ algorithms: ['HS256'] }`
  // pin, the RS256 case slips through (jose will attempt verification with the HMAC secret as
  // a public key and the wrong reason can mask the regression). The alg=none case is also
  // not redundant — it guards against future jose versions that might relax defaults.
  it("rejects alg=none tokens", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      sub: "attacker", role: "admin", exp: Math.floor(Date.now() / 1000) + 3600,
    })).toString("base64url");
    const token = `${header}.${payload}.`;
    await expect(verifyToken(token)).rejects.toThrow(/algorithm|alg|signature|none/i);
  });

  it("rejects RS256-signed tokens (HS256 is the only accepted alg)", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const token = await new SignJWT({ role: "admin", user_id: "x", org: "default" })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject("attacker")
      .setExpirationTime("1h")
      .sign(privateKey);
    // Assert on the rejection REASON, not just any throw — a generic .toThrow()
    // passes on key-import or test-setup errors, masking a missing pin.
    await expect(verifyToken(token)).rejects.toThrow(/algorithm|alg|JOSEAlgNotAllowed/i);
  });

  it("accepts HS256 with the configured secret", async () => {
    const key = new TextEncoder().encode(SECRET);
    const token = await new SignJWT({ role: "agent", user_id: "u1", org: "default" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("agent-1")
      .setExpirationTime("1h")
      .sign(key);
    const claims = await verifyToken(token);
    expect(claims.sub).toBe("agent-1");
  });
});
