import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

// Resolve repo root so this suite runs from any cwd.
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPTS_DIR = path.join(REPO_ROOT, "scripts");

// Detect whether a working POSIX bash is available. The suite shells out to
// `bash` to run /scripts/lint-*.sh. Cases that block this test:
//   - Pure Windows host with no Git Bash AND no WSL → bash not on PATH.
//   - Windows host with WSL but no distro installed → `bash.exe` is on PATH
//     but invoking it tries to launch /bin/bash inside a non-existent WSL
//     distro, producing `WSL (NN) ERROR: ... execvpe(/bin/bash) failed:
//     No such file or directory`.
// In both cases the lint suite cannot meaningfully run; skip the whole
// describe block so the suite does not red-flag the developer on Windows.
const BASH_AVAILABLE: boolean = (() => {
  try {
    const out = execFileSync("bash", ["-c", "echo ok"], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      timeout: 5000,
    });
    return out.trim() === "ok";
  } catch {
    return false;
  }
})();

// Use `bash` on PATH so the suite works on Windows (Git Bash) and Linux CI.
// execFileSync returns the script's stdout on success and throws on non-zero exit.
function runLint(script: string, args: string[] = []): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("bash", [path.join(SCRIPTS_DIR, script), ...args], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      status: typeof e.status === "number" ? e.status : 1,
      stdout: e.stdout ? e.stdout.toString() : "",
      stderr: e.stderr ? e.stderr.toString() : "",
    };
  }
}

// Each lint test creates an isolated sandbox dir under the OS temp area,
// writes a synthetic violation file, and asserts the lint exit code.
let sandbox: string;
beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "lint-sandbox-"));
});
afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function writeFixture(relPath: string, content: string): string {
  const full = path.join(sandbox, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content, "utf-8");
  return full;
}

