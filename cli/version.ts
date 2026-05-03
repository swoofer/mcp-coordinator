import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

export function getVersion(): string {
  // dist/cli/version.js -> ../../package.json
  // cli/version.ts (tsx) -> ../package.json
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
