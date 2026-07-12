import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import path from "path";

// Resolve the repo root from this test file's location so the suite is
// runnable from any cwd (vitest picks it up via vitest.config.ts include).
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DOCKERFILE = path.join(REPO_ROOT, "Dockerfile");
const DOCKERIGNORE = path.join(REPO_ROOT, ".dockerignore");
const COMPOSE = path.join(REPO_ROOT, "docker-compose.yml");

describe("Dockerfile (production image)", () => {
  // Read once — the file is small and content checks don't need re-reads.
  const dockerfile = existsSync(DOCKERFILE) ? readFileSync(DOCKERFILE, "utf-8") : "";

  it("exists at the repo root", () => {
    expect(existsSync(DOCKERFILE)).toBe(true);
  });

  it("uses a multi-stage build with two FROM statements", () => {
    const fromLines = dockerfile
      .split("\n")
      .filter((l) => /^\s*FROM\s+/i.test(l));
    expect(fromLines.length).toBeGreaterThanOrEqual(2);
  });

  it("bases both stages on node:22-alpine for a small final image", () => {
    // The tag may carry a pinned digest (@sha256:…) for supply-chain
    // reproducibility (ci-cd-10); the base image and stage names are what matter.
    expect(dockerfile).toMatch(/FROM\s+node:22-alpine(@sha256:[0-9a-f]{64})?\s+AS\s+builder/i);
    expect(dockerfile).toMatch(/FROM\s+node:22-alpine(@sha256:[0-9a-f]{64})?\s+AS\s+runtime/i);
  });

  it("creates a non-root coordinator user with uid 1001 and switches to it", () => {
    // Group + user creation, then USER directive — order matters because
    // the USER must come after WORKDIR/COPY chowns to take effect.
    expect(dockerfile).toMatch(/addgroup\s+-g\s+1001\s+-S\s+coordinator/);
    expect(dockerfile).toMatch(/adduser\s+-u\s+1001\s+-S\s+coordinator/);
    expect(dockerfile).toMatch(/^\s*USER\s+coordinator\s*$/m);
  });

  it("does not run as root (no trailing USER root)", () => {
    // Find every USER line; the last one wins. It must be the non-root user.
    const userLines = dockerfile
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^USER\s+/i.test(l));
    expect(userLines.length).toBeGreaterThan(0);
    const lastUser = userLines[userLines.length - 1]!;
    expect(lastUser).not.toMatch(/^USER\s+root/i);
    expect(lastUser).toMatch(/^USER\s+coordinator/i);
  });

  it("declares /data as a VOLUME for SQLite + config persistence", () => {
    // Accept either string-form or JSON-array-form VOLUME directives.
    expect(dockerfile).toMatch(/^\s*VOLUME\s+(\["\/data"\]|\/data)\s*$/m);
  });

  it("sets COORDINATOR_DATA_DIR to /data/data", () => {
    expect(dockerfile).toMatch(/COORDINATOR_DATA_DIR\s*=\s*\/data\/data/);
  });

  it("exposes both the HTTP (3100) and MQTT (1883) ports", () => {
    expect(dockerfile).toMatch(/^\s*EXPOSE\s+.*\b3100\b/m);
    expect(dockerfile).toMatch(/^\s*EXPOSE\s+.*\b1883\b/m);
  });

  it("declares an HTTP HEALTHCHECK against /health", () => {
    expect(dockerfile).toMatch(/^\s*HEALTHCHECK\b/m);
    // The probe must hit /health (the route registered in serve-http.ts).
    expect(dockerfile).toMatch(/wget[^\n]*\/health/);
  });

  it("uses the compiled CLI as the ENTRYPOINT and `server start` as the default CMD", () => {
    // dist/cli/index.js is the bin target in package.json — entrypoint must
    // exec it so `docker run image foo bar` swaps args, not the binary.
    expect(dockerfile).toMatch(/ENTRYPOINT\s+\[[^\]]*"node"[^\]]*"dist\/cli\/index\.js"/);
    expect(dockerfile).toMatch(/CMD\s+\["server",\s*"start"\]/);
  });

  it("sets WORKDIR /app in the runtime stage", () => {
    expect(dockerfile).toMatch(/^\s*WORKDIR\s+\/app\s*$/m);
  });
});

describe(".dockerignore", () => {
  it("excludes tests, dist, .git, node_modules, and superpowers docs", () => {
    expect(existsSync(DOCKERIGNORE)).toBe(true);
    const ignore = readFileSync(DOCKERIGNORE, "utf-8");
    // Each pattern must appear on its own line — substring matching is
    // sufficient because docker globs aren't regex.
    for (const pattern of ["tests/", "dist/", ".git/", "node_modules/", "docs/superpowers/", "*.md"]) {
      expect(ignore).toContain(pattern);
    }
    // LICENSE must be re-included so the runtime stage can COPY it.
    expect(ignore).toMatch(/^\s*!LICENSE\s*$/m);
  });
});

describe("docker-compose.yml", () => {
  it("declares the coordinator service with the expected ports and named volume", () => {
    expect(existsSync(COMPOSE)).toBe(true);
    const compose = readFileSync(COMPOSE, "utf-8");
    expect(compose).toMatch(/^\s*coordinator\s*:\s*$/m);
    expect(compose).toContain("3100:3100");
    expect(compose).toContain("1883:1883");
    expect(compose).toContain("mcp-coordinator-data:/data");
    expect(compose).toMatch(/restart:\s*unless-stopped/);
    expect(compose).toMatch(/COORDINATOR_BIND:\s*["']?0\.0\.0\.0/);
  });
});
