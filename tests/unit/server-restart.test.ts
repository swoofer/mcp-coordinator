import { describe, it, expect } from "vitest";
import { buildStartArgv } from "../../cli/server/restart.js";

describe("buildStartArgv", () => {
  it("Node/tsx: re-passes the script path before `server start`", () => {
    expect(
      buildStartArgv(["--daemon", "--port", "3200"], {
        execPath: "/usr/bin/node",
        scriptPath: "/app/dist/cli/index.js",
        isBun: false,
      }),
    ).toEqual(["/app/dist/cli/index.js", "server", "start", "--daemon", "--port", "3200"]);
  });

  it("Bun binary: execPath is the CLI, so no script path is re-passed", () => {
    expect(
      buildStartArgv(["--daemon"], {
        execPath: "/usr/local/bin/mcp-coordinator",
        scriptPath: "/usr/local/bin/mcp-coordinator",
        isBun: true,
      }),
    ).toEqual(["server", "start", "--daemon"]);
  });

  it("forwards no extra flags when none are given", () => {
    expect(
      buildStartArgv([], { execPath: "/usr/bin/node", scriptPath: "/app/cli.js", isBun: false }),
    ).toEqual(["/app/cli.js", "server", "start"]);
  });

  it("Node with an undefined scriptPath falls back to just `server start`", () => {
    expect(buildStartArgv(["--port", "3100"], { execPath: "/usr/bin/node", isBun: false })).toEqual(
      ["server", "start", "--port", "3100"],
    );
  });
});
