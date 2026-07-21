import { Command } from "commander";
import { createServerStartCommand } from "./start.js";
import { createServerStopCommand } from "./stop.js";
import { createServerRestartCommand } from "./restart.js";
import { createServerStatusCommand } from "./status.js";
import { createServerLogsCommand } from "./logs.js";
import { createServerBackupCommand } from "./backup.js";
import { createServerRestoreCommand } from "./restore.js";

export function createServerProgram(): Command {
  const server = new Command("server").description("Manage the coordination server");
  server.addCommand(createServerStartCommand());
  server.addCommand(createServerStopCommand());
  server.addCommand(createServerRestartCommand());
  server.addCommand(createServerStatusCommand());
  server.addCommand(createServerLogsCommand());
  // v0.4 Operability
  server.addCommand(createServerBackupCommand());
  server.addCommand(createServerRestoreCommand());
  return server;
}
