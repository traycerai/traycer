import { describe, expect, it } from "vitest";
import type { ComposerTopBannerKind } from "@/components/chat/composer/chat-composer-top-banner";
import {
  isPromptSuggestionAcceptKey,
  promptSuggestionAllowed,
} from "@/components/chat/composer/prompt-suggestion";

const ALLOWED_INPUT: {
  readonly topBannerKind: ComposerTopBannerKind;
  readonly sendDisabled: boolean;
  readonly workspaceBlocked: boolean;
  readonly draftHasText: boolean;
  readonly draftHasImages: boolean;
} = {
  topBannerKind: "none",
  sendDisabled: false,
  workspaceBlocked: false,
  draftHasText: false,
  draftHasImages: false,
};

const OTHER_BANNER_KINDS: ReadonlyArray<ComposerTopBannerKind> = [
  "fallback",
  "reauth",
  "fallback-return",
  "rate-limit",
];

describe("promptSuggestionAllowed", () => {
  it("is true when no banner is up, sending is possible and the draft is empty", () => {
    expect(promptSuggestionAllowed(ALLOWED_INPUT)).toBe(true);
  });

  it.each(OTHER_BANNER_KINDS)(
    "is false when the banner kind is %s",
    (topBannerKind) => {
      expect(promptSuggestionAllowed({ ...ALLOWED_INPUT, topBannerKind })).toBe(
        false,
      );
    },
  );

  it("is false when sending is disabled", () => {
    expect(
      promptSuggestionAllowed({ ...ALLOWED_INPUT, sendDisabled: true }),
    ).toBe(false);
  });

  it("is false when the workspace is blocked", () => {
    expect(
      promptSuggestionAllowed({ ...ALLOWED_INPUT, workspaceBlocked: true }),
    ).toBe(false);
  });

  it("is false when the draft already has text", () => {
    expect(
      promptSuggestionAllowed({ ...ALLOWED_INPUT, draftHasText: true }),
    ).toBe(false);
  });

  it("is false when the draft already has images", () => {
    expect(
      promptSuggestionAllowed({ ...ALLOWED_INPUT, draftHasImages: true }),
    ).toBe(false);
  });
});

const ACCEPT_EVENT = {
  key: "ArrowRight",
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  isComposing: false,
};

describe("isPromptSuggestionAcceptKey", () => {
  it("is true for a bare ArrowRight", () => {
    expect(isPromptSuggestionAcceptKey(ACCEPT_EVENT)).toBe(true);
  });

  it("is false with altKey held", () => {
    expect(isPromptSuggestionAcceptKey({ ...ACCEPT_EVENT, altKey: true })).toBe(
      false,
    );
  });

  it("is false with ctrlKey held", () => {
    expect(
      isPromptSuggestionAcceptKey({ ...ACCEPT_EVENT, ctrlKey: true }),
    ).toBe(false);
  });

  it("is false with metaKey held", () => {
    expect(
      isPromptSuggestionAcceptKey({ ...ACCEPT_EVENT, metaKey: true }),
    ).toBe(false);
  });

  it("is false with shiftKey held", () => {
    expect(
      isPromptSuggestionAcceptKey({ ...ACCEPT_EVENT, shiftKey: true }),
    ).toBe(false);
  });

  it("is false while composing an IME candidate", () => {
    expect(
      isPromptSuggestionAcceptKey({ ...ACCEPT_EVENT, isComposing: true }),
    ).toBe(false);
  });

  it.each(["Enter", "ArrowLeft", "ArrowUp", "ArrowDown", " "])(
    "is false for another key (%s)",
    (key) => {
      expect(isPromptSuggestionAcceptKey({ ...ACCEPT_EVENT, key })).toBe(false);
    },
  );
});
