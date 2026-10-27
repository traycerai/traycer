import { describe, expect, it } from "vitest";
import type { ComposerTopBannerKind } from "@/components/chat/composer/chat-composer-top-banner";
import type { JsonContent } from "@traycer/protocol/common/registry";
import {
  isPromptSuggestionAcceptEvent,
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

/**
 * A keydown as the editor hands it over: physical `code` set, because the
 * binding is matched on the key's position, not its label.
 */
function acceptKeyDown(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", { cancelable: true, ...init });
}

const ARROW_RIGHT: KeyboardEventInit = { key: "ArrowRight", code: "ArrowRight" };
const TAB: KeyboardEventInit = { key: "Tab", code: "Tab" };

describe("isPromptSuggestionAcceptEvent", () => {
  it("accepts the bound key - the default → and a rebound Tab alike", () => {
    expect(
      isPromptSuggestionAcceptEvent({
        binding: "arrowright",
        event: acceptKeyDown(ARROW_RIGHT),
        pickerOpen: false,
      }),
    ).toBe(true);
    expect(
      isPromptSuggestionAcceptEvent({
        binding: "tab",
        event: acceptKeyDown(TAB),
        pickerOpen: false,
      }),
    ).toBe(true);
  });

  it("stops accepting the old key once rebound", () => {
    expect(
      isPromptSuggestionAcceptEvent({
        binding: "tab",
        event: acceptKeyDown(ARROW_RIGHT),
        pickerOpen: false,
      }),
    ).toBe(false);
  });

  it("accepts nothing while the action is unbound", () => {
    expect(
      isPromptSuggestionAcceptEvent({
        binding: null,
        event: acceptKeyDown(ARROW_RIGHT),
        pickerOpen: false,
      }),
    ).toBe(false);
  });

  it.each([
    ["shiftKey", { shiftKey: true }],
    ["altKey", { altKey: true }],
    ["metaKey", { metaKey: true }],
    ["ctrlKey", { ctrlKey: true }],
  ])("does not accept a modified bound key (%s)", (_name, modifier) => {
    expect(
      isPromptSuggestionAcceptEvent({
        binding: "tab",
        event: acceptKeyDown({ ...TAB, ...modifier }),
        pickerOpen: false,
      }),
    ).toBe(false);
  });

  it("yields to an open mention or slash picker", () => {
    expect(
      isPromptSuggestionAcceptEvent({
        binding: "tab",
        event: acceptKeyDown(TAB),
        pickerOpen: true,
      }),
    ).toBe(false);
  });

  it("yields to a key something earlier already took", () => {
    const event = acceptKeyDown(ARROW_RIGHT);
    event.preventDefault();
    expect(
      isPromptSuggestionAcceptEvent({
        binding: "arrowright",
        event,
        pickerOpen: false,
      }),
    ).toBe(false);
  });

  it("does not accept on OS key-repeat", () => {
    expect(
      isPromptSuggestionAcceptEvent({
        binding: "arrowright",
        event: acceptKeyDown({ ...ARROW_RIGHT, repeat: true }),
        pickerOpen: false,
      }),
    ).toBe(false);
  });

  // AltGr+Q types @ on a German layout and reaches the event as Ctrl+Alt+Q
  // with AltGraph set; a person bound to mod+alt+q must still get their @.
  it("does not accept an AltGr chord that types a character", () => {
    expect(
      isPromptSuggestionAcceptEvent({
        binding: "mod+alt+q",
        event: acceptKeyDown({
          key: "@",
          code: "KeyQ",
          ctrlKey: true,
          altKey: true,
          modifierAltGraph: true,
        }),
        pickerOpen: false,
      }),
    ).toBe(false);
  });

  it("does not accept while composing an IME candidate", () => {
    expect(
      isPromptSuggestionAcceptEvent({
        binding: "arrowright",
        event: acceptKeyDown({ ...ARROW_RIGHT, isComposing: true }),
        pickerOpen: false,
      }),
    ).toBe(false);
  });
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
