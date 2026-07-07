import {
  type ItemLocationCallback,
  type ScrollModifier,
} from "@virtuoso.dev/message-list";
import { describe, expect, it } from "vitest";

import {
  buildMessageIdToIndex,
  chatComputeItemKey,
  chatItemIdentity,
  chatScrollLocationForMessage,
  chatViewportAnchorMessageId,
  classifyChatScrollPolicy,
  isNearChatBottom,
  measuredItemChangeScrollModifier,
  selectActiveUserMessageId,
} from "@/components/chat/chat-messages-virtuoso-helpers";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";

import {
  makeMessage,
  makeMessageAt,
  makeMessages,
} from "./chat-message-fixtures";

describe("ChatMessages Virtuoso helpers", () => {
  it("classifies the first non-empty history as a LAST/end item-location", () => {
    const modifier = classifyChatScrollModifier({
      previousMessages: null,
      nextMessages: makeMessages(2),
    });

    expect(modifier).toEqual({
      type: "item-location",
      location: { index: "LAST", align: "end" },
      purgeItemSizes: true,
    });
  });

  it("treats the first non-empty render after an empty list as initial", () => {
    const modifier = classifyChatScrollModifier({
      previousMessages: [],
      nextMessages: makeMessages(1),
    });

    expect(modifier).toEqual({
      type: "item-location",
      location: { index: "LAST", align: "end" },
      purgeItemSizes: true,
    });
  });

  it("returns no modifier when the next list is empty", () => {
    expect(
      classifyChatScrollModifier({
        previousMessages: makeMessages(2),
        nextMessages: [],
      }),
    ).toBeUndefined();
  });

  it("anchors removed trailing optimistic rows at the new tail (not following)", () => {
    const previousMessages = [
      makeMessageAt(0, "user", 100),
      makeMessageAt(1, "assistant", 200),
      makeMessageAt(2, "user", 300),
    ];
    const nextMessages = previousMessages.slice(0, 2);

    expect(
      classifyChatScrollModifier({ previousMessages, nextMessages }),
    ).toEqual({
      type: "item-location",
      location: {
        index: 1,
        align: "start-no-overflow",
        behavior: "auto",
      },
      purgeItemSizes: true,
    });
  });

  it("purges cached heights and stays pinned when deleting a message suffix at the tail while following", () => {
    const previousMessages = [
      makeMessageAt(0, "user", 100),
      makeMessageAt(1, "assistant", 200),
      makeMessageAt(2, "user", 300),
      makeMessageAt(3, "assistant", 400),
    ];
    const nextMessages = previousMessages.slice(0, 2);

    expect(
      classifyFollowingChatScrollModifier({ previousMessages, nextMessages }),
    ).toEqual({
      type: "item-location",
      location: {
        index: "LAST",
        align: "end",
        behavior: "auto",
      },
      purgeItemSizes: true,
    });
  });

  it("bottom-follows a freshly sent user prompt like a normal chat", () => {
    const previousMessages = [
      makeMessageAt(0, "user", 100),
      makeMessageAt(1, "assistant", 200),
    ];
    const newUser = makeMessageAt(2, "user", 300);
    const nextMessages = [...previousMessages, newUser];

    expectSubmittedUserScrollModifier(
      classifyChatScrollModifier({ previousMessages, nextMessages }),
    );
  });

  it("bottom-follows a mid-list steered user row like a normal chat", () => {
    const userMessage = makeMessageAt(0, "user", 100);
    const liveAssistant = {
      ...makeMessageAt(1, "assistant", 200),
      id: "assistant:turn-1",
    };
    const previousMessages = [userMessage, liveAssistant];
    const steerUser = { ...makeMessageAt(2, "user", 300), id: "steer:queue-1" };
    const nextMessages = [
      userMessage,
      { ...liveAssistant, id: "assistant:turn-1:part:0" },
      steerUser,
      { ...makeMessageAt(3, "assistant", 400), id: "assistant:turn-1:part:1" },
    ];

    expectSubmittedUserScrollModifier(
      classifyChatScrollModifier({ previousMessages, nextMessages }),
    );
  });

  it("anchors a new user row even when the assistant placeholder arrives with it", () => {
    const previousMessages = [
      makeMessageAt(0, "user", 100),
      makeMessageAt(1, "assistant", 200),
    ];
    const nextMessages = [
      ...previousMessages,
      makeMessageAt(2, "user", 300),
      makeMessageAt(3, "assistant", 400),
    ];

    expectSubmittedUserScrollModifier(
      classifyChatScrollModifier({ previousMessages, nextMessages }),
    );
  });

  it("uses Virtuoso items-change for streaming same-id assistant updates (not following)", () => {
    const previousMessages = [
      makeMessageAt(0, "user", 100),
      makeMessageAt(1, "assistant", 200),
    ];
    const nextMessages = [
      previousMessages[0],
      { ...previousMessages[1], content: "streamed update" },
    ];

    expectItemsChangeScrollModifier(
      classifyChatScrollModifier({ previousMessages, nextMessages }),
      "smooth",
    );
  });

  it("bottom-follows streaming assistant updates while pinned", () => {
    const previousMessages = [
      makeMessageAt(0, "user", 100),
      makeMessageAt(1, "assistant", 200),
    ];
    const nextMessages = [
      previousMessages[0],
      { ...previousMessages[1], content: "streamed update" },
    ];

    expectAutoScrollModifier(
      classifyFollowingChatScrollModifier({ previousMessages, nextMessages }),
    );
  });

  it("keeps measured expansion item changes immediate", () => {
    expectItemsChangeScrollModifier(
      measuredItemChangeScrollModifier(false),
      "auto",
    );
  });

  it("bottom-follows measured expansion item changes while pinned", () => {
    expectAutoScrollModifier(measuredItemChangeScrollModifier(true));
  });

  it("purges cached heights for an edit-style user replacement", () => {
    const previousMessages = [
      makeMessageAt(0, "user", 100),
      makeMessageAt(1, "assistant", 200),
      makeMessageAt(2, "user", 300),
      makeMessageAt(3, "assistant", 400),
      makeMessageAt(4, "user", 500),
      makeMessageAt(5, "assistant", 600),
    ];
    const editedUserMessage = {
      ...makeMessageAt(6, "user", 300),
      id: "edited-user-message",
    };
    const nextMessages = [
      previousMessages[0],
      previousMessages[1],
      editedUserMessage,
    ];

    expectBranchResetScrollModifier(
      classifyChatScrollModifier({ previousMessages, nextMessages }),
      2,
    );
  });

  it("treats editing the first user row as a fresh branch root", () => {
    const previousMessages = makeMessages(20);
    const nextMessages = [
      {
        ...makeMessageAt(20, "user", 0),
        id: "edited-first-user-message",
      },
    ];

    expectBranchResetScrollModifier(
      classifyChatScrollModifier({ previousMessages, nextMessages }),
      0,
    );
  });

  it("does not infer bottom-follow intent when an assistant row is appended", () => {
    const previousMessages = [
      makeMessageAt(0, "user", 100),
      makeMessageAt(1, "assistant", 200),
    ];
    const nextMessages = [
      ...previousMessages,
      makeMessageAt(2, "assistant", 300),
    ];

    expectAppendedMessagesScrollModifier(
      classifyChatScrollModifier({ previousMessages, nextMessages }),
    );
  });

  it("keeps appended rows following when the reader is still pinned", () => {
    const previousMessages = [
      makeMessageAt(0, "user", 100),
      makeMessageAt(1, "assistant", 200),
    ];
    const nextMessages = [
      ...previousMessages,
      makeMessageAt(2, "assistant", 300),
    ];
    const autoScroll = expectAutoScrollModifier(
      classifyFollowingChatScrollModifier({ previousMessages, nextMessages }),
    );

    expect(
      autoScroll({
        atBottom: false,
        scrollInProgress: false,
        data: [],
        context: null,
        scrollLocation: {
          listOffset: 0,
          visibleListHeight: 500,
          scrollHeight: 1_000,
          bottomOffset: 300,
          isAtBottom: false,
          lastVisibleItemIndex: 0,
          lastItemBottomOffset: 300,
        },
      }),
    ).toBe("smooth");
  });

  it("never drags an unpinned reader sitting inside the bottom tolerance band", () => {
    const previousMessages = [
      makeMessageAt(0, "user", 100),
      makeMessageAt(1, "assistant", 200),
    ];
    const nextMessages = [
      ...previousMessages,
      makeMessageAt(2, "assistant", 300),
    ];
    const autoScroll = expectAutoScrollModifier(
      classifyChatScrollModifier({ previousMessages, nextMessages }),
    );

    expect(
      autoScroll({
        atBottom: false,
        scrollInProgress: false,
        data: [],
        context: null,
        scrollLocation: {
          listOffset: 0,
          visibleListHeight: 500,
          scrollHeight: 1_000,
          bottomOffset: 30,
          isAtBottom: false,
          lastVisibleItemIndex: 0,
          lastItemBottomOffset: 30,
        },
      }),
    ).toBe(false);
  });

  it("treats small bottom drift as still near the chat tail", () => {
    expect(
      isNearChatBottom({
        listOffset: 0,
        visibleListHeight: 500,
        scrollHeight: 1_000,
        bottomOffset: 24,
        isAtBottom: false,
        lastVisibleItemIndex: 0,
        lastItemBottomOffset: 24,
      }),
    ).toBe(true);
    expect(
      isNearChatBottom({
        listOffset: 0,
        visibleListHeight: 500,
        scrollHeight: 1_000,
        bottomOffset: 100,
        isAtBottom: false,
        lastVisibleItemIndex: 0,
        lastItemBottomOffset: 100,
      }),
    ).toBe(false);
  });

  it("does not move the viewport when a live assistant row becomes persisted", () => {
    const userMessage = makeMessageAt(0, "user", 100);
    const liveAssistantMessage = {
      ...makeMessageAt(1, "assistant", 200),
      id: "assistant:live",
    };
    const persistedAssistantMessage = {
      ...liveAssistantMessage,
      id: "assistant:turn-1",
      statusLabel: null,
      runState: null,
    };

    expect(
      classifyChatScrollModifier({
        previousMessages: [userMessage, liveAssistantMessage],
        nextMessages: [userMessage, persistedAssistantMessage],
      }),
    ).toBeUndefined();
  });

  it("does not re-anchor when an optimistic user message gets persisted under the same id", () => {
    const userMessage = makeMessageAt(0, "user", 100);
    const assistantMessage = makeMessageAt(1, "assistant", 200);
    const pendingNewUser = makeMessageAt(2, "user", 300);
    const previousMessages = [userMessage, assistantMessage, pendingNewUser];
    const nextMessages = [
      userMessage,
      assistantMessage,
      { ...pendingNewUser, statusLabel: null },
    ];

    expect(
      classifyChatScrollModifier({ previousMessages, nextMessages }),
    ).toBeUndefined();
  });

  it("bottom-follows when multiple new user rows arrive in a single update", () => {
    const previousMessages = [
      makeMessageAt(0, "user", 100),
      makeMessageAt(1, "assistant", 200),
    ];
    const nextMessages = [
      ...previousMessages,
      makeMessageAt(2, "user", 300),
      makeMessageAt(3, "user", 400),
    ];

    expectSubmittedUserScrollModifier(
      classifyChatScrollModifier({ previousMessages, nextMessages }),
    );
  });

  it("purges item sizes and re-anchors the tail when the setup-card weave shifts retained rows while following", () => {
    // The worktree-send shape: the pending shimmer renders after the user row,
    // then one update weaves the setup card ABOVE the user row and drops the
    // shimmer. The retained user row shifts index 0 -> 1, so its cached height
    // record now describes the shimmer - without a purge every later row is
    // painted inside the user bubble (the overlapping-messages bug).
    const userMessage = makeMessageAt(0, "user", 100);
    const pendingShimmer = {
      ...makeMessageAt(1, "assistant", 200),
      id: "assistant:live",
    };
    const setupCard = {
      ...makeMessageAt(2, "system", 50),
      id: "setup-card:tab-1:0",
    };

    expect(
      classifyFollowingChatScrollModifier({
        previousMessages: [userMessage, pendingShimmer],
        nextMessages: [setupCard, userMessage],
      }),
    ).toEqual({
      type: "item-location",
      location: { index: "LAST", align: "end", behavior: "auto" },
      purgeItemSizes: true,
    });
  });

  it("purges item sizes and anchors the first shifted row for an unpinned reader", () => {
    const messages = makeMessages(3);
    const genesisCard = {
      ...makeMessageAt(3, "system", 0),
      id: "setup-card:tab-1:genesis",
    };

    expect(
      classifyChatScrollModifier({
        previousMessages: messages,
        nextMessages: [genesisCard, ...messages],
      }),
    ).toEqual({
      type: "item-location",
      location: { index: 1, align: "start-no-overflow", behavior: "auto" },
      purgeItemSizes: true,
    });
  });

  it("purges item sizes at the tail when a send is coalesced with an index-shifting insertion", () => {
    // A new user row (newest createdAt) normally rides the unconditional
    // smooth scroll-to-tail - but when the SAME update also inserted a row
    // above retained ones, their index-keyed size records are stale and
    // `auto-scroll-to-bottom` cannot purge. The send must ride the
    // tail-anchored purge instead.
    const previousMessages = [
      makeMessageAt(0, "user", 100),
      makeMessageAt(1, "assistant", 200),
    ];
    const setupCard = {
      ...makeMessageAt(2, "system", 50),
      id: "setup-card:tab-1:0",
    };
    const newUser = makeMessageAt(3, "user", 300);

    expect(
      classifyChatScrollModifier({
        previousMessages,
        nextMessages: [setupCard, ...previousMessages, newUser],
      }),
    ).toEqual({
      type: "item-location",
      location: { index: "LAST", align: "end", behavior: "auto" },
      purgeItemSizes: true,
    });
  });

  it("purges item sizes when a non-user row is inserted mid-list", () => {
    const [first, second, third] = makeMessages(3);
    const insertedCard = {
      ...makeMessageAt(3, "system", 150),
      id: "setup-card:tab-1:1",
    };

    expect(
      classifyChatScrollModifier({
        previousMessages: [first, second, third],
        nextMessages: [first, insertedCard, second, third],
      }),
    ).toEqual({
      type: "item-location",
      location: { index: 2, align: "start-no-overflow", behavior: "auto" },
      purgeItemSizes: true,
    });
  });

  it("selects the active user id from the viewport anchor row", () => {
    const messages = [
      makeMessage(0, "user"),
      makeMessage(1, "assistant"),
      makeMessage(2, "assistant"),
      makeMessage(3, "user"),
      makeMessage(4, "assistant"),
    ];

    expect(selectActiveUserMessageId(messages, "message-2", false)).toBe(
      "message-0",
    );
    expect(selectActiveUserMessageId(messages, "message-3", false)).toBe(
      "message-3",
    );
    expect(selectActiveUserMessageId(messages, "message-4", false)).toBe(
      "message-3",
    );
    expect(selectActiveUserMessageId(messages, "message-0", true)).toBe(
      "message-3",
    );
  });

  it("finds the row under the viewport anchor instead of the first rendered row", () => {
    const scroller = document.createElement("div");
    setElementRect(scroller, 0, 500);
    appendMessageRow(scroller, "message-2", -40, 48);
    appendMessageRow(scroller, "message-3", 48, 128);
    appendMessageRow(scroller, "message-4", 128, 420);

    expect(chatViewportAnchorMessageId(scroller, 49)).toBe("message-3");
  });

  it("falls back to the closest viewport row when the anchor lands in a gap", () => {
    const scroller = document.createElement("div");
    setElementRect(scroller, 0, 500);
    appendMessageRow(scroller, "message-2", -40, 20);
    appendMessageRow(scroller, "message-3", 72, 128);

    expect(chatViewportAnchorMessageId(scroller, 49)).toBe("message-3");
  });

  it("maps minimap ids to Virtuoso item locations", () => {
    expect(
      chatScrollLocationForMessage(
        "message-3",
        buildMessageIdToIndex(makeMessages(5)),
        "smooth",
      ),
    ).toEqual({
      index: 3,
      align: "start",
      offset: -48,
      behavior: "smooth",
    });
  });
});

