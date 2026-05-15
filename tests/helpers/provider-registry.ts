import { ProviderRegistry } from "../../src/auth/providers/registry.js";
import type { IdPProvider } from "../../src/auth/providers/types.js";

/**
 * Build a ProviderRegistry containing a single stub provider. The stub
 * becomes the default. Used by unit tests whose makeCtx passes a single
 * stubbed IdPProvider in `githubProvider` — preserves the Phase 2
 * single-provider behavior without each test instantiating
 * ProviderRegistry inline.
 */
export function singleProviderRegistry(p: IdPProvider): ProviderRegistry {
  const r = new ProviderRegistry();
  r.register(p);
  return r;
}
