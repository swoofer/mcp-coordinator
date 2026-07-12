import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { TokenSet } from "./types.js";

export interface TokenStore {
  load(): Promise<TokenSet | null>;
  save(tokens: TokenSet): Promise<void>;
  clear(): Promise<void>;
}

export interface FileTokenStoreOptions {
  /** Path to the token file. Defaults to ~/.mcp-coordinator/tokens.json */
  filePath?: string;
}

/**
 * File-backed token store. Writes ~/.mcp-coordinator/tokens.json with
 * chmod 0600 on POSIX (rw for owner only). On Windows the default ACL
 * applies; for encrypted-at-rest on Windows use KeytarTokenStore
 * (Credential Manager wraps DPAPI internally). The directory is created
 * on first save with chmod 0700 on POSIX.
 *
 * NOT secure on shared filesystems -- operators on multi-user systems
 * should use KeytarTokenStore (opt-in via `npm install keytar`).
 *
 * Atomic writes via write-to-tmp + rename to prevent partial writes
 * on crash during save.
 */
export class FileTokenStore implements TokenStore {
  private readonly filePath: string;
  // Serializes save() calls against this instance. `setTokens()` fires a
  // save() without awaiting it, and a caller may immediately await
  // `persistTokens()`, which calls save() again -- two legitimately
  // concurrent writes to the same destination file. Without serialization,
  // both write+rename their own (uniquely-named) tmp file to `filePath`
  // concurrently: on POSIX the last rename silently "wins" (usually
  // harmless since content is identical), but on Windows the second
  // rename can throw EPERM because the destination was just replaced by
  // the other in-flight rename. Chaining every save() through this queue
  // means each write completes (rename included) before the next starts.
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(opts: FileTokenStoreOptions = {}) {
    this.filePath = opts.filePath ?? path.join(os.homedir(), ".mcp-coordinator", "tokens.json");
  }

  async load(): Promise<TokenSet | null> {
    try {
      const raw = await fs.promises.readFile(this.filePath, "utf8");
      return JSON.parse(raw) as TokenSet;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async save(tokens: TokenSet): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    if (process.platform !== "win32") {
      try {
        await fs.promises.chmod(dir, 0o700);
      } catch {
        /* best-effort */
      }
    }
    // Chain onto the write queue so this save() waits for any in-flight
    // save() on this instance to fully finish (including its rename)
    // before starting its own write+rename. `.catch(() => {})` on the
    // prior tail means a failed earlier save doesn't block this one.
    const task = this.writeQueue
      .catch(() => {})
      .then(async () => {
        const tmpPath = `${this.filePath}.tmp.${process.pid}.${crypto.randomUUID()}`;
        await fs.promises.writeFile(tmpPath, JSON.stringify(tokens, null, 2), {
          encoding: "utf8",
          mode: 0o600,
        });
        await fs.promises.rename(tmpPath, this.filePath);
      });
    this.writeQueue = task;
    return task;
  }

  async clear(): Promise<void> {
    try {
      await fs.promises.unlink(this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  /** Path getter (for debugging). */
  getPath(): string {
    return this.filePath;
  }
}

/** In-memory token store. Useful for tests + ephemeral CLI invocations. */
export class MemoryTokenStore implements TokenStore {
  private tokens: TokenSet | null = null;

  async load(): Promise<TokenSet | null> {
    return this.tokens;
  }

  async save(tokens: TokenSet): Promise<void> {
    this.tokens = tokens;
  }

  async clear(): Promise<void> {
    this.tokens = null;
  }
}
