import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { run, script, vp } from "./tasks.ts";

const scoped = process.argv[2] === "--staged";
const changed = process.argv.slice(3);
const docsOnly = scoped && changed.length > 0 && changed.every((file) => file.endsWith(".md"));
const existing = changed.filter((file) => existsSync(file));
const formatFiles = existing.filter((file) =>
  /\.(?:[cm]?[jt]sx?|jsonc?|md|ya?ml|css|html)$/.test(file),
);
const lintFiles = existing.filter((file) => /\.[cm]?[jt]sx?$/.test(file));

if (!scoped) vp(["fmt", "--check"]);
else if (formatFiles.length) vp(["fmt", "--check", ...formatFiles]);
if (!docsOnly) {
  if (!scoped) vp(["lint", "--deny-warnings"]);
  else if (lintFiles.length) vp(["lint", "--deny-warnings", ...lintFiles]);
  run(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "--noEmit"]);
  if (!scoped) {
    script("build-check");
    vp(["test", "run"]);
    script("e2e");
  } else {
    const units = existing.filter(
      (file) => file.startsWith("tests/unit/") && file.endsWith(".test.ts"),
    );
    if (units.length) vp(["test", "run", ...units]);
    const sources = existing.filter((file) => file.startsWith("src/"));
    if (sources.length)
      vp([
        "test",
        "related",
        "--run",
        "--exclude",
        "tests/integration/**",
        "--passWithNoTests",
        ...sources,
      ]);
  }
}
console.log(docsOnly ? "Documentation checks passed." : "Quality checks passed.");
