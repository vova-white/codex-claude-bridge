import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  workers: 2,
  timeout: 10_000,
  reporter: "list",
  outputDir: process.env.BRIDGE_TEST_OUTPUT ?? "test-results",
});
