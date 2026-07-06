import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  readComposerDraftSnapshot,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";

/** Selection text already extracted from the DOM (T4/T5 own that step). */
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

function normalizedQuoteLines(text: string): string[] {
  return text.split(LINE_BREAK_REGEX).map((line) => line.replace(/\s+$/, ""));
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
