import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  readComposerDraftSnapshot,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";

import {
  appendTranslateToSpanishToDraft,
  buildTranslateToSpanishRequest,
  TRANSLATE_TO_SPANISH_INSTRUCTION,
} from "../translate-to-spanish";

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

describe("buildTranslateToSpanishRequest", () => {
  it("prefixes the instruction and quotes the selection verbatim", () => {
    expect(
      buildTranslateToSpanishRequest({
        text: "This is the selected text.",
        fenceLanguage: null,
      }),
    ).toEqual(
      doc([
        paragraph(TRANSLATE_TO_SPANISH_INSTRUCTION),
        {
          type: "blockquote",
          content: [paragraph("This is the selected text.")],
        },
      ]),
    );
  });

  it("keeps a code-fence selection in a code block", () => {
    expect(
      buildTranslateToSpanishRequest({
        text: "const x = 1;",
        fenceLanguage: "typescript",
      }),
    ).toEqual(
      doc([
        paragraph(TRANSLATE_TO_SPANISH_INSTRUCTION),
        {
          type: "blockquote",
          content: [
            {
              type: "codeBlock",
              attrs: { language: "typescript" },
              content: [{ type: "text", text: "const x = 1;" }],
            },
          ],
        },
      ]),
    );
  });
});

describe("appendTranslateToSpanishToDraft", () => {
  it("appends the request into a draft that already has content", () => {
    const taskId = "task-1";
    useComposerDraftStore
      .getState()
      .setSnapshot(taskId, doc([paragraph("hello")]), null);

    appendTranslateToSpanishToDraft(taskId, {
      text: "This is the selected text.",
      fenceLanguage: null,
    });

    const draft = readComposerDraftSnapshot(taskId);
    expect(draft.content).toEqual(
      doc([
        paragraph("hello"),
        paragraph(TRANSLATE_TO_SPANISH_INSTRUCTION),
        {
          type: "blockquote",
          content: [paragraph("This is the selected text.")],
        },
        emptyParagraph(),
      ]),
    );
    expect(draft.selection).toBeNull();
  });

  it("appends into a task with no prior draft", () => {
    const taskId = "task-2";

    appendTranslateToSpanishToDraft(taskId, {
      text: "Selected text.",
      fenceLanguage: null,
    });

    const draft = readComposerDraftSnapshot(taskId);
    expect(draft.content).toEqual(
      doc([
        paragraph(TRANSLATE_TO_SPANISH_INSTRUCTION),
        { type: "blockquote", content: [paragraph("Selected text.")] },
        emptyParagraph(),
      ]),
    );
  });
});
