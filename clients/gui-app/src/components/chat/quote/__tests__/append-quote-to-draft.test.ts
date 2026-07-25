import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  readComposerDraftSnapshot,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";

import {
  appendBlocks,
  appendQuoteToDraft,
  buildQuoteBlockquote,
} from "../append-quote-to-draft";

afterEach(() => {
  useComposerDraftStore.setState({ drafts: {} });
});

function paragraph(text: string): JsonContent {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

function emptyParagraph(): JsonContent {
  return { type: "paragraph" };
}

function doc(content: JsonContent[]): JsonContent {
  return { type: "doc", content };
}

describe("buildQuoteBlockquote", () => {
  it("splits plain text into paragraph nodes inside one blockquote", () => {
    const node = buildQuoteBlockquote({
      text: "first line\nsecond line",
      fenceLanguage: null,
    });
    expect(node).toEqual({
      type: "blockquote",
      content: [paragraph("first line"), paragraph("second line")],
    });
  });

  it("trims trailing per-line whitespace and collapses CRLF", () => {
    const node = buildQuoteBlockquote({
      text: "first line   \r\nsecond line\t",
      fenceLanguage: null,
    });
    expect(node).toEqual({
      type: "blockquote",
      content: [paragraph("first line"), paragraph("second line")],
    });
  });

  it("represents a blank line as an empty paragraph", () => {
    const node = buildQuoteBlockquote({
      text: "first\n\nthird",
      fenceLanguage: null,
    });
    expect(node).toEqual({
      type: "blockquote",
      content: [paragraph("first"), emptyParagraph(), paragraph("third")],
    });
  });

  it("yields a single empty paragraph for whitespace-only text", () => {
    const node = buildQuoteBlockquote({ text: "   ", fenceLanguage: null });
    expect(node).toEqual({
      type: "blockquote",
      content: [emptyParagraph()],
    });
  });

  it("drops a single trailing empty line (the browser's block-boundary blank after a triple-click)", () => {
    const node = buildQuoteBlockquote({
      text: "Third paragraph, the last one.\n",
      fenceLanguage: null,
    });
    expect(node).toEqual({
      type: "blockquote",
      content: [paragraph("Third paragraph, the last one.")],
    });
  });

  it("drops two trailing empty lines", () => {
    const node = buildQuoteBlockquote({
      text: "Third paragraph, the last one.\n\n",
      fenceLanguage: null,
    });
    expect(node).toEqual({
      type: "blockquote",
      content: [paragraph("Third paragraph, the last one.")],
    });
  });

  it("drops three trailing empty lines", () => {
    const node = buildQuoteBlockquote({
      text: "Third paragraph, the last one.\n\n\n",
      fenceLanguage: null,
    });
    expect(node).toEqual({
      type: "blockquote",
      content: [paragraph("Third paragraph, the last one.")],
    });
  });

  it("drops trailing empty lines after a multi-paragraph selection while keeping the internal blank line", () => {
    const node = buildQuoteBlockquote({
      text: "First.\n\nSecond.\n\n",
      fenceLanguage: null,
    });
    expect(node).toEqual({
      type: "blockquote",
      content: [paragraph("First."), emptyParagraph(), paragraph("Second.")],
    });
  });

  it("wraps a fence selection in a codeBlock with the language attr, preserving raw lines", () => {
    const node = buildQuoteBlockquote({
      text: "const x = 1;  \nconst y = 2;",
      fenceLanguage: "typescript",
    });
    expect(node).toEqual({
      type: "blockquote",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "typescript" },
          content: [{ type: "text", text: "const x = 1;  \nconst y = 2;" }],
        },
      ],
    });
  });

  it("collapses CRLF in fence content without trimming trailing whitespace", () => {
    const node = buildQuoteBlockquote({
      text: "line one \r\nline two",
      fenceLanguage: "python",
    });
    expect(node).toEqual({
      type: "blockquote",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "python" },
          content: [{ type: "text", text: "line one \nline two" }],
        },
      ],
    });
  });
});

