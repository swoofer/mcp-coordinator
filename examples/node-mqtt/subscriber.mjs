#!/usr/bin/env node
// Subscribe to mcp-coordinator MQTT events and pretty-print them per topic.
//
// The coordinator publishes everything under a hardcoded org `default`, so we
// listen on `coordinator/default/#`. Anonymous access is the default; if the
// coordinator runs with COORDINATOR_AUTH_ENABLED=true, supply a Phase-1 JWT via
// the COORDINATOR_TOKEN env var (sent as the MQTT CONNECT password).

import mqtt from "mqtt";

// Default: the plain TCP listener (simplest, no HTTP server involved).
//   TCP: mqtt://127.0.0.1:1883        (bound to 127.0.0.1)
// WebSocket alternative (shares the HTTP server on port 3100):
//   WS:  ws://localhost:3100/mqtt     (NO `mqtt` WS subprotocol — do not set one)
// Override either with the BROKER_URL env var.
const BROKER_URL = process.env.BROKER_URL ?? "mqtt://127.0.0.1:1883";
const TOKEN = process.env.COORDINATOR_TOKEN; // optional Phase-1 JWT
const TOPIC = "coordinator/default/#";

const options = {
  clientId: `node-mqtt-subscriber-${Math.random().toString(16).slice(2, 10)}`,
  reconnectPeriod: 2000,
  clean: true,
};

// Auth is opt-in. When enabled, the JWT goes in the CONNECT password field;
// the username is ignored by the broker but conventionally the agent id.
if (TOKEN) {
  options.username = "node-mqtt-subscriber";
  options.password = TOKEN;
}

console.error(`Connecting to ${BROKER_URL}${TOKEN ? " (with token)" : " (anonymous)"}`);

const client = mqtt.connect(BROKER_URL, options);

client.on("connect", () => {
  client.subscribe(TOPIC, { qos: 1 }, (err) => {
    if (err) {
      console.error(`Subscribe failed: ${err.message}`);
      client.end();
      return;
    }
    console.error(`Subscribed to ${TOPIC}. Waiting for events... (Ctrl-C to stop)`);
  });
});

client.on("message", (topic, payload) => {
  // A retained `consultations/new` (or `.../status`) may arrive immediately on
  // connect; an empty payload means the retained message was cleared — skip it.
  if (payload.length === 0) return;

  let data;
  try {
    data = JSON.parse(payload.toString("utf8"));
  } catch {
    console.log(`\n[${topic}] (non-JSON) ${payload.toString("utf8")}`);
    return;
  }

  print(topic, data);
});

client.on("error", (err) => {
  console.error(`MQTT error: ${err.message}`);
});

client.on("reconnect", () => {
  console.error("Reconnecting...");
});

// Pretty-print one event, branching on the topic suffix.
function print(topic, data) {
  const parts = topic.split("/"); // coordinator / default / <section> / ...
  const section = parts[2];
  const suffix = parts[parts.length - 1];

  let line;
  if (section === "consultations" && suffix === "new") {
    line = `consultation opened  thread=${data.thread_id} by=${data.agent_id}` +
      `  subject="${data.subject}"  modules=${fmtList(data.target_modules)}`;
  } else if (section === "consultations" && suffix === "messages") {
    line = `message [${data.type}]  by=${data.agent_id}  ${data.content}`;
  } else if (section === "consultations" && suffix === "status") {
    line = `status -> ${data.status}${data.summary ? `  ${data.summary}` : ""}`;
  } else if (section === "consultations" && suffix === "claimed") {
    line = `claimed  by=${data.claimed_by}  at=${data.claimed_at}`;
  } else if (section === "consultations" && suffix === "completed") {
    line = `completed  by=${data.completed_by}${data.summary ? `  ${data.summary}` : ""}`;
  } else if (section === "agents" && suffix === "status") {
    line = data.status === "online"
      ? `agent online   ${data.name ?? parts[3]}`
      : `agent offline  ${parts[3]}${data.reason ? `  (${data.reason})` : ""}`;
  } else if (section === "broadcast") {
    line = `broadcast  by=${data.agent_id}  ${data.message}`;
  } else if (section === "quota" && suffix === "update") {
    line = `quota  5h=${data.fiveHour} 7d=${data.sevenDay} 7dSonnet=${data.sevenDaySonnet}`;
  } else {
    line = JSON.stringify(data);
  }

  console.log(`\n[${topic}]\n  ${line}`);
}

function fmtList(v) {
  return Array.isArray(v) ? `[${v.join(", ")}]` : String(v ?? "");
}

// Graceful shutdown on Ctrl-C.
let closing = false;
process.on("SIGINT", () => {
  if (closing) return;
  closing = true;
  console.error("\nStopping subscriber...");
  client.end(false, () => process.exit(0));
  // Fallback if the broker never acknowledges DISCONNECT.
  setTimeout(() => process.exit(0), 2000).unref();
});
