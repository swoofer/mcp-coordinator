import { Command } from "commander";
import { createServerStartCommand } from "./start.js";
import { createServerStopCommand } from "./stop.js";
import { createServerStatusCommand } from "./status.js";

export function createServerProgram(): Command {
  const server = new Command("server").description("Manage the coordination server");
  server.addCommand(createServerStartCommand());
  server.addCommand(createServerStopCommand());
  server.addCommand(createServerStatusCommand());
  return server;
}
