import { Command } from "commander";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { createConnection } from "net";
import { request } from "http";
import { getConfigDir, loadConfig } from "./config.js";

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

async function tcpReachable(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolveP) => {
    const sock = createConnection({ host, port });
    const settle = (ok: boolean) => {
      try {
        sock.destroy();
      } catch {}
      resolveP(ok);
    };
    sock.setTimeout(timeoutMs, () => settle(false));
    sock.on("connect", () => settle(true));
    sock.on("error", () => settle(false));
  });
}

async function httpGet(host: string, port: number, path: string, timeoutMs = 1500): Promise<{ status: number; body: string } | null> {
  return new Promise((resolveP) => {
    const req = request({ host, port, path, method: "GET", timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolveP({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8").slice(0, 200) });
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolveP(null);
    });
    req.on("error", () => resolveP(null));
    req.end();
  });
}

async function mcpInitialize(host: string, port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolveP) => {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "mcp-coordinator-doctor", version: "1.0.0" },
      },
    });
    const req = request(
      {
        host,
        port,
        path: "/mcp",
        method: "POST",
        timeout: timeoutMs,
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
          "Content-Length": Buffer.byteLength(payload).toString(),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          // streaming MCP responses prefix with `data: { ... }`
          resolveP(res.statusCode === 200 && body.includes('"protocolVersion"'));
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolveP(false);
    });
    req.on("error", () => resolveP(false));
    req.write(payload);
    req.end();
  });
}

export function createDoctorCommand(): Command {
  return new Command("doctor")
    .description("Run a health check: config, server liveness, MCP endpoint, MQTT broker, dashboard")
    .option("--host <host>", "Hostname to probe", "127.0.0.1")
    .option("--port <port>", "HTTP port", "")
    .option("--mqtt-port <port>", "MQTT TCP port", "")
    .action(async (opts: { host: string; port: string; mqttPort: string }) => {
      const results: CheckResult[] = [];
      const host = opts.host;

      // 1. Config dir
      const configDir = getConfigDir();
      results.push({
        name: "config-dir",
        ok: existsSync(configDir),
        detail: existsSync(configDir) ? configDir : `missing — run 'mcp-coordinator init'`,
        hint: existsSync(configDir) ? undefined : "Run: mcp-coordinator init",
      });

      // 2. config.json
      const configFile = join(configDir, "config.json");
      let parsedConfig: ReturnType<typeof loadConfig> | null = null;
      if (existsSync(configFile)) {
        try {
          parsedConfig = loadConfig();
          results.push({
            name: "config.json",
            ok: true,
            detail: `valid — port ${parsedConfig.server.port}, data_dir ${parsedConfig.server.data_dir}`,
          });
        } catch (e) {
          results.push({
            name: "config.json",
            ok: false,
            detail: `invalid: ${(e as Error).message}`,
            hint: "Re-run 'mcp-coordinator init' to restore defaults",
          });
        }
      } else {
        results.push({
          name: "config.json",
          ok: false,
          detail: "missing — defaults will be used",
          hint: "Run: mcp-coordinator init",
        });
      }

      const port = parseInt(opts.port || String(parsedConfig?.server.port ?? 3100), 10);
      const mqttPort = parseInt(opts.mqttPort || process.env.COORDINATOR_MQTT_TCP_PORT || "1883", 10);

      // 3. Server PID file
      const pidPath = join(configDir, "server.pid");
      let pidFromFile: number | null = null;
      if (existsSync(pidPath)) {
        try {
          pidFromFile = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
          results.push({
            name: "pid-file",
            ok: !isNaN(pidFromFile) && pidFromFile > 0,
            detail: `PID ${pidFromFile} (this is just the PID file; check 'tcp-${port}' below to confirm the server is actually listening)`,
          });
        } catch {
          results.push({
            name: "pid-file",
            ok: false,
            detail: "exists but unreadable",
            hint: "Stale state — run 'mcp-coordinator server stop' or delete ~/.mcp-coordinator/server.pid",
          });
        }
      } else {
        results.push({
          name: "pid-file",
          ok: false,
          detail: "absent (server not running in daemon mode)",
          hint: "Start the server: mcp-coordinator server start --daemon",
        });
      }

      // 4. HTTP TCP reachable
      const httpUp = await tcpReachable(host, port);
      results.push({
        name: `tcp-${port}`,
        ok: httpUp,
        detail: httpUp ? `${host}:${port} accepts connections` : `${host}:${port} unreachable`,
        hint: httpUp ? undefined : `Start the server: mcp-coordinator server start --daemon (or check the configured port)`,
      });

      // 5. /health endpoint
      if (httpUp) {
        const health = await httpGet(host, port, "/health");
        results.push({
          name: "/health",
          ok: !!health && health.status === 200,
          detail: health ? `HTTP ${health.status}: ${health.body}` : "no response",
          hint: !!health && health.status === 200 ? undefined : "Server is reachable but /health failed; check server logs",
        });

        // 6. /mcp initialize
        const mcpOk = await mcpInitialize(host, port);
        results.push({
          name: "/mcp initialize",
          ok: mcpOk,
          detail: mcpOk ? "JSON-RPC 2.0 initialize succeeded" : "no valid MCP response",
          hint: mcpOk ? undefined : "MCP HTTP transport not responding; check server logs and version compatibility",
        });

        // 7. Dashboard
        const dash = await httpGet(host, port, "/dashboard/");
        results.push({
          name: "/dashboard",
          ok: !!dash && dash.status === 200,
          detail: dash ? `HTTP ${dash.status}` : "no response",
          hint: !!dash && dash.status === 200 ? undefined : "Dashboard files not found; verify package install or rerun init",
        });
      }

      // 8. MQTT broker
      const mqttUp = await tcpReachable(host, mqttPort);
      results.push({
        name: `mqtt-${mqttPort}`,
        ok: mqttUp,
        detail: mqttUp ? `${host}:${mqttPort} accepts connections` : `${host}:${mqttPort} unreachable`,
        hint: mqttUp ? undefined : `MQTT broker not listening on port ${mqttPort}; check COORDINATOR_MQTT_TCP_PORT and server logs`,
      });

      // Print
      let allOk = true;
      console.log("");
      for (const r of results) {
        const prefix = r.ok ? "[ OK ]" : "[FAIL]";
        console.log(`${prefix}  ${r.name.padEnd(20)} ${r.detail}`);
        if (!r.ok) {
          allOk = false;
          if (r.hint) console.log(`        hint: ${r.hint}`);
        }
      }
      console.log("");
      if (allOk) {
        console.log("All checks passed. Coordinator is healthy.");
      } else {
        console.log("Some checks failed. See hints above.");
        process.exit(1);
      }
    });
}
