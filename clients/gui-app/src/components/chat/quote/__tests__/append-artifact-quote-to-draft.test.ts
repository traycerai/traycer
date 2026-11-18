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
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";

import {
  appendArtifactQuoteToDraft,
  appendArtifactQuoteToNewConversationDraft,
  buildArtifactQuoteBlocks,
  type ArtifactQuote,
} from "../append-artifact-quote-to-draft";

afterEach(() => {
  useComposerDraftStore.setState({ drafts: {} });
  useNewConversationModalStore.getState().resetForTests();
});

const QUOTE: ArtifactQuote = {
  epicId: "epic-1",
  artifactId: "artifact-9",
  artifactKind: "spec",
  artifactTitle: "Onboarding plan",
  artifactStatus: null,
  blocks: [
    { type: "paragraph", content: [{ type: "text", text: "Step one" }] },
  ],
};

function paragraph(text: string): JsonContent {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

function buildSchema() {
  return getSchema(
    buildComposerExtensions({
      pickerStore: createComposerPickerStore(),
      getPlaceholder: () => "",
      onSubmit: { current: () => undefined },
      slashProviderId: "claude",
      getHasPastedImageBytes: () => null,
      getIngestPastedComposerImages: () => null,
    }),
  );
}

describe("buildArtifactQuoteBlocks", () => {
  it("adds a sourced quote naming the artifact, then its mention chip", () => {
    const [quote, chipParagraph] = buildArtifactQuoteBlocks(QUOTE);

    expect(quote).toEqual({
      type: "sourcedQuote",
      attrs: {
        sourceType: "spec",
        sourceId: "artifact-9",
        sourceEpicId: "epic-1",
      },
      content: [...QUOTE.blocks],
    });

    const chip = chipParagraph.content?.[0];
    expect(chip?.type).toBe("mention");
    expect(mentionAttachmentFromAttrs(chip?.attrs)).toMatchObject({
      contextType: "spec",
      path: "spec:epic-1/artifact-9",
      epicId: "epic-1",
      artifactId: "artifact-9",
      artifactType: "spec",
      label: "Onboarding plan",
    });
  });

  it("is a node the composer's own schema keeps", () => {
    // Tiptap silently DROPS unknown node types on `setContent`. Without
    // `sourcedQuote` registered, loading this draft would strip the quote's
    // source and leave the coding agent an excerpt it cannot trace.
    const schema = buildSchema();

    expect(schema.nodes.sourcedQuote).toBeDefined();
    expect(
      schema.nodeFromJSON({
        type: "doc",
        content: buildArtifactQuoteBlocks(QUOTE),
      }).childCount,
    ).toBe(2);
  });

  it("keeps the quote's source through an HTML round-trip", () => {
    // A paste (or any clipboard round-trip) re-parses the draft from HTML. The
    // plain `blockquote` rule matches the same element, so without the sourced
    // rule outranking it the quote comes back as an ordinary blockquote and the
    // agent loses the artifact it was told to go read.
    const schema = buildSchema();
    const doc = schema.nodeFromJSON({
      type: "doc",
      content: buildArtifactQuoteBlocks(QUOTE),
    });

    const container = document.createElement("div");
    container.appendChild(
      DOMSerializer.fromSchema(schema).serializeFragment(doc.content),
    );
    const reparsed = DOMParser.fromSchema(schema).parse(container);

    expect(reparsed.firstChild?.type.name).toBe("sourcedQuote");
    expect(reparsed.firstChild?.attrs).toMatchObject({
      sourceType: "spec",
      sourceId: "artifact-9",
      sourceEpicId: "epic-1",
    });
  });
});

describe("appendArtifactQuoteToDraft", () => {
  it("appends to an existing draft instead of replacing it", () => {
    useComposerDraftStore
      .getState()
      .replaceDraft(
        "chat-1",
        { type: "doc", content: [paragraph("already typing")] },
        null,
      );

    appendArtifactQuoteToDraft("chat-1", QUOTE);

    const blocks = readComposerDraftSnapshot("chat-1").content.content ?? [];
    expect(blocks[0]).toEqual(paragraph("already typing"));
    expect(blocks[1]?.type).toBe("sourcedQuote");
    expect(blocks[2]?.content?.[0]?.type).toBe("mention");
  });

  it("leaves the caret after the chip and never sends", () => {
    appendArtifactQuoteToDraft("chat-1", QUOTE);
    const draft = readComposerDraftSnapshot("chat-1");

    // `selection: null` is the composer's focus-at-end signal, and the bumped
    // `resetEpoch` is what makes a mounted composer pick the quote up. Nothing
    // here submits: the draft is where the message stays until the user sends.
    expect(draft.selection).toBeNull();
    expect(draft.resetEpoch).toBeGreaterThan(0);
  });
});

describe("appendArtifactQuoteToNewConversationDraft", () => {
  it("writes the per-epic new-conversation draft", () => {
    appendArtifactQuoteToNewConversationDraft(QUOTE);

    const draft =
      useNewConversationModalStore.getState().draftPatchesByEpicId[
        QUOTE.epicId
      ];
    const types = (draft?.content?.content ?? []).map((node) => node.type);
    expect(types).toEqual(["sourcedQuote", "paragraph"]);
    expect(draft?.selection).toBeNull();
  });
});
