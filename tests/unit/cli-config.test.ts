import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { loadConfig, resolveValue, type CoordinatorConfig } from "../../cli/config.js";
import fs from "fs";

const TEST_CONFIG_DIR = "/tmp/test-mcp-coordinator-config";

beforeEach(() => {
  fs.rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
  delete process.env.PORT;
  delete process.env.COORDINATOR_URL;
  delete process.env.COORDINATOR_DATA_DIR;
});

afterAll(() => {
  fs.rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("returns defaults when no config file exists", () => {
    const config = loadConfig(TEST_CONFIG_DIR);
    expect(config.server.port).toBe(3100);
    expect(config.defaults.coordinator_url).toBe("http://localhost:3100");
  });

  it("reads config.json when it exists", () => {
    fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(`${TEST_CONFIG_DIR}/config.json`, JSON.stringify({
      server: { port: 4000 },
      defaults: { coordinator_url: "http://remote:3100" },
    }));
    const config = loadConfig(TEST_CONFIG_DIR);
    expect(config.server.port).toBe(4000);
    expect(config.defaults.coordinator_url).toBe("http://remote:3100");
  });
});

describe("resolveValue", () => {
  it("flag overrides env overrides config overrides default", () => {
    const config = loadConfig(TEST_CONFIG_DIR);
    expect(resolveValue(undefined, undefined, config.server.port, 3100)).toBe(3100);
    expect(resolveValue(undefined, undefined, 4000, 3100)).toBe(4000);
    expect(resolveValue(undefined, "5000", 4000, 3100)).toBe("5000");
    expect(resolveValue("6000", "5000", 4000, 3100)).toBe("6000");
  });
});

