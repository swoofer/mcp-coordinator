import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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
    const tmpPath = `${this.filePath}.tmp.${process.pid}`;
    await fs.promises.writeFile(tmpPath, JSON.stringify(tokens, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.promises.rename(tmpPath, this.filePath);
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
