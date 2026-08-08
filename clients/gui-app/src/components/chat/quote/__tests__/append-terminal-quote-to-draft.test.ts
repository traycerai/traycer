import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import { DOMParser, DOMSerializer } from "@tiptap/pm/model";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { buildComposerExtensions } from "@/components/chat/composer/editor/editor-config";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { mentionAttachmentFromAttrs } from "@/lib/composer/tiptap-json-content";
import {
  readComposerDraftSnapshot,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";

import {
  appendTerminalQuoteToDraft,
  buildTerminalQuoteBlocks,
  type TerminalQuote,
} from "../append-terminal-quote-to-draft";

afterEach(() => {
  useComposerDraftStore.setState({ drafts: {} });
});

const QUOTE: TerminalQuote = {
  epicId: "epic-1",
  terminalId: "term-9",
  terminalTitle: "repo · zsh",
  terminalCwd: "/work/repo",
  text: "$ bun test\n  2 failed",
};

function paragraph(text: string): JsonContent {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

describe("appendTerminalQuoteToDraft", () => {
  it("adds a sourced quote naming the terminal, then its mention chip", () => {
    const [quote, chipParagraph] = buildTerminalQuoteBlocks(QUOTE);

    expect(quote).toEqual({
      type: "sourcedQuote",
      attrs: {
        sourceType: "terminal",
        sourceId: "term-9",
        sourceEpicId: "epic-1",
      },
      content: [
        {
          type: "codeBlock",
          attrs: { language: null },
          // Preformatted: terminal output's alignment IS its content.
          content: [{ type: "text", text: "$ bun test\n  2 failed" }],
        },
      ],
    });

    const chip = chipParagraph.content?.[0];
    expect(chip?.type).toBe("mention");
    expect(mentionAttachmentFromAttrs(chip?.attrs)).toMatchObject({
      contextType: "terminal",
      path: "terminal:epic-1/term-9",
      epicId: "epic-1",
      terminalId: "term-9",
      label: "repo · zsh",
      // The chip's tooltip answers "which repo is this shell in", the way the
      // @-picker's terminal rows do. Repeating the label there would say
      // nothing the chip does not already show.
      description: "/work/repo",
    });
  });

  it("does not fall back to repeating the label when the host row is missing", () => {
    const [, chipParagraph] = buildTerminalQuoteBlocks({
      ...QUOTE,
      terminalCwd: null,
    });

    // No directory to show, so the chip takes the same no-description fallback
    // every entity mention takes - its own token - rather than echoing the
    // title back at the user.
    expect(
      mentionAttachmentFromAttrs(chipParagraph.content?.[0]?.attrs),
    ).toMatchObject({
      label: "repo · zsh",
      description: "terminal:epic-1/term-9",
    });
  });

  it("appends to an existing draft instead of replacing it", () => {
    useComposerDraftStore
      .getState()
      .replaceDraft(
        "chat-1",
        { type: "doc", content: [paragraph("already typing")] },
        null,
      );

    appendTerminalQuoteToDraft("chat-1", QUOTE);

    const blocks = readComposerDraftSnapshot("chat-1").content.content ?? [];
    expect(blocks[0]).toEqual(paragraph("already typing"));
    expect(blocks[1]?.type).toBe("sourcedQuote");
    expect(blocks[2]?.content?.[0]?.type).toBe("mention");
  });

  it("leaves the caret after the chip and never sends", () => {
    appendTerminalQuoteToDraft("chat-1", QUOTE);
    const draft = readComposerDraftSnapshot("chat-1");

    // `selection: null` is the composer's focus-at-end signal, and the bumped
    // `resetEpoch` is what makes a mounted composer pick the quote up. Nothing
    // here submits: the draft is where the message stays until the user sends.
    expect(draft.selection).toBeNull();
    expect(draft.resetEpoch).toBeGreaterThan(0);
  });

  it("stacks repeat quotes without blank gaps between them", () => {
    appendTerminalQuoteToDraft("chat-1", QUOTE);
    appendTerminalQuoteToDraft("chat-1", { ...QUOTE, text: "second" });

    const types = (
      readComposerDraftSnapshot("chat-1").content.content ?? []
    ).map((node) => node.type);
    expect(types).toEqual([
      "sourcedQuote",
      "paragraph",
      "sourcedQuote",
      "paragraph",
    ]);
  });

  it("is a node the composer's own schema keeps", () => {
    // Tiptap silently DROPS unknown node types on `setContent`. Without
    // `sourcedQuote` registered, loading this draft would strip the quote's
    // source and leave the coding agent an excerpt it cannot trace.
    const schema = getSchema(
      buildComposerExtensions({
        pickerStore: createComposerPickerStore(),
        getPlaceholder: () => "",
        onSubmit: { current: () => undefined },
        slashProviderId: "claude",
        getHasPastedImageBytes: () => null,
        getIngestPastedComposerImages: () => null,
      }),
    );

    expect(schema.nodes.sourcedQuote).toBeDefined();
    expect(
      schema.nodeFromJSON({
        type: "doc",
        content: buildTerminalQuoteBlocks(QUOTE),
      }).childCount,
    ).toBe(2);
  });

  it("keeps the quote's source through an HTML round-trip", () => {
    // A paste (or any clipboard round-trip) re-parses the draft from HTML. The
    // plain `blockquote` rule matches the same element, so without the sourced
    // rule outranking it the quote comes back as an ordinary blockquote and the
    // agent loses the terminal it was told to go read.
    const schema = getSchema(
      buildComposerExtensions({
        pickerStore: createComposerPickerStore(),
        getPlaceholder: () => "",
        onSubmit: { current: () => undefined },
        slashProviderId: "claude",
        getHasPastedImageBytes: () => null,
        getIngestPastedComposerImages: () => null,
      }),
    );
    const doc = schema.nodeFromJSON({
      type: "doc",
      content: buildTerminalQuoteBlocks(QUOTE),
    });

    const container = document.createElement("div");
    container.appendChild(
      DOMSerializer.fromSchema(schema).serializeFragment(doc.content),
    );
    const reparsed = DOMParser.fromSchema(schema).parse(container);

    expect(reparsed.firstChild?.type.name).toBe("sourcedQuote");
    expect(reparsed.firstChild?.attrs).toMatchObject({
      sourceType: "terminal",
      sourceId: "term-9",
      sourceEpicId: "epic-1",
    });
  });
});
