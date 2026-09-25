import { constants } from "node:os";

/** Shapes that are credentials wherever they appear. */
const credentialPatterns: [RegExp, string][] = [
  [/sk-ant-[\w-]+/g, "sk-ant-[REDACTED]"],
  [/\b(Bearer|Basic)\s+[^\s"',]+/gi, "$1 [REDACTED]"],
  [/\b(gh[pousr]_|github_pat_)\w+/g, "$1[REDACTED]"],
];

/** Shapes that usually carry credentials in error messages and logs. */
const diagnosticPatterns: [RegExp, string][] = [
  // URL user info and query strings often carry credentials.
  // Greedy: user info ends at the last "@" before the path, as URL parsers read it.
  [/\b([a-z][\w+.-]*:\/\/)[^\s/?#"]*@/gi, "$1[REDACTED]@"],
  [/\b([a-z][\w+.-]*:\/\/[^\s?#"]*)\?[^\s#"]*/gi, "$1?[REDACTED]"],
  ...credentialPatterns,
  [
    /\b(api[_-]?key|auth[_-]?token|access[_-]?token|secret|password)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
    "$1$2[REDACTED]",
  ],
];

function replace(text: string, secrets: readonly string[], patterns: [RegExp, string][]) {
  let result = text;
  for (const secret of secrets) {
    if (secret.length >= 4) result = result.split(secret).join("[REDACTED]");
  }
  for (const [pattern, replacement] of patterns) result = result.replace(pattern, replacement);
  return result;
}

/**
 * Removes known secret values and common credential shapes from diagnostic text.
 * Values shorter than four characters are too common to replace everywhere;
 * inside URLs the patterns still mask them.
 */
export function redact(text: string, secrets: readonly string[] = []): string {
  return replace(text, secrets, diagnosticPatterns);
}

export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Decodes a URL query component the way form parsers do. */
function queryDecode(value: string): string {
  return safeDecode(value.replaceAll("+", " "));
}

/**
 * Masks the credential parts of one URL: user info with a password or a known
 * secret, and query values equal to a known secret in any encoding. Other
 * parameters and the rest of the link stay readable.
 */
function maskUrlCredentials(url: string, secrets: Set<string>): string {
  const masked = url.replace(
    /^([a-z][\w+.-]*:\/\/)([^/?#]*)@/i,
    (whole, scheme: string, info: string) =>
      info.includes(":") || secrets.has(queryDecode(info)) ? `${scheme}[REDACTED]@` : whole,
  );
  const question = masked.indexOf("?");
  if (question < 0) return masked;
  const fragment = masked.indexOf("#", question);
  const end = fragment < 0 ? masked.length : fragment;
  const query = masked
    .slice(question + 1, end)
    .split("&")
    .map((pair) => {
      const equals = pair.indexOf("=");
      if (equals < 0 || !secrets.has(queryDecode(pair.slice(equals + 1)))) return pair;
      return `${pair.slice(0, equals + 1)}[REDACTED]`;
    })
    .join("&");
  return `${masked.slice(0, question + 1)}${query}${masked.slice(end)}`;
}

/**
 * Removes known secret values and credential tokens from content meant for the
 * parent agent, such as task results, while keeping URLs and prose readable.
 */
export function redactContent(text: string, secrets: readonly string[] = []): string {
  const decoded = new Set(secrets.filter((secret) => secret.length >= 4).map(queryDecode));
  const withUrls = text.replace(/\b[a-z][\w+.-]*:\/\/[^\s"'<>]+/gi, (url) =>
    maskUrlCredentials(url, decoded),
  );
  return replace(withUrls, secrets, credentialPatterns);
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
