import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" });
const files = git("diff", "--cached", "--name-only", "--no-renames", "-z")
  .split("\0")
  .filter(Boolean);
if (files.length > 0) {
  const snapshot = mkdtempSync(join(tmpdir(), "bridge-index-"));
  try {
    git("checkout-index", "--all", `--prefix=${snapshot}${sep}`);
    symlinkSync(resolve("node_modules"), join(snapshot, "node_modules"), "junction");
    const env = { ...process.env };
    for (const variable of git("rev-parse", "--local-env-vars").trim().split("\n")) {
      delete env[variable];
    }
    const result = spawnSync(
      process.execPath,
      [join(snapshot, "scripts/quality.ts"), "--staged", ...files],
      {
        cwd: snapshot,
        env,
        stdio: "inherit",
      },
    );
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}
