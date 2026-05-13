import { randomUUID } from "crypto";
import { getDb } from "./database.js";
import { silentLogger, type Logger } from "./logger.js";
import type {
  Thread,
  ThreadMessage,
  ActionSummary,
  MessageType,
  ResolutionType,
} from "./types.js";

export interface ResolutionEvent {
  thread_id: string;
  org_id: string;
  resolution_type: ResolutionType;
  resolution_summary: string | null;
  created_at: string;
  resolved_at: string;
  approved_by?: string;
  approved_by_name?: string;
  had_messages: boolean;
}

export class Consultation {
  private onResolveCallback: ((event: ResolutionEvent) => void) | null = null;
  private log: Logger;
  private timeoutSweeperHandle: ReturnType<typeof setInterval> | null = null;

  constructor(logger?: Logger) {
    this.log = logger || silentLogger;
  }

  onResolve(callback: (event: ResolutionEvent) => void): void {
    this.onResolveCallback = callback;
  }

  /**
   * B2 fix: replace the side-effect-on-read timeout check with an explicit
   * background sweeper. Each tick atomically claims and resolves any thread
   * past its deadline, then emits resolution events outside the transaction.
   *
   * Default tick interval: 30 seconds. Tests can pass a shorter interval to
   * exercise the sweeper, or call checkTimeouts() explicitly.
   *
   * Safe to call multiple times — second call is a no-op until the previous
   * sweeper is stopped.
   */
  startTimeoutSweeper(intervalMs = 30000): void {
    if (this.timeoutSweeperHandle) return;
    this.timeoutSweeperHandle = setInterval(() => {
      try { this.checkTimeouts(); } catch (err) {
        this.log.warn({ err }, "Timeout sweeper iteration failed");
      }
    }, intervalMs);
    // Don't keep the event loop alive just for the sweeper.
    if (typeof this.timeoutSweeperHandle.unref === "function") this.timeoutSweeperHandle.unref();
  }

  stopTimeoutSweeper(): void {
    if (this.timeoutSweeperHandle) {
      clearInterval(this.timeoutSweeperHandle);
      this.timeoutSweeperHandle = null;
    }
  }

  emitResolution(threadId: string, type: ResolutionType, approvedBy?: string, approvedByName?: string): void {
    const db = getDb();
    // emitResolution is called internally after we already know the thread belongs
    // to the right org. We look it up cross-org here intentionally so that
    // handleAgentDeparture (which is cross-org) can still emit resolution events.
    const thread = this.getThreadCrossOrg(threadId);
    if (!thread) return;

    const messageCount = (db.prepare("SELECT COUNT(*) as count FROM thread_messages WHERE thread_id = ?").get(threadId) as { count: number }).count;

    const durationMs = thread ? Date.now() - new Date(thread.created_at).getTime() : undefined;
    this.log.info({
      thread_id: threadId,
      resolution_type: type,
      approved_by: approvedBy,
      duration_ms: durationMs,
    }, "Thread resolved");

    if (this.onResolveCallback) {
      this.onResolveCallback({
        thread_id: threadId,
        org_id: thread.org_id,
        resolution_type: type,
        resolution_summary: thread.resolution_summary,
        created_at: thread.created_at,
        resolved_at: thread.resolved_at || new Date().toISOString(),
        approved_by: approvedBy,
        approved_by_name: approvedByName,
        had_messages: messageCount > 0,
      });
    }
  }

