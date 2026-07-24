/**
 * Split a raw include/exclude field into ripgrep glob patterns.
 *
 * Patterns are comma-separated, but a comma is NOT a separator when it is:
 *   - inside a brace expression `{a,b}` (ripgrep alternation) — tracked by depth;
 *     an UNBALANCED `{` swallows the rest of the field into one pattern (which rg
 *     then rejects), a defined outcome rather than a silent mis-split; or
 *   - backslash-escaped (`\,`) — a literal comma within a single pattern.
 *
 * Each resulting pattern is trimmed of surrounding whitespace and empty patterns
 * are dropped, so a blank field, whitespace, or stray separators impose no
 * filter. A bare extension such as `.md` is accepted as friendly shorthand for
 * `*.md`. Braces and escapes are otherwise passed through to ripgrep verbatim —
 * rg owns their meaning; this parser only decides the split points.
 */
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
