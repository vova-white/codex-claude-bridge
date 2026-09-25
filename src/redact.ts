import { constants } from "node:os";

/** Shapes that usually carry credentials in error messages and logs. */
const diagnosticPatterns: [RegExp, string][] = [
  // URL user info and query strings often carry credentials.
  // Greedy: user info ends at the last "@" before the path, as URL parsers read it.
  [/\b([a-z][\w+.-]*:\/\/)[^\s/?#"]*@/gi, "$1[REDACTED]@"],
  [/\b([a-z][\w+.-]*:\/\/[^\s?#"]*)\?[^\s#"]*/gi, "$1?[REDACTED]"],
  [/sk-ant-[\w-]+/g, "sk-ant-[REDACTED]"],
  [/\b(Bearer|Basic)\s+[^\s"',]+/gi, "$1 [REDACTED]"],
  [/\b(gh[pousr]_|github_pat_)\w+/g, "$1[REDACTED]"],
  [
    /\b(api[_-]?key|auth[_-]?token|access[_-]?token|secret|password)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
    "$1$2[REDACTED]",
  ],
];

/**
 * Removes known secret values and common credential shapes from diagnostic text.
 * Values shorter than four characters are too common to replace everywhere;
 * inside URLs the patterns still mask them.
 */
export function redact(text: string, secrets: readonly string[] = []): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length >= 4) result = result.split(secret).join("[REDACTED]");
  }
  for (const [pattern, replacement] of diagnosticPatterns) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const errorNames = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "AbortError",
  "TimeoutError",
  "SqliteError",
]);
const errnoCodes = new Set(Object.keys(constants.errno));

/**
 * An error's type and code, for the service log, drawn only from values Node
 * defines: an error's own fields can carry text from Claude Code, the SDK, or
 * an MCP server.
 */
export function errorOrigin(error: unknown): string {
  if (!(error instanceof Error)) return `non-error value (${typeof error})`;
  const name = errorNames.has(error.name) ? error.name : "Error";
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && errnoCodes.has(code) ? `${name} (${code})` : name;
}
