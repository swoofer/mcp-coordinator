#!/usr/bin/env node
import { Command } from "commander";
import { createServerProgram } from "./server/index.js";
import { createChannelCommand } from "./channel.js";
import { createDashboardCommand } from "./dashboard.js";
import { createInitCommand } from "./init.js";
import { createDoctorCommand } from "./doctor.js";
import { createUninstallCommand } from "./uninstall.js";
import { createServiceTokensCommand } from "./service-tokens.js";
import { createRotateJwtSecretCommand } from "./rotate-jwt-secret.js";
import { createEncryptionCommand } from "./encryption/index.js";
import { getVersion } from "./version.js";

const program = new Command();
program
  .name("mcp-coordinator")
  .description("Embedded MQTT broker + MCP server for multi-agent coordination")
  .version(getVersion());

program.addCommand(createInitCommand());
program.addCommand(createServerProgram());
program.addCommand(createChannelCommand());
program.addCommand(createDashboardCommand());
program.addCommand(createDoctorCommand());
program.addCommand(createUninstallCommand());
program.addCommand(createServiceTokensCommand());
program.addCommand(createRotateJwtSecretCommand());
program.addCommand(createEncryptionCommand());

program.parse();
