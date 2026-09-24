import { describe, expect, it, vi, type Mock } from "vitest";
import { plainTextPromptContent } from "@/components/epic-canvas/renderers/chat-tile-session-state";
import {
  fillComposerWithSuggestion,
  type SuggestionFillTarget,
} from "@/components/chat/composer/prompt-suggestion";

interface FakeSuggestionFillTarget {
  readonly target: SuggestionFillTarget;
  readonly isReady: Mock<SuggestionFillTarget["isReady"]>;
  readonly setContent: Mock<SuggestionFillTarget["setContent"]>;
  readonly focusAtEnd: Mock<SuggestionFillTarget["focusAtEnd"]>;
  /** Shared call-order log across all three members, in invocation order. */
  readonly calls: string[];
}

function makeFakeTarget(isReadyValue: boolean): FakeSuggestionFillTarget {
  const calls: string[] = [];
  const isReady = vi.fn<SuggestionFillTarget["isReady"]>(() => {
    calls.push("isReady");
    return isReadyValue;
  });
  const setContent = vi.fn<SuggestionFillTarget["setContent"]>(() => {
    calls.push("setContent");
  });
  const focusAtEnd = vi.fn<SuggestionFillTarget["focusAtEnd"]>(() => {
    calls.push("focusAtEnd");
  });
  return {
    target: { isReady, setContent, focusAtEnd },
    isReady,
    setContent,
    focusAtEnd,
    calls,
  };
}

describe("fillComposerWithSuggestion", () => {
  it("fills a ready editor: setContent once with the plain-text content, then focusAtEnd, in that order", () => {
    const fake = makeFakeTarget(true);

    fillComposerWithSuggestion(fake.target, "Run the tests");

    expect(fake.setContent).toHaveBeenCalledTimes(1);
    expect(fake.setContent).toHaveBeenCalledWith(
      plainTextPromptContent("Run the tests"),
      null,
    );
    expect(fake.focusAtEnd).toHaveBeenCalledTimes(1);
    // Order matters: `setContent` (the real document mutation) must land
    // before `focusAtEnd`, not merely both get called.
    expect(fake.calls).toEqual(["isReady", "setContent", "focusAtEnd"]);
  });

  it("does nothing and does not throw when the editor is null", () => {
    expect(() =>
      fillComposerWithSuggestion(null, "Run the tests"),
    ).not.toThrow();
  });

  it("calls neither setContent nor focusAtEnd when the editor reports it is not ready", () => {
    const fake = makeFakeTarget(false);

    fillComposerWithSuggestion(fake.target, "Run the tests");

    expect(fake.setContent).not.toHaveBeenCalled();
    expect(fake.focusAtEnd).not.toHaveBeenCalled();
    expect(fake.calls).toEqual(["isReady"]);
  });

  // "The chip never sends" is structural, not something a test can exercise
  // here: `SuggestionFillTarget` is a `Pick<ComposerPromptEditorHandle,
  // "isReady" | "setContent" | "focusAtEnd">`, so no send-shaped member is
  // even reachable from a value of this type - there is no call path to
  // assert against.
});
