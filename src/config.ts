import { readFileSync } from "node:fs";
import { z } from "zod";

const mcpServer = z.looseObject({
  type: z.enum(["stdio", "http", "sse"]).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

const configSchema = z.strictObject({
  claudeExecutable: z.string().min(1).optional(),
  claudeConfigDir: z.string().min(1).optional(),
  mcpServers: z.record(z.string(), mcpServer).default({}),
});

/** User-editable settings stored as config.json in the state directory. */
export type BridgeConfig = z.infer<typeof configSchema>;
export type McpServerConfig = z.infer<typeof mcpServer>;

export class ConfigError extends Error {}

/** Reads the configuration on each use so that edits apply without restarting the service. */
export function loadConfig(path: string): BridgeConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return configSchema.parse({});
    throw new ConfigError(`Cannot read ${path}: ${(error as Error).message}`);
  }
  let parsed: z.ZodSafeParseResult<BridgeConfig>;
  try {
    parsed = configSchema.safeParse(JSON.parse(text));
  } catch (error) {
    throw new ConfigError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  if (!parsed.success) {
    throw new ConfigError(`${path} is invalid: ${z.prettifyError(parsed.error)}`);
  }
  for (const [name, server] of Object.entries(parsed.data.mcpServers)) {
    if (!server.command && !server.url) {
      throw new ConfigError(`${path}: MCP server "${name}" needs a command or a url.`);
    }
  }
  return parsed.data;
}

/** Values that must never appear in results or diagnostics. */
export function configSecrets(config: BridgeConfig): string[] {
  return Object.values(config.mcpServers).flatMap((server) => [
    ...Object.values(server.env ?? {}),
    ...Object.values(server.headers ?? {}),
  ]);
}
