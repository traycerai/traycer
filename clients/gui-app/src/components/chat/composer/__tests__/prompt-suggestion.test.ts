import { describe, expect, it } from "vitest";
import type { ComposerTopBannerKind } from "@/components/chat/composer/chat-composer-top-banner";
import type { JsonContent } from "@traycer/protocol/common/registry";
import {
  isPromptSuggestionAcceptKey,
  promptSuggestionAllowed,
  suggestionOfferableWhilePending,
} from "@/components/chat/composer/prompt-suggestion";
import type { PendingChatAction } from "@/stores/chats/chat-session-store";

const EMPTY_DOC: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

const ALLOWED_INPUT: {
  readonly topBannerKind: ComposerTopBannerKind;
  readonly sendDisabled: boolean;
  readonly workspaceBlocked: boolean;
  readonly draftHasText: boolean;
  readonly draftHasImages: boolean;
  readonly draftContent: JsonContent;
} = {
  topBannerKind: "none",
  sendDisabled: false,
  workspaceBlocked: false,
  draftHasText: false,
  draftHasImages: false,
  draftContent: EMPTY_DOC,
};

const BLANK_DRAFT_CONTENTS: ReadonlyArray<{
  readonly label: string;
  readonly content: JsonContent;
}> = [
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
    label: "a code block followed by the trailing paragraph",
    content: {
      type: "doc",
      content: [{ type: "codeBlock" }, { type: "paragraph" }],
    },
  },
  {
    label: "an empty heading",
    content: {
      type: "doc",
      content: [{ type: "heading", attrs: { level: 1 } }],
    },
  },
  {
    label: "an empty list",
    content: {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [{ type: "listItem", content: [{ type: "paragraph" }] }],
        },
      ],
    },
  },
  {
    label: "multiple blank paragraphs",
    content: {
      type: "doc",
      content: [{ type: "paragraph" }, { type: "paragraph" }],
    },
  },
];

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

  it.each(BLANK_DRAFT_CONTENTS)(
    "is false for $label even when draftHasText is false",
    ({ content }) => {
      expect(
        promptSuggestionAllowed({
          ...ALLOWED_INPUT,
          draftHasText: false,
          draftContent: content,
        }),
      ).toBe(false);
    },
  );

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

type PendingActionKind = PendingChatAction["action"];

// The parameter is `Pick<PendingChatAction, "action">`, so each in-flight
// action is the bare `{ action }` the helper reads, keyed by its action id.
function pendingOf(
  ...kinds: ReadonlyArray<PendingActionKind>
): Record<string, Pick<PendingChatAction, "action">> {
  const pending: Record<string, Pick<PendingChatAction, "action">> = {};
  kinds.forEach((action, index) => {
    pending[`action-${String(index)}`] = { action };
  });
  return pending;
}

const OTHER_ACTION_KINDS: ReadonlyArray<PendingActionKind> = [
  "stop",
  "approvalDecision",
  "queueCancel",
];

describe("suggestionOfferableWhilePending", () => {
  it("passes the suggestion through when nothing is pending", () => {
    expect(suggestionOfferableWhilePending("run the tests", pendingOf())).toBe(
      "run the tests",
    );
  });

  it("keeps an absent suggestion absent when nothing is pending", () => {
    expect(suggestionOfferableWhilePending(undefined, pendingOf())).toBe(
      undefined,
    );
  });

  it("withholds the suggestion while a send is pending", () => {
    expect(
      suggestionOfferableWhilePending("run the tests", pendingOf("send")),
    ).toBe(undefined);
  });

  it("withholds the suggestion while an edit-and-resend is pending", () => {
    expect(
      suggestionOfferableWhilePending(
        "run the tests",
        pendingOf("editUserMessage"),
      ),
    ).toBe(undefined);
  });

  it.each(OTHER_ACTION_KINDS)(
    "passes the suggestion through while only a %s is pending",
    (kind) => {
      expect(
        suggestionOfferableWhilePending("run the tests", pendingOf(kind)),
      ).toBe("run the tests");
    },
  );

  it("passes the suggestion through while several non-send actions are pending", () => {
    expect(
      suggestionOfferableWhilePending(
        "run the tests",
        pendingOf(...OTHER_ACTION_KINDS),
      ),
    ).toBe("run the tests");
  });

  it.each(OTHER_ACTION_KINDS)(
    "withholds the suggestion when a send is pending beside a %s",
    (kind) => {
      expect(
        suggestionOfferableWhilePending(
          "run the tests",
          pendingOf(kind, "send"),
        ),
      ).toBe(undefined);
    },
  );

  it("withholds the suggestion when an edit is pending beside another kind", () => {
    expect(
      suggestionOfferableWhilePending(
        "run the tests",
        pendingOf("stop", "editUserMessage"),
      ),
    ).toBe(undefined);
  });
});
