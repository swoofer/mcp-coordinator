#!/usr/bin/env node
/**
 * Bounded MQTT -> webhook bridge for mcp-coordinator, built to run inside a
 * GitHub Actions job.
 *
 * GitHub Actions is NOT a daemon: a job can't hold an MQTT connection open
 * forever. So this script does a *bounded drain*: connect, subscribe, forward
 * every event it sees for RUN_SECONDS, then disconnect and exit 0. Schedule it
 * (cron / workflow_dispatch) to poll periodically. For continuous, always-on
 * bridging use a long-running host instead (see ../systemd and ../fly-io).
 *
 * Transport: MQTT over WebSocket. The coordinator's TCP broker is bound to
 * 127.0.0.1, so it is NOT reachable from a GitHub-hosted runner. Point
 * COORDINATOR_URL at the coordinator exposed through a TLS reverse proxy, e.g.
 *   wss://coordinator.example.com/mqtt        (see ../nginx-reverse-proxy)
 *
 * Env vars:
 *   COORDINATOR_URL    (required) ws(s):// broker URL, e.g. wss://host/mqtt
 *   WEBHOOK_URL        (required) destination webhook URL
 *   WEBHOOK_TYPE       (optional) "slack" (default) or "generic"
 *   COORDINATOR_TOKEN  (optional) Phase-1 JWT; only needed when the coordinator
 *                      runs with COORDINATOR_AUTH_ENABLED=true. Sent as the MQTT
 *                      CONNECT password (username is ignored by the broker).
 *   RUN_SECONDS        (optional) drain window in seconds, default 55.
 *
 * The coordinator publishes everything under the hardcoded org `default`, so we
 * subscribe to `coordinator/default/#`. Consultation events are the interesting
 * ones; agent-status / quota chatter is filtered out below.
 */

import mqtt from "mqtt";

const COORDINATOR_URL = process.env.COORDINATOR_URL;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_TYPE = (process.env.WEBHOOK_TYPE || "slack").toLowerCase();
const TOKEN = process.env.COORDINATOR_TOKEN;
const RUN_SECONDS = Number(process.env.RUN_SECONDS || 55);

const ORG = "default";
const TOPIC_FILTER = `coordinator/${ORG}/#`;

if (!COORDINATOR_URL || !WEBHOOK_URL) {
  console.error(
    "ERROR: COORDINATOR_URL and WEBHOOK_URL are both required.\n" +
      "  COORDINATOR_URL=wss://coordinator.example.com/mqtt\n" +
      "  WEBHOOK_URL=https://hooks.slack.com/services/T.../B.../xxxx"
  );
  process.exit(1);
}
if (!/^wss?:\/\//.test(COORDINATOR_URL)) {
  // A GitHub runner can't reach the 127.0.0.1-bound TCP listener; it must go
  // through the WebSocket path fronted by a TLS reverse proxy.
  console.error(
    `ERROR: COORDINATOR_URL must be a ws:// or wss:// URL (got "${COORDINATOR_URL}"). ` +
      "The mqtt://127.0.0.1:1883 TCP listener is not reachable from a runner."
  );
  process.exit(1);
}

