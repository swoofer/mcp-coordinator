import { AsyncLocalStorage } from "node:async_hooks";

export interface ActorContext {
  userId: string | null;
  orgId: string | null;
}

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

interface AuditScope {
  actor: ActorContext;
  request: RequestMeta;
}

const als = new AsyncLocalStorage<AuditScope>();

/**
 * Run fn inside an audit context. audit() reads actor + request via
 * getCurrentActor / getCurrentRequest. Compose with T10 withRequestId
 * to get full audit row context (actor + network + request_id).
 */
export function withAuditContext<T>(actor: ActorContext, request: RequestMeta, fn: () => T): T {
  return als.run({ actor, request }, fn);
}

export function getCurrentActor(): ActorContext {
  return als.getStore()?.actor ?? { userId: null, orgId: null };
}

export function getCurrentRequest(): RequestMeta {
  return als.getStore()?.request ?? { ip: null, userAgent: null };
}

/**
 * Update the actor on the active context. Use after authenticating mid-handler
 * (e.g., resolving JWT after scope entry). Throws if no active context —
 * silent failure would leave audit rows with stale identity.
 */
export function setActor(actor: ActorContext): void {
  const scope = als.getStore();
  if (!scope) throw new Error("setActor: no active audit context");
  scope.actor = actor;
}
