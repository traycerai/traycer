import { Extension, type MarkdownToken } from "@tiptap/core";

const LONE_BREAK_HTML = /^<br\s*\/?>$/i;

/**
 * Reads a line that holds only `<br>` (an HTML block) as that literal text,
 * the way the host's converter stores it.
 *
 * Read as HTML it became a paragraph holding one hard break, which artifact
 * Markdown cannot write back: the line vanished from the export, and a quote
 * holding it was lost by the second pass. An inline `<br>` is parsed before
 * any handler sees it and stays a hard break; any other HTML block returns
 * nothing here and takes the default path.
 */
export const BlockBreakAsText = Extension.create({
  name: "blockBreakAsText",

  markdownTokenName: "html",

  parseMarkdown: (token: MarkdownToken) => {
    const html = (token.text ?? token.raw ?? "").trim();
    if (token.block !== true || !LONE_BREAK_HTML.test(html)) return [];
    return { type: "paragraph", content: [{ type: "text", text: html }] };
  },
});
