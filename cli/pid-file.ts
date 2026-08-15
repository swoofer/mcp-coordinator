import { join } from "path";
import { existsSync } from "fs";
import { DEFAULT_HTTP_PORT } from "./config.js";

/**
 * Where a daemon's PID file lives, derived from the port it serves.
 *
 * issue #279: every one of the eight PID sites used a fixed
 * `join(configDir, "server.pid")`, independent of `--port` and `--data-dir`.
 * Starting a second daemon overwrote the first's PID file, so `server stop`
 * killed the wrong process and `server status` could only ever describe the
 * most recently started instance. `docs/usage.md` documented that as a known
 * limitation and told operators to note the PID from the start banner and
 * `kill` it by hand.
 *
 * The port is the natural instance identity: two daemons on one machine have
 * to bind different HTTP ports anyway, so it is the one thing that is already
 * guaranteed distinct.
 *
 * The default port keeps the historical filename, byte for byte. That is not
 * cosmetic — an operator who upgrades while a daemon is running must still be
 * able to stop it, and anything scripted against `~/.mcp-coordinator/server.pid`
 * keeps working.
 */
export function pidFileName(port: number): string {
  return port === DEFAULT_HTTP_PORT ? "server.pid" : `server-${port}.pid`;
}

export function pidFilePath(configDir: string, port: number): string {
  return join(configDir, pidFileName(port));
}

/**
 * Which PID file a READER should open.
 *
 * Prefers the per-instance name, but falls back to the historical fixed
 * `server.pid` when that is the one on disk. Without this, upgrading while a
 * daemon is running would strand it: an operator whose `config.json` sets a
 * non-default port has a running process recorded under `server.pid`, and a
 * new binary looking only for `server-<port>.pid` would report "stopped" and
 * refuse to stop anything.
 *
 * Writers do NOT fall back — `start` always writes the per-instance name, or
 * two instances would collide again, which is the whole point of #279.
 *
 * When neither exists the per-instance path is returned, so "not found"
 * messages name where the file was expected rather than where it used to be.
 */
export function existingPidFilePath(
  configDir: string,
  port: number,
  exists: (p: string) => boolean = existsSync,
): string {
  const scoped = pidFilePath(configDir, port);
  if (exists(scoped)) return scoped;
  const legacy = join(configDir, "server.pid");
  return exists(legacy) ? legacy : scoped;
}