describe("chat item key / identity", () => {
  it("keys a present row by id", () => {
    const message = makeMessage(7, "user");

    expect(chatComputeItemKey({ data: message, index: 3 })).toBe("message-7");
    expect(chatItemIdentity(message)).toBe("message-7");
  });

  it("tolerates the transient undefined item message-list emits when the transcript shrinks", () => {
    // message-list reads `data[index]` past the freshly-shortened array while
    // its totalCount catches up, handing these callbacks an undefined item.
    // Dereferencing `data.id` here crashed the whole app; the key falls back to
    // a sentinel index key and the identity to null instead of throwing.
    expect(chatComputeItemKey({ data: undefined, index: 42 })).toBe(
      "missing-chat-row:42",
    );
    expect(chatItemIdentity(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// helpers — classify wrappers
// ---------------------------------------------------------------------------

function classifyChatScrollModifier(input: {
  readonly previousMessages: ReadonlyArray<ChatMessageModel> | null;
  readonly nextMessages: ReadonlyArray<ChatMessageModel>;
}): ScrollModifier {
  return classifyChatScrollPolicy({
    ...input,
    shouldFollowOutput: false,
  }).scrollModifier;
}

function classifyFollowingChatScrollModifier(input: {
  readonly previousMessages: ReadonlyArray<ChatMessageModel> | null;
  readonly nextMessages: ReadonlyArray<ChatMessageModel>;
}): ScrollModifier {
  return classifyChatScrollPolicy({
    ...input,
    shouldFollowOutput: true,
  }).scrollModifier;
}

function appendMessageRow(
  scroller: HTMLElement,
  messageId: string,
  top: number,
  bottom: number,
): void {
  const row = document.createElement("div");
  row.dataset.messageId = messageId;
  setElementRect(row, top, bottom);
  scroller.append(row);
}

function setElementRect(element: Element, top: number, bottom: number): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => makeDomRect(top, bottom),
  });
}

function makeDomRect(top: number, bottom: number): DOMRect {
  return {
    bottom,
    height: bottom - top,
    left: 0,
    right: 100,
    top,
    width: 100,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

// ---------------------------------------------------------------------------
// assertion helpers
// ---------------------------------------------------------------------------

function expectSubmittedUserScrollModifier(modifier: ScrollModifier): void {
  const autoScroll = expectAutoScrollModifier(modifier);

  expect(
    autoScroll({
      atBottom: true,
      scrollInProgress: false,
      data: [],
      context: null,
      scrollLocation: {
        listOffset: 0,
        visibleListHeight: 500,
        scrollHeight: 1_000,
        bottomOffset: 0,
        isAtBottom: true,
        lastVisibleItemIndex: 0,
        lastItemBottomOffset: 0,
      },
    }),
  ).toEqual({
    index: "LAST",
    align: "end",
    behavior: "smooth",
  });
  expect(
    autoScroll({
      atBottom: false,
      scrollInProgress: false,
      data: [],
      context: null,
      scrollLocation: {
        listOffset: 0,
        visibleListHeight: 500,
        scrollHeight: 1_000,
        bottomOffset: 100,
        isAtBottom: false,
        lastVisibleItemIndex: 0,
        lastItemBottomOffset: 100,
      },
    }),
  ).toEqual({
    index: "LAST",
    align: "end",
    behavior: "auto",
  });
}

function expectBranchResetScrollModifier(
  modifier: ScrollModifier,
  expectedIndex: number,
): void {
  expect(modifier).toEqual({
    type: "item-location",
    location: {
      index: expectedIndex,
      align: "start-no-overflow",
      behavior: "auto",
    },
    purgeItemSizes: true,
  });
}

function expectAppendedMessagesScrollModifier(modifier: ScrollModifier): void {
  const autoScroll = expectAutoScrollModifier(modifier);

  expect(
    autoScroll({
      atBottom: true,
      scrollInProgress: false,
      data: [],
      context: null,
      scrollLocation: {
        listOffset: 0,
        visibleListHeight: 500,
        scrollHeight: 1_000,
        bottomOffset: 0,
        isAtBottom: true,
        lastVisibleItemIndex: 0,
        lastItemBottomOffset: 0,
      },
    }),
  ).toBe(false);
  expect(
    autoScroll({
      atBottom: false,
      scrollInProgress: false,
      data: [],
      context: null,
      scrollLocation: {
        listOffset: 0,
        visibleListHeight: 500,
        scrollHeight: 1_000,
        bottomOffset: 100,
        isAtBottom: false,
        lastVisibleItemIndex: 0,
        lastItemBottomOffset: 100,
      },
    }),
  ).toBe(false);
}

function expectAutoScrollModifier(
  modifier: ScrollModifier,
): ItemLocationCallback {
  if (
    modifier === null ||
    modifier === undefined ||
    typeof modifier !== "object" ||
    modifier.type !== "auto-scroll-to-bottom"
  ) {
    throw new Error("expected auto-scroll-to-bottom modifier");
  }
  if (typeof modifier.autoScroll !== "function") {
    throw new Error("expected callback autoScroll");
  }
  return modifier.autoScroll;
}

function expectItemsChangeScrollModifier(
  modifier: ScrollModifier,
  behavior: "auto" | "smooth",
): void {
  expect(modifier).toEqual({
    type: "items-change",
    behavior,
  });
}
