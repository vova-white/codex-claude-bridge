import { join, resolve } from "node:path";
import { run, withBuild } from "./tasks.ts";

withBuild((directory, env) => {
  run(process.execPath, [resolve("node_modules/@playwright/test/cli.js"), "test"], {
    ...env,
    BRIDGE_TEST_OUTPUT: join(directory, "test-results"),
  });
});
