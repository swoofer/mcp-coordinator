import { describe, it, expect, afterEach } from "vitest";
import { providers, registerProvider, getProvider } from "../../src/auth/providers/registry.js";
import type { IdPProvider } from "../../src/auth/providers/types.js";

afterEach(() => {
  providers.clear();
});

describe("provider registry", () => {
  it("getProvider returns null for unknown provider", () => {
    expect(getProvider("nope")).toBeNull();
  });

  it("registerProvider stores by name", () => {
    const fake: IdPProvider = {
      name: "fake",
      buildAuthUrl: () => "https://x",
      exchangeCode: async () => ({ user: { idp_user_id: "1", email: "a@x" }, accessToken: "tok" }),
    };
    registerProvider(fake);
    expect(getProvider("fake")).toBe(fake);
  });

  it("registry is empty by default (Phase 1 ships no impls)", () => {
    expect(providers.size).toBe(0);
  });
});
