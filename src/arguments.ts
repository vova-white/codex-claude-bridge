export type Command = "help" | "version";

export function parseArguments(args: readonly string[]): Command {
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
    return "help";
  }
  if (args.length === 1 && args[0] === "--version") {
    return "version";
  }
  throw new Error(`Unsupported arguments: ${args.join(" ")}. Use --help.`);
}