/** Parse a JSON MQTT payload; returns null for empty/invalid payloads. */
function parsePayload(buf) {
  const text = buf.toString("utf8");
  if (!text) return null; // empty retained payload = cleared, skip
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Extract the thread id from `coordinator/default/consultations/<id>/<verb>`. */
function threadIdFromTopic(topic) {
  const parts = topic.split("/");
  return parts.length >= 5 ? parts[3] : undefined;
}

/**
 * Build a human-readable one-line summary of a consultation event, or null to
 * skip (non-consultation topics, noisy intermediate states, empty payloads).
 */
function summarize(topic, data) {
  if (!data) return null;
  const prefix = `coordinator/${ORG}/consultations/`;
  if (!topic.startsWith(prefix)) return null; // ignore agents/broadcast/quota
  const suffix = topic.slice(prefix.length);
  const thread = threadIdFromTopic(topic);

  if (suffix === "new") {
    if (!data.subject) return null;
    const modules =
      Array.isArray(data.target_modules) && data.target_modules.length
        ? data.target_modules.join(", ")
        : "—";
    return `New consultation "${data.subject}" — thread ${data.thread_id ?? "?"}, agent ${data.agent_id ?? "?"}, modules: ${modules}`;
  }
  if (suffix.endsWith("/status")) {
    // Only the terminal `resolved` state is worth forwarding; `resolving` is noise.
    if (data.status !== "resolved") return null;
    return `Consultation resolved — thread ${thread}${data.summary ? `: ${data.summary}` : ""}`;
  }
  if (suffix.endsWith("/claimed")) {
    return `Consultation claimed by ${data.claimed_by ?? data.agent_id ?? "?"} — thread ${thread}`;
  }
  if (suffix.endsWith("/completed")) {
    return `Consultation completed by ${data.completed_by ?? data.agent_id ?? "?"} — thread ${thread}${data.summary ? `: ${data.summary}` : ""}`;
  }
  // Ignore `/messages` and everything else.
  return null;
}

/** Shape the outgoing webhook body per WEBHOOK_TYPE. */
function webhookBody(topic, data, text) {
  if (WEBHOOK_TYPE === "generic") {
    // Forward the raw event; the receiver decides what to do with it.
    return { source: "mcp-coordinator", topic, event: data, text, received_at: new Date().toISOString() };
  }
  // Slack incoming-webhook default.
  return { text: `:mega: ${text}` };
}

async function forward(topic, data, text) {
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(webhookBody(topic, data, text)),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`Webhook POST failed: ${res.status} ${res.statusText} ${body}`);
    } else {
      console.log(`forwarded: ${text}`);
    }
  } catch (err) {
    console.error("Webhook POST error:", err.message);
  }
}

const options = {
  clientId: `gha-bridge-${Math.random().toString(16).slice(2, 10)}`,
  // Bounded run: no point reconnecting once, or after, the drain window.
  reconnectPeriod: 0,
  clean: true,
  connectTimeout: 10_000,
  // NOTE: mqtt.js sends `Sec-WebSocket-Protocol: mqtt` on the WS handshake by
  // default. The coordinator's WS endpoint does not use a subprotocol; per the
  // WebSocket RFC it simply omits it from the response and the handshake still
  // succeeds, so this is harmless.
};
if (TOKEN) {
  // Auth-enabled coordinator expects the Phase-1 JWT in the CONNECT password.
  options.username = "gha-bridge";
  options.password = TOKEN;
}

console.error(
  `Connecting to ${COORDINATOR_URL}${TOKEN ? " (with token)" : " (anonymous)"}; ` +
    `draining for ${RUN_SECONDS}s, forwarding to ${WEBHOOK_TYPE} webhook.`
);

const client = mqtt.connect(COORDINATOR_URL, options);
const inflight = new Set();
let stopping = false;

client.on("connect", () => {
  client.subscribe(TOPIC_FILTER, { qos: 1 }, (err) => {
    if (err) {
      console.error("Subscribe failed:", err.message);
      shutdown(1);
    } else {
      console.error(`Subscribed to ${TOPIC_FILTER}.`);
    }
  });
});

client.on("message", (topic, payload) => {
  if (stopping) return;
  const data = parsePayload(payload);
  const text = summarize(topic, data);
  if (!text) return;
  // Track the POST so we can await outstanding forwards before exiting.
  const p = forward(topic, data, text).finally(() => inflight.delete(p));
  inflight.add(p);
});

client.on("error", (err) => {
  console.error("MQTT error:", err.message);
});

// End the drain window. This is the whole point of the bounded-run design.
const timer = setTimeout(() => {
  console.error(`Drain window elapsed (${RUN_SECONDS}s); flushing and exiting.`);
  shutdown(0);
}, RUN_SECONDS * 1000);
timer.unref();

async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  // Let in-flight webhook POSTs finish so we don't drop the last events.
  await Promise.allSettled([...inflight]);
  client.end(true, () => process.exit(code));
  // Hard fallback if the broker never acknowledges DISCONNECT.
  setTimeout(() => process.exit(code), 3000).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
