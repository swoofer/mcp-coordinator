import { describe, it, expect } from "vitest";
import { metricRoute } from "../../src/http/utils.js";

/**
 * performance-03: metricRoute(path) must collapse id-like path segments to
 * a bounded set of labels (`:id`) while leaving real REST route templates
 * (words like "agents", "threads-active") distinguishable. See
 * tests/integration/metrics-cardinality.test.ts for the end-to-end proof
 * against the real server + /metrics scrape.
 */
describe("metricRoute", () => {
  it("collapses a UUID path segment to :id", () => {
    expect(metricRoute("/api/agent-status/3fa85f64-5717-4562-b3fc-2c963f66afa6")).toBe(
      "/api/agent-status/:id",
    );
  });

  it("collapses distinct UUIDs in the same route template to the SAME label", () => {
    const a = metricRoute("/api/agent-status/11111111-1111-1111-1111-111111111111");
    const b = metricRoute("/api/agent-status/22222222-2222-2222-2222-222222222222");
    expect(a).toBe(b);
    expect(a).toBe("/api/agent-status/:id");
  });

  it("collapses a long hex segment (16+ chars) to :id", () => {
    expect(metricRoute("/api/consultation/deadbeefcafebabe0123/status")).toBe(
      "/api/consultation/:id/status",
    );
  });

  it("collapses a long numeric segment (4+ digits) to :id", () => {
    expect(metricRoute("/api/agent-status/948213")).toBe("/api/agent-status/:id");
  });

  it("leaves short numeric segments alone (not treated as an id)", () => {
    // 3 digits: below the "long numeric" threshold — real routes with small
    // enumerable suffixes shouldn't be bucketed away needlessly.
    expect(metricRoute("/api/v/123")).toBe("/api/v/123");
  });

  it("leaves plain REST route words untouched (route templates stay distinguishable)", () => {
    expect(metricRoute("/api/threads-active")).toBe("/api/threads-active");
    expect(metricRoute("/api/hot-files")).toBe("/api/hot-files");
    expect(metricRoute("/api/status")).toBe("/api/status");
    expect(metricRoute("/api/quota")).toBe("/api/quota");
  });

  it("distinct static routes stay distinct labels", () => {
    expect(metricRoute("/api/status")).not.toBe(metricRoute("/api/quota"));
  });

  it("handles the root and empty-ish paths without throwing", () => {
    expect(metricRoute("/")).toBe("/");
    expect(metricRoute("")).toBe("");
  });

  it("normalizes multiple id segments in one path", () => {
    expect(metricRoute("/api/org/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/agent/12345678")).toBe(
      "/api/org/:id/agent/:id",
    );
  });
});
