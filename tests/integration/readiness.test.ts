import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { BridgeFixture, type BridgeOptions } from "../support/bridge.ts";

const fixtures: BridgeFixture[] = [];

function bridge(options?: BridgeOptions): BridgeFixture {
  const fixture = new BridgeFixture(options);
  fixtures.push(fixture);
  return fixture;
}

async function readiness(fixture: BridgeFixture, args: Record<string, unknown> = {}) {
  const client = await fixture.connect();
  const result = await client.call("readiness", args);
  expect(result.isError).toBe(false);
  return result.data;
}

function problemCodes(report: { problems: { code: string }[] }): string[] {
  return report.problems.map((problem) => problem.code);
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

describe("readiness", () => {
  it("verifies subscription login, models, and Claude Code compatibility without a prompt", async () => {
    const fixture = bridge({
      scenario: {
        models: [
          {
            value: "sonnet",
            displayName: "Sonnet",
            description: "Everyday model",
            supportedEffortLevels: ["low", "high"],
          },
        ],
      },
    });
    const report = await readiness(fixture, { project: process.cwd() });

    expect(report.ready).toBe(true);
    expect(report.problems).toEqual([]);
    expect(report.claude).toMatchObject({ version: "2.1.282", compatible: true });
    expect(report.credentials).toMatchObject({
      source: "subscription",
      verified: true,
      subscriptionType: "Claude Max",
    });
    expect(report.models).toEqual([
      expect.objectContaining({ value: "sonnet", supportedEffortLevels: ["low", "high"] }),
    ]);
    expect(report.operations).toEqual(["readiness"]);
    expect(report.git.project.root).toBe(process.cwd());
    expect(existsSync(fixture.promptLog)).toBe(false);
  });

  it.each([
    {
      name: "an inherited API key",
      account: {
        tokenSource: "claude.ai",
        apiKeySource: "ANTHROPIC_API_KEY",
        apiProvider: "firstParty",
      },
      source: "api-key",
      action: "ANTHROPIC_API_KEY",
    },
    {
      name: "a third-party provider",
      account: { apiProvider: "bedrock" },
      source: "third-party-provider",
      action: "subscription",
    },
    {
      name: "a missing login",
      account: { tokenSource: "none", apiProvider: "firstParty" },
      source: "not-authenticated",
      action: "/login",
    },
  ])("does not pass $name as subscription authentication", async ({ account, source, action }) => {
    const report = await readiness(bridge({ scenario: { account } }));

    expect(report.ready).toBe(false);
    expect(report.credentials).toMatchObject({ source, verified: false });
    const problem = report.problems.find((item: { code: string }) => item.code === "credentials");
    expect(problem.action).toContain(action);
  });

  it("reports Claude Code versions older than the SDK supports", async () => {
    const report = await readiness(bridge({ scenario: { version: "2.0.9" } }));

    expect(report.ready).toBe(false);
    expect(report.claude).toMatchObject({ version: "2.0.9", compatible: false });
    expect(problemCodes(report)).toContain("claude_version");
  });

  it("reports a missing Claude Code executable with the configuration to change", async () => {
    const fixture = bridge({ config: { claudeExecutable: "/nonexistent/claude" } });
    const report = await readiness(fixture);

    expect(report.ready).toBe(false);
    const problem = report.problems.find(
      (item: { code: string }) => item.code === "claude_missing",
    );
    expect(problem.action).toContain(join(fixture.stateDir, "config.json"));
  });

  it("reports Claude Code start-up failures without exposing credentials", async () => {
    const fixture = bridge({
      scenario: { startupError: "Invalid token sk-ant-oat01-SECRETSECRET for this organization" },
    });
    const report = await readiness(fixture);

    expect(report.ready).toBe(false);
    expect(problemCodes(report)).toContain("claude_start");
    expect(JSON.stringify(report)).not.toContain("SECRETSECRET");
    expect(fixture.serviceLog()).not.toContain("SECRETSECRET");
  });

  it("reports missing Git and non-repository projects", async () => {
    const withoutGit = bridge();
    const bin = join(withoutGit.root, "bin");
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, "node"));
    withoutGit.env.PATH = bin;
    expect(problemCodes(await readiness(withoutGit))).toContain("git_missing");

    const report = await readiness(bridge(), { project: bin });
    expect(problemCodes(report)).toContain("project_not_git");
  });

  it("rejects an unreadable configuration without quoting its content", async () => {
    const fixture = bridge();
    writeFileSync(
      join(fixture.stateDir, "config.json"),
      '{"mcpServers": {"github": {"command": "x", "env": {"TOKEN": "ghp_LEAKEDVALUE" oops}}}}',
    );
    const result = await (await fixture.connect()).call("readiness");

    expect(result.isError).toBe(true);
    expect(result.text).toContain("config.json is not valid JSON");
    expect(result.text).not.toContain("LEAKEDVALUE");
    expect(fixture.serviceLog()).not.toContain("LEAKEDVALUE");
  });

  it("keeps MCP URL credentials out of the service log when Claude Code fails to start", async () => {
    const url = "https://user:url-password-1@tracker.invalid/mcp?sig=my+private+sig";
    const fixture = bridge({
      config: { mcpServers: { tracker: { type: "http", url } } },
      scenario: { startupError: `cannot reach ${url.replace("+", "%20").replace("+", "%20")}` },
    });
    const report = await readiness(fixture);

    expect(problemCodes(report)).toContain("claude_start");
    expect(fixture.serviceLog()).toContain("tracker.invalid");
    for (const secret of ["url-password-1", "private", "sig%20"]) {
      expect(JSON.stringify(report)).not.toContain(secret);
      expect(fixture.serviceLog()).not.toContain(secret);
    }
  });

  it("distinguishes configured MCP integrations from Codex tools and redacts their secrets", async () => {
    const fixture = bridge({
      config: {
        mcpServers: {
          github: {
            type: "stdio",
            command: "github-mcp",
            env: { GITHUB_TOKEN: "ghp_TOPSECRETVALUE" },
          },
          tracker: {
            type: "http",
            url: "https://user:url-password-1@tracker.invalid/mcp?token=url-token-456&sig=my+private+sig&key=a%2fkey%2fvalue",
            headers: { Authorization: "Bearer hdr-secret-123" },
          },
        },
      },
      scenario: {
        mcpStatus: {
          tracker: {
            status: "failed",
            error:
              "401 for Bearer hdr-secret-123 at https://user:url-password-1@tracker.invalid/mcp?token=url-token-456&sig=my+private+sig&key=a%2fkey%2fvalue",
          },
        },
        settingsMcpServers: [{ name: "docs", status: "connected", scope: "user" }],
      },
    });
    const report = await readiness(fixture);

    expect(report.integrations.configured).toEqual([
      { name: "github", status: "connected" },
      expect.objectContaining({ name: "tracker", status: "failed" }),
    ]);
    expect(report.integrations.fromClaudeSettings).toEqual([
      { name: "docs", status: "connected", scope: "user" },
    ]);
    expect(report.integrations.codexTools).toMatchObject({ inherited: false });
    expect(problemCodes(report)).toContain("integration_unavailable");
    for (const secret of [
      "ghp_TOPSECRETVALUE",
      "hdr-secret-123",
      "url-password-1",
      "url-token-456",
      "private+sig",
      "private sig",
      "key%2fvalue",
      "key/value",
    ]) {
      expect(JSON.stringify(report)).not.toContain(secret);
      expect(fixture.serviceLog()).not.toContain(secret);
    }
  });
});
