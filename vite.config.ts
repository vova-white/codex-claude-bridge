import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: [
      "bun.lock",
      "dist/**",
      "plugins/claude-bridge/dist/**",
      "test-results/**",
      "playwright-report/**",
      ".vite-hooks/_/**",
    ],
  },
  lint: {
    ignorePatterns: [
      "dist/**",
      "plugins/claude-bridge/dist/**",
      "test-results/**",
      "playwright-report/**",
    ],
    categories: { correctness: "error", suspicious: "warn" },
    rules: { "no-debugger": "error" },
  },
  pack: {
    entry: ["src/cli.ts"],
    platform: "node",
    target: "node24",
    format: ["esm"],
    outDir: process.env.BRIDGE_BUILD_DIR ?? "dist",
    dts: false,
    sourcemap: true,
    clean: true,
    // The plugin runs from Codex's plugin cache without node_modules.
    deps: { alwaysBundle: [/.*/], onlyBundle: false },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    passWithNoTests: false,
    allowOnly: false,
    testTimeout: 10_000,
  },
});
