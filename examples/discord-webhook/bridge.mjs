#!/usr/bin/env node
// Discord bridge: forward mcp-coordinator consultation events to a Discord webhook.
//
// Subscribes to the coordinator's embedded MQTT broker and posts notable
// consultation lifecycle events to a Discord incoming webhook as rich embeds.
//
// Env:
//   DISCORD_WEBHOOK_URL  (required)  Discord incoming-webhook URL.
//   COORDINATOR_MQTT_URL (optional)  default mqtt://127.0.0.1:1883
//   COORDINATOR_TOKEN    (optional)  Phase-1 JWT; only needed when the
//                                    coordinator runs with COORDINATOR_AUTH_ENABLED=true.

import mqtt from "mqtt";

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const MQTT_URL = process.env.COORDINATOR_MQTT_URL || "mqtt://127.0.0.1:1883";
const TOKEN = process.env.COORDINATOR_TOKEN || "";

// The coordinator publishes everything under the hardcoded org `default`.
const BASE = "coordinator/default";

if (!WEBHOOK_URL) {
  console.error(
    "DISCORD_WEBHOOK_URL is not set.\n" +
      "Create a webhook (Server Settings > Integrations > Webhooks > New Webhook),\n" +
      "copy its URL, and export it, e.g.:\n" +
      "  export DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/...'"
  );
  process.exit(1);
}

// Discord embed colors (decimal).
const COLOR = {
  new: 0x5865f2, // blurple
  resolving: 0xfaa61a, // amber
  resolved: 0x57f287, // green
  claimed: 0x5865f2,
  completed: 0x57f287,
};

function parse(payload) {
  const text = payload.toString("utf8");
  if (!text) return null; // empty retained payload = cleared
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function postToDiscord(embed) {
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (!res.ok) {
      console.error(`Discord webhook returned ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    console.error(`Failed to POST to Discord: ${err.message}`);
  }
}

// Turn a coordinator MQTT message into a Discord embed, or null to skip.
function toEmbed(topic, data) {
  const parts = topic.split("/"); // coordinator, default, consultations, <id?>, <kind?>

  // coordinator/default/consultations/new
  if (topic === `${BASE}/consultations/new`) {
    const modules = Array.isArray(data.target_modules) ? data.target_modules : [];
    return {
      title: "New consultation",
      description: data.subject || "(no subject)",
      color: COLOR.new,
      fields: [
        { name: "Thread", value: String(data.thread_id ?? "?"), inline: true },
        { name: "Agent", value: String(data.agent_id ?? "?"), inline: true },
        {
          name: "Modules",
          value: modules.length ? modules.join(", ") : "—",
          inline: false,
        },
      ],
    };
  }

  const threadId = parts[3];
  const kind = parts[4];

  // coordinator/default/consultations/<threadId>/status
  if (kind === "status" && data.status === "resolved") {
    return {
      title: `Consultation resolved · ${threadId}`,
      description: data.summary || "(no summary)",
      color: COLOR.resolved,
    };
  }

  // coordinator/default/consultations/<threadId>/claimed
  if (kind === "claimed") {
    return {
      title: `Consultation claimed · ${threadId}`,
      description: `Claimed by **${data.claimed_by ?? data.agent_id ?? "?"}**`,
      color: COLOR.claimed,
      fields: data.claimed_at
        ? [{ name: "At", value: String(data.claimed_at), inline: true }]
        : undefined,
    };
  }

  // coordinator/default/consultations/<threadId>/completed
  if (kind === "completed") {
    return {
      title: `Consultation completed · ${threadId}`,
      description: data.summary || "(no summary)",
      color: COLOR.completed,
      fields: [
        {
          name: "Completed by",
          value: String(data.completed_by ?? data.agent_id ?? "?"),
          inline: true,
        },
      ],
    };
  }

  return null; // messages, resolving-status, agents, broadcast, quota — not forwarded
}

const options = {};
if (TOKEN) {
  // When auth is enabled, the JWT goes in the CONNECT password field;
  // username is ignored but conventionally the agent id.
  options.username = "discord-bridge";
  options.password = TOKEN;
}

const client = mqtt.connect(MQTT_URL, options);

client.on("connect", () => {
  console.error(`Connected to ${MQTT_URL}`);
  // Subscribe to the whole consultations subtree at QoS 1.
  client.subscribe(`${BASE}/consultations/#`, { qos: 1 }, (err) => {
    if (err) {
      console.error(`Subscribe failed: ${err.message}`);
      process.exit(1);
    }
    console.error(`Subscribed to ${BASE}/consultations/#`);
  });
});

client.on("message", async (topic, payload) => {
  const data = parse(payload);
  if (!data) return; // skip empty retained (cleared) consultations/new
  const embed = toEmbed(topic, data);
  if (embed) await postToDiscord(embed);
});

client.on("error", (err) => {
  console.error(`MQTT error: ${err.message}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.error("\nStopping bridge.");
    client.end(true, () => process.exit(0));
  });
}
