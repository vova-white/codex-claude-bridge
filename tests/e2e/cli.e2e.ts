import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import metadata from "../../package.json" with { type: "json" };

function invoke(...args: string[]) {
  const directory = process.env.BRIDGE_BUILD_DIR;
  if (!directory) throw new Error("Run bun run test:e2e to build the CLI first.");
  const result = spawnSync(process.execPath, [join(directory, "cli.mjs"), ...args], {
    encoding: "utf8",
    timeout: 5_000,
    cwd: directory,
  });
  expect(result.error).toBeUndefined();
  return result;
}

test("the bundle runs outside the source checkout", () => {
  const result = invoke("--version");
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe(metadata.version);
  expect(result.stderr).toBe("");
});

test("help explains the available commands", () => {
  const result = invoke("--help");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("--version");
  expect(result.stdout).toContain("mcp");
  expect(result.stderr).toBe("");
});

test("unsupported commands fail with actionable stderr", () => {
  const result = invoke("start");
  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Unsupported arguments: start. Use --help.");
});
