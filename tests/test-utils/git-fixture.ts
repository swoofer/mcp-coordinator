import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { execSync } from "child_process";

export interface FixtureCommit {
  files: Record<string, string>;
  message: string;
}

/** Creates a temp git repo with the given commits (in order). Returns the repo path. */
export function createGitFixture(commits: FixtureCommit[]): string {
  const dir = mkdtempSync(join(tmpdir(), "gitfix-"));
  execSync("git init -q", { cwd: dir });
  execSync('git config user.email "test@test.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  execSync('git config core.autocrlf false', { cwd: dir });
  for (const c of commits) {
    for (const [p, content] of Object.entries(c.files)) {
      const fp = join(dir, p);
      mkdirSync(dirname(fp), { recursive: true });
      writeFileSync(fp, content);
    }
    execSync("git add -A", { cwd: dir });
    execSync(`git commit -q -m "${c.message.replace(/"/g, '\\"')}"`, { cwd: dir });
  }
  return dir;
}
