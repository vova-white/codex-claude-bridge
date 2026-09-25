import { join } from "node:path";
import { run, withBuild } from "./tasks.ts";

withBuild((directory) => {
  run(process.execPath, [join(directory, "cli.mjs"), "--version"]);
});
