import { randomUUID } from "crypto";
import { getDb } from "./database.js";

export interface IntrospectionRecord {
  id: string;
  org_id: string;
  thread_id: string;
  agent_id: string;
  score: number;
  reasons: string | null;
  status: "pending" | "concerned" | "not_concerned" | "responded";
  response: string | null;
  concerned: number;
  created_at: string;
  responded_at: string | null;
}

export class IntrospectionManager {
  create(
    orgId: string,
    params: {
      thread_id: string;
      agent_id: string;
      score: number;
      reasons?: string | string[];
    },
  ): IntrospectionRecord {
    const db = getDb();
    const id = randomUUID();
    const reasons =
      params.reasons == null
        ? null
        : Array.isArray(params.reasons)
          ? JSON.stringify(params.reasons)
          : params.reasons;
    db.prepare(
      `INSERT INTO introspections (id, org_id, thread_id, agent_id, score, reasons)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, orgId, params.thread_id, params.agent_id, params.score, reasons);
    return this.get(id)!;
  }

  respond(orgId: string, id: string, response: string): IntrospectionRecord | null {
    const db = getDb();
    db.prepare(
      `UPDATE introspections SET response = ?, status = 'responded', responded_at = ? WHERE org_id = ? AND id = ?`,
    ).run(response, new Date().toISOString(), orgId, id);
    return this.getScoped(orgId, id);
  }

  /** Retrieve a single record by id (unscoped — internal helper only). */
  private get(id: string): IntrospectionRecord | null {
    const db = getDb();
    return (
      (db.prepare("SELECT * FROM introspections WHERE id = ?").get(id) as IntrospectionRecord) ||
      null
    );
  }

  /** Retrieve a single record scoped to an org. */
  private getScoped(orgId: string, id: string): IntrospectionRecord | null {
    const db = getDb();
    return (
      (db
        .prepare("SELECT * FROM introspections WHERE org_id = ? AND id = ?")
        .get(orgId, id) as IntrospectionRecord) || null
    );
  }

  getPending(orgId: string, agentId: string): IntrospectionRecord[] {
    const db = getDb();
    return db
      .prepare(
        "SELECT * FROM introspections WHERE org_id = ? AND agent_id = ? AND status = 'pending' ORDER BY created_at",
      )
      .all(orgId, agentId) as IntrospectionRecord[];
  }

  list(orgId: string, threadId: string): IntrospectionRecord[] {
    const db = getDb();
    return db
      .prepare(
        "SELECT * FROM introspections WHERE org_id = ? AND thread_id = ? ORDER BY created_at",
      )
      .all(orgId, threadId) as IntrospectionRecord[];
  }

  /** @deprecated Use list(orgId, threadId) instead. Kept for backward compat. */
  getByThread(orgId: string, threadId: string): IntrospectionRecord[] {
    return this.list(orgId, threadId);
  }
}