describe("appendBlocks", () => {
  it("appends into an empty draft without leaving a leading blank paragraph", () => {
    const quote = buildQuoteBlockquote({ text: "quoted", fenceLanguage: null });
    const next = appendBlocks(doc([emptyParagraph()]), [
      quote,
      emptyParagraph(),
    ]);
    expect(next).toEqual(doc([quote, emptyParagraph()]));
  });

  it("keeps existing typed text and appends after it", () => {
    const quote = buildQuoteBlockquote({ text: "quoted", fenceLanguage: null });
    const next = appendBlocks(doc([paragraph("hello")]), [
      quote,
      emptyParagraph(),
    ]);
    expect(next).toEqual(doc([paragraph("hello"), quote, emptyParagraph()]));
  });

  it("drops a single existing trailing empty paragraph before appending (dedup)", () => {
    const quote = buildQuoteBlockquote({ text: "quoted", fenceLanguage: null });
    const next = appendBlocks(doc([paragraph("hello"), emptyParagraph()]), [
      quote,
      emptyParagraph(),
    ]);
    expect(next).toEqual(doc([paragraph("hello"), quote, emptyParagraph()]));
  });

  it("only drops one trailing empty paragraph, not every blank block", () => {
    const quote = buildQuoteBlockquote({ text: "quoted", fenceLanguage: null });
    const next = appendBlocks(
      doc([paragraph("hello"), emptyParagraph(), emptyParagraph()]),
      [quote, emptyParagraph()],
    );
    expect(next).toEqual(
      doc([paragraph("hello"), emptyParagraph(), quote, emptyParagraph()]),
    );
  });

  it("stacks repeat appends without accumulating blank gaps between them", () => {
    const first = buildQuoteBlockquote({ text: "one", fenceLanguage: null });
    const second = buildQuoteBlockquote({ text: "two", fenceLanguage: null });
    const afterFirst = appendBlocks(doc([emptyParagraph()]), [
      first,
      emptyParagraph(),
    ]);
    const afterSecond = appendBlocks(afterFirst, [second, emptyParagraph()]);
    expect(afterSecond).toEqual(doc([first, second, emptyParagraph()]));
  });
});

describe("appendQuoteToDraft", () => {
  it("reads the current draft, appends the quote, and bumps resetEpoch via replaceDraft", () => {
    const taskId = "task-1";
    useComposerDraftStore
      .getState()
      .setSnapshot(taskId, doc([paragraph("hello")]), null);
    const quote = buildQuoteBlockquote({ text: "quoted", fenceLanguage: null });

    appendQuoteToDraft(taskId, quote);

    const draft = readComposerDraftSnapshot(taskId);
    expect(draft.content).toEqual(
      doc([paragraph("hello"), quote, emptyParagraph()]),
    );
    expect(draft.selection).toBeNull();
    expect(draft.resetEpoch).toBe(1);
  });

  it("appends into a task with no prior draft (defaults to the empty draft)", () => {
    const taskId = "task-2";
    const quote = buildQuoteBlockquote({ text: "quoted", fenceLanguage: null });

    appendQuoteToDraft(taskId, quote);

    const draft = readComposerDraftSnapshot(taskId);
    expect(draft.content).toEqual(doc([quote, emptyParagraph()]));
  });

  it("stacks a second quote after a first append on the same task", () => {
    const taskId = "task-3";
    const first = buildQuoteBlockquote({ text: "one", fenceLanguage: null });
    const second = buildQuoteBlockquote({ text: "two", fenceLanguage: null });

    appendQuoteToDraft(taskId, first);
    appendQuoteToDraft(taskId, second);

    const draft = readComposerDraftSnapshot(taskId);
    expect(draft.content).toEqual(doc([first, second, emptyParagraph()]));
    expect(draft.resetEpoch).toBe(2);
  });
});
