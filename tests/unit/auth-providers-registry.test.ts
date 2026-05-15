import { describe, it, expect } from "vitest";
import { ProviderRegistry } from "../../src/auth/providers/registry.js";
import type { IdPProvider } from "../../src/auth/providers/types.js";

function fakeProvider(name: string): IdPProvider {
  return {
    name,
    buildAuthUrl: () => `https://${name}/auth`,
    exchangeCode: async () => ({
      user: { idp_user_id: "1", email: `u@${name}` },
      accessToken: `tok-${name}`,
    }),
  };
}

describe("ProviderRegistry", () => {
  it("starts empty", () => {
    const r = new ProviderRegistry();
    expect(r.size()).toBe(0);
    expect(r.list()).toEqual([]);
    expect(r.names()).toEqual([]);
    expect(r.getDefault()).toBeNull();
    expect(r.get("github")).toBeNull();
    expect(r.has("github")).toBe(false);
  });

  it("registers and retrieves by name", () => {
    const r = new ProviderRegistry();
    const gh = fakeProvider("github");
    r.register(gh);
    expect(r.size()).toBe(1);
    expect(r.has("github")).toBe(true);
    expect(r.get("github")).toBe(gh);
    expect(r.list()).toEqual([gh]);
    expect(r.names()).toEqual(["github"]);
  });

  it("first registration becomes the default", () => {
    const r = new ProviderRegistry();
    const gh = fakeProvider("github");
    const goog = fakeProvider("google");
    r.register(gh);
    r.register(goog);
    expect(r.getDefault()).toBe(gh);
    expect(r.size()).toBe(2);
  });

  it("setDefault overrides the implicit default", () => {
    const r = new ProviderRegistry();
    const gh = fakeProvider("github");
    const goog = fakeProvider("google");
    r.register(gh);
    r.register(goog);
    r.setDefault("google");
    expect(r.getDefault()).toBe(goog);
  });

  it("setDefault throws for unknown provider", () => {
    const r = new ProviderRegistry();
    r.register(fakeProvider("github"));
    expect(() => r.setDefault("nope")).toThrow(/unknown provider/);
  });

  it("re-registering same name overwrites", () => {
    const r = new ProviderRegistry();
    const gh1 = fakeProvider("github");
    const gh2 = fakeProvider("github");
    r.register(gh1);
    r.register(gh2);
    expect(r.get("github")).toBe(gh2);
    expect(r.size()).toBe(1);
  });

  it("re-registering same name does not change implicit default", () => {
    const r = new ProviderRegistry();
    const gh = fakeProvider("github");
    const goog = fakeProvider("google");
    const gh2 = fakeProvider("github");
    r.register(gh);
    r.register(goog);
    r.register(gh2);
    expect(r.getDefault()).toBe(gh2);
  });

  it("get returns null for unknown provider", () => {
    const r = new ProviderRegistry();
    r.register(fakeProvider("github"));
    expect(r.get("nope")).toBeNull();
  });

  it("clear resets registry and default", () => {
    const r = new ProviderRegistry();
    r.register(fakeProvider("github"));
    r.register(fakeProvider("google"));
    r.clear();
    expect(r.size()).toBe(0);
    expect(r.getDefault()).toBeNull();
    expect(r.list()).toEqual([]);
  });

  it("list returns insertion order", () => {
    const r = new ProviderRegistry();
    const gh = fakeProvider("github");
    const goog = fakeProvider("google");
    const oidc = fakeProvider("oidc");
    r.register(gh);
    r.register(goog);
    r.register(oidc);
    expect(r.list().map((p) => p.name)).toEqual(["github", "google", "oidc"]);
  });
});
