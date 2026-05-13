// ── Agent ─────────────────────────────────────────────
export type AgentConnectionStatus = "online" | "offline";
export type ActivityStatus = "working" | "idle" | "waiting" | "offline";

export interface Agent {
  id: string;
  org_id: string;
  name: string;
  modules: string; // JSON array
  status: AgentConnectionStatus;
  registered_at: string;
  last_seen_at: string;
}

export interface AgentActivity {
  agent_id: string;
  activity_status: ActivityStatus;
  current_file: string | null;
  current_thread: string | null;
  last_activity_at: string;
}

// ── Consultation Thread ───────────────────────────────
// "poisoned" = a work-stealing task that was unclaimed too many times without
// reaching DONE. Filtered out of the claim pool so it doesn't churn indefinitely.
export type ThreadStatus = "open" | "resolving" | "resolved" | "cancelled" | "poisoned";
export type ResolutionType = "consensus" | "auto_resolved" | "timeout" | "closed" | "max_rounds" | "agent_departure";

export interface Thread {
  id: string;
  initiator_id: string;
  subject: string;
  plan: string | null;
  target_modules: string; // JSON array
  target_files: string; // JSON array
  status: ThreadStatus;
  resolution_summary: string | null;
  conflicts: string | null; // JSON ConflictReport[]
  round: number;
  max_rounds: number;
  timeout_seconds: number;
  created_at: string;
  resolved_at: string | null;
  expected_respondents: string | null; // JSON array of agent_ids
  depends_on_files: string | null; // JSON array
  exports_affected: string | null; // JSON array
  claimed_by: string | null;
  claimed_at: string | null;
  // F4: number of times this thread was unclaimed without reaching DONE.
  // After POISON_THRESHOLD, status flips to 'poisoned' and it leaves the pool.
  unclaim_count?: number | null;
  // Directed-dispatch target. When set, only the named agent can claim this
  // thread. NULL preserves the original work-stealing semantics (anyone can
  // claim). Populated by lead agents that want to hand a specific piece of
  // work to a specific worker instead of publishing it to the pool at large.
  assigned_to?: string | null;
}

export type MessageType =
  | "context"
  | "suggestion"
  | "warning"
  | "resolution"
  | "approve"
  | "contest";

export interface ThreadMessage {
  id: string;
  thread_id: string;
  agent_id: string;
  agent_name: string | null;
  type: MessageType;
  content: string;
  context_snapshot: string | null; // JSON
  in_reply_to: string | null;
  round: number;
  token_estimate: number;
  created_at: string;
}

// ── Action Summaries ──────────────────────────────────
export interface ActionSummary {
  id: string;
  session_id: string;
  agent_id: string;
  file_path: string | null;
  summary: string;
  created_at: string;
}

// ── Events (SSE + dashboard) ──────────────────────────
export type EventType =
  | "agent_online"
  | "agent_offline"
  | "thread_opened"
  | "message_posted"
  | "resolution_proposed"
  | "thread_resolved"
  | "thread_cancelled"
  | "file_edited"
  | "action_summary"
  | "impact_scored"
  | "introspection_requested"
  | "introspection_completed"
  | "agent_activity"
  | "task_claimed"
  | "token_usage"
  | "quota_update";

export interface CoordinatorEvent {
  id?: number;
  type: EventType;
  payload: string; // JSON
  created_at?: string;
}

// ── Conflict Detection ────────────────────────────────
export interface ConflictReport {
  type: "module_overlap" | "api_contract" | "file_overlap" | "dependency_chain";
  severity: "warning" | "info";
  agent_id: string;
  agent_name: string;
  description: string;
  details: string;
}

export interface BlastRadius {
  module_id: string;
  direct_dependents: string[];
  indirect_dependents: string[];
  affected_exports: string[];
  active_threads_in_radius: Thread[];
}

// ── Dependency Map ────────────────────────────────────
export interface ModuleInfo {
  module_id: string;
  depends_on: string[];
  exports: string[];
  owners: string[];
}

export type DependencyMap = Record<string, ModuleInfo>;

// ── File Activity ─────────────────────────────────────
export interface FileActivity {
  id?: number;
  session_id: string;
  agent_id: string;
  agent_name?: string;
  tool_name: string;
  file_path: string;
  module: string;
  created_at?: string;
}

// ── Context Provider (pluggable) ──────────────────────
export interface AgentContext {
  agent_id: string;
  modules: string[];
  recent_files: string[];
  action_summaries: ActionSummary[];
}

export interface ConsultationAnnounce {
  thread_id: string;
  subject: string;
  target_modules: string[];
  target_files: string[];
}

// ── Coordinator Services ──────────────────────────────
export interface CoordinatorConfig {
  dataDir: string;
  authEnabled?: boolean;
  jwtSecret?: string;
  jwtExpiry?: string;
}
