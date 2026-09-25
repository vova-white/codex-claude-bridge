import { describe, expect, it } from "vite-plus/test";
import { configSecrets, type BridgeConfig } from "../../src/config.ts";
import { redact } from "../../src/redact.ts";

function redactFor(url: string, message: string): string {
  const config: BridgeConfig = { mcpServers: { tracker: { type: "http", url } } };
  return redact(message, configSecrets(config));
}

describe("MCP URL credential redaction", () => {
  it("keeps query values out of diagnostics whatever their encoding", () => {
    const message = redactFor(
      "https://example.invalid/it's?token=a%2fb%20c",
      "failed: https://example.invalid/it's?token=a%2Fb+c",
    );
    expect(message).not.toMatch(/a%2Fb|b\+c|a\/b/);
  });

  it("keeps user info out of diagnostics when it contains an apostrophe", () => {
    const message = redactFor(
      "https://ab:c'd@example.invalid/mcp?token=abcd",
      "failed: https://ab:c'd@example.invalid/mcp",
    );
    expect(message).not.toContain("c'd");
  });

  it("keeps credentials out of diagnostics that quote them without the URL", () => {
    const message = redactFor(
      "https://bad%XX:pw-secret@tracker.invalid/mcp?token=token-secret",
      "SDK error: pw-secret token-secret",
    );
    expect(message).not.toMatch(/pw-secret|token-secret/);
  });
});
