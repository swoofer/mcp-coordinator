#!/usr/bin/env node
/**
 * Slack bridge for mcp-coordinator.
 *
 * Subscribes to the coordinator's embedded MQTT broker and forwards
 * interesting consultation events to a Slack Incoming Webhook.
 *
 * Env vars:
 *   SLACK_WEBHOOK_URL  (required) Slack incoming-webhook URL.
 *   COORDINATOR_MQTT_URL  (optional) broker URL, default mqtt://127.0.0.1:1883.
 *   COORDINATOR_TOKEN  (optional) Phase-1 JWT, only needed when the coordinator
 *                      runs with COORDINATOR_AUTH_ENABLED=true.
 */

import mqtt from "mqtt";

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const MQTT_URL = process.env.COORDINATOR_MQTT_URL || "mqtt://127.0.0.1:1883";
const TOKEN = process.env.COORDINATOR_TOKEN;

// The coordinator publishes everything under the hardcoded org `default`.
const ORG = "default";
const TOPIC_FILTER = `coordinator/${ORG}/consultations/#`;

if (!SLACK_WEBHOOK_URL) {
  console.error(
    "ERROR: SLACK_WEBHOOK_URL is not set. Create a Slack incoming webhook " +
      "and export it, e.g.\n" +
      '  export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/T.../B.../xxxx"'
  );
  process.exit(1);
}

/** Parse a JSON MQTT payload; returns null for empty/invalid payloads. */
function parsePayload(buf) {
  const text = buf.toString("utf8");
  if (!text) return null; // empty retained payload = cleared
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Extract the thread id from a `.../consultations/<threadId>/<verb>` topic. */
function threadIdFromTopic(topic) {
  const parts = topic.split("/");
  // coordinator / default / consultations / <threadId> / <verb>
  return parts.length >= 5 ? parts[3] : undefined;
}

/**
 * Turn a coordinator event into a Slack message payload, or null to skip.
 * Returns a `{ text, blocks? }` object suitable for the webhook.
 */
function formatEvent(topic, data) {
  const suffix = topic.slice(`coordinator/${ORG}/consultations/`.length);

  // New consultation announced: `consultations/new`
  if (suffix === "new") {
    // Skip empty retained payloads (already handled) and payloads with no subject.
    if (!data || !data.subject) return null;
    const modules =
      Array.isArray(data.target_modules) && data.target_modules.length
        ? data.target_modules.join(", ")
        : "—";
    const text =
      `:mega: *New consultation* — ${data.subject}\n` +
      `thread: \`${data.thread_id ?? "?"}\` · agent: \`${data.agent_id ?? "?"}\` · modules: ${modules}`;
    return {
      text: `New consultation: ${data.subject}`,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text },
        },
      ],
    };
  }

  const threadId = threadIdFromTopic(topic);

  // Status change: `consultations/<threadId>/status`
  if (suffix.endsWith("/status")) {
    if (!data) return null;
    // Only surface the terminal `resolved` state; `resolving` is noise.
    if (data.status !== "resolved") return null;
    const summary = data.summary ? `\n> ${data.summary}` : "";
    return {
      text: `:white_check_mark: Consultation resolved — thread \`${threadId}\`${summary}`,
    };
  }

  // Claimed: `consultations/<threadId>/claimed`
  if (suffix.endsWith("/claimed")) {
    if (!data) return null;
    const who = data.claimed_by ?? data.agent_id ?? "?";
    const when = data.claimed_at ? ` at ${data.claimed_at}` : "";
    return {
      text: `:hand: Consultation claimed by \`${who}\`${when} — thread \`${threadId}\``,
    };
  }

  // Completed: `consultations/<threadId>/completed`
  if (suffix.endsWith("/completed")) {
    if (!data) return null;
    const who = data.completed_by ?? data.agent_id ?? "?";
    const summary = data.summary ? `\n> ${data.summary}` : "";
    return {
      text: `:checkered_flag: Consultation completed by \`${who}\` — thread \`${threadId}\`${summary}`,
    };
  }

  // Ignore `/messages` and anything else.
  return null;
}

async function postToSlack(message) {
  try {
    const res = await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`Slack POST failed: ${res.status} ${res.statusText} ${body}`);
    }
  } catch (err) {
    console.error("Slack POST error:", err.message);
  }
}

const options = {};
if (TOKEN) {
  // Auth-enabled coordinator expects the Phase-1 JWT in the CONNECT password.
  // Username is ignored but conventionally the agent id.
  options.username = "slack-bridge";
  options.password = TOKEN;
}

console.error(`Connecting to ${MQTT_URL} ...`);
const client = mqtt.connect(MQTT_URL, options);

client.on("connect", () => {
  client.subscribe(TOPIC_FILTER, { qos: 1 }, (err) => {
    if (err) {
      console.error("Subscribe failed:", err.message);
      process.exit(1);
    }
    console.error(`Subscribed to ${TOPIC_FILTER}. Forwarding to Slack.`);
  });
});

client.on("message", (topic, payload) => {
  const data = parsePayload(payload);
  const message = formatEvent(topic, data);
  if (message) postToSlack(message);
});

client.on("error", (err) => {
  console.error("MQTT error:", err.message);
});

process.on("SIGINT", () => {
  console.error("\nStopping Slack bridge.");
  client.end(() => process.exit(0));
});
