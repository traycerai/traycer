import type { MarkdownToken } from "@tiptap/core";

/**
 * Shared helpers for serializing / parsing atom-block nodes that persist as
 * standard fenced code blocks in markdown. Mermaid uses ` ```mermaid `,
 * wireframe uses ` ```wireframe `. By routing both through the same helpers
 * we get identical fence fencing logic (triple-backtick length bump if the
 * body itself contains backticks) and a single place to tweak whitespace
 * handling.
 */

/**
 * Returns a fence delimiter of at least three backticks that is guaranteed
 * not to collide with any run of backticks inside `body`. Mermaid diagrams
 * rarely contain backticks, but wireframe HTML does - e.g. `<code>` inside
 * the rendered HTML won't confuse the parser with a 4-backtick fence.
 */
function pickFence(body: string): string {
  const matches = body.match(/`{3,}/g);
  if (matches === null) return "```";
  const longest = matches.reduce((n, m) => Math.max(n, m.length), 3);
  return "`".repeat(longest + 1);
}

/**
 * Formats a fenced code block for markdown output. A trailing newline is
 * NOT included - the Markdown extension joins block siblings with `\n\n`
 * so nodes must not over-emit newlines.
 */
export function renderFencedBlock(language: string, body: string): string {
  const fence = pickFence(body);
  return `${fence}${language}\n${body}\n${fence}`;
}

/**
 * Returns `true` when the incoming `code` token matches the expected fence
 * language. Called from each node's `parseMarkdown` so the manager can try
 * the next registered handler (CodeBlockLowlight) when the language does
 * not match.
 */
export function matchesFenceLanguage(
  token: MarkdownToken,
  language: string,
): boolean {
  if (token.type !== "code") return false;
  const lang =
    typeof (token as { lang?: unknown }).lang === "string"
      ? (token as { lang: string }).lang.trim()
      : "";
  return lang === language;
}
