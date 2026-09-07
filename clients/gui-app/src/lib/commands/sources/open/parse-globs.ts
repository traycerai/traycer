/** Split a raw include/exclude field into ripgrep glob patterns. */
export function parseGlobs(text: string): string[] {
  const patterns: string[] = [];
  let current = "";
  let braceDepth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      // Keep the backslash AND the next char literally, so `\,` never splits and
      // reaches rg as an escaped literal comma. A trailing backslash is kept.
      current += char;
      if (index + 1 < text.length) {
        current += text[index + 1];
        index += 1;
      }
      continue;
    }
    if (char === "{") {
      braceDepth += 1;
      current += char;
      continue;
    }
    if (char === "}") {
      if (braceDepth > 0) braceDepth -= 1;
      current += char;
      continue;
    }
    if (char === "," && braceDepth === 0) {
      pushTrimmed(patterns, current);
      current = "";
      continue;
    }
    current += char;
  }
  pushTrimmed(patterns, current);
  return patterns;
}

function pushTrimmed(out: string[], raw: string): void {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return;
  const extensionShorthand = /^\.[a-z0-9][a-z0-9._+-]*$/i.test(trimmed);
  out.push(extensionShorthand ? `*${trimmed}` : trimmed);
}
