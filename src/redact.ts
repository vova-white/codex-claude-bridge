const patterns: [RegExp, string][] = [
  [/sk-ant-[\w-]+/g, "sk-ant-[REDACTED]"],
  [/\b(Bearer|Basic)\s+[^\s"',]+/gi, "$1 [REDACTED]"],
  [/\b(gh[pousr]_|github_pat_)\w+/g, "$1[REDACTED]"],
  [
    /\b(api[_-]?key|auth[_-]?token|access[_-]?token|secret|password)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
    "$1$2[REDACTED]",
  ],
];

/** Removes known secret values and common credential shapes from diagnostic text. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length >= 4) result = result.split(secret).join("[REDACTED]");
  }
  for (const [pattern, replacement] of patterns) result = result.replace(pattern, replacement);
  return result;
}
