#!/usr/bin/env node
import { Command } from "commander";
import { getVersion } from "./version.js";
import { explainDependencyFailure } from "./dependency-error.js";

const program = new Command();
program
  .name("mcp-coordinator")
  .description("Embedded MQTT broker + MCP server for multi-agent coordination")
  .version(getVersion());

// issue #282: `doctor` has to stay usable when the dependency tree is broken —
// diagnosing exactly that is its job. Registering every subcommand imports them
// all eagerly, and `channel.ts` pulls `mqtt`, which is the chain that goes
// missing (mqtt -> worker-timers -> worker-timers-broker -> broker-factory ->
// @babel/runtime). Without this fast path, doctor dies on the same raw
// cjs/loader stack trace it exists to explain — verified by reproducing the
// incident.
//
// Scoped deliberately to `doctor`. Making every subcommand lazy is issue #278
// (the CLI pays ~700 ms of server graph on every invocation); this is not that
// change, and does not pretend to be.
// issue #282: when node_modules loses a link, this is where it surfaces — as a
// raw cjs/loader stack naming a transitive package nobody declared. The
// registration block below is the usual point of failure, not the dispatch:
// `channel.ts` pulls mqtt, and mqtt -> worker-timers -> worker-timers-broker
// -> broker-factory -> @babel/runtime is the chain that goes missing. So the
// guard has to cover the imports, not just parseAsync.
try {
  if (process.argv[2] === "doctor") {
    const { createDoctorCommand } = await import("./doctor.js");
    program.addCommand(createDoctorCommand());
  } else {
    const [
      { createInitCommand },
      { createServerProgram },
      { createChannelCommand },
      { createDashboardCommand },
      { createDoctorCommand },
      { createUninstallCommand },
      { createServiceTokensCommand },
      { createRotateJwtSecretCommand },
      { createEncryptionCommand },
    ] = await Promise.all([
      import("./init.js"),
      import("./server/index.js"),
      import("./channel.js"),
      import("./dashboard.js"),
      import("./doctor.js"),
      import("./uninstall.js"),
      import("./service-tokens.js"),
      import("./rotate-jwt-secret.js"),
      import("./encryption/index.js"),
    ]);

    program.addCommand(createInitCommand());
    program.addCommand(createServerProgram());
    program.addCommand(createChannelCommand());
    program.addCommand(createDashboardCommand());
    program.addCommand(createDoctorCommand());
    program.addCommand(createUninstallCommand());
    program.addCommand(createServiceTokensCommand());
    program.addCommand(createRotateJwtSecretCommand());
    program.addCommand(createEncryptionCommand());
  }

  await program.parseAsync();
} catch (err) {
  const explanation = explainDependencyFailure(err);
  // Not a dependency failure: rethrow untouched rather than dress an
  // unrelated crash up as one, which would send the operator to the wrong fix.
  if (explanation === null) throw err;
  console.error(explanation);
  process.exit(1);
}
