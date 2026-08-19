import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * issue #333 — docs/index.html carried the version in 37 places and nothing
 * kept them in sync, so the published site advertised a Docker tag and a
 * release banner two minor versions behind package.json.
 *
 * issue #377 — the comparison section had five cards; the sixth was added by
 * hand across the markup and six language dictionaries.
 *
 * The counts below are the load-bearing part. A fix that updates the English
 * dictionary and leaves the other five silently ships an English string to
 * zh/ja readers: index.html falls back to `translations.en` on a missing key
 * and only console.warns, so nothing fails at runtime.
 *
 * Deliberately NOT solved with release-please `extra-files`: its generic
 * updater rewrites only lines carrying an `x-release-please-version`
 * annotation, and the JSON-LD block cannot hold a comment without breaking
 * structured-data parsing. That would fix 36 of 37 while looking complete.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version as string;
const html = readFileSync(join(ROOT, "docs", "index.html"), "utf8");

function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

describe("docs/index.html tracks package.json version (#333)", () => {
  // 6 language dictionaries + 1 markup occurrence each; the Docker tag also
  // appears in the FAQ JSON-LD block, hence 15 rather than 14.
  const FAMILIES: Array<[string, number]> = [
    [`ghcr.io/swoofer/mcp-coordinator:${version}`, 15],
    [`MIT &middot; v${version}`, 7],
    [`mcp-coordinator v${version} &middot;`, 7],
    [`MCP Coordinator v${version}`, 7],
  ];

  it.each(FAMILIES)("%s appears %i times", (needle, expected) => {
    expect(count(html, needle as string)).toBe(expected);
  });

  it("JSON-LD softwareVersion matches package.json", () => {
    expect(html).toContain(`"softwareVersion": "${version}"`);
  });

  // A set assertion, not a substring one: a NEW stale tag added tomorrow
  // fails this even though the current one is present.
  it("advertises no Docker tag other than the current version", () => {
    const tags = [...html.matchAll(/ghcr\.io\/swoofer\/mcp-coordinator:(\d+\.\d+\.\d+)/g)].map(
      (m) => m[1],
    );
    expect(tags.length).toBeGreaterThan(0);
    expect([...new Set(tags)]).toEqual([version]);
  });

  // The historical references must survive: the roadmap links a real release
  // tag, and the compliance copy states what v2.0.0 shipped. A blanket
  // search-and-replace over the file would rewrite both, and the href would
  // 404 on a tag that never existed.
  it("leaves the v2.0.0 release link and the historical copy alone", () => {
    expect(html).toContain("releases/tag/v2.0.0");
    expect(count(html, "v2.0.0")).toBeGreaterThan(0);
  });
});

describe("docs/index.html only shows flags `mcp-coordinator init` accepts (#333)", () => {
  // Kept in sync with createInitCommand() in cli/init.ts, which registers no
  // positional argument at all.
  const ALLOWED = new Set(["--url", "--write-mcp-config", "--write-claude-md", "--print-only"]);

  it("every init example uses a registered flag and no positional", () => {
    const invocations = [...html.matchAll(/mcp-coordinator init\b([^<]*)/g)].map((m) => m[1]);
    expect(invocations.length).toBeGreaterThan(0);
    for (const tail of invocations) {
      for (const flag of tail.match(/--[a-z][a-z-]*/g) ?? []) {
        expect(ALLOWED, `unknown init flag ${flag}`).toContain(flag);
      }
      const first = tail.trim().split(/\s+/)[0];
      if (first) expect(first.startsWith("--"), `positional argument: ${first}`).toBe(true);
    }
  });
});

describe("the comparison section has six cards in every language (#377)", () => {
  it.each(["title", "desc"])("compare.card6.%s is translated six times plus markup", (part) => {
    expect(count(html, `compare.card6.${part}`)).toBe(7);
  });

  it("every card index from 1 to 6 is present the same number of times", () => {
    const counts = [1, 2, 3, 4, 5, 6].map((n) => count(html, `compare.card${n}.title`));
    expect(new Set(counts).size, `uneven card counts: ${counts.join(",")}`).toBe(1);
  });
});
