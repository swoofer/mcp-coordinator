import type { IdPProvider } from "./types.js";

/**
 * IdP provider registry. Holds zero or more IdPProvider implementations
 * keyed by their `name`. Boot composes one instance per server and passes
 * it through AuthHandlerContext.providers.
 *
 * Phase 2 registers GitHubProvider only. v0.9.0+ adds GoogleProvider and
 * OIDCProvider; the picker UI on /auth/login activates whenever
 * size() > 1.
 *
 * Naming uniqueness is the operator's responsibility: registering a
 * provider with a name already in the registry overwrites the previous
 * entry (Map.set semantics). Boot is the single registration site and
 * each provider has a fixed `name` constant, so collisions are impossible
 * in normal use.
 *
 * The first provider registered becomes the implicit default (used by
 * legacy single-provider call sites that have no per-request provider
 * selector). Operators can override via setDefault() if needed.
 */
export class ProviderRegistry {
  private readonly byName = new Map<string, IdPProvider>();
  private defaultName: string | null = null;

  register(p: IdPProvider): void {
    this.byName.set(p.name, p);
    if (this.defaultName === null) {
      this.defaultName = p.name;
    }
  }

  get(name: string): IdPProvider | null {
    return this.byName.get(name) ?? null;
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  list(): IdPProvider[] {
    return [...this.byName.values()];
  }

  names(): string[] {
    return [...this.byName.keys()];
  }

  size(): number {
    return this.byName.size;
  }

  getDefault(): IdPProvider | null {
    if (this.defaultName === null) return null;
    return this.byName.get(this.defaultName) ?? null;
  }

  setDefault(name: string): void {
    if (!this.byName.has(name)) {
      throw new Error(`Cannot set default to unknown provider: ${name}`);
    }
    this.defaultName = name;
  }

  clear(): void {
    this.byName.clear();
    this.defaultName = null;
  }
}
