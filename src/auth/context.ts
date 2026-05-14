import type Database from "better-sqlite3";
import type { Clock } from "./clock.js";

/**
 * Phase 2 auth handler dependencies. Composed at boot (T29) and passed
 * to every dispatchAuthRoutes call from serve-http.ts. Future tasks
 * extend this with: providers registry (T05), audit queue (T11b),
 * rate limiter (T12), membership cache (T04), JWT key registry (T08b),
 * metrics registry (T37), logger (T36), etc.
 *
 * Currently minimal — db + clock are enough for the stub scaffolding.
 */
export interface AuthHandlerContext {
  db: Database.Database;
  clock: Clock;
}
