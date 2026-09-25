import { describe, expect, it } from "vite-plus/test";
import { configSecrets, type BridgeConfig } from "../../src/config.ts";
import { errorOrigin, redact, redactContent } from "../../src/redact.ts";

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

  it("masks all of the user info when it contains a literal @", () => {
    const message = redactFor(
      "https://a@b:pw-secret@tracker.invalid/mcp",
      "failed: https://a@b:pw-secret@tracker.invalid/mcp",
    );
    expect(message).toBe("failed: https://[REDACTED]@tracker.invalid/mcp");
  });

  it("keeps credentials out of diagnostics that quote them without the URL", () => {
    const message = redactFor(
      "https://bad%XX:pw-secret@tracker.invalid/mcp?token=token-secret",
      "SDK error: pw-secret token-secret",
    );
    expect(message).not.toMatch(/pw-secret|token-secret/);
  });
});

describe("task result redaction", () => {
  const secrets = configSecrets({
    mcpServers: {
      tracker: { type: "http", url: "https://tracker.invalid/mcp?token=a%2fb%20c-key" },
    },
  });

  it("masks configured query credentials in any encoding and keeps the rest of the link", () => {
    expect(
      redactContent("See https://tracker.invalid/mcp?token=a%2Fb+c-key&page=2#top.", secrets),
    ).toBe("See https://tracker.invalid/mcp?token=[REDACTED]&page=2#top.");
  });

  it("keeps ordinary links and prose readable", () => {
    const text = "Docs: https://docs.invalid/search?q=password%3A+required and ssh://git@host/repo";
    expect(redactContent(text, secrets)).toBe(text);
  });

  it("masks user info that carries a password", () => {
    expect(redactContent("Clone https://me:pw-123@host.invalid/repo", secrets)).toBe(
      "Clone https://[REDACTED]@host.invalid/repo",
    );
  });
});

describe("service log error origin", () => {
  it("records the error type and code without message or stack text", () => {
    const error = Object.assign(
      new Error("SDK failure red+blue\n    at MCP-ERROR-MARKER (x:1:1)"),
      {
        code: "ECONNRESET",
      },
    );
    expect(errorOrigin(error)).toBe("Error (ECONNRESET)");
  });

  it("ignores error names and codes Node does not define", () => {
    const error = Object.assign(new Error("x"), { name: "SDKSECRET", code: "TOKENVALUE" });
    expect(errorOrigin(error)).toBe("Error");
  });
});
