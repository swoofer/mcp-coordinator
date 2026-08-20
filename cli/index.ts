#!/usr/bin/env node
import { Command } from "commander";
import { getVersion } from "./version.js";
import { explainDependencyFailure } from "./dependency-error.js";
import { SUBCOMMANDS, subcommandsFor } from "./subcommands.js";

const program = new Command();
program
  .name("mcp-coordinator")
  .description("Embedded MQTT broker + MCP server for multi-agent coordination")
  .version(getVersion());

// issue #282: when node_modules loses a link, this is where it surfaces — as a
// raw cjs/loader stack naming a transitive package nobody declared. The
// registration below is the usual point of failure, not the dispatch:
// `channel.ts` pulls mqtt, and mqtt -> worker-timers -> worker-timers-broker
// -> broker-factory -> @babel/runtime is the chain that goes missing. So the
// guard has to cover the imports, not just parseAsync.
//
// issue #278: and now it imports only what this invocation needs. `doctor` had
// a hand-written fast path here for the same reason — diagnosing a broken
// dependency tree is its job, so it cannot be taken out by loading
// everyone else's dependencies first. That special case is gone: every
// subcommand gets the property it had.
try {
  const wanted = subcommandsFor(process.argv);
  const commands = await Promise.all(wanted.map((name) => SUBCOMMANDS[name]()));
  for (const command of commands) program.addCommand(command);

  await program.parseAsync();
} catch (err) {
  const explanation = explainDependencyFailure(err);
  // Not a dependency failure: rethrow untouched rather than dress an
  // unrelated crash up as one, which would send the operator to the wrong fix.
  if (explanation === null) throw err;
  console.error(explanation);
  process.exit(1);
}
