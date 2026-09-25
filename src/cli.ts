import { parseArguments } from "./arguments.ts";
import metadata from "../package.json" with { type: "json" };

try {
  const command = parseArguments(process.argv.slice(2));
  if (command === "version") {
    console.log(metadata.version);
  } else {
    console.log(`codex-claude-bridge

Usage: codex-claude-bridge [--help | --version]

Development scaffold. Delegation is not implemented yet.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
