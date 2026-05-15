import type { TokenStore } from "./storage.js";
import type { TokenSet } from "./types.js";

const DEFAULT_SERVICE_NAME = "mcp-coordinator";
const DEFAULT_ACCOUNT = "default";

export interface KeytarTokenStoreOptions {
  /** OS keychain service name. Default: "mcp-coordinator" */
  serviceName?: string;
  /** Account within the service. Use the profile name for multi-tenant CLI installs. Default: "default" */
  account?: string;
}

export class KeytarUnavailableError extends Error {
  constructor(public readonly cause: unknown) {
    super(
      "keytar is not installed or could not load. " +
        "Install via `npm install keytar` in your consumer project, " +
        "or use FileTokenStore as a fallback. " +
        `Underlying error: ${(cause as Error)?.message ?? String(cause)}`,
    );
    this.name = "KeytarUnavailableError";
  }
}

interface KeytarAPI {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

/**
 * OS-keychain-backed token store. Opt-in: requires the consumer project
 * to `npm install keytar` separately (the SDK does NOT bundle it).
 *
 * Cross-platform via keytar's unified API:
 *   - Windows -> Credential Manager
 *   - macOS   -> Keychain
 *   - Linux   -> libsecret (GNOME Keyring / KWallet / etc.)
 *
 * If keytar isn't installed, the first call throws KeytarUnavailableError
 * with install instructions. Operators on locked-down systems should use
 * FileTokenStore instead -- no compromise on security since FileTokenStore
 * writes 0600 + atomic rename.
 *
 * Token set stored as a single JSON blob under (service, account).
 * Default service = "mcp-coordinator", account = "default".
 *
 * Test injection: pass `_keytar` option in constructor to inject a mock
 * keytar implementation (used by tests; not part of the public API).
 */
export class KeytarTokenStore implements TokenStore {
  private readonly serviceName: string;
  private readonly account: string;
  private keytarPromise: Promise<KeytarAPI> | null = null;
  private readonly injectedKeytar: KeytarAPI | null;

  constructor(opts: KeytarTokenStoreOptions & { _keytar?: KeytarAPI } = {}) {
    this.serviceName = opts.serviceName ?? DEFAULT_SERVICE_NAME;
    this.account = opts.account ?? DEFAULT_ACCOUNT;
    this.injectedKeytar = opts._keytar ?? null;
  }

  async load(): Promise<TokenSet | null> {
    const keytar = await this.resolveKeytar();
    const raw = await keytar.getPassword(this.serviceName, this.account);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as TokenSet;
    } catch {
      return null; // corrupted; treat as absent. Caller can clear() if needed.
    }
  }

  async save(tokens: TokenSet): Promise<void> {
    const keytar = await this.resolveKeytar();
    await keytar.setPassword(this.serviceName, this.account, JSON.stringify(tokens));
  }

  async clear(): Promise<void> {
    const keytar = await this.resolveKeytar();
    await keytar.deletePassword(this.serviceName, this.account);
  }

  /** Inspect which (service, account) this instance uses. */
  getServiceAccount(): { serviceName: string; account: string } {
    return { serviceName: this.serviceName, account: this.account };
  }

  private async resolveKeytar(): Promise<KeytarAPI> {
    if (this.injectedKeytar) return this.injectedKeytar;
    if (!this.keytarPromise) {
      this.keytarPromise = this.dynamicImport();
    }
    return this.keytarPromise;
  }

  private async dynamicImport(): Promise<KeytarAPI> {
    try {
      // Dynamic import so consumers without keytar installed can still load the SDK.
      // Indirected through a variable so the TypeScript compiler doesn't try to
      // resolve `keytar` types at build time in workspaces where it isn't installed.
      // Bundlers (esbuild, etc.) also won't try to resolve a static import this way.
      const moduleName = "keytar";
      const mod = (await import(/* @vite-ignore */ moduleName)) as
        | KeytarAPI
        | { default?: KeytarAPI };
      // Some packagers wrap CJS exports under .default
      const api = (mod as { default?: KeytarAPI }).default ?? (mod as KeytarAPI);
      return api;
    } catch (err) {
      throw new KeytarUnavailableError(err);
    }
  }
}
