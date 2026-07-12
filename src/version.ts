import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

/**
 * architecture-11: version resolution lives in src/ (the core) so cli/ (the
 * interface layer) can depend on it — not the other way around. Previously
 * this lived in cli/version.ts and src/ imported it, inverting the intended
 * layering (core depending on interface). cli/version.ts now re-exports this
 * module for backward compatibility with existing cli/ consumers.
 */
export function getVersion(): string {
  // dist/src/version.js -> ../../package.json
  // src/version.ts (tsx) -> ../package.json
  // Wrap fileURLToPath in the try as well — under Bun --compile, import.meta.url
  // may be a synthetic non-file URL that throws TypeError on fileURLToPath.
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const candidate of [resolve(here, "..", "package.json"), resolve(here, "..", "..", "package.json")]) {
      try {
        const json = JSON.parse(readFileSync(candidate, "utf-8")) as { version?: string };
        if (json.version) return json.version;
      } catch {}
    }
  } catch {}
  return "0.0.0";
}
