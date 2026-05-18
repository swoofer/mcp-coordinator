import { describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import {
  createFingerprintCommand,
  runFingerprint,
} from "../../cli/encryption/fingerprint.js";
import { createEncryptionCommand } from "../../cli/encryption/index.js";

const KEY_A_HEX = randomBytes(32).toString("hex");
const KEY_B_HEX = randomBytes(32).toString("hex");

const HEX16_RE = /^[0-9a-f]{16}$/;

describe("cli encryption fingerprint — runFingerprint", () => {
  it("returns exit 0 and a 16-hex-char fingerprint for a valid key", () => {
    const result = runFingerprint({ encryptionKey: KEY_A_HEX });
    expect(result.exitCode).toBe(0);
    expect(result.fingerprint).toMatch(HEX16_RE);
    expect(result.message).toBe(result.fingerprint);
  });

  it("is deterministic: same key produces the same fingerprint across calls", () => {
    const a = runFingerprint({ encryptionKey: KEY_A_HEX });
    const b = runFingerprint({ encryptionKey: KEY_A_HEX });
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it("produces different fingerprints for different keys", () => {
    const a = runFingerprint({ encryptionKey: KEY_A_HEX });
    const b = runFingerprint({ encryptionKey: KEY_B_HEX });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it("returns exit 2 with the canonical message when no key is set", () => {
    const prev = process.env.COORDINATOR_ENCRYPTION_KEY;
    delete process.env.COORDINATOR_ENCRYPTION_KEY;
    try {
      const result = runFingerprint();
      expect(result.exitCode).toBe(2);
      expect(result.message).toBe("COORDINATOR_ENCRYPTION_KEY not set");
      expect(result.fingerprint).toBe("");
    } finally {
      if (prev !== undefined) process.env.COORDINATOR_ENCRYPTION_KEY = prev;
    }
  });

  it("returns exit 2 for a malformed key (decodeMasterKey throws)", () => {
    const result = runFingerprint({ encryptionKey: "not-a-real-key" });
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/Failed to decode master key/);
    expect(result.fingerprint).toBe("");
  });

  it("is a pure env-only function: succeeds without any DB or config dir", () => {
    // No configDir/dataDir involvement at all — purely env-driven.
    const result = runFingerprint({ encryptionKey: KEY_A_HEX });
    expect(result.exitCode).toBe(0);
    expect(result.fingerprint).toMatch(HEX16_RE);
  });
});

describe("cli encryption fingerprint — command + wiring", () => {
  it("createFingerprintCommand exposes the expected commander definition", () => {
    const cmd = createFingerprintCommand();
    expect(cmd.name()).toBe("fingerprint");
    expect(cmd.description()).toMatch(/fingerprint/i);
  });

  it("createEncryptionCommand registers the fingerprint subcommand", () => {
    const cmd = createEncryptionCommand();
    const sub = cmd.commands.find((c) => c.name() === "fingerprint");
    expect(sub).toBeDefined();
  });

  it("action writes fingerprint to stdout and exits 0 with a valid key", () => {
    const prevKey = process.env.COORDINATOR_ENCRYPTION_KEY;
    process.env.COORDINATOR_ENCRYPTION_KEY = KEY_A_HEX;
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: string | number | null) => {
        throw new Error(`__exit:${code}`);
      });
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockReturnValue(true);
    try {
      const cmd = createFingerprintCommand();
      expect(() => cmd.parse([], { from: "user" })).toThrow(/__exit:0/);
      // First write call argument: fingerprint + newline.
      const written = String(stdoutSpy.mock.calls[0][0]);
      expect(written).toMatch(/^[0-9a-f]{16}\n$/);
    } finally {
      exitSpy.mockRestore();
      stdoutSpy.mockRestore();
      if (prevKey === undefined) delete process.env.COORDINATOR_ENCRYPTION_KEY;
      else process.env.COORDINATOR_ENCRYPTION_KEY = prevKey;
    }
  });

  it("action writes to stderr and exits 2 when no key is set", () => {
    const prevKey = process.env.COORDINATOR_ENCRYPTION_KEY;
    delete process.env.COORDINATOR_ENCRYPTION_KEY;
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: string | number | null) => {
        throw new Error(`__exit:${code}`);
      });
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockReturnValue(true);
    try {
      const cmd = createFingerprintCommand();
      expect(() => cmd.parse([], { from: "user" })).toThrow(/__exit:2/);
      const written = String(stderrSpy.mock.calls[0][0]);
      expect(written).toMatch(/COORDINATOR_ENCRYPTION_KEY not set/);
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
      if (prevKey !== undefined) process.env.COORDINATOR_ENCRYPTION_KEY = prevKey;
    }
  });
});
