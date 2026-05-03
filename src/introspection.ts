import { randomUUID } from "crypto";
import { getDb } from "./database.js";

export interface IntrospectionRecord {
  id: string;
  thread_id: string;
  agent_id: string;
  score: number;
  reasons: string | null;
  status: "pending" | "concerned" | "not_concerned";
  response: string | null;
  concerned: number;
  created_at: string;
  responded_at: string | null;
}

export class IntrospectionManager {
  create(params: {
    thread_id: string;
    agent_id: string;
    score: number;
    reasons: string[];
  }): IntrospectionRecord {
    const db = getDb();
    const id = randomUUID();
    db.prepare(
      `INSERT INTO introspections (id, thread_id, agent_id, score, reasons)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, params.thread_id, params.agent_id, params.score, JSON.stringify(params.reasons));
    return this.get(id)!;
  }

  respond(id: string, concerned: boolean, response: string): IntrospectionRecord {
    const db = getDb();
    db.prepare(
      `UPDATE introspections SET status = ?, concerned = ?, response = ?, responded_at = ? WHERE id = ?`
    ).run(
      concerned ? "concerned" : "not_concerned",
      concerned ? 1 : 0,
      response,
      new Date().toISOString(),
      id
    );
    return this.get(id)!;
  }

  get(id: string): IntrospectionRecord | null {
    const db = getDb();
    return (db.prepare("SELECT * FROM introspections WHERE id = ?").get(id) as IntrospectionRecord) || null;
  }

  getPending(agentId: string): IntrospectionRecord[] {
    const db = getDb();
    return db.prepare(
      "SELECT * FROM introspections WHERE agent_id = ? AND status = 'pending' ORDER BY created_at"
    ).all(agentId) as IntrospectionRecord[];
  }

  getByThread(threadId: string): IntrospectionRecord[] {
    const db = getDb();
    return db.prepare(
      "SELECT * FROM introspections WHERE thread_id = ? ORDER BY created_at"
    ).all(threadId) as IntrospectionRecord[];
  }
}
