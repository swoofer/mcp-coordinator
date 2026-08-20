import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * issue #328 — the repo shipped three competing names for the same channel
 * server. `.mcp.json.sample` registered it as `coordinator-channel`, while the
 * launch command in the same directory's README said
 * `server:mcp-coordinator-channel`, and a third form appeared in a documented
 * tag. The client matches that argument against the *registration key*, so the
 * quickstart could not work as written — and a name mismatch there fails
 * silently, which is the worst possible failure mode for a walkthrough.
 *
 * These tests pin the two invariants that were broken: one name everywhere,
 * and a tool description that names an event the code actually emits.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const SERVER_KEY = "mcp-coordinator-channel";

describe("channel server naming is consistent (#328)", () => {
  const SAMPLE = read("examples/channels-quickstart/.mcp.json.sample");
  const QUICKSTART = read("examples/channels-quickstart/README.md");
  const README = read("README.md");
  const MODES = read("docs/operating-modes.md");

  it("the sample registers the server under the key the launch commands name", () => {
    const parsed = JSON.parse(SAMPLE) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(parsed.mcpServers)).toContain(SERVER_KEY);
  });

  it("every documented launch command names that same key", () => {
    // `--channels`/`server:<key>` is matched against the .mcp.json key, never
    // against serverInfo.name, and a mismatch produces no error at all.
    for (const [name, doc] of [
      ["quickstart", QUICKSTART],
      ["README", README],
      ["operating-modes", MODES],
    ] as const) {
      const launches = [...doc.matchAll(/server:([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
      expect(launches.length, `${name} documents no launch command`).toBeGreaterThan(0);
      for (const named of launches) {
        expect(named, `${name} launches a server the sample does not register`).toBe(SERVER_KEY);
      }
    }
  });

  it("no document still uses the old bare name", () => {
    for (const [name, doc] of [
      ["sample", SAMPLE],
      ["quickstart", QUICKSTART],
      ["README", README],
      ["operating-modes", MODES],
    ] as const) {
      // Matches `coordinator-channel` only when it is NOT preceded by "mcp-".
      expect(doc.replaceAll(SERVER_KEY, ""), `${name} still uses the bare name`).not.toContain(
        "coordinator-channel",
      );
    }
  });
});

describe("the channel tool description names a real event (#328)", () => {
  const CHANNEL = read("cli/channel.ts");

  /** event_type values translateEvent actually puts in the meta bag. */
  const emitted = [...CHANNEL.matchAll(/event_type: "([a-z_]+)"/g)].map((m) => m[1]);

  it("emits the events we think it does", () => {
    expect(new Set(emitted)).toEqual(
      new Set(["consultation_new", "consultation_message", "agent_status"]),
    );
  });

  it("post_to_thread's description does not tell the model to watch for a phantom", () => {
    // The description is the model's only cue for when to call the tool. It
    // named `consultation_opened`, which nothing has ever emitted.
    // `event_type=` (the tag shown to the model) rather than `event_type:`
    // (the meta key emitted above).
    const described = [...CHANNEL.matchAll(/event_type="([a-z_]+)"/g)].map((m) => m[1]);
    expect(described.length, "no event_type quoted in a tool description").toBeGreaterThan(0);
    for (const name of described) {
      expect(emitted, `description names ${name}, which is never emitted`).toContain(name);
    }
  });
});
