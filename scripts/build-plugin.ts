import { resolve } from "node:path";
import { vp } from "./tasks.ts";

// Codex copies the plugin directory into its cache, so the bundle lives inside it.
vp(["pack"], { ...process.env, BRIDGE_BUILD_DIR: resolve("plugins/claude-bridge/dist") });
