import type { IdPProvider } from "./types.js";

export const providers = new Map<string, IdPProvider>();

export function registerProvider(p: IdPProvider): void {
  providers.set(p.name, p);
}

export function getProvider(name: string): IdPProvider | null {
  return providers.get(name) ?? null;
}
