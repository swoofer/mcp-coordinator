import type { Thread } from "./types.js";
import type { CoordinatorServices } from "./server-setup.js";
import type { CategorizedImpact, ImpactScore } from "./impact-scorer.js";
import { getDb } from "./database.js";
import { assessPlanQuality, type PlanQualityResult } from "./plan-quality.js";

/**
 * S2 fix: shared `announce_work` orchestration.
 *
 * The MCP tool handler (`server-setup.ts`) and the REST endpoint
 * (`serve-http.ts`) historically duplicated ~95 lines of code that
 * scored impact, overrode respondents, auto-resolved when alone,
 * and emitted impact/introspection/plan-quality SSE events.
 *
 * This module extracts that common orchestration. Both transports
 * call `runCommonAnnounceFlow()` after creating the thread; each
 * transport then adds its own pre-step (MCP: conflict detection)
 * and post-step (MCP: MQTT publish + context gathering, REST: JSON
 * response) so existing SSE/response contracts are preserved.
 *
 * Why not unify the response/SSE shapes too? The MCP and REST
 * `thread_opened` event payloads have DIFFERENT field sets today
 * (e.g. MCP uses `initiator`, REST uses `agent_id` + `agent_name`).
 * essaim (and other consumers) may depend on those exact shapes.
 * Behavioral unification is a separate, riskier change deferred to
 * a later major.
 */

export interface CommonFlowResult {
  /** The same thread you passed in, refreshed after the override+auto-resolve. */
  updated: Thread;
  /** Impact scoring across all online agents. */
  categorized: CategorizedImpact;
  /** Concerned agent IDs (== updated.expected_respondents). */
  respondents: string[];
  /** Plan quality assessment (callers may emit downgrade event). */
  planQuality: PlanQualityResult;
}

export interface CommonFlowParams {
  org_id: string;
  agent_id: string;
  subject: string;
  plan?: string;
  target_modules: string[];
  target_files: string[];
  depends_on_files?: string[];
  exports_affected?: string[];
  keep_open?: boolean;
  target_symbols?: string[];
}

/**
 * Run the common post-`announceWork` orchestration. Mutates the thread row
 * (overrides `expected_respondents`, may transition to `resolved`) and emits
 * SSE events for impact scoring + introspection. Pure side-effects on the
 * services + DB; returns metadata callers use to build their own responses.
 */
