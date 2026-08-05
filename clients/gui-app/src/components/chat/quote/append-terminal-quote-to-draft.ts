import type { JsonContent } from "@traycer/protocol/common/registry";

import { mentionAttrsFromAttachment } from "@/lib/composer/tiptap-json-content";
import type { EntityMentionAttachment } from "@/lib/composer/types";
import {
  readComposerDraftSnapshot,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";

import { appendBlocks } from "./append-quote-to-draft";

const LINE_BREAK_REGEX = /\r\n?|\n/;

export interface TerminalQuote {
  readonly epicId: string;
  readonly terminalId: string;
  /** Terminal title, as the sidebar and the mention picker both show it. */
  readonly terminalTitle: string;
  /**
   * The shell's launch directory, shown as the chip's tooltip - the same
   * secondary line the `@`-picker gives a terminal row. `null` while the
   * host's `terminal.list` row has not arrived; the chip then carries no
   * directory rather than an invented one.
   */
  readonly terminalCwd: string | null;
  /** The selected lines, exactly as xterm reported them. */
  readonly text: string;
}

/**
 * The two blocks a terminal quote adds to a chat draft:
 *
 * 1. a `sourcedQuote` wrapping the selection as a code block - the excerpt, plus
 *    the terminal it came from, so the coding agent can go read the live
 *    session instead of reasoning from a frozen snippet;
 * 2. a paragraph holding the terminal's mention chip - the same pointer the
 *    `@`-picker inserts, so the reference reads identically however it got
 *    there, and so the user has a line to start typing on.
 *
 * The chip follows the quote rather than leading it because the quote is what
 * the user selected and the chip is the citation for it.
 */
export function buildTerminalQuoteBlocks(
  quote: TerminalQuote,
): ReadonlyArray<JsonContent> {
  return [
    {
      type: "sourcedQuote",
      attrs: {
        sourceType: "terminal",
        sourceId: quote.terminalId,
        sourceEpicId: quote.epicId,
      },
      content: [terminalQuoteCodeBlock(quote.text)],
    },
    {
      type: "paragraph",
      content: [
        {
          type: "mention",
          attrs: mentionAttrsFromAttachment(terminalMention(quote)),
        },
        { type: "text", text: " " },
      ],
    },
  ];
}

/**
 * Appends a terminal quote to a chat's composer draft. Never replaces the
 * draft and never sends: the user reviews and submits.
 *
 * `replaceDraft` bumps the store, and a mounted composer's `syncContent` ->
 * `applyContent` -> `focus("end")` follows, leaving the caret after the space
 * that trails the chip - so the user types their message straight after the
 * citation. A composer that is not mounted yet picks the same draft up as its
 * initial content when it opens.
 */
export function appendTerminalQuoteToDraft(
  chatId: string,
  quote: TerminalQuote,
): void {
  const draft = readComposerDraftSnapshot(chatId);
  const next = appendBlocks(draft.content, buildTerminalQuoteBlocks(quote));
  useComposerDraftStore.getState().replaceDraft(chatId, next, null);
}

/**
 * Terminal output is preformatted: column alignment and indentation are the
 * content. A code block preserves both, and `language: null` keeps the
 * highlighter from guessing a language for shell output.
 */
function terminalQuoteCodeBlock(text: string): JsonContent {
  const code = text.split(LINE_BREAK_REGEX).join("\n");
  return {
    type: "codeBlock",
    attrs: { language: null },
    content: code.length === 0 ? [] : [{ type: "text", text: code }],
  };
}

function terminalMention(quote: TerminalQuote): EntityMentionAttachment {
  return {
    kind: "mention",
    contextType: "terminal",
    // Same token the picker builds, so a quoted reference and a typed one are
    // indistinguishable downstream.
    path: `terminal:${quote.epicId}/${quote.terminalId}`,
    pathKind: null,
    relPath: null,
    absolutePath: null,
    workspacePath: null,
    label: quote.terminalTitle,
    // Where this shell is, not what it is called: the label already carries
    // the title, so repeating it as the tooltip says nothing.
    description: quote.terminalCwd ?? "",
    epicId: quote.epicId,
    artifactId: null,
    artifactType: null,
    chatId: null,
    terminalAgentId: null,
    terminalId: quote.terminalId,
    status: null,
  };
}
