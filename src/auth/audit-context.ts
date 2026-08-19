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

/**
 * Same as setActor, but a no-op when there is no active context (#319).
 *
 * The strict setActor is right for a handler that knows it opened a scope.
 * This one exists for authenticateRequest, which is also reached from paths
 * that never enter one -- the MQTT broker's authenticate hook, and every test
 * that calls it directly. Throwing there would turn a missing audit detail
 * into a failed authentication, which is the wrong trade.
 */
export function setActorIfInScope(actor: ActorContext): void {
  const scope = als.getStore();
  if (!scope) return;
  scope.actor = actor;
}
