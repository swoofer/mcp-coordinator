import { describe, it, expect, beforeEach } from "vitest";
import { MqttBridge } from "../../src/mqtt-bridge.js";

/**
 * issue #236, cause 3 — `get_queued_messages` drained without acknowledgement.
 *
 * The field report: two payloads published, never seen by any consumer, zero
 * trace anywhere, while k8s workers polling every 30s took `fetch failed`
 * bursts. Copy-then-clear means the batch leaves the process before anything
 * confirms it arrived, so a pod SIGKILLed between the drain and its own
 * persistence takes the batch with it.
 *
 * The fix is opt-in per consumer, because this method already has callers in
 * the field. What is pinned here is that the two contracts really are two, and
 * that the new one redelivers rather than loses.
 */

const ORG = "default";
const AGENT = "worker-1";

/** Push straight onto a listener's queue; the transport is not the subject. */
function enqueue(bridge: MqttBridge, n: number, from = 0): void {
  bridge.registerListener(ORG, AGENT);
  const listeners = (
    bridge as unknown as {
      listeners: Map<string, Map<string, { queue: unknown[] }>>;
    }
  ).listeners;
  const queue = listeners.get(ORG)!.get(AGENT)!.queue;
  for (let i = 0; i < n; i++) {
    queue.push({
      topic: "coordinator/default/broadcast",
      payload: { seq: from + i },
      timestamp: i,
    });
  }
}

const seqs = (messages: { payload: Record<string, unknown> }[]): number[] =>
  messages.map((m) => m.payload.seq as number);

let bridge: MqttBridge;
beforeEach(() => {
  bridge = new MqttBridge(ORG);
});

describe("the legacy contract is untouched (#236)", () => {
  it("a caller that never asks for acks drains and loses, exactly as before", () => {
    enqueue(bridge, 3);
    const first = bridge.getQueuedMessages(ORG, AGENT);
    expect(seqs(first.messages)).toEqual([0, 1, 2]);
    // No batch id offered, because nothing is being held for them.
    expect(first.batch_id).toBeNull();
    expect(bridge.getQueuedMessages(ORG, AGENT).messages).toEqual([]);
  });

  it("an empty queue is still an empty answer", () => {
    bridge.registerListener(ORG, AGENT);
    expect(bridge.getQueuedMessages(ORG, AGENT)).toEqual({ messages: [], batch_id: null });
  });
});

describe("opting in holds the batch (#236)", () => {
  it("require_ack returns a batch id", () => {
    enqueue(bridge, 2);
    const r = bridge.getQueuedMessages(ORG, AGENT, { requireAck: true });
    expect(seqs(r.messages)).toEqual([0, 1]);
    expect(r.batch_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("an unacknowledged batch comes BACK — the whole point", () => {
    enqueue(bridge, 2);
    const first = bridge.getQueuedMessages(ORG, AGENT, { requireAck: true });
    // The consumer dies here. On its next poll it has persisted nothing, so it
    // acknowledges nothing.
    const second = bridge.getQueuedMessages(ORG, AGENT, { requireAck: true });
    expect(seqs(second.messages)).toEqual([0, 1]);
    expect(second.batch_id).not.toBe(first.batch_id);
  });

  it("acknowledging it lets it go", () => {
    enqueue(bridge, 2);
    const first = bridge.getQueuedMessages(ORG, AGENT, { requireAck: true });
    const second = bridge.getQueuedMessages(ORG, AGENT, { ack: first.batch_id! });
    expect(second.messages).toEqual([]);
  });

  it("a redelivered batch keeps its place ahead of what arrived since", () => {
    // Requeue is at the head and only one batch is ever in flight, so the
    // consumer never sees a newer message before an older one it never
    // confirmed.
    enqueue(bridge, 2); // 0,1
    bridge.getQueuedMessages(ORG, AGENT, { requireAck: true });
    enqueue(bridge, 2, 10); // 10,11 arrive while the first batch is unacked
    const redelivered = bridge.getQueuedMessages(ORG, AGENT, { requireAck: true });
    expect(seqs(redelivered.messages)).toEqual([0, 1, 10, 11]);
  });

  it("the mode is sticky, so a later call may omit require_ack", () => {
    enqueue(bridge, 1);
    const first = bridge.getQueuedMessages(ORG, AGENT, { requireAck: true });
    enqueue(bridge, 1, 5);
    // No requireAck this time, and no ack either: still held, still redelivered.
    const second = bridge.getQueuedMessages(ORG, AGENT);
    expect(seqs(second.messages)).toEqual([0, 5]);
    expect(second.batch_id).not.toBe(first.batch_id);
  });
});

describe("ackBatch out of band (#236)", () => {
  it("acknowledges the batch in flight", () => {
    enqueue(bridge, 1);
    const r = bridge.getQueuedMessages(ORG, AGENT, { requireAck: true });
    expect(bridge.ackBatch(ORG, AGENT, r.batch_id!)).toBe(true);
    expect(bridge.getQueuedMessages(ORG, AGENT).messages).toEqual([]);
  });

  it("refuses an id it is not holding, so the caller can tell the cases apart", () => {
    // false means "that is not the batch I have", which is exactly when the
    // consumer's next drain WILL see those messages again. Reporting success
    // would hide the redelivery it is about to get.
    enqueue(bridge, 1);
    const r = bridge.getQueuedMessages(ORG, AGENT, { requireAck: true });
    expect(bridge.ackBatch(ORG, AGENT, "not-the-batch")).toBe(false);
    expect(bridge.ackBatch(ORG, AGENT, r.batch_id!)).toBe(true);
    expect(bridge.ackBatch(ORG, AGENT, r.batch_id!)).toBe(false); // already gone
  });

  it("an unknown agent is a refusal, not a crash", () => {
    expect(bridge.ackBatch(ORG, "nobody", "x")).toBe(false);
    expect(bridge.ackBatch("other-org", AGENT, "x")).toBe(false);
  });
});

describe("what the queue reports about itself (#236)", () => {
  it("depth counts an unacknowledged batch, which is still owed", () => {
    enqueue(bridge, 3);
    expect(bridge.queueDepth(ORG, AGENT)).toBe(3);
    bridge.getQueuedMessages(ORG, AGENT, { requireAck: true });
    // Reporting 0 here would tell a monitor the agent is caught up while it is
    // holding three messages it has not confirmed.
    expect(bridge.queueDepth(ORG, AGENT)).toBe(3);
  });

  it("and drops to zero once acknowledged", () => {
    enqueue(bridge, 3);
    const r = bridge.getQueuedMessages(ORG, AGENT, { requireAck: true });
    bridge.ackBatch(ORG, AGENT, r.batch_id!);
    expect(bridge.queueDepth(ORG, AGENT)).toBe(0);
  });

  it("still reports nothing for an agent with no listener", () => {
    expect(bridge.queueDepth(ORG, "never-seen")).toBe(0);
  });
});
