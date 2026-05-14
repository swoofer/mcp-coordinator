import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";

interface RequestContext {
  requestId: string;
}

// AsyncLocalStorage gives per-async-context isolation: concurrent inbound
// requests each run inside their own withRequestId scope and cannot read
// each other's IDs, even across awaits.
const als = new AsyncLocalStorage<RequestContext>();

/** Generate a UUID v4 for new request IDs. */
export function generateRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Run `fn` inside an async context tagged with `requestId`. All audit()
 * calls (T11a) inside the callback chain — including awaited promises —
 * will see this ID via getRequestId().
 */
export function withRequestId<T>(requestId: string, fn: () => T): T {
  return als.run({ requestId }, fn);
}

/** Return the current request's ID, or undefined if not inside withRequestId. */
export function getRequestId(): string | undefined {
  return als.getStore()?.requestId;
}

// Bounded to 128 chars from a printable-ASCII-ish allowlist to defend
// against header-pollution log spam (clients can otherwise inject arbitrary
// bytes into structured logs/audit by way of X-Request-Id).
const VALID_INBOUND_REQUEST_ID = /^[A-Za-z0-9._:\-]{1,128}$/;

/**
 * Pick the X-Request-Id inbound header if present and well-formed, else
 * generate a fresh UUID. Multi-value headers (string[]) are rejected
 * because they indicate a duplicate header which we cannot trust.
 */
export function resolveRequestId(inboundHeader: string | string[] | undefined): string {
  if (typeof inboundHeader === "string" && VALID_INBOUND_REQUEST_ID.test(inboundHeader)) {
    return inboundHeader;
  }
  return generateRequestId();
}
