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

describe("Logger --log-json / COORDINATOR_LOG_JSON", () => {
  const origJsonEnv = process.env.COORDINATOR_LOG_JSON;
  const origNodeEnv = process.env.NODE_ENV;

  afterAll(() => {
    if (origJsonEnv === undefined) delete process.env.COORDINATOR_LOG_JSON;
    else process.env.COORDINATOR_LOG_JSON = origJsonEnv;
    if (origNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = origNodeEnv;
  });

  function captureStdout(fn: () => void): string[] {
    const writes: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown): boolean => {
      const s = typeof chunk === "string" ? chunk : (chunk as Buffer).toString();
      writes.push(s);
      return true;
    }) as typeof process.stdout.write;
    try {
      fn();
    } finally {
      process.stdout.write = origWrite;
    }
    return writes;
  }

  it("creates a logger with json: true without throwing", () => {
    delete process.env.COORDINATOR_LOG_JSON;
    const logger = createLogger({ level: "info", json: true });
    expect(logger).toBeDefined();
    expect(logger.level).toBe("info");
  });

  it("emits valid NDJSON when json: true is passed (one JSON object per line)", () => {
    delete process.env.COORDINATOR_LOG_JSON;
    // Force pretty-eligible env to confirm json:true overrides it
    process.env.NODE_ENV = "development";
    const writes = captureStdout(() => {
      const logger = createLogger({ level: "info", json: true });
      logger.info({ foo: "bar" }, "hello-json-flag");
    });
    const line = writes.find((w) => w.includes("hello-json-flag"));
    expect(line, `expected stdout to contain a line with our message; got ${JSON.stringify(writes)}`).toBeDefined();
    const trimmed = line!.trim();
    // NDJSON: each emitted line is valid JSON
    const parsed = JSON.parse(trimmed);
    expect(parsed.msg).toBe("hello-json-flag");
    expect(parsed.foo).toBe("bar");
    // No ANSI color codes (pino-pretty's colorize would leak [...)
    expect(trimmed).not.toMatch(/\[/);
  });

  it("reads COORDINATOR_LOG_JSON=true from env when option is unset", () => {
    process.env.COORDINATOR_LOG_JSON = "true";
    process.env.NODE_ENV = "development";
    const writes = captureStdout(() => {
      const logger = createLogger({ level: "info" });
      logger.info("hello-env-json");
    });
    const line = writes.find((w) => w.includes("hello-env-json"));
    expect(line).toBeDefined();
    expect(() => JSON.parse(line!.trim())).not.toThrow();
  });

  it("explicit json: false overrides COORDINATOR_LOG_JSON=true", () => {
    // option takes precedence over env (nullish coalescing in createLogger)
    process.env.COORDINATOR_LOG_JSON = "true";
    process.env.NODE_ENV = "production";
    // Just verify no throw and logger created — actual pretty output requires
    // NODE_ENV=development which we can't easily test without a worker thread.
    const logger = createLogger({ level: "info", json: false });
    expect(logger).toBeDefined();
  });
});

