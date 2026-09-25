import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import metadata from "../../package.json" with { type: "json" };
import { BridgeFixture } from "../support/bridge.ts";

test("the plugin copied into a Codex cache reaches the service through its MCP entry point", async () => {
  const build = process.env.BRIDGE_BUILD_DIR;
  if (!build) throw new Error("Run bun run test:e2e to build the CLI first.");
  const fixture = new BridgeFixture();
  try {
    // Codex installs a plugin by copying its directory; the bundle must not need node_modules.
    const plugin = join(fixture.root, "plugin-cache", "claude-bridge");
    cpSync("plugins/claude-bridge", plugin, {
      recursive: true,
      filter: (source) => !source.includes(join("claude-bridge", "dist")),
    });
    mkdirSync(join(plugin, "dist"));
    cpSync(join(build, "cli.mjs"), join(plugin, "dist", "cli.mjs"));

    const manifest = JSON.parse(readFileSync(join(plugin, ".codex-plugin", "plugin.json"), "utf8"));
    expect(manifest.version).toBe(metadata.version);
    expect(existsSync(join(plugin, manifest.skills, "claude-delegation", "SKILL.md"))).toBe(true);
    const { mcpServers } = JSON.parse(readFileSync(join(plugin, manifest.mcpServers), "utf8"));
    const server = mcpServers.claude_bridge;
    expect(server.command).toBe("node");

    fixture.entry = {
      command: process.execPath,
      args: server.args,
      cwd: resolve(plugin, server.cwd),
    };
    const client = await fixture.connect();
    const result = await client.call("readiness");
    expect(result.isError).toBe(false);
    expect(result.data).toMatchObject({
      ready: true,
      operations: [
        "readiness",
        "start_task",
        "list_tasks",
        "task_status",
        "task_result",
        "wait_task",
        "read_output",
      ],
    });
  } finally {
    await fixture.cleanup();
  }
});
