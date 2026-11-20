#!/usr/bin/env node
import { main as benchmark } from "./bench.js";
import { main as live } from "./live.js";
import { main as server, VERSION } from "./server.js";

/** The package's one command: the MCP server by default, or a subcommand. */
const USAGE = `observability-replay ${VERSION}

Usage:
  observability-replay                       run the MCP server over stdio (for an MCP client)
  observability-replay live [--minutes N] [--refresh S] [--port P]
                                             serve the pages on this machine and keep them fresh
  observability-replay benchmark observe [--minutes N]
  observability-replay benchmark test --plan <file>
  observability-replay benchmark report <result.json> [--compare <file>]

The backend comes from the environment: OBS_BACKEND=demo (default) or
OBS_BACKEND=prometheus with OBS_PROM_URL. See the README for every variable.`;

const command = process.argv[2];
try {
  if (command === undefined || command === "server") {
    await server();
  } else if (command === "live" || command === "benchmark") {
    // The subcommands read their own arguments from the same place a direct run would.
    process.argv.splice(2, 1);
    await (command === "live" ? live() : benchmark());
  } else if (command === "--version" || command === "-v") {
    console.log(VERSION);
  } else if (command === "--help" || command === "-h" || command === "help") {
    console.log(USAGE);
  } else {
    console.error(`unknown command: ${command}\n\n${USAGE}`);
    process.exit(2);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
