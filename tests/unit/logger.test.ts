import { describe, it, expect, afterAll, beforeAll, beforeEach, afterEach, vi } from "vitest";
import pino from "pino";
import { Writable } from "node:stream";
import { createLogger, createConsoleLogger, createPinoLogger } from "../../src/logger.js";
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

  it("createServices threads stdio:true into the logger (no throw)", () => {
    const services = createServices({ dataDir: TEST_DIR, stdio: true });
    expect(services.logger).toBeDefined();
    expect(() => services.logger.child({ component: "x" }).info("noop")).not.toThrow();
  });
});

// protocole-mcp-01: in MCP stdio transport mode, stdout is reserved for
// JSON-RPC protocol messages. A stray log line on stdout corrupts the
// protocol stream (spec "MUST NOT"). ALL log levels — not just error/fatal —
// must go to stderr when stdio mode is active. See src/index.ts (sets
// `stdio: true`) and src/logger.ts (createConsoleLogger / createPinoLogger).
describe("Logger — stdio mode routes ALL levels to stderr, never stdout (protocole-mcp-01)", () => {
  describe("console variant", () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it("BASELINE (stdio=false): info/warn/debug still go to stdout — documents the bug this task fixes", () => {
      const logger = createConsoleLogger("debug");
      logger.debug("d");
      logger.info("i");
      logger.warn("w");
      expect(logSpy).toHaveBeenCalledTimes(3);
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("stdio=true: info/warn/debug go to stderr (console.error), stdout untouched", () => {
      const logger = createConsoleLogger("debug", {}, true);
      logger.debug("d");
      logger.info("i");
      logger.warn("w");
      expect(logSpy).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledTimes(3);
    });

    it("stdio=true: error/fatal ALSO stay on stderr (negative check — never stdout)", () => {
      const logger = createConsoleLogger("debug", {}, true);
      logger.error("e");
      logger.fatal("f");
      expect(logSpy).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledTimes(2);
    });

    it("child loggers inherit stdio=true", () => {
      const logger = createConsoleLogger("debug", {}, true).child({ component: "mcp" });
      logger.info("i");
      expect(logSpy).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("pino variant", () => {
    it("BASELINE (stdio=false, no destination override): writes to fd 1 (stdout)", () => {
      const logger = createPinoLogger("info");
      const stream = (logger as unknown as Record<symbol, { fd: number }>)[pino.symbols.streamSym];
      expect(stream.fd).toBe(1);
    });

    it("stdio=true, no destination override: writes to fd 2 (stderr), not fd 1", () => {
      const logger = createPinoLogger("info", undefined, true);
      const stream = (logger as unknown as Record<symbol, { fd: number }>)[pino.symbols.streamSym];
      expect(stream.fd).toBe(2);
    });

    it("an explicit test destination still wins over the stdio default", () => {
      const chunks: string[] = [];
      const sink = new Writable({
        write(chunk, _enc, cb) {
          chunks.push(chunk.toString());
          cb();
        },
      });
      const logger = createPinoLogger("info", sink, true);
      logger.info("hello-from-stdio-pino");
      expect(chunks.join("")).toContain("hello-from-stdio-pino");
    });
  });

  describe("createLogger({ stdio }) plumbing", () => {
    it("stdio=true does not throw and preserves the requested level", () => {
      const logger = createLogger({ stdio: true, level: "warn" });
      expect(logger.level).toBe("warn");
    });
  });
});

