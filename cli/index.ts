#!/usr/bin/env node
import { Command } from "commander";
import { createServerProgram } from "./server/index.js";
import { createDashboardCommand } from "./dashboard.js";
import { getVersion } from "./version.js";

const program = new Command();
program
  .name("mcp-coordinator")
  .description("Embedded MQTT broker + MCP server for multi-agent coordination")
  .version(getVersion());

program.addCommand(createServerProgram());
program.addCommand(createDashboardCommand());

program.parse();
