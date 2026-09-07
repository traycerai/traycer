import type { MarkdownToken } from "@tiptap/core";

/** Atom blocks persist as mermaid/wireframe fences. Shared fence-length bump when the body contains backticks. */

/** Fence of at least three backticks that does not collide with any run inside body (wireframe HTML can contain <code>). */
function pickFence(body: string): string {
  const matches = body.match(/`{3,}/g);
  if (matches === null) return "```";
  const longest = matches.reduce((n, m) => Math.max(n, m.length), 3);
  return "`".repeat(longest + 1);
}

/**
 * No trailing newline: the Markdown extension joins block siblings with \\n\\n.
 */
export function renderFencedBlock(language: string, body: string): string {
  const fence = pickFence(body);
  return `${fence}${language}\n${body}\n${fence}`;
}

/** True when the code token's fence language matches. False lets the manager try CodeBlockLowlight next. */
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