  announceWork(orgId: string, params: {
    agent_id: string;
    subject: string;
    plan?: string;
    target_modules: string[];
    target_files: string[];
    depends_on_files?: string[];
    exports_affected?: string[];
    keep_open?: boolean;
    // Directed-dispatch: when set, only that agent_id can claim the thread.
    // Implies keep_open=true because the target agent must have time to pick
    // it up even if no module-based respondents are found.
    assigned_to?: string | null;
  }): Thread {
    const db = getDb();
    const id = randomUUID();

    // B1 fix: SELECT respondents + INSERT thread must be atomic w.r.t. agent
    // registry mutations (registerAgent / setOffline). Without a transaction,
    // a race between announce and a concurrent setOffline produces a thread
    // whose expected_respondents contains an agent that just went away — the
    // thread then stays open forever waiting for an absent voter.
    const tx = db.transaction(() => {
      const onlineAgents = db
        .prepare("SELECT id, modules FROM agents WHERE status = 'online' AND id != ? AND org_id = ?")
        .all(params.agent_id, orgId) as { id: string; modules: string }[];

      const respondents = onlineAgents.filter((agent) => {
        const agentModules: string[] = JSON.parse(agent.modules);
        return params.target_modules.some((tm) =>
          agentModules.some((am) => am === tm || am.startsWith(tm + "/") || tm.startsWith(am + "/"))
        );
      });

      const respondentIds = respondents.map((r) => r.id);
      // Directed dispatch skips module-based auto-resolve: if the thread is
      // explicitly aimed at an agent, we keep it open for them regardless of
      // what the module scorer finds.
      const assignedTo = params.assigned_to ?? null;
      const keepOpen = params.keep_open || assignedTo !== null;
      const autoResolve = respondentIds.length === 0 && !keepOpen;

      db.prepare(
        `INSERT INTO threads (id, org_id, initiator_id, subject, plan, target_modules, target_files, status, expected_respondents, resolved_at, depends_on_files, exports_affected, timeout_seconds, assigned_to)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        orgId,
        params.agent_id,
        params.subject,
        params.plan || null,
        JSON.stringify(params.target_modules),
        JSON.stringify(params.target_files),
        autoResolve ? "resolved" : "open",
        JSON.stringify(respondentIds),
        autoResolve ? new Date().toISOString() : null,
        JSON.stringify(params.depends_on_files || []),
        JSON.stringify(params.exports_affected || []),
        keepOpen ? 0 : 600,
        assignedTo,
      );

      return { autoResolve, respondentIds, assignedTo };
    });

    const { autoResolve, respondentIds, assignedTo } = tx();

    this.log.info({
      thread_id: id,
      org_id: orgId,
      agent_id: params.agent_id,
      subject: params.subject,
      target_modules: params.target_modules,
      auto_resolve: autoResolve,
      respondent_count: respondentIds.length,
      assigned_to: assignedTo,
    }, "Thread opened");

    return this.getThread(orgId, id)!;
  }

  postToThread(orgId: string, params: {
    thread_id: string;
    agent_id: string;
    agent_name?: string;
    type: MessageType;
    content: string;
    context_snapshot?: string;
    in_reply_to?: string;
  }): ThreadMessage {
    const db = getDb();
    const thread = this.getThread(orgId, params.thread_id);
    if (!thread) throw new Error(`Thread ${params.thread_id} not found`);
    // Cancelled threads are explicit aborts — reject posts.
    // Resolved threads accept late posts (audit/enrichment) because the review
    // phase races with auto-resolve: an ENRICHIT computed against an open
    // thread may arrive milliseconds after the thread transitioned to resolved.
    if (thread.status === "cancelled")
      throw new Error(`Thread ${params.thread_id} is cancelled`);

    const id = randomUUID();
    // Simple token estimate: ~4 chars per token for English/French
    const tokenEstimate = Math.ceil(params.content.length / 4);
    db.prepare(
      `INSERT INTO thread_messages (id, org_id, thread_id, agent_id, agent_name, type, content, context_snapshot, in_reply_to, round, token_estimate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      orgId,
      params.thread_id,
      params.agent_id,
      params.agent_name || null,
      params.type,
      params.content,
      params.context_snapshot || null,
      params.in_reply_to || null,
      thread.round,
      tokenEstimate
    );

    this.log.debug({
      thread_id: params.thread_id,
      agent_id: params.agent_id,
      type: params.type,
      content_length: params.content.length,
    }, "Message posted to thread");

    return db.prepare("SELECT * FROM thread_messages WHERE id = ?").get(id) as ThreadMessage;
  }

  proposeResolution(orgId: string, threadId: string, agentId: string, summary: string): void {
    const db = getDb();
    const thread = this.getThread(orgId, threadId);
    if (!thread) throw new Error(`Thread ${threadId} not found`);
    if (thread.initiator_id !== agentId && thread.claimed_by !== agentId)
      throw new Error("Only the initiator or the claimant can propose a resolution");

    db.prepare(
      "UPDATE threads SET status = 'resolving', resolution_summary = ? WHERE id = ? AND org_id = ?"
    ).run(summary, threadId, orgId);

    // Post resolution message
    this.postResolutionMessage(orgId, threadId, agentId, "resolution", summary);
  }

  approveResolution(orgId: string, threadId: string, agentId: string, agentName?: string): void {
    const db = getDb();
    const thread = this.getThread(orgId, threadId);
    if (!thread) throw new Error(`Thread ${threadId} not found`);
    if (thread.status !== "resolving")
      throw new Error(`Thread is ${thread.status}, not resolving`);

    // B1 fix: post + check + transition must be atomic, else two concurrent
    // approvals each see "all approved" and fire emitResolution twice. Using
    // a transaction + UPDATE ... WHERE status='resolving' (CAS) ensures only
    // the first transaction wins the consensus race; the loser's UPDATE
    // affects 0 rows and emit is suppressed.
    const tx = db.transaction(() => {
      this.postResolutionMessage(orgId, threadId, agentId, "approve", "Approved");
      if (!this.allRespondentsApproved(orgId, threadId)) return false;
      const res = db
        .prepare("UPDATE threads SET status = 'resolved', resolved_at = ? WHERE id = ? AND org_id = ? AND status = 'resolving'")
        .run(new Date().toISOString(), threadId, orgId);
      return res.changes > 0;
    });

    const wonRace = tx();
    this.log.debug({ thread_id: threadId, agent_id: agentId }, "Resolution approved");
    if (wonRace) {
      this.emitResolution(threadId, "consensus", agentId, agentName || agentId);
    }
  }

  contestResolution(orgId: string, threadId: string, agentId: string, reason: string): void {
    const db = getDb();
    const thread = this.getThread(orgId, threadId);
    if (!thread) throw new Error(`Thread ${threadId} not found`);
    if (thread.status !== "resolving")
      throw new Error(`Thread is ${thread.status}, not resolving`);

    // Post contest message
    this.postResolutionMessage(orgId, threadId, agentId, "contest", reason);
    this.log.debug({ thread_id: threadId, agent_id: agentId, reason }, "Resolution contested");

    // Return to open with next round
    const nextRound = thread.round + 1;
    if (nextRound > thread.max_rounds) {
      // Max rounds reached — force resolve
      db.prepare(
        "UPDATE threads SET status = 'resolved', resolved_at = ? WHERE id = ? AND org_id = ?"
      ).run(new Date().toISOString(), threadId, orgId);
      this.emitResolution(threadId, "max_rounds");
    } else {
      db.prepare(
        "UPDATE threads SET status = 'open', round = ?, resolution_summary = NULL WHERE id = ? AND org_id = ?"
      ).run(nextRound, threadId, orgId);
    }
  }

  cancelThread(orgId: string, threadId: string, agentId: string, reason?: string): void {
    const db = getDb();
    const thread = this.getThread(orgId, threadId);
    if (!thread) throw new Error(`Thread ${threadId} not found`);
    if (thread.initiator_id !== agentId)
      throw new Error("Only the initiator can cancel");

    db.prepare(
      "UPDATE threads SET status = 'cancelled', resolved_at = ? WHERE id = ? AND org_id = ?"
    ).run(new Date().toISOString(), threadId, orgId);

    if (reason) {
      this.postResolutionMessage(orgId, threadId, agentId, "context", `Cancelled: ${reason}`);
    }
  }

  closeThread(orgId: string, threadId: string, agentId: string, summary: string): void {
    const db = getDb();
    const thread = this.getThread(orgId, threadId);
    if (!thread) {
      throw new Error(`Thread ${threadId} not found`);
    }
    if (thread.initiator_id !== agentId) {
      throw new Error(
        `Only the initiator (${thread.initiator_id}) may close thread ${threadId}, not ${agentId}`
      );
    }
    if (thread.status !== "open" && thread.status !== "resolving") {
      throw new Error(
        `Cannot close thread ${threadId} in status '${thread.status}'`
      );
    }
    db.prepare(
      "UPDATE threads SET status = 'resolved', resolution_summary = ?, resolved_at = ? WHERE id = ? AND org_id = ?"
    ).run(summary, new Date().toISOString(), threadId, orgId);
    this.emitResolution(threadId, "closed");
  }

  /**
   * Cross-org maintenance sweep — stays at v0.6 signature per Phase 1 plan.
   * handleAgentDeparture iterates ALL orgs (internal maintenance only).
   */
  handleAgentDeparture(agentId: string): void {
    const db = getDb();
    // Unclaim any tasks claimed by the departing agent
    db.prepare("UPDATE threads SET claimed_by = NULL, claimed_at = NULL WHERE claimed_by = ? AND status = 'open'")
      .run(agentId);

    // Remove departed agent from expected_respondents of all open/resolving threads
    const threads = db
      .prepare("SELECT id, org_id, expected_respondents FROM threads WHERE status IN ('open', 'resolving')")
      .all() as { id: string; org_id: string; expected_respondents: string | null }[];

    for (const thread of threads) {
      const respondents: string[] = JSON.parse(thread.expected_respondents || "[]");
      const updated = respondents.filter((r) => r !== agentId);
      db.prepare("UPDATE threads SET expected_respondents = ? WHERE id = ?").run(
        JSON.stringify(updated),
        thread.id
      );

      // If resolving and all remaining approved, resolve
      const t = this.getThreadCrossOrg(thread.id)!;
      if (t.status === "resolving" && this.allRespondentsApproved(thread.org_id, thread.id)) {
        db.prepare(
          "UPDATE threads SET status = 'resolved', resolved_at = ? WHERE id = ?"
        ).run(new Date().toISOString(), thread.id);
        this.emitResolution(thread.id, "agent_departure");
      }
      // If open and no respondents left, auto-resolve
      if (t.status === "open" && updated.length === 0) {
        db.prepare(
          "UPDATE threads SET status = 'resolved', resolved_at = ? WHERE id = ?"
        ).run(new Date().toISOString(), thread.id);
        this.emitResolution(thread.id, "agent_departure");
      }
    }
  }

  /**
   * Cross-org sweeper — stays at v0.6 signature per Phase 1 plan.
   * checkTimeouts scans ALL orgs (internal maintenance only).
   */
  checkTimeouts(): void {
    const db = getDb();
    // B2 fix: SELECT-then-UPDATE wrapped in a transaction so two concurrent
    // sweepers can't both claim the same thread. The UPDATE returns
    // db.changes (rows affected) — we use the SELECT only to know which
    // thread IDs to emit for. The transaction makes both observe the same
    // snapshot.
    const tx = db.transaction(() => {
      const timedOut = db.prepare(`
        SELECT id FROM threads
        WHERE status IN ('open', 'resolving')
        AND timeout_seconds > 0
        AND datetime(created_at, '+' || (timeout_seconds * round) || ' seconds') < CURRENT_TIMESTAMP
      `).all() as { id: string }[];

      if (timedOut.length === 0) return [];

      db.prepare(`
        UPDATE threads SET status = 'resolved',
          resolution_summary = 'Résolu par timeout — pas de réponse dans le délai',
          resolved_at = CURRENT_TIMESTAMP
        WHERE status IN ('open', 'resolving')
        AND timeout_seconds > 0
        AND datetime(created_at, '+' || (timeout_seconds * round) || ' seconds') < CURRENT_TIMESTAMP
      `).run();

      return timedOut;
    });

    const timedOut = tx();
    if (timedOut.length === 0) return;

    this.log.info({ count: timedOut.length, thread_ids: timedOut.map(t => t.id) }, "Threads timed out");

    // Emit OUTSIDE the transaction so listeners can re-enter the DB safely.
    for (const t of timedOut) {
      this.emitResolution(t.id, "timeout");
    }
  }

  getThread(orgId: string, threadId: string): Thread | null {
    // B2 fix: timeout sweeping moved to startTimeoutSweeper() background timer.
    // Reads no longer mutate state. Tests that need synchronous timeout
    // resolution should call checkTimeouts() explicitly.
    const db = getDb();
    return (
      (db.prepare("SELECT * FROM threads WHERE id = ? AND org_id = ?").get(threadId, orgId) as Thread) || null
    );
  }

  getThreadWithMessages(orgId: string, threadId: string): { thread: Thread; messages: ThreadMessage[] } | null {
    const thread = this.getThread(orgId, threadId);
    if (!thread) return null;
    const db = getDb();
    const messages = db
      .prepare("SELECT tm.* FROM thread_messages tm JOIN threads t ON tm.thread_id = t.id WHERE tm.thread_id = ? AND t.org_id = ? ORDER BY tm.created_at")
      .all(threadId, orgId) as ThreadMessage[];
    return { thread, messages };
  }

  listThreads(orgId: string, filters: {
    status?: string;
    agent_id?: string;
    module?: string;
    /**
     * When set, only return threads that are claimable by this agent:
     *   assigned_to IS NULL  (open pool — anyone can take it)
     *   OR assigned_to = agent_id  (directed to me)
     * Workers use this to filter out dispatches for other agents without
     * parsing the thread list themselves.
     */
    assigned_to_me?: string;
    /**
     * P2 perf: bound resolved-thread queries to a recency window. Without
     * this, the impact scorer would scan all-time resolved threads on every
     * announce_work call (O(historical-threads) per scoring pass). The window
     * applies to resolved_at when status='resolved', otherwise to created_at,
     * so the filter is meaningful for both states.
     */
    since_minutes?: number;
  }): Thread[] {
    // B2 fix: removed checkTimeouts() side-effect; sweeper handles it.
    const db = getDb();
    let sql = "SELECT * FROM threads WHERE org_id = ?";
    const params: unknown[] = [orgId];

    if (filters.status) {
      sql += " AND status = ?";
      params.push(filters.status);
    }
    if (filters.agent_id) {
      sql += " AND initiator_id = ?";
      params.push(filters.agent_id);
    }
    if (filters.module) {
      // Exact match against each array element via json_each — LIKE on the
      // serialized JSON caused false positives where "src/api" matched
      // "src/api-gateway" too.
      sql += " AND EXISTS (SELECT 1 FROM json_each(target_modules) WHERE value = ?)";
      params.push(filters.module);
    }
    if (filters.assigned_to_me) {
      sql += " AND (assigned_to IS NULL OR assigned_to = ?)";
      params.push(filters.assigned_to_me);
    }
    if (typeof filters.since_minutes === "number") {
      // For resolved threads, gate on resolved_at (the moment that matters
      // for "recent enough to still influence scoring"). For open/resolving
      // threads, gate on created_at since they have no resolved_at yet.
      // COALESCE picks the right column per row.
      sql += " AND COALESCE(resolved_at, created_at) > datetime('now', '-' || ? || ' minutes')";
      params.push(filters.since_minutes);
    }
    sql += " ORDER BY created_at DESC";
    return db.prepare(sql).all(...params) as Thread[];
  }

  getThreadUpdates(orgId: string, agentId: string, since?: string): ThreadMessage[] {
    const db = getDb();
    let sql = `SELECT tm.* FROM thread_messages tm
               JOIN threads t ON tm.thread_id = t.id
               WHERE t.org_id = ?
               AND t.status IN ('open', 'resolving')
               AND tm.agent_id != ?`;
    const params: unknown[] = [orgId, agentId];

    if (since) {
      sql += " AND tm.created_at >= ?";
      // Normalize ANY parseable ISO/date string (including timezone offsets
      // like "+05:00", "-0800", fractional seconds) to SQLite CURRENT_TIMESTAMP
      // format "YYYY-MM-DD HH:MM:SS" in UTC. The old regex-based normalization
      // only handled the `.\d+$` suffix, which left "+05:00" in place and
      // broke the comparison.
      const date = new Date(since);
      const normalized = isNaN(date.getTime())
        ? since
        : date.toISOString().replace("T", " ").slice(0, 19);
      params.push(normalized);
    }
    sql += " ORDER BY tm.created_at";
    return db.prepare(sql).all(...params) as ThreadMessage[];
  }

  logActionSummary(orgId: string, params: {
    session_id: string;
    agent_id: string;
    file_path?: string;
    summary: string;
  }): ActionSummary {
    const db = getDb();
    const id = randomUUID();
    db.prepare(
      `INSERT INTO action_summaries (id, org_id, session_id, agent_id, file_path, summary)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, orgId, params.session_id, params.agent_id, params.file_path || null, params.summary);
    return db.prepare("SELECT * FROM action_summaries WHERE id = ?").get(id) as ActionSummary;
  }

  getActionSummaries(orgId: string, agentId: string, since?: string): ActionSummary[] {
    const db = getDb();
    let sql = "SELECT * FROM action_summaries WHERE org_id = ? AND agent_id = ?";
    const params: unknown[] = [orgId, agentId];
    if (since) {
      sql += " AND created_at > ?";
      params.push(since);
    }
    sql += " ORDER BY created_at DESC";
    return db.prepare(sql).all(...params) as ActionSummary[];
  }

  getActionSummariesBySession(orgId: string, sessionId: string): ActionSummary[] {
    const db = getDb();
    return db
      .prepare("SELECT * FROM action_summaries WHERE org_id = ? AND session_id = ? ORDER BY created_at")
      .all(orgId, sessionId) as ActionSummary[];
  }

  // ── Private helpers ──

  /**
   * Cross-org thread lookup for internal sweepers/departure handlers.
   * Do NOT call from public methods — use getThread(orgId, id) instead.
   */
  private getThreadCrossOrg(threadId: string): Thread | null {
    const db = getDb();
    return (
      (db.prepare("SELECT * FROM threads WHERE id = ?").get(threadId) as Thread) || null
    );
  }

  private postResolutionMessage(
    orgId: string,
    threadId: string,
    agentId: string,
    type: MessageType,
    content: string
  ): void {
    const db = getDb();
    const thread = this.getThread(orgId, threadId)!;
    const id = randomUUID();
    db.prepare(
      `INSERT INTO thread_messages (id, org_id, thread_id, agent_id, type, content, round)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, orgId, threadId, agentId, type, content, thread.round);
  }

  private allRespondentsApproved(orgId: string, threadId: string): boolean {
    const db = getDb();
    const thread = this.getThread(orgId, threadId)!;
    const expected: string[] = JSON.parse(thread.expected_respondents || "[]");
    if (expected.length === 0) return true;

    // Only count approvals from the CURRENT round. A contested resolution
    // increments the round, and prior-round approvals must be re-collected
    // for the new proposal.
    const approvals = db
      .prepare(
        `SELECT DISTINCT agent_id FROM thread_messages
         WHERE thread_id = ? AND type = 'approve' AND round = ?`
      )
      .all(threadId, thread.round) as { agent_id: string }[];

    const approvedIds = new Set(approvals.map((a) => a.agent_id));
    return expected.every((id) => approvedIds.has(id));
  }
}
