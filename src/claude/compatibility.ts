/** Pinned Claude Agent SDK release; keep in sync with package.json. */
export const agentSdkVersion = "0.3.282";
/** Claude Code release bundled with, and verified against, the pinned SDK. */
export const supportedClaudeCodeVersion = "2.1.282";

function parse(version: string): number[] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? match.slice(1, 4).map(Number) : undefined;
}

/**
 * The SDK drives the Claude Code executable over a versioned control protocol.
 * Newer releases of the same major version keep that protocol; older releases
 * may lack control requests the SDK sends.
 */
export function isCompatibleClaudeCode(version: string): boolean {
  const installed = parse(version);
  const supported = parse(supportedClaudeCodeVersion);
  if (!installed || !supported || installed[0] !== supported[0]) return false;
  for (let index = 1; index < 3; index++) {
    if (installed[index]! !== supported[index]!) return installed[index]! > supported[index]!;
  }
  return true;
}
