import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const DISCOVERY_PATH = "/.well-known/oauth-authorization-server";

export interface DiscoveryDoc {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  device_authorization_endpoint: string;
  revocation_endpoint: string;
  userinfo_endpoint?: string;
  grant_types_supported: string[];
  response_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  [key: string]: unknown;
}

interface CacheEntry {
  fetchedAt: number; // epoch ms
  baseUrl: string;
  doc: DiscoveryDoc;
}

export interface DiscoveryCacheOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  /** Custom cache file path. Default: ~/.mcp-coordinator/discovery-cache.json */
  cachePath?: string;
  /** Cache TTL in milliseconds. Default 24h. */
  ttlMs?: number;
}

/**
 * Fetches the OAuth discovery document with a 24h cache. Network failures
 * fall back to the last-known cached value if available; otherwise re-throw.
 *
 * Cache is keyed by baseUrl -- switching profiles to a different coordinator
 * triggers a fresh fetch.
 */
export class DiscoveryCache {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cachePath: string;
  private readonly ttlMs: number;
  private memoryCache: CacheEntry | null = null;

  constructor(opts: DiscoveryCacheOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.cachePath =
      opts.cachePath ?? path.join(os.homedir(), ".mcp-coordinator", "discovery-cache.json");
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  }

  /** Load doc -- from memory cache, disk cache, or network (in that order). */
  async load(): Promise<DiscoveryDoc> {
    // Memory first
    if (this.memoryCache && this.memoryCache.baseUrl === this.baseUrl && this.isFresh(this.memoryCache)) {
      return this.memoryCache.doc;
    }
    // Disk
    const disk = await this.readDiskCache();
    if (disk && disk.baseUrl === this.baseUrl && this.isFresh(disk)) {
      this.memoryCache = disk;
      return disk.doc;
    }
    // Network (with fallback to stale disk on error)
    try {
      const doc = await this.fetchFromNetwork();
      const entry: CacheEntry = { fetchedAt: Date.now(), baseUrl: this.baseUrl, doc };
      this.memoryCache = entry;
      await this.writeDiskCache(entry).catch(() => {
        /* best-effort */
      });
      return doc;
    } catch (err) {
      if (disk && disk.baseUrl === this.baseUrl) {
        // Stale-on-error: return the last known doc even if past TTL
        this.memoryCache = disk;
        return disk.doc;
      }
      throw err;
    }
  }

  /** Force a fresh network fetch, bypassing cache. */
  async refresh(): Promise<DiscoveryDoc> {
    const doc = await this.fetchFromNetwork();
    const entry: CacheEntry = { fetchedAt: Date.now(), baseUrl: this.baseUrl, doc };
    this.memoryCache = entry;
    await this.writeDiskCache(entry).catch(() => {
      /* best-effort */
    });
    return doc;
  }

  /** Clear in-memory + on-disk cache. */
  async clear(): Promise<void> {
    this.memoryCache = null;
    try {
      await fs.promises.unlink(this.cachePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  private isFresh(entry: CacheEntry): boolean {
    return Date.now() - entry.fetchedAt < this.ttlMs;
  }

  private async fetchFromNetwork(): Promise<DiscoveryDoc> {
    const res = await this.fetchImpl(`${this.baseUrl}${DISCOVERY_PATH}`);
    if (!res.ok) {
      throw new Error(`Discovery fetch failed: HTTP ${res.status}`);
    }
    return (await res.json()) as DiscoveryDoc;
  }

  private async readDiskCache(): Promise<CacheEntry | null> {
    try {
      const raw = await fs.promises.readFile(this.cachePath, "utf8");
      return JSON.parse(raw) as CacheEntry;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (err instanceof SyntaxError) return null; // corrupted; ignore
      throw err;
    }
  }

  private async writeDiskCache(entry: CacheEntry): Promise<void> {
    const dir = path.dirname(this.cachePath);
    await fs.promises.mkdir(dir, { recursive: true });
    const tmpPath = `${this.cachePath}.tmp.${process.pid}`;
    await fs.promises.writeFile(tmpPath, JSON.stringify(entry, null, 2), "utf8");
    await fs.promises.rename(tmpPath, this.cachePath);
  }
}
