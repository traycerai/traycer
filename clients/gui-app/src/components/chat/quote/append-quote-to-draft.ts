import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  readComposerDraftSnapshot,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";

/** Selection text already extracted from the DOM. */
export interface QuoteTextSnapshot {
  readonly text: string;
  readonly fenceLanguage: string | null;
}

const LINE_BREAK_REGEX = /\r\n?|\n/;

/**
 * Builds the `blockquote` node inserted into the composer for a quoted
 * selection. Plain text becomes one paragraph per line; a selection wholly
 * inside a code block becomes a single `codeBlock` child instead, keeping the
 * raw (untrimmed) lines - the host flattens either shape to plain text inside
 * `<user_quoted_section>`, so fence fidelity here is a client-visual concern.
 */
export function buildQuoteBlockquote(snapshot: QuoteTextSnapshot): JsonContent {
  if (snapshot.fenceLanguage !== null) {
    return {
      type: "blockquote",
      content: [quoteCodeBlockNode(snapshot.text, snapshot.fenceLanguage)],
    };
  }
  return {
    type: "blockquote",
    content: normalizedQuoteLines(snapshot.text).map(quoteParagraphNode),
  };
}

/**
 * Appends `blocks` to a doc's top-level content, dropping a single existing
 * trailing empty paragraph first so repeat quotes don't accumulate blank gaps
 * between them.
 */
export function appendBlocks(
  doc: JsonContent,
  blocks: ReadonlyArray<JsonContent>,
): JsonContent {
  const existing = doc.content ?? [];
  return {
    ...doc,
    content: [...withoutTrailingEmptyParagraph(existing), ...blocks],
  };
}

/**
 * Single reusable action for quoting into a chat tab's draft - a future
 * keybinding or command-palette entry calls this same function. Riding
 * `replaceDraft(taskId, next, null)` intentionally reuses the composer's
 * existing `setContent(..., null)` -> `focus("end")` path, so this adds no
 * focus code of its own.
 */
export function appendQuoteToDraft(
  taskId: string,
  blockquoteNode: JsonContent,
): void {
  const draft = readComposerDraftSnapshot(taskId);
  const next = appendBlocks(draft.content, [
    blockquoteNode,
    { type: "paragraph" },
  ]);
  useComposerDraftStore.getState().replaceDraft(taskId, next, null);
}

/**
 * Appends a quoted selection to a markdown box's `text`, as blockquote lines
 * after a blank line (none when the box is empty) and followed by one, so
 * what is typed next starts its own paragraph. A selection wholly inside a
 * code block keeps its fence, inside the quote.
 */
export function appendQuoteMarkdown(
  text: string,
  snapshot: QuoteTextSnapshot,
): string {
  const lines =
    snapshot.fenceLanguage === null
      ? normalizedQuoteLines(snapshot.text)
      : fencedLines(snapshot.text, snapshot.fenceLanguage);
  const quote = lines
    .map((line) => (line.length === 0 ? ">" : `> ${line}`))
    .join("\n");
  // Blank lines the box already ends with are the gap, not more of it.
  const before = text.replace(/\n+$/, "");
  return `${before.length === 0 ? "" : `${before}\n\n`}${quote}\n\n`;
}

// The code between fences longer than any run of backticks in it, so no
// line of it closes the fence early.
function fencedLines(code: string, language: string): string[] {
  const longestRun = Math.max(
    0,
    ...(code.match(/`+/g) ?? []).map((run) => run.length),
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return [`${fence}${language}`, ...code.split(LINE_BREAK_REGEX), fence];
}

function quoteCodeBlockNode(text: string, language: string): JsonContent {
  // Raw lines: only the line-ending style is normalized (CRLF/CR -> LF), so
  // indentation and trailing whitespace inside the code stay byte-for-byte.
  const code = text.split(LINE_BREAK_REGEX).join("\n");
  return {
    type: "codeBlock",
    attrs: { language },
    content: code.length === 0 ? [] : [{ type: "text", text: code }],
  };
}

// A triple-click's captured `Selection.toString()` carries trailing
// block-boundary blank lines the browser synthesizes at the selection's end
// (one exact-last-paragraph triple-click observed 2 trailing LFs in real
// Chromium). Left alone, each becomes a real empty paragraph inside the
// blockquote - visible blank rows the user never selected. Internal blank
// lines (between two real lines) stay: they're deliberate paragraph spacing.
function normalizedQuoteLines(text: string): string[] {
  const lines = text
    .split(LINE_BREAK_REGEX)
    .map((line) => line.replace(/\s+$/, ""));
  return withoutTrailingEmptyLines(lines);
}

function withoutTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 1 && lines[end - 1].length === 0) end -= 1;
  return lines.slice(0, end);
}

function quoteParagraphNode(line: string): JsonContent {
  return line.length === 0
    ? { type: "paragraph" }
    : { type: "paragraph", content: [{ type: "text", text: line }] };
}

function withoutTrailingEmptyParagraph(
  blocks: ReadonlyArray<JsonContent>,
): JsonContent[] {
  if (blocks.length === 0) return [...blocks];
  const last = blocks[blocks.length - 1];
  if (!isEmptyParagraph(last)) return [...blocks];
  return blocks.slice(0, -1);
}

function isEmptyParagraph(node: JsonContent): boolean {
  return node.type === "paragraph" && (node.content ?? []).length === 0;
}
