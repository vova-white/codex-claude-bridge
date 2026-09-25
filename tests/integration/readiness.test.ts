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
    expect(report.operations).toEqual([
      "readiness",
      "start_task",
      "list_tasks",
      "task_status",
      "task_result",
      "wait_task",
      "read_output",
      "send_followup",
      "cancel_task",
      "respond_to_request",
      "cleanup_task",
    ]);
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

  it("reports only known account values from Claude Code", async () => {
    const report = await readiness(
      bridge({
        scenario: {
          account: {
            apiKeySource: "helper red+blue",
            apiProvider: "vendor SECRET-X",
            subscriptionType: "Claude SECRETPLAN",
          },
          models: [
            { value: "sonnet", displayName: "Sonnet DISPLAY-SECRET", description: "DESC-SECRET" },
            { value: "bad value MODEL-SECRET", displayName: "x", description: "y" },
          ],
        },
      }),
    );

    expect(report.credentials).toMatchObject({
      source: "third-party-provider",
      apiProvider: "other",
      apiKeySource: "other",
      subscriptionType: "other",
    });
    expect(report.models).toEqual([{ value: "sonnet" }]);
    expect(JSON.stringify(report)).not.toMatch(/red\+blue|SECRET/);
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

  it("records a start-up failure without any of Claude Code's error output", async () => {
    const url = "https://user:url-password-1@tracker.invalid/mcp?sig=red%20blue";
    const fixture = bridge({
      config: {
        mcpServers: {
          tracker: { type: "http", url },
          github: { command: "github-mcp", env: { GITHUB_TOKEN: "ghp_TOPSECRETVALUE" } },
        },
      },
      scenario: {
        startupError: `STDERR-MARKER cannot reach ${url} (sig red+blue) with ghp_TOPSECRETVALUE`,
      },
    });
    const report = await readiness(fixture);

    const problem = report.problems.find((item: { code: string }) => item.code === "claude_start");
    expect(problem.message).toContain("exited with code 1");
    expect(problem.action).toContain("claude");
    expect(fixture.serviceLog()).toContain(
      "could not start a session (Claude Code exited with code 1)",
    );
    for (const text of ["STDERR-MARKER", "url-password-1", "red+blue", "red%20blue", "TOPSECRET"]) {
      expect(JSON.stringify(report)).not.toContain(text);
      expect(fixture.serviceLog()).not.toContain(text);
    }
  });

  it("reports MCP integrations from known fields only, never their error text", async () => {
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
            url: "https://user:url-password-1@tracker.invalid/mcp?token=red%20blue&key=a%2fkey%2fvalue",
            headers: { Authorization: "Bearer hdr-secret-123" },
          },
        },
      },
      scenario: {
        mcpStatus: {
          tracker: {
            status: "failed",
            error:
              "MCP-ERROR-MARKER 401 for Bearer hdr-secret-123 at https://user:url-password-1@tracker.invalid/mcp?token=RED%20BLUE&key=a%2Fkey%2Fvalue; token red+blue, key a/key/value",
          },
        },
        settingsMcpServers: [
          { name: "docs SETTINGS-NAME-SECRET", status: "connected", scope: "user" },
        ],
      },
    });
    const report = await readiness(fixture);

    expect(report.integrations.configured).toEqual([
      { name: "github", status: "connected" },
      { name: "tracker", status: "failed" },
    ]);
    expect(report.integrations.fromClaudeSettings).toEqual({ connected: 1 });
    expect(report.integrations.codexTools).toMatchObject({ inherited: false });
    const problem = report.problems.find(
      (item: { code: string }) => item.code === "integration_unavailable",
    );
    expect(problem).toMatchObject({ blocking: false, message: 'MCP server "tracker" is failed.' });
    expect(problem.action).toContain("/mcp");
    for (const text of [
      "SETTINGS-NAME-SECRET",
      "MCP-ERROR-MARKER",
      "ghp_TOPSECRETVALUE",
      "hdr-secret-123",
      "url-password-1",
      "red+blue",
      "RED%20BLUE",
      "red%20blue",
      "a/key/value",
      "a%2Fkey",
    ]) {
      expect(JSON.stringify(report)).not.toContain(text);
      expect(fixture.serviceLog()).not.toContain(text);
    }
  });
});
