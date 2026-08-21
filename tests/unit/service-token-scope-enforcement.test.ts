import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { requireScope, TOOL_SCOPES } from "../../src/tools/tool-scopes.js";
import type { AuthClaims } from "../../src/auth.js";

/**
 * issue #313, the enforcement half — a `--scope read` service token wrote,
 * deleted and published exactly like an `--scope admin` one, because nothing
 * downstream read the claim.
 *
 * WHERE THE CHECK LIVES. The issue proposes BearerAuthOptions.requiredScopes at
 * the HTTP gate. That cannot work here: `/mcp` is one endpoint, authentication
 * runs before transport.handleRequest while the JSON-RPC body is an unread
 * stream, so the tool name does not exist yet when the authorization decision
 * would be made. (Separately, requiredScopes is a fixed per-gate list typed on
 * Web Request/Response while this gate is node:http.)
 *
 * And HTTP is the wrong GRANULARITY, which the issue does not consider. A 403
 * rejects the request, and on a multiplexed endpoint the request is the
 * transport. A read token calling a write tool should be told no about THAT
 * tool and stay free to call a read tool next — a per-call answer, i.e. a
 * JSON-RPC error. That is also what this codebase already does for the sibling
 * failure: every tool throws for missing claims.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const base: AuthClaims = {
  sub: "svc",
  user_id: "svc",
  org: "default",
  role: "service",
  jti: "j1",
};
const withScope = (scope: AuthClaims["scope"]): AuthClaims => ({ ...base, scope });

describe("scope enforcement (#313)", () => {
  it("a read token is refused on a write tool", () => {
    // The issue's acceptance criterion, in one line.
    expect(() => requireScope(withScope("read"), "announce_work")).toThrow(/scope "read"/);
    expect(() => requireScope(withScope("read"), "announce_work")).toThrow(/requires "write"/);
  });

  it("and accepted on a read tool", () => {
    expect(() => requireScope(withScope("read"), "list_threads")).not.toThrow();
  });

  it("write covers read, admin covers everything", () => {
    expect(() => requireScope(withScope("write"), "list_threads")).not.toThrow();
    expect(() => requireScope(withScope("write"), "announce_work")).not.toThrow();
    for (const tool of Object.keys(TOOL_SCOPES)) {
      expect(() => requireScope(withScope("admin"), tool), tool).not.toThrow();
    }
  });

  it("the refusal says how to get a token that works", () => {
    // A permission error that does not name the remedy just moves the problem.
    const message = (() => {
      try {
        requireScope(withScope("read"), "mqtt_publish");
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(message).toContain("service-token issue --scope write");
    expect(message).toContain("cannot be widened at call time");
    // And which tools the token it already holds CAN reach.
    expect(message).toContain("list_threads");
  });
});

describe("everything that is not a service token stays unrestricted (#313)", () => {
  it("claims with no scope are never refused", () => {
    // Only `service-token issue` mints a scope. Phase 1 agent tokens, Phase 2
    // cookie sessions and stdio's synthetic claims carry none. Refusing them
    // would break every existing deployment on upgrade, so undefined means
    // unrestricted — not least privilege.
    for (const tool of Object.keys(TOOL_SCOPES)) {
      expect(() => requireScope(base, tool), tool).not.toThrow();
    }
  });

  it("stdio's synthetic claims carry no scope", () => {
    // The stdio entry point builds claims by hand; if it ever grew a scope,
    // every stdio tool call would start being checked.
    expect(read("src/stdio-server.ts")).not.toContain("scope");
  });
});

describe("the scope table covers exactly the registered tools (#313)", () => {
  const registered = (() => {
    const names: string[] = [];
    for (const f of [
      "agents-tools",
      "consultation-tools",
      "dependencies-tools",
      "files-tools",
      "mqtt-tools",
      "status-tools",
    ]) {
      const src = read("src/tools/" + f + ".ts");
      for (const m of src.matchAll(/registerTool\(\s*["']([a-z_]+)["']/g)) names.push(m[1]);
    }
    return names.sort();
  })();

  it("every registered tool has a scope", () => {
    // A tool missing from the table is silently unrestricted for every token,
    // which is the exact defect #313 is about — a check that looks present and
    // is not.
    expect(registered.length).toBe(26);
    for (const tool of registered) {
      expect(TOOL_SCOPES[tool], "no scope declared for " + tool).toBeDefined();
    }
  });

  it("the table has no entry for a tool that no longer exists", () => {
    for (const tool of Object.keys(TOOL_SCOPES)) {
      expect(registered, "table lists " + tool + ", which nothing registers").toContain(tool);
    }
  });

  it("every registered tool actually calls the check", () => {
    // The table is inert unless each handler consults it. Counting the call
    // sites against the registrations is what catches a tool added later
    // without one.
    let calls = 0;
    for (const f of [
      "agents-tools",
      "consultation-tools",
      "dependencies-tools",
      "files-tools",
      "mqtt-tools",
      "status-tools",
    ]) {
      calls += (read("src/tools/" + f + ".ts").match(/requireScope\(claims, "/g) ?? []).length;
    }
    expect(calls).toBe(registered.length);
  });
});

describe("the read set is the one an observer needs (#313)", () => {
  it("draining tools are writes, because draining consumes", () => {
    // get_queued_messages and wait_for_message remove messages with no ack, so
    // a "read-only" caller would silently steal another agent's queue.
    expect(TOOL_SCOPES.get_queued_messages).toBe("write");
    expect(TOOL_SCOPES.wait_for_message).toBe("write");
  });

  it("registry mutations are writes even though they feel like bookkeeping", () => {
    expect(TOOL_SCOPES.register_agent).toBe("write");
    expect(TOOL_SCOPES.heartbeat).toBe("write");
  });

  it("a read token can still see the whole coordination picture", () => {
    // The point of the read scope: a dashboard or CI observer should work.
    for (const tool of [
      "coordinator_status",
      "list_agents",
      "list_threads",
      "get_thread",
      "hot_files",
      "check_file_conflict",
      "get_blast_radius",
    ]) {
      expect(TOOL_SCOPES[tool], tool + " should be readable by an observer").toBe("read");
    }
  });
});
