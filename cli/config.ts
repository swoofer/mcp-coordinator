import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface CoordinatorConfig {
  server: {
    port: number;
    data_dir: string;
  };
  defaults: {
    coordinator_url: string;
  };
}

/** The port a coordinator serves when nothing overrides it. Exported so the
 *  PID-file naming (see cli/pid-file.ts) and the config default cannot drift. */
export const DEFAULT_HTTP_PORT = 3100;

const DEFAULT_CONFIG: CoordinatorConfig = {
  server: {
    port: DEFAULT_HTTP_PORT,
    data_dir: join(homedir(), ".mcp-coordinator", "data"),
  },
  defaults: {
    coordinator_url: `http://localhost:${DEFAULT_HTTP_PORT}`,
  },
};

export function getConfigDir(): string {
  return join(homedir(), ".mcp-coordinator");
}

export function ensureConfigDir(): string {
  const dir = getConfigDir();
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, "logs"), { recursive: true });
  return dir;
}

export function loadConfig(configDir?: string): CoordinatorConfig {
  const dir = configDir ?? getConfigDir();
  const configPath = join(dir, "config.json");

  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    return {
      server: {
        port: raw.server?.port ?? DEFAULT_CONFIG.server.port,
        data_dir: raw.server?.data_dir ?? DEFAULT_CONFIG.server.data_dir,
      },
      defaults: {
        coordinator_url: raw.defaults?.coordinator_url ?? DEFAULT_CONFIG.defaults.coordinator_url,
      },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse config file "${configPath}": ${message}`);
  }
}

export function saveConfig(config: CoordinatorConfig, configDir?: string): void {
  const dir = configDir ?? getConfigDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2) + "\n");
}

export function resolveValue(
  flag: unknown,
  envVar: string | undefined,
  configValue: unknown,
  defaultValue: unknown,
): unknown {
  if (flag !== undefined) return flag;
  if (envVar !== undefined) return envVar;
  if (configValue !== undefined) return configValue;
  return defaultValue;
}
