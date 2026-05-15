import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DiscoveryCache } from "../src/discovery.js";
import type { DiscoveryDoc } from "../src/discovery.js";

const BASE_URL = "https://coord.test";

function makeDoc(overrides: Partial<DiscoveryDoc> = {}): DiscoveryDoc {
  return {
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/auth/login`,
    token_endpoint: `${BASE_URL}/api/auth/oauth/token`,
    device_authorization_endpoint: `${BASE_URL}/api/auth/oauth/device_authorization`,
    revocation_endpoint: `${BASE_URL}/api/auth/revoke`,
    userinfo_endpoint: `${BASE_URL}/api/auth/me`,
    grant_types_supported: ["refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "ERR",
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("DiscoveryCache", () => {
  let tmpDir: string;
  let cachePath: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `mcp-discovery-${crypto.randomUUID()}`);
    await fs.promises.mkdir(tmpDir, { recursive: true });
    cachePath = path.join(tmpDir, "discovery-cache.json");
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {
      /* best-effort */
    });
  });

  it("load: first call fetches from network and caches in memory + disk", async () => {
    const doc = makeDoc();
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(`${BASE_URL}/.well-known/oauth-authorization-server`);
      return jsonResponse(doc);
    });
    const cache = new DiscoveryCache({
      baseUrl: BASE_URL,
      fetch: fetchMock as unknown as typeof fetch,
      cachePath,
    });
    const out = await cache.load();
    expect(out.token_endpoint).toBe(doc.token_endpoint);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const onDisk = JSON.parse(await fs.promises.readFile(cachePath, "utf8"));
    expect(onDisk.doc.token_endpoint).toBe(doc.token_endpoint);
    expect(onDisk.baseUrl).toBe(BASE_URL);
  });

  it("load: second call within TTL returns memory cache (no network)", async () => {
    const doc = makeDoc();
    const fetchMock = vi.fn(async () => jsonResponse(doc));
    const cache = new DiscoveryCache({
      baseUrl: BASE_URL,
      fetch: fetchMock as unknown as typeof fetch,
      cachePath,
    });
    await cache.load();
    await cache.load();
    await cache.load();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("load: after TTL expiry refetches", async () => {
    const doc1 = makeDoc({ token_endpoint: `${BASE_URL}/v1/token` });
    const doc2 = makeDoc({ token_endpoint: `${BASE_URL}/v2/token` });
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      return jsonResponse(call === 1 ? doc1 : doc2);
    });
    const cache = new DiscoveryCache({
      baseUrl: BASE_URL,
      fetch: fetchMock as unknown as typeof fetch,
      cachePath,
      ttlMs: 50, // very short TTL
    });
    const out1 = await cache.load();
    expect(out1.token_endpoint).toBe(`${BASE_URL}/v1/token`);
    await new Promise((r) => setTimeout(r, 80));
    const out2 = await cache.load();
    expect(out2.token_endpoint).toBe(`${BASE_URL}/v2/token`);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("load: network failure with stale disk cache returns stale (last-known)", async () => {
    const staleDoc = makeDoc({ token_endpoint: `${BASE_URL}/stale/token` });
    // Pre-seed disk cache with a stale entry (fetchedAt way in the past).
    await fs.promises.writeFile(
      cachePath,
      JSON.stringify({
        fetchedAt: Date.now() - 100 * 24 * 60 * 60 * 1000, // 100 days ago
        baseUrl: BASE_URL,
        doc: staleDoc,
      }),
    );
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    const cache = new DiscoveryCache({
      baseUrl: BASE_URL,
      fetch: fetchMock as unknown as typeof fetch,
      cachePath,
    });
    const out = await cache.load();
    expect(out.token_endpoint).toBe(`${BASE_URL}/stale/token`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("load: network failure with no cache throws", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    const cache = new DiscoveryCache({
      baseUrl: BASE_URL,
      fetch: fetchMock as unknown as typeof fetch,
      cachePath,
    });
    await expect(cache.load()).rejects.toThrow("network down");
  });

  it("refresh: bypasses cache + writes fresh", async () => {
    const doc1 = makeDoc({ token_endpoint: `${BASE_URL}/v1/token` });
    const doc2 = makeDoc({ token_endpoint: `${BASE_URL}/v2/token` });
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      return jsonResponse(call === 1 ? doc1 : doc2);
    });
    const cache = new DiscoveryCache({
      baseUrl: BASE_URL,
      fetch: fetchMock as unknown as typeof fetch,
      cachePath,
    });
    await cache.load();
    const fresh = await cache.refresh();
    expect(fresh.token_endpoint).toBe(`${BASE_URL}/v2/token`);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const onDisk = JSON.parse(await fs.promises.readFile(cachePath, "utf8"));
    expect(onDisk.doc.token_endpoint).toBe(`${BASE_URL}/v2/token`);
  });

  it("clear: empties memory + deletes disk file", async () => {
    const doc = makeDoc();
    const fetchMock = vi.fn(async () => jsonResponse(doc));
    const cache = new DiscoveryCache({
      baseUrl: BASE_URL,
      fetch: fetchMock as unknown as typeof fetch,
      cachePath,
    });
    await cache.load();
    expect(fs.existsSync(cachePath)).toBe(true);
    await cache.clear();
    expect(fs.existsSync(cachePath)).toBe(false);
    // Next load refetches (memory cleared too).
    await cache.load();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("disk-cache baseUrl mismatch is ignored (forces refetch)", async () => {
    const wrongDoc = makeDoc({ token_endpoint: "https://other.example/token" });
    // Seed disk cache with a DIFFERENT baseUrl.
    await fs.promises.writeFile(
      cachePath,
      JSON.stringify({
        fetchedAt: Date.now(),
        baseUrl: "https://other.example",
        doc: wrongDoc,
      }),
    );
    const rightDoc = makeDoc();
    const fetchMock = vi.fn(async () => jsonResponse(rightDoc));
    const cache = new DiscoveryCache({
      baseUrl: BASE_URL,
      fetch: fetchMock as unknown as typeof fetch,
      cachePath,
    });
    const out = await cache.load();
    expect(out.token_endpoint).toBe(rightDoc.token_endpoint);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("corrupted cache file (SyntaxError) is treated as absent and refetched", async () => {
    await fs.promises.writeFile(cachePath, "{ not valid json");
    const doc = makeDoc();
    const fetchMock = vi.fn(async () => jsonResponse(doc));
    const cache = new DiscoveryCache({
      baseUrl: BASE_URL,
      fetch: fetchMock as unknown as typeof fetch,
      cachePath,
    });
    const out = await cache.load();
    expect(out.token_endpoint).toBe(doc.token_endpoint);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("atomic write: writes a tmp + rename so cachePath ends up complete", async () => {
    const doc = makeDoc();
    const fetchMock = vi.fn(async () => jsonResponse(doc));
    const cache = new DiscoveryCache({
      baseUrl: BASE_URL,
      fetch: fetchMock as unknown as typeof fetch,
      cachePath,
    });
    await cache.load();
    // After write+rename, cachePath should exist and parse correctly.
    const raw = await fs.promises.readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.doc.token_endpoint).toBe(doc.token_endpoint);
    // The tmp file should not be lingering.
    const dirEntries = await fs.promises.readdir(path.dirname(cachePath));
    const tmpLeftover = dirEntries.find((n) => n.includes(".tmp."));
    expect(tmpLeftover).toBeUndefined();
  });

  it("HTTP error response from discovery throws (and falls back to disk if available)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 503));
    const cache = new DiscoveryCache({
      baseUrl: BASE_URL,
      fetch: fetchMock as unknown as typeof fetch,
      cachePath,
    });
    await expect(cache.load()).rejects.toThrow(/HTTP 503/);
  });
});
