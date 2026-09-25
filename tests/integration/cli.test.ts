import { spawnSync } from "node:child_process";
import { expect, it } from "vite-plus/test";
import metadata from "../../package.json" with { type: "json" };

it("runs the TypeScript entry point on Node and reports the package version", () => {
  const result = spawnSync(process.execPath, ["src/cli.ts", "--version"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe(metadata.version);
  expect(result.stderr).toBe("");
});
