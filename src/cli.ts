import { parseArguments } from "./arguments.ts";
import { runMcpServer } from "./mcp/server.ts";
import { runService } from "./service/service.ts";
import { statePaths } from "./state.ts";
import metadata from "../package.json" with { type: "json" };

try {
  const command = parseArguments(process.argv.slice(2));
  if (command === "version") {
    console.log(metadata.version);
  } else if (command === "mcp") {
    await runMcpServer(statePaths(), process.argv[1]!);
  } else if (command === "service") {
    await runService(statePaths());
  } else {
    console.log(`codex-claude-bridge

Usage: codex-claude-bridge [--help | --version | mcp | service]

  mcp        Run the stdio MCP entry point that Codex launches
  service    Run the background task service (started automatically by mcp)

State directory: $CODEX_CLAUDE_BRIDGE_HOME, or $XDG_STATE_HOME/codex-claude-bridge.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