describe.skipIf(!BASH_AVAILABLE)("lint scripts (Phase 2 guard rails)", () => {
  describe("lint-no-users-org-id.sh", () => {
    it("catches synthetic users.org_id violation", () => {
      writeFixture("src/foo.ts", "const x = row.users.org_id;\n");
      const { status, stderr } = runLint("lint-no-users-org-id.sh", [sandbox]);
      expect(status).toBe(1);
      expect(stderr).toMatch(/users\.org_id/);
    });

    it("passes on a clean sandbox", () => {
      writeFixture("src/foo.ts", "const x = row.primary_org_id;\n");
      const { status } = runLint("lint-no-users-org-id.sh", [sandbox]);
      expect(status).toBe(0);
    });

    it("passes against the real repo at HEAD", () => {
      const { status } = runLint("lint-no-users-org-id.sh");
      expect(status).toBe(0);
    });
  });

  describe("lint-no-current-timestamp.sh", () => {
    it("catches synthetic CURRENT_TIMESTAMP violation", () => {
      writeFixture("src/oauth-state.ts", "db.exec(\"INSERT ... DEFAULT CURRENT_TIMESTAMP\");\n");
      const { status, stderr } = runLint("lint-no-current-timestamp.sh", [sandbox]);
      expect(status).toBe(1);
      expect(stderr).toMatch(/CURRENT_TIMESTAMP/);
    });

    it("passes on a clean sandbox using strftime", () => {
      writeFixture("src/oauth-state.ts", "db.exec(\"INSERT ... strftime('%s','now')\");\n");
      const { status } = runLint("lint-no-current-timestamp.sh", [sandbox]);
      expect(status).toBe(0);
    });

    it("passes against the real repo at HEAD", () => {
      const { status } = runLint("lint-no-current-timestamp.sh");
      expect(status).toBe(0);
    });
  });

  describe("lint-no-audit-mutation.sh", () => {
    it("catches synthetic UPDATE audit_log violation", () => {
      writeFixture("src/handler.ts", "db.prepare(\"UPDATE audit_log SET outcome='x'\").run();\n");
      const { status, stderr } = runLint("lint-no-audit-mutation.sh", [sandbox]);
      expect(status).toBe(1);
      expect(stderr).toMatch(/audit_log/);
    });

    it("catches synthetic DELETE FROM audit_log violation", () => {
      writeFixture("src/handler.ts", "db.prepare(\"DELETE FROM audit_log\").run();\n");
      const { status, stderr } = runLint("lint-no-audit-mutation.sh", [sandbox]);
      expect(status).toBe(1);
      expect(stderr).toMatch(/audit_log/);
    });

    it("passes on a clean sandbox", () => {
      writeFixture("src/handler.ts", "db.prepare(\"INSERT INTO audit_log VALUES (?)\").run('x');\n");
      const { status } = runLint("lint-no-audit-mutation.sh", [sandbox]);
      expect(status).toBe(0);
    });

    it("passes against the real repo at HEAD", () => {
      const { status } = runLint("lint-no-audit-mutation.sh");
      expect(status).toBe(0);
    });
  });

  describe("lint-html-escape.sh", () => {
    it("catches unescaped interpolation in a page template", () => {
      writeFixture(
        "pages/login.ts",
        "export function loginPage(name: string) {\n  return `<div>${name}</div>`;\n}\n",
      );
      const { status, stderr } = runLint("lint-html-escape.sh", [path.join(sandbox, "pages")]);
      expect(status).toBe(1);
      expect(stderr).toMatch(/\$\{/);
    });

    it("passes when interpolation routes through escapeHtml()", () => {
      writeFixture(
        "pages/login.ts",
        "export function loginPage(name: string) {\n  return `<div>${escapeHtml(name)}</div>`;\n}\n",
      );
      const { status } = runLint("lint-html-escape.sh", [path.join(sandbox, "pages")]);
      expect(status).toBe(0);
    });

    it("passes when the line uses render() with no inline interpolation", () => {
      // render(template, vars) without ${...} on the line exits at the
      // `[[ "$stripped" =~ \$\{ ]] || continue` guard — no bypass needed.
      writeFixture(
        "pages/login.ts",
        "export function loginPage(name: string) {\n  return render(loginTemplate, { user: name });\n}\n",
      );
      const { status } = runLint("lint-html-escape.sh", [path.join(sandbox, "pages")]);
      expect(status).toBe(0);
    });

    it("catches unescaped interpolation on a line that also contains render(", () => {
      // Regression: a prior line-level `render(` bypass let through inline
      // template literals like `render(\`<div>${x}</div>\`, {})` that DO
      // need escapeHtml() wrapping. The per-expression check must apply
      // regardless of whether `render(` appears on the line.
      const pagesDir = path.join(sandbox, "src", "auth", "pages");
      mkdirSync(pagesDir, { recursive: true });
      writeFileSync(
        path.join(pagesDir, "bad.ts"),
        "export const x = render(`<div>${userInput}</div>`, {});\n",
        "utf-8",
      );
      const { status, stderr } = runLint("lint-html-escape.sh", [path.join(sandbox, "src", "auth", "pages")]);
      expect(status).toBe(1);
      expect(stderr).toMatch(/\$\{/);
    });

    it("exits 0 cleanly when src/auth/pages does not yet exist", () => {
      // No sandbox files; lint defaults to src/auth/pages which is absent at HEAD.
      const { status } = runLint("lint-html-escape.sh");
      expect(status).toBe(0);
    });
  });

  describe("lint-no-direct-env-in-auth.sh", () => {
    it("catches synthetic process.env.COORDINATOR_ violation", () => {
      writeFixture(
        "src/auth/handler.ts",
        "const s = process.env.COORDINATOR_JWT_SECRET;\n",
      );
      const { status, stderr } = runLint(
        "lint-no-direct-env-in-auth.sh",
        [path.join(sandbox, "src", "auth")],
      );
      expect(status).toBe(1);
      expect(stderr).toMatch(/process\.env\.COORDINATOR_/);
    });

    it("passes on a clean sandbox (no env reads)", () => {
      writeFixture(
        "src/auth/handler.ts",
        "const s = getOrgSetting(db, orgId, 'jwt_secret', '');\n",
      );
      const { status } = runLint(
        "lint-no-direct-env-in-auth.sh",
        [path.join(sandbox, "src", "auth")],
      );
      expect(status).toBe(0);
    });

    it("allowlists src/auth/org-settings.ts (the shim may read env)", () => {
      writeFixture(
        "src/auth/org-settings.ts",
        "const s = process.env.COORDINATOR_JWT_SECRET;\n",
      );
      const { status } = runLint(
        "lint-no-direct-env-in-auth.sh",
        [path.join(sandbox, "src", "auth")],
      );
      expect(status).toBe(0);
    });

    it("passes against the real repo at HEAD", () => {
      const { status } = runLint("lint-no-direct-env-in-auth.sh");
      expect(status).toBe(0);
    });
  });

  describe("lint-run-all.sh", () => {
    it("exits 0 against the real repo at HEAD", () => {
      const { status } = runLint("lint-run-all.sh");
      expect(status).toBe(0);
    });
  });
});
