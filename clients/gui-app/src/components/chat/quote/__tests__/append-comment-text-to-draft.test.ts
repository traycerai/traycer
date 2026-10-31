import { afterEach, describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  readComposerDraftSnapshot,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";

import { appendCommentTextToDraft } from "../append-comment-text-to-draft";

afterEach(() => {
  useComposerDraftStore.setState({ drafts: {} });
});

function paragraph(...content: JsonContent[]): JsonContent {
  return { type: "paragraph", content };
}

function text(value: string): JsonContent {
  return { type: "text", text: value };
}

function doc(...content: JsonContent[]): JsonContent {
  return { type: "doc", content };
}

function composerContent(chatId: string): JsonContent[] {
  return [...(readComposerDraftSnapshot(chatId).content.content ?? [])];
}

describe("appendCommentTextToDraft", () => {
  it("flattens text, collaborator mentions and lists into one paragraph per line", () => {
    appendCommentTextToDraft(
      "chat-1",
      doc(
        paragraph(
          text("Ask "),
          { type: "mention", attrs: { id: "user-1", label: "Ada" } },
          text(" to look"),
        ),
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [paragraph(text("first"))] },
            { type: "listItem", content: [paragraph(text("second"))] },
          ],
        },
        paragraph(),
      ),
    );

    expect(composerContent("chat-1")).toEqual([
      paragraph(text("Ask @Ada to look")),
      paragraph(text("first")),
      paragraph(text("second")),
    ]);
  });

  it("puts one blank paragraph between what was already typed and the comment", () => {
    useComposerDraftStore
      .getState()
      .replaceDraft("chat-1", doc(paragraph(text("already typed"))), null);

    appendCommentTextToDraft("chat-1", doc(paragraph(text("from the box"))));

    expect(composerContent("chat-1")).toEqual([
      paragraph(text("already typed")),
      { type: "paragraph" },
      paragraph(text("from the box")),
    ]);
  });

  it("leaves the composer untouched for a comment with no text", () => {
    useComposerDraftStore
      .getState()
      .replaceDraft("chat-1", doc(paragraph(text("already typed"))), null);
    const before = readComposerDraftSnapshot("chat-1");

    appendCommentTextToDraft("chat-1", doc(paragraph(), paragraph(text("  "))));

    expect(readComposerDraftSnapshot("chat-1")).toBe(before);
  });
});
