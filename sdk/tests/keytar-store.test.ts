import { describe, it, expect, vi } from "vitest";
import { KeytarTokenStore, KeytarUnavailableError } from "../src/keytar-store.js";
import type { TokenSet } from "../src/types.js";

function makeStubKeytar() {
  const data = new Map<string, string>();
  return {
    getPassword: vi.fn(async (s: string, a: string) => data.get(`${s}:${a}`) ?? null),
    setPassword: vi.fn(async (s: string, a: string, p: string) => {
      data.set(`${s}:${a}`, p);
    }),
    deletePassword: vi.fn(async (s: string, a: string) => {
      const had = data.has(`${s}:${a}`);
      data.delete(`${s}:${a}`);
      return had;
    }),
    _data: data,
  };
}

const SAMPLE_TOKENS: TokenSet = {
  accessToken: "at-abc",
  refreshToken: "rt-xyz",
  accessExpiresAt: 1_999_999_999,
};

describe("KeytarTokenStore", () => {
  it("load returns null when keychain has no entry", async () => {
    const stub = makeStubKeytar();
    const store = new KeytarTokenStore({ _keytar: stub });
    expect(await store.load()).toBeNull();
    expect(stub.getPassword).toHaveBeenCalledWith("mcp-coordinator", "default");
  });

  it("save then load roundtrip", async () => {
    const stub = makeStubKeytar();
    const store = new KeytarTokenStore({ _keytar: stub });
    await store.save(SAMPLE_TOKENS);
    expect(await store.load()).toEqual(SAMPLE_TOKENS);
  });

  it("custom serviceName + account are honored", async () => {
    const stub = makeStubKeytar();
    const store = new KeytarTokenStore({
      serviceName: "custom-svc",
      account: "alice",
      _keytar: stub,
    });
    await store.save(SAMPLE_TOKENS);
    expect(stub.setPassword).toHaveBeenCalledWith(
      "custom-svc",
      "alice",
      JSON.stringify(SAMPLE_TOKENS),
    );
  });

  it("clear deletes the entry", async () => {
    const stub = makeStubKeytar();
    const store = new KeytarTokenStore({ _keytar: stub });
    await store.save(SAMPLE_TOKENS);
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it("clear on empty keychain is idempotent (no throw)", async () => {
    const stub = makeStubKeytar();
    const store = new KeytarTokenStore({ _keytar: stub });
    await expect(store.clear()).resolves.toBeUndefined();
  });

  it("getServiceAccount reports configured values", () => {
    const store = new KeytarTokenStore({ serviceName: "x", account: "y" });
    expect(store.getServiceAccount()).toEqual({ serviceName: "x", account: "y" });
  });

  it("default serviceName + account when omitted", () => {
    const store = new KeytarTokenStore();
    expect(store.getServiceAccount()).toEqual({
      serviceName: "mcp-coordinator",
      account: "default",
    });
  });

  it("corrupted JSON in keychain -> load returns null (no throw)", async () => {
    const stub = makeStubKeytar();
    stub._data.set("mcp-coordinator:default", "not valid json {{{");
    const store = new KeytarTokenStore({ _keytar: stub });
    expect(await store.load()).toBeNull();
  });

  it("real keytar import fails -> KeytarUnavailableError with cause", async () => {
    // No _keytar injected -- triggers dynamic import which will fail because
    // keytar is not installed in this workspace.
    const store = new KeytarTokenStore();
    await expect(store.load()).rejects.toThrow(KeytarUnavailableError);
    try {
      await store.load();
    } catch (err) {
      expect(err).toBeInstanceOf(KeytarUnavailableError);
      expect((err as KeytarUnavailableError).message).toContain("npm install keytar");
    }
  });
});
