import { describe, expect, it } from "vite-plus/test";
import { parseArguments } from "../../src/arguments.ts";

describe("CLI arguments", () => {
  it("shows help by default and on explicit request", () => {
    expect(parseArguments([])).toBe("help");
    expect(parseArguments(["--help"])).toBe("help");
  });
  it("selects version output", () => {
    expect(parseArguments(["--version"])).toBe("version");
  });
  it.each([["--unknown"], ["--version", "--help"], ["start"]])(
    "rejects unsupported invocation %s",
    (...args) => {
      expect(() => parseArguments(args)).toThrow("Use --help");
    },
  );
});
