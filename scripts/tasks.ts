import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export function run(command: string, args: string[], env = process.env): void {
  console.log(`Running: ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit", env });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? result.signal})`);
}

export function vp(args: string[], env = process.env): void {
  run(process.execPath, [resolve("node_modules/vite-plus/bin/vp"), ...args], env);
}

export function script(name: string, args: string[] = []): void {
  run(process.execPath, [resolve(`scripts/${name}.ts`), ...args]);
}

export function withBuild(action: (directory: string, env: NodeJS.ProcessEnv) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "bridge-build-"));
  const env = { ...process.env, BRIDGE_BUILD_DIR: directory };
  try {
    vp(["pack"], env);
    run(process.execPath, ["--check", join(directory, "cli.mjs")]);
    action(directory, env);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
