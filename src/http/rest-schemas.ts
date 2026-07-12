import { z } from "zod";

/**
 * qualite-code-02 + architecture-15: zod schemas for REST mutation endpoint
 * bodies in handle-rest.ts. Previously every handler did an unchecked
 * `body as { ... }` cast — a missing/mistyped field sailed straight through
 * to the service layer and blew up as an opaque 500 (or, worse, a silent
 * wrong-type value reaching better-sqlite3's bind params, which only accepts
 * number/bigint/string/buffer/null and throws TypeError on anything else).
 *
 * Each schema below mirrors the shape the handler already assumed — no more,
 * no less. Where the corresponding MCP tool (server.tool(...) in
 * src/tools/*.ts) defines the same operation, the schema mirrors ITS field
 * set for parity. Deliberately NOT copied from MCP: extra MCP-only
 * constraints (e.g. announce_work's target_symbols max(200)/max(256)) that
 * would newly reject REST payloads the handler previously accepted without
 * crashing — see architecture-15 rétro-compat note in the audit brief.
 *
 * Fields the current handler reads without requiring (e.g. `modules || []`,
 * `plan?`) stay `.optional()` here so previously-valid requests keep working
 * (R5 adversarial check: no valid existing input newly rejected).
 */

// POST /api/register — mirrors MCP register_agent (agents-tools.ts), except
// `modules` stays optional: the REST handler has always tolerated an absent
// `modules` array via `modules || []`, while the MCP tool requires it.
export const RegisterBodySchema = z.object({
  agent_id: z.string(),
  name: z.string(),
  modules: z.array(z.string()).optional(),
});
export type RegisterBody = z.infer<typeof RegisterBodySchema>;

// POST /api/session-stop — no MCP equivalent (dashboard/session lifecycle only).
export const SessionStopBodySchema = z.object({
  agent_id: z.string(),
});
export type SessionStopBody = z.infer<typeof SessionStopBodySchema>;

// POST /api/check-conflict — REST-only field name `file` (MCP's
// check_file_conflict tool uses `file_path` for the same concept; that
// naming divergence predates this fix and is out of scope to rename).
export const CheckConflictBodySchema = z.object({
  file: z.string(),
  agent_id: z.string(),
});
export type CheckConflictBody = z.infer<typeof CheckConflictBodySchema>;

// POST /api/log-file — no MCP equivalent (essaim/hook telemetry only).
export const LogFileBodySchema = z.object({
  session_id: z.string(),
  agent_id: z.string(),
  agent_name: z.string().optional(),
  tool_name: z.string(),
  file: z.string(),
});
export type LogFileBody = z.infer<typeof LogFileBodySchema>;

// POST /api/announce — mirrors MCP announce_work (consultation-tools.ts).
// target_symbols intentionally has no max()/max() length caps here (see
// module doc comment above) to avoid rejecting previously-accepted payloads.
export const AnnounceBodySchema = z.object({
  agent_id: z.string(),
  subject: z.string(),
  plan: z.string().optional(),
  target_modules: z.array(z.string()),
  target_files: z.array(z.string()),
  depends_on_files: z.array(z.string()).optional(),
  exports_affected: z.array(z.string()).optional(),
  keep_open: z.boolean().optional(),
  assigned_to: z.string().nullable().optional(),
  target_symbols: z.array(z.string()).optional(),
});
export type AnnounceBody = z.infer<typeof AnnounceBodySchema>;

// POST /api/post-to-thread — mirrors MCP post_to_thread (consultation-tools.ts)
// fields actually read by the REST handler (context_snapshot/in_reply_to are
// MCP-only and not consumed by this endpoint today).
export const PostToThreadBodySchema = z.object({
  thread_id: z.string(),
  agent_id: z.string(),
  agent_name: z.string().optional(),
  type: z.enum(["context", "suggestion", "warning"]),
  content: z.string(),
});
export type PostToThreadBody = z.infer<typeof PostToThreadBodySchema>;

// POST /api/token-usage — agent telemetry forwarded as-is via SSE. No fixed
// shape by design (free-form usage payload); only guarantee it's a JSON
// object (not an array/primitive) so the SSE payload stays well-formed.
export const TokenUsageBodySchema = z.record(z.string(), z.unknown());
export type TokenUsageBody = z.infer<typeof TokenUsageBodySchema>;

// POST /api/unclaim-task — thread_id/agent_id required (previously enforced
// via `if (!thread_id || !agent_id)`, which also rejected empty strings —
// min(1) preserves that).
export const UnclaimTaskBodySchema = z.object({
  thread_id: z.string().min(1),
  agent_id: z.string().min(1),
});
export type UnclaimTaskBody = z.infer<typeof UnclaimTaskBodySchema>;

// POST /api/claim-task — same shape/tolerance as unclaim-task.
export const ClaimTaskBodySchema = z.object({
  thread_id: z.string().min(1),
  agent_id: z.string().min(1),
});
export type ClaimTaskBody = z.infer<typeof ClaimTaskBodySchema>;

// POST /api/propose-resolution — mirrors MCP propose_resolution's required
// fields (its optional `plan` isn't read by the REST handler).
export const ProposeResolutionBodySchema = z.object({
  thread_id: z.string(),
  agent_id: z.string(),
  summary: z.string(),
});
export type ProposeResolutionBody = z.infer<typeof ProposeResolutionBodySchema>;

// POST /api/approve-resolution — mirrors MCP approve_resolution.
export const ApproveResolutionBodySchema = z.object({
  thread_id: z.string(),
  agent_id: z.string(),
});
export type ApproveResolutionBody = z.infer<typeof ApproveResolutionBodySchema>;

// /api/hot-files — mirrors MCP hot_files (files-tools.ts); since_minutes
// stays optional (defaults to 30 in the handler).
export const HotFilesBodySchema = z.object({
  since_minutes: z.number().optional(),
});
export type HotFilesBody = z.infer<typeof HotFilesBodySchema>;

// POST /api/check-interrupt — no MCP equivalent (polling endpoint).
export const CheckInterruptBodySchema = z.object({
  agent_id: z.string(),
});
export type CheckInterruptBody = z.infer<typeof CheckInterruptBodySchema>;

// POST /api/introspection-response — no MCP equivalent.
export const IntrospectionResponseBodySchema = z.object({
  introspection_id: z.string(),
  concerned: z.boolean(),
  reason: z.string(),
});
export type IntrospectionResponseBody = z.infer<typeof IntrospectionResponseBodySchema>;

// POST /api/run-config — free-form dashboard-set run configuration, stored
// and echoed back verbatim (no fixed shape by design). Only guarantee it's a
// JSON object so downstream consumers (getRunConfig callers, SSE payload)
// keep getting an object.
export const RunConfigBodySchema = z.record(z.string(), z.unknown());
export type RunConfigBody = z.infer<typeof RunConfigBodySchema>;
