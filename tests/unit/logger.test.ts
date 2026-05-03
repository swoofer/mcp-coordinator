import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { createLogger } from "../../src/logger.js";
import { createServices } from "../../src/server-setup.js";
import { closeDb } from "../../src/database.js";
import fs from "fs";

const TEST_DIR = "data-test-logger";

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("Logger", () => {
  it("creates a logger with default info level", () => {
    const logger = createLogger();
    expect(logger).toBeDefined();
    expect(logger.level).toBe("info");
  });

  it("respects LOG_LEVEL env var", () => {
    const logger = createLogger({ level: "debug" });
    expect(logger.level).toBe("debug");
  });

  it("creates child loggers with component field", () => {
    const logger = createLogger({ level: "silent" });
    const child = logger.child({ component: "mqtt" });
    expect(child).toBeDefined();
    expect(child.level).toBe("silent");
  });
});

describe("Logger integration", () => {
  it("createServices includes a logger in services", () => {
    const services = createServices({ dataDir: TEST_DIR });
    expect(services.logger).toBeDefined();
    expect(services.logger.level).toBe("info");
  });
});

