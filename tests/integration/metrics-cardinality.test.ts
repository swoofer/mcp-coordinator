/**
 * performance-03: `src/serve-http.ts` used to pass the raw request path as
 * a Prometheus label VALUE for the `mcp_coordinator_http_requests_total`
 * counter (l.711 REST branch, l.714 404 catch-all). Every distinct path —
 * including arbitrary paths a prober/scanner throws at the 404 branch —
 * created a brand-new time series. Unbounded cardinality → Prometheus /
 * process memory growth.
 *
 * This suite proves the bound end-to-end against a REAL running server:
 *   - N distinct 404 paths collapse into ONE `<unmatched>` series.
 *   - REST paths carrying distinct ids (uuid/hex/numeric) collapse into ONE
 *     series per route TEMPLATE.
 *   - Real static REST routes stay distinguishable (granularity isn't
 *     destroyed — only arbitrary/id segments are).
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHttpHarness } from "../helpers/mcp-client-harness.js";

interface HttpRequestSeries {
  route: string;
  status: string;
  value: number;
}

function parseHttpRequestSeries(metricsText: string): HttpRequestSeries[] {
  const out: HttpRequestSeries[] = [];
  const re = /mcp_coordinator_http_requests_total\{([^}]*)\}\s+(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(metricsText))) {
    const labels = m[1];
    const route = /route="([^"]*)"/.exec(labels)?.[1] ?? "";
    const status = /status="([^"]*)"/.exec(labels)?.[1] ?? "";
    out.push({ route, status, value: Number(m[2]) });
  }
  return out;
}

async function hit(baseUrl: string, path: string): Promise<void> {
  await fetch(`${baseUrl}${path}`);
}

async function hitAllBatched(baseUrl: string, paths: string[], batchSize = 50): Promise<void> {
  for (let i = 0; i < paths.length; i += batchSize) {
    const batch = paths.slice(i, i + batchSize);
    await Promise.all(batch.map((p) => hit(baseUrl, p)));
  }
}

describe("Prometheus route-label cardinality is bounded (performance-03)", () => {
  let harness: Awaited<ReturnType<typeof createHttpHarness>>;
  let baseUrl: string;

  beforeAll(async () => {
    harness = await createHttpHarness();
    baseUrl = `http://127.0.0.1:${harness.httpPort}`;
  }, 30_000);

  afterAll(async () => {
    await harness.cleanup();
  });

  it("R1/R4: many distinct 404 paths collapse into ONE <unmatched> series, not one per path", async () => {
    const distinctPaths = Array.from(
      { length: 25 },
      (_, i) => `/definitely-not-a-route/${i}/${randomUUID()}`,
    );
    await hitAllBatched(baseUrl, distinctPaths);

    const metricsText = await (await fetch(`${baseUrl}/metrics`)).text();
    const series = parseHttpRequestSeries(metricsText);
    const notFoundRoutes = new Set(series.filter((s) => s.status === "404").map((s) => s.route));

    // Bounded: exactly one series for all 404s, labeled with the constant.
    expect(notFoundRoutes.size).toBe(1);
    expect(notFoundRoutes.has("<unmatched>")).toBe(true);
    // None of the arbitrary probed paths leaked through as a label value.
    for (const p of distinctPaths) {
      expect(notFoundRoutes.has(p)).toBe(false);
    }
  });

  it("R3: REST requests with distinct ids collapse into ONE series per route template", async () => {
    const uuid1 = randomUUID();
    const uuid2 = randomUUID();
    await hit(baseUrl, `/api/agent-status/${uuid1}`);
    await hit(baseUrl, `/api/agent-status/${uuid2}`);

    const metricsText = await (await fetch(`${baseUrl}/metrics`)).text();
    const series = parseHttpRequestSeries(metricsText);
    const agentStatusRoutes = new Set(
      series.filter((s) => s.route.startsWith("/api/agent-status")).map((s) => s.route),
    );

    expect(agentStatusRoutes.size).toBe(1);
    expect(agentStatusRoutes.has("/api/agent-status/:id")).toBe(true);
    expect(agentStatusRoutes.has(`/api/agent-status/${uuid1}`)).toBe(false);
    expect(agentStatusRoutes.has(`/api/agent-status/${uuid2}`)).toBe(false);
  });

  it("R3/R5: real static REST routes remain distinguishable (granularity is not destroyed)", async () => {
    await hit(baseUrl, "/api/status");
    await hit(baseUrl, "/api/quota");

    const metricsText = await (await fetch(`${baseUrl}/metrics`)).text();
    const series = parseHttpRequestSeries(metricsText);
    const routes = new Set(series.map((s) => s.route));

    expect(routes.has("/api/status")).toBe(true);
    expect(routes.has("/api/quota")).toBe(true);
    expect(routes.has("/api/status")).not.toBe(routes.has("nonexistent-marker")); // sanity: Set works
  });

  it("R5 adversarial: 1000 distinct 404 paths still yield a CONSTANT cardinality of 1", async () => {
    const distinctPaths = Array.from(
      { length: 1000 },
      (_, i) => `/adversarial-probe/${i}-${randomUUID()}`,
    );
    await hitAllBatched(baseUrl, distinctPaths, 50);

    const metricsText = await (await fetch(`${baseUrl}/metrics`)).text();
    const series = parseHttpRequestSeries(metricsText);
    const notFoundRoutes = new Set(series.filter((s) => s.status === "404").map((s) => s.route));

    // Still exactly one series, no matter how many distinct paths were probed.
    expect(notFoundRoutes.size).toBe(1);
    expect(notFoundRoutes.has("<unmatched>")).toBe(true);

    // The single series' counter accumulated across ALL 404s from every test
    // in this suite (shared registry) — sanity check it's "a lot", not 1.
    const unmatched = series.find((s) => s.status === "404" && s.route === "<unmatched>");
    expect(unmatched?.value ?? 0).toBeGreaterThanOrEqual(1000);
  }, 60_000);
});
