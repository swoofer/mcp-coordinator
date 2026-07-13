import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initDatabase, closeDb } from "../../src/database.js";
import { initAuth, createToken, verifyToken } from "../../src/auth.js";
import fs from "fs";

const DIR = "data-test-rotation";

beforeAll(() => {
  fs.mkdirSync(DIR, { recursive: true });
  initDatabase(DIR);
});
afterAll(() => {
  closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
});

// CRITICAL: reset auth state so prevKey doesn't contaminate later test files
// under vitest's fileParallelism: false. See "Module-state hygiene" in Conventions.
afterAll(() => {
  initAuth("test-secret-at-least-32-characters-long!");
});

describe("JWT secret rotation", () => {
  it("accepts tokens signed with the previous secret when both are configured", async () => {
    initAuth("OLD-secret-at-least-32-characters-long!");
    const oldToken = await createToken("agent-rot", "agent");

    initAuth("NEW-secret-at-least-32-characters-long!", undefined, {
      prevSecret: "OLD-secret-at-least-32-characters-long!",
    });
    const claims = await verifyToken(oldToken);
    expect(claims.sub).toBe("agent-rot");
  });

  it("rejects tokens signed with the old secret once it is removed", async () => {
    initAuth("OLD-secret-at-least-32-characters-long!");
    const oldToken = await createToken("agent-rot-2", "agent");

    initAuth("NEW-secret-at-least-32-characters-long!");
    await expect(verifyToken(oldToken)).rejects.toThrow();
  });

  it("new tokens are signed with the current secret, not prev", async () => {
    initAuth("NEW-secret-at-least-32-characters-long!", undefined, {
      prevSecret: "OLD-secret-at-least-32-characters-long!",
    });
    const newToken = await createToken("agent-rot-3", "agent");

    initAuth("NEW-secret-at-least-32-characters-long!");
    const claims = await verifyToken(newToken);
    expect(claims.sub).toBe("agent-rot-3");
  });
});
