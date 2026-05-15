import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { FileTokenStore, MemoryTokenStore } from "../src/index.js";
import type { TokenSet } from "../src/types.js";

const SAMPLE: TokenSet = {
  accessToken: "at_sample",
  refreshToken: "rt_sample",
  accessExpiresAt: 1_700_000_000,
};

const POSIX_ONLY = process.platform !== "win32";

describe("FileTokenStore", () => {
  let tmpDir: string;
  let filePath: string;
  let store: FileTokenStore;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `mcp-test-${crypto.randomUUID()}`);
    filePath = path.join(tmpDir, "tokens.json");
    store = new FileTokenStore({ filePath });
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {
      /* best-effort */
    });
  });

  it("load returns null when file does not exist", async () => {
    const loaded = await store.load();
    expect(loaded).toBeNull();
  });

  it("save writes JSON to disk", async () => {
    await store.save(SAMPLE);
    const raw = await fs.promises.readFile(filePath, "utf8");
    expect(JSON.parse(raw)).toEqual(SAMPLE);
  });

  it("save creates parent dir (and chmod 0700 on POSIX)", async () => {
    await store.save(SAMPLE);
    const dirStat = await fs.promises.stat(tmpDir);
    expect(dirStat.isDirectory()).toBe(true);
    if (POSIX_ONLY) {
      // Mode lower bits should be 0700.
      expect(dirStat.mode & 0o777).toBe(0o700);
    }
  });

  it.skipIf(!POSIX_ONLY)("save writes file with chmod 0600 on POSIX", async () => {
    await store.save(SAMPLE);
    const stat = await fs.promises.stat(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("atomic write: no stray tmp file remains after save", async () => {
    await store.save(SAMPLE);
    const entries = await fs.promises.readdir(tmpDir);
    // Only tokens.json should remain -- the .tmp.<pid> file was renamed.
    expect(entries).toEqual(["tokens.json"]);
    // And the rename target should match.
    const stat = await fs.promises.stat(filePath);
    expect(stat.isFile()).toBe(true);
  });

  it("load returns the same TokenSet that save wrote", async () => {
    await store.save(SAMPLE);
    const loaded = await store.load();
    expect(loaded).toEqual(SAMPLE);
  });

  it("clear unlinks the file", async () => {
    await store.save(SAMPLE);
    await store.clear();
    await expect(fs.promises.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await store.load()).toBeNull();
  });

  it("clear is idempotent (no error if already cleared)", async () => {
    await expect(store.clear()).resolves.toBeUndefined();
    await expect(store.clear()).resolves.toBeUndefined();
  });

  it("getPath returns the configured file path", () => {
    expect(store.getPath()).toBe(filePath);
  });

  it("default constructor uses ~/.mcp-coordinator/tokens.json", () => {
    const defaultStore = new FileTokenStore();
    expect(defaultStore.getPath()).toBe(
      path.join(os.homedir(), ".mcp-coordinator", "tokens.json"),
    );
  });
});

describe("MemoryTokenStore", () => {
  it("save then load roundtrip", async () => {
    const m = new MemoryTokenStore();
    expect(await m.load()).toBeNull();
    await m.save(SAMPLE);
    expect(await m.load()).toEqual(SAMPLE);
  });

  it("clear empties the store", async () => {
    const m = new MemoryTokenStore();
    await m.save(SAMPLE);
    await m.clear();
    expect(await m.load()).toBeNull();
  });
});