export function runCommonAnnounceFlow(
  services: CoordinatorServices,
  threadId: string,
  params: CommonFlowParams,
): CommonFlowResult {
  const { registry, consultation, impactScorer, introspection, sseEmitter } = services;

  // 1. Score impact: categorize all online agents into concerned / gray_zone / pass.
  const categorized = impactScorer.categorize({
    org_id: params.org_id,
    agent_id: params.agent_id,
    target_modules: params.target_modules,
    target_files: params.target_files,
    depends_on_files: params.depends_on_files,
    exports_affected: params.exports_affected,
    target_symbols: params.target_symbols,
  });

  // Layer firing log: one row per concerned/gray-zone scored agent.
  // Used by /api/scoring-stats and the dashboard "Conflict signals" panel.
  const dbForFirings = getDb();
  const insertFiring = dbForFirings.prepare(
    "INSERT INTO layer_firings (thread_id, layer, score, agent_id) VALUES (?, ?, ?, ?)"
  );
  for (const s of [...categorized.concerned, ...categorized.gray_zone]) {
    const layer = inferLayerFromReasons(s.reasons);
    insertFiring.run(threadId, layer, s.score, s.agent_id);
  }

  // 2. Override expected_respondents on the thread with the scored set.
  // Auto-resolve only when truly alone — if peers are online but not concerned
  // (e.g., they haven't announced yet), keep the thread open so a subsequent
  // announce can match via Layer 0. Thread will timeout naturally if no one joins.
  const db = getDb();
  const concernedIds = categorized.concerned.map((s) => s.agent_id);
  db.prepare("UPDATE threads SET expected_respondents = ? WHERE id = ?")
    .run(JSON.stringify(concernedIds), threadId);

  // TODO(Task 23.5): thread real org_id from MCP session claims; for now MCP uses 'default' (cross-org leak window — single-tenant only)
  const otherOnlineCount = registry.listOnline("default").filter((a) => a.id !== params.agent_id).length;
  const shouldAutoResolve = concernedIds.length === 0 && otherOnlineCount === 0;
  const currentThread = consultation.getThread(threadId)!;
  if (shouldAutoResolve && currentThread.status === "open" && !params.keep_open) {
    db.prepare("UPDATE threads SET status = 'resolved', resolved_at = ? WHERE id = ?")
      .run(new Date().toISOString(), threadId);
    consultation.emitResolution(threadId, "auto_resolved");
  }

  // 3. Emit impact_scored SSE events for every scored agent.
  for (const s of [...categorized.concerned, ...categorized.gray_zone, ...categorized.pass]) {
    sseEmitter.emit("impact_scored", {
      thread_id: threadId,
      agent_id: s.agent_id,
      agent_name: s.agent_name,
      score: s.score,
      reasons: s.reasons,
      category: scoredCategory(s),
    });
  }

  // 4. Create introspection records and emit introspection_requested for gray_zone agents.
  for (const s of categorized.gray_zone) {
    introspection.create({ thread_id: threadId, agent_id: s.agent_id, score: s.score, reasons: s.reasons });
    sseEmitter.emit("introspection_requested", {
      thread_id: threadId,
      agent_id: s.agent_id,
      agent_name: s.agent_name,
      score: s.score,
      reasons: s.reasons,
    });
  }

  // 5. Plan quality downgrade event — both transports emit this when a plan
  // was provided but quality was insufficient. Callers can re-emit if their
  // payload shape differs (MCP vs REST agent_name source).
  const planQuality = assessPlanQuality(params.plan);
  if (params.plan && planQuality.mode === "discovery") {
    sseEmitter.emit("impact_scored" as "impact_scored", {
      thread_id: threadId,
      agent_id: params.agent_id,
      // TODO(Task 23.5): thread real org_id from MCP session claims; for now MCP uses 'default' (cross-org leak window — single-tenant only)
      agent_name: registry.get("default", params.agent_id)?.name || params.agent_id,
      score: planQuality.score,
      reasons: [planDowngradeReason(planQuality)],
      category: "plan_quality",
    } as Parameters<typeof sseEmitter.emit>[1]);
  }

  const updated = consultation.getThread(threadId)!;
  const respondents: string[] = JSON.parse(updated.expected_respondents || "[]");

  return { updated, categorized, respondents, planQuality };
}

function inferLayerFromReasons(reasons: string[]): string {
  for (const r of reasons) {
    if (r.includes("disjoint symbols")) return "L0.5";
    if (r.includes("announced same file") || r.includes("modifies my dependency") || r.includes("they depend on my target")) return "L0";
    if (r.includes("same file (in flight)")) return "L1";
    if (r.includes("same file")) return "L1";
    if (r.includes("co-change")) return "L4";
    if (r.includes("depends on")) return "L2";
    if (r.includes("module overlap")) return "L3";
  }
  return "L1";
}

function scoredCategory(s: ImpactScore): "concerned" | "gray_zone" | "pass" {
  if (s.score >= 90) return "concerned";
  if (s.score >= 30) return "gray_zone";
  return "pass";
}

function planDowngradeReason(pq: PlanQualityResult): string {
  const flags: string[] = [];
  if (!pq.checks.mentions_files) flags.push("no files");
  if (!pq.checks.concrete_approach) flags.push("vague approach");
  if (!pq.checks.sufficient_detail) flags.push("too short");
  return `plan downgraded: score ${pq.score}/3 — ${flags.join(" ")}`.trim();
}
