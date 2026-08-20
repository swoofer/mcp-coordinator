import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isCredentialReaderSupported } from "../../src/quota/credential-reader.js";

/**
 * issue #341 — three dashboard panels could not display anything, ever.
 * token-total/token-agents fed on a `token_usage` SSE event and run-config on
 * `GET /api/run-config`; both endpoints existed as handlers and schemas with
 * *zero* callers anywhere in src/, cli/, sdk/, scripts/ or examples/. The
 * quota widget has a producer, but only on macOS, so on Windows and on any
 * Linux server it showed a standing error nobody could act on.
 *
 * A panel with no producer is invisible in every way that matters: it renders
 * an empty state that looks exactly like "nothing has happened yet". These
 * tests make the missing producer visible instead.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const DASHBOARD = read("dashboard/public/dashboard.js");
const TYPES = read("src/types.ts");
const ROUTER = read("src/http/handle-rest.ts");

describe("every dashboard input has a producer (#341)", () => {
  it("listens only for SSE events the server can emit", () => {
    const listened =
      DASHBOARD.match(/const eventTypes = \[([^\]]+)\]/)?.[1].match(/'([a-z_]+)'/g) ?? [];
    expect(listened.length).toBeGreaterThan(10);

    const emitted = new Set([...TYPES.matchAll(/^\s*\| "([a-z_]+)"/gm)].map((m) => m[1]));
    for (const quoted of listened) {
      const type = quoted.slice(1, -1);
      expect(
        emitted,
        `dashboard listens for "${type}", which EventType does not include`,
      ).toContain(type);
    }
  });

  it("fetches only endpoints the router serves", () => {
    const fetched = [...DASHBOARD.matchAll(/COORDINATOR_URL\}(\/api\/[a-z0-9/-]+)/g)].map((m) =>
      m[1].replace(/\/$/, ""),
    );
    expect(fetched.length).toBeGreaterThan(3);

    const routed = new Set([...ROUTER.matchAll(/"(\/api\/[a-z0-9/-]+)":/g)].map((m) => m[1]));
    // A few URLs (/api/events, the SSE stream) are matched in serve-http.ts
    // before the router table is consulted, so both are searched.
    const SERVE = read("src/serve-http.ts");
    for (const url of new Set(fetched)) {
      if (routed.has(url)) continue;
      expect(
        SERVE.includes(`"${url}"`) || ROUTER.includes(`"${url}"`),
        `dashboard fetches ${url}, which nothing serves`,
      ).toBe(true);
    }
  });

  it("the producerless endpoints are gone, not merely unlinked", () => {
    // Leaving the handlers behind would let the panels come back without a
    // producer, which is how they got here.
    for (const file of [
      "src/http/handle-rest.ts",
      "src/http/rest-handlers.ts",
      "src/http/rest-schemas.ts",
      "src/serve-http.ts",
      "src/types.ts",
      "dashboard/public/dashboard.js",
      "dashboard/public/index.html",
    ]) {
      const text = read(file);
      for (const dead of ["token_usage", "token-usage", "run_config", "run-config"]) {
        expect(text, `${file} still references ${dead}`).not.toContain(dead);
      }
    }
  });
});

describe("the quota widget is honest about its platform (#341)", () => {
  it("only macOS has a credential reader", () => {
    expect(isCredentialReaderSupported("darwin")).toBe(true);
    expect(isCredentialReaderSupported("win32")).toBe(false);
    expect(isCredentialReaderSupported("linux")).toBe(false);
  });

  it("the 503 body says whether the platform is the reason", () => {
    // Without this flag the dashboard cannot tell a transient fetch failure
    // (worth reporting) from a permanent platform gap (worth hiding).
    expect(read("src/http/rest-handlers.ts")).toContain("unsupported_platform");
    expect(DASHBOARD).toContain("unsupported_platform");
    expect(DASHBOARD).toContain("hideQuotaSection");
  });

  it("hiding the widget hides its header too", () => {
    // Otherwise a bare "Quota Anthropic" title sits above nothing.
    expect(read("dashboard/public/index.html")).toContain('id="quota-header"');
    expect(DASHBOARD).toContain("quota-header");
  });
});

describe("the README describes loggers that exist (#341)", () => {
  it("names every component logger and no others", () => {
    const listed = new Set(
      read("README.md")
        .match(/Component loggers: (.+)\./)?.[1]
        .match(/`([a-z]+)`/g)
        ?.map((s) => s.slice(1, -1)) ?? [],
    );
    expect(listed.size).toBeGreaterThan(4);

    // Every listed component must appear as component: "<name>" somewhere.
    const haystack = [
      "src/serve-http.ts",
      "src/server-setup.ts",
      "src/boot.ts",
      "src/logger.ts",
      "src/http/handle-rest.ts",
    ]
      .map((f) => {
        try {
          return read(f);
        } catch {
          return "";
        }
      })
      .join("\n");
    for (const name of listed) {
      expect(haystack, `README lists a "${name}" logger that is never created`).toContain(
        `component: "${name}"`,
      );
    }
  });
});
