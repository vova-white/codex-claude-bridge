import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
  agentSdkVersion,
  isCompatibleClaudeCode,
  supportedClaudeCodeVersion,
} from "../../src/claude/compatibility.ts";

const sdkDirectory = "node_modules/@anthropic-ai/claude-agent-sdk";

describe("Claude Code compatibility", () => {
  it("matches the installed Agent SDK and the Claude Code release it bundles", () => {
    const sdk = JSON.parse(readFileSync(`${sdkDirectory}/package.json`, "utf8"));
    const manifest = JSON.parse(readFileSync(`${sdkDirectory}/manifest.json`, "utf8"));
    expect(agentSdkVersion).toBe(sdk.version);
    expect(supportedClaudeCodeVersion).toBe(manifest.version);
  });

  it("accepts the bundled release and newer releases of the same major version", () => {
    expect(isCompatibleClaudeCode("2.1.282 (Claude Code)")).toBe(true);
    expect(isCompatibleClaudeCode("2.1.300")).toBe(true);
    expect(isCompatibleClaudeCode("2.4.0")).toBe(true);
  });

  it("rejects older releases, other major versions, and unparseable output", () => {
    expect(isCompatibleClaudeCode("2.1.281")).toBe(false);
    expect(isCompatibleClaudeCode("2.0.999")).toBe(false);
    expect(isCompatibleClaudeCode("3.0.0")).toBe(false);
    expect(isCompatibleClaudeCode("unknown")).toBe(false);
  });
});
