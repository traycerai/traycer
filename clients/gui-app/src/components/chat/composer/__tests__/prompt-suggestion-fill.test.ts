import { describe, expect, it, vi, type Mock } from "vitest";
import { plainTextPromptContent } from "@/components/epic-canvas/renderers/chat-tile-session-state";
import type { JsonContent } from "@traycer/protocol/common/registry";
import {
  fillComposerWithSuggestion,
  type SuggestionFillTarget,
} from "@/components/chat/composer/prompt-suggestion";

const EMPTY_DOC: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

const DIRTY_DRAFT_CONTENTS: ReadonlyArray<{
  readonly label: string;
  readonly content: JsonContent;
}> = [
  {
    label: "a nonempty paragraph",
    content: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Draft" }] },
      ],
    },
  },
  {
    label: "a whitespace-only paragraph",
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: " \t " }],
        },
      ],
    },
  },
  {
    label: "a code block with the trailing paragraph",
    content: {
      type: "doc",
      content: [{ type: "codeBlock" }, { type: "paragraph" }],
    },
  },
];

interface FakeSuggestionFillTarget {
  readonly target: SuggestionFillTarget;
  readonly isReady: Mock<SuggestionFillTarget["isReady"]>;
  readonly getJSON: Mock<() => JsonContent>;
  readonly setContent: Mock<SuggestionFillTarget["setContent"]>;
  readonly focusAtEnd: Mock<SuggestionFillTarget["focusAtEnd"]>;
  /** Shared call-order log across all four members, in invocation order. */
  readonly calls: string[];
}

function makeFakeTarget(
  isReadyValue: boolean,
  content: JsonContent,
): FakeSuggestionFillTarget {
  const calls: string[] = [];
  const isReady = vi.fn<SuggestionFillTarget["isReady"]>(() => {
    calls.push("isReady");
    return isReadyValue;
  });
  const getJSON = vi.fn<() => JsonContent>(() => {
    calls.push("getJSON");
    return content;
  });
  const setContent = vi.fn<SuggestionFillTarget["setContent"]>(() => {
    calls.push("setContent");
  });
  const focusAtEnd = vi.fn<SuggestionFillTarget["focusAtEnd"]>(() => {
    calls.push("focusAtEnd");
  });
  return {
    target: { isReady, getJSON, setContent, focusAtEnd },
    isReady,
    getJSON,
    setContent,
    focusAtEnd,
    calls,
  };
}

describe("fillComposerWithSuggestion", () => {
  it("fills a ready editor: setContent once with the plain-text content, then focusAtEnd, in that order", () => {
    const fake = makeFakeTarget(true, EMPTY_DOC);

    fillComposerWithSuggestion(fake.target, "Run the tests");

    expect(fake.getJSON).toHaveBeenCalledTimes(1);
    expect(fake.setContent).toHaveBeenCalledTimes(1);
    expect(fake.setContent).toHaveBeenCalledWith(
      plainTextPromptContent("Run the tests"),
      null,
    );
    expect(fake.focusAtEnd).toHaveBeenCalledTimes(1);
    // Order matters: `setContent` (the real document mutation) must land
    // before `focusAtEnd`, not merely both get called.
    expect(fake.calls).toEqual([
      "isReady",
      "getJSON",
      "setContent",
      "focusAtEnd",
    ]);
  });

  it("does nothing and does not throw when the editor is null", () => {
    expect(() =>
      fillComposerWithSuggestion(null, "Run the tests"),
    ).not.toThrow();
  });

  it("calls neither setContent nor focusAtEnd when the editor reports it is not ready", () => {
    const fake = makeFakeTarget(false, EMPTY_DOC);

    fillComposerWithSuggestion(fake.target, "Run the tests");

    expect(fake.getJSON).not.toHaveBeenCalled();
    expect(fake.setContent).not.toHaveBeenCalled();
    expect(fake.focusAtEnd).not.toHaveBeenCalled();
    expect(fake.calls).toEqual(["isReady"]);
  });

  it.each(DIRTY_DRAFT_CONTENTS)(
    "does not replace $label when it appears after the suggestion was offered",
    ({ content }) => {
      const fake = makeFakeTarget(true, EMPTY_DOC);
      // The suggestion was offered over EMPTY_DOC; the editor changed before
      // the reader accepted it, so filling must use the current JSON.
      fake.getJSON.mockImplementation(() => {
        fake.calls.push("getJSON");
        return content;
      });

      fillComposerWithSuggestion(fake.target, "Run the tests");

      expect({
        setContentCalls: fake.setContent.mock.calls.length,
        focusCalls: fake.focusAtEnd.mock.calls.length,
        calls: fake.calls,
      }).toEqual({
        setContentCalls: 0,
        focusCalls: 0,
        calls: ["isReady", "getJSON"],
      });
    },
  );

  // "Accepting a suggestion never sends" is structural, not something a test can exercise
  // here: `SuggestionFillTarget` is a `Pick<ComposerPromptEditorHandle,
  // "isReady" | "getJSON" | "setContent" | "focusAtEnd">`, so no send-shaped member is
  // even reachable from a value of this type - there is no call path to
  // assert against.
});
