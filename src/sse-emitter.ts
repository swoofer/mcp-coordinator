import { getDb } from "./database.js";
import type { CoordinatorEvent, EventType } from "./types.js";

type EventListener = (event: CoordinatorEvent) => void;

export class SseEmitter {
  private listeners: EventListener[] = [];

  emit(type: EventType, payload: Record<string, unknown>): void {
    const db = getDb();
    const payloadStr = JSON.stringify(payload);
    const result = db
      .prepare("INSERT INTO events (type, payload) VALUES (?, ?)")
      .run(type, payloadStr);

    const event: CoordinatorEvent = {
      id: result.lastInsertRowid as number,
      type,
      payload: payloadStr,
      created_at: new Date().toISOString(),
    };

    for (const listener of this.listeners) {
      listener(event);
    }
  }

  getEventsSince(lastId: number): CoordinatorEvent[] {
    const db = getDb();
    return db
      .prepare("SELECT * FROM events WHERE id > ? ORDER BY id")
      .all(lastId) as CoordinatorEvent[];
  }

  addListener(listener: EventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  removeAllListeners(): void {
    this.listeners = [];
  }
}
