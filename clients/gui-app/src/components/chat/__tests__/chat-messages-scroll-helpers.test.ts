import { describe, expect, it } from "vitest";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import {
  acceptExhaustedPersistedRestoreFallback,
  buildRowKeyToIndex,
  chatTimelineGetItemType,
  chatTimelineLocationForMessage,
  chatTimelineNavigationLandedAtLocation,
  chatViewportAnchorRowIndex,
  CHAT_ARROW_SCROLL_STEP_PX,
  CHAT_TIMELINE_NAVIGATION_VIEW_OFFSET_PX,
  selectActiveUserMessageId,
  viewportActiveUserMessageId,
  viewportAnchorRowKey,
} from "@/components/chat/chat-messages-scroll-helpers";
import { transcriptListRows } from "@/stores/chats/transcript-list-rows";
import { makeMessageAt } from "./chat-message-fixtures";

function user(id: string, createdAt: number): ChatMessageModel {
  return {
    ...makeMessageAt(0, "user", createdAt),
    id,
    content: `User ${id}`,
  };
}

function assistant(id: string, createdAt: number): ChatMessageModel {
  return {
    ...makeMessageAt(0, "assistant", createdAt),
    id,
  };
}

function a2aUser(id: string, createdAt: number): ChatMessageModel {
  return {
    ...user(id, createdAt),
    agentSenderInfo: {
      agentId: "agent-1",
      senderTitle: "Peer",
      expectReply: false,
      responseId: null,
    },
  };
}

function rowsOf(messages: ReadonlyArray<ChatMessageModel>) {
  return transcriptListRows({ window: null, rendered: messages });
}

function rowOf(message: ChatMessageModel) {
  return rowsOf([message])[0];
}

describe("buildRowKeyToIndex", () => {
  it("maps each message id to its index", () => {
    const messages = [user("a", 1), assistant("b", 2), user("c", 3)];
    const rows = rowsOf(messages);
    expect(buildRowKeyToIndex(rows).get("a")).toBe(0);
    expect(buildRowKeyToIndex(rows).get("b")).toBe(1);
    expect(buildRowKeyToIndex(rows).get("c")).toBe(2);
    expect(buildRowKeyToIndex(rows).get("missing")).toBeUndefined();
  });
});

describe("chatTimelineLocationForMessage", () => {
  it("returns navigation location with the fixed view offset", () => {
    const indexById = buildRowKeyToIndex(
      rowsOf([user("a", 1), assistant("b", 2)]),
    );
    expect(chatTimelineLocationForMessage("b", indexById, true)).toEqual({
      index: 1,
      viewOffset: CHAT_TIMELINE_NAVIGATION_VIEW_OFFSET_PX,
      animated: true,
    });
  });

  it("returns null when the message id is unknown", () => {
    const indexById = buildRowKeyToIndex(rowsOf([user("a", 1)]));
    expect(
      chatTimelineLocationForMessage("missing", indexById, false),
    ).toBeNull();
  });
});

describe("chatTimelineNavigationLandedAtLocation (Ticket 10)", () => {
  const location = {
    index: 5,
    viewOffset: CHAT_TIMELINE_NAVIGATION_VIEW_OFFSET_PX,
    animated: true,
  } as const;

  it("returns true when the target row sits exactly at viewOffset", () => {
    // position 900 + header 40 - scroll 892 = 48 viewOffset.
    expect(
      chatTimelineNavigationLandedAtLocation(
        {
          positionAtIndex: (index) => (index === 5 ? 900 : undefined),
          scroll: 900 + 40 - CHAT_TIMELINE_NAVIGATION_VIEW_OFFSET_PX,
          topOffsetAdjustment: 40,
        },
        location,
        1,
      ),
    ).toBe(true);
  });

  it("returns false when the landing is off by more than epsilon (undershoot)", () => {
    expect(
      chatTimelineNavigationLandedAtLocation(
        {
          positionAtIndex: (index) => (index === 5 ? 900 : undefined),
          scroll: 200,
          topOffsetAdjustment: 40,
        },
        location,
        1,
      ),
    ).toBe(false);
  });

  it("returns false for an unmeasured row (no positionAtIndex)", () => {
    expect(
      chatTimelineNavigationLandedAtLocation(
        {
          positionAtIndex: () => undefined,
          scroll: 0,
          topOffsetAdjustment: 0,
        },
        location,
        1,
      ),
    ).toBe(false);
  });

  it("tolerates floating-point noise within epsilon", () => {
    expect(
      chatTimelineNavigationLandedAtLocation(
        {
          positionAtIndex: (index) => (index === 5 ? 900 : undefined),
          scroll: 900 + 40 - CHAT_TIMELINE_NAVIGATION_VIEW_OFFSET_PX + 0.4,
          topOffsetAdjustment: 40,
        },
        location,
        1,
      ),
    ).toBe(true);
  });
});

describe("selectActiveUserMessageId", () => {
  const messages: ReadonlyArray<ChatMessageModel> = [
    user("u0", 1),
    assistant("a0", 2),
    user("u1", 3),
    a2aUser("a2a", 4),
    assistant("a1", 5),
    user("u2", 6),
  ];

  it("returns the last human user message when at bottom", () => {
    expect(selectActiveUserMessageId(messages, "u0", true)).toBe("u2");
  });

  it("ignores agent-to-agent role=user rows for the rail active id", () => {
    expect(selectActiveUserMessageId(messages, "a2a", false)).toBe("u1");
  });

  it("returns null when there are no human user messages", () => {
    expect(
      selectActiveUserMessageId(
        [assistant("a0", 1), a2aUser("a2a", 2)],
        null,
        true,
      ),
    ).toBeNull();
  });

  it("falls back to the last human user when viewport row is null or unknown", () => {
    expect(selectActiveUserMessageId(messages, null, false)).toBe("u2");
    expect(selectActiveUserMessageId(messages, "missing", false)).toBe("u2");
  });

  it("selects the human user at or before the viewport row", () => {
    expect(selectActiveUserMessageId(messages, "a0", false)).toBe("u0");
    expect(selectActiveUserMessageId(messages, "a1", false)).toBe("u1");
    expect(selectActiveUserMessageId(messages, "u2", false)).toBe("u2");
  });

  it("looks forward when the viewport is before any human user", () => {
    const leadingAssistant: ReadonlyArray<ChatMessageModel> = [
      assistant("lead", 0),
      user("u0", 1),
      assistant("a0", 2),
    ];
    expect(selectActiveUserMessageId(leadingAssistant, "lead", false)).toBe(
      "u0",
    );
  });
});

describe("chatViewportAnchorRowIndex + viewportActiveUserMessageId", () => {
  /** `positionAtIndex` is monotonically increasing with row index - LegendList's
   *  own measured-position contract - so a plain array lookup fakes it exactly. */
  function stateWithRowTops(rowTops: ReadonlyArray<number>, scroll: number) {
    return {
      scroll,
      positionAtIndex: (index: number) => rowTops[index],
    };
  }

  it("returns null when there are no rows or positions cannot be measured", () => {
    expect(chatViewportAnchorRowIndex({ scroll: 0 }, 0, 48)).toBeNull();
    expect(chatViewportAnchorRowIndex({ scroll: 0 }, 3, 48)).toBeNull();
  });

  it("returns the last row whose top has scrolled past the anchor line", () => {
    const state = stateWithRowTops([0, 100, 200], 0);
    // anchor at top + 48 → still inside row 0 (top 0..100)
    expect(chatViewportAnchorRowIndex(state, 3, 48)).toBe(0);
    // anchor at top + 150 → row 1 (top 100..200)
    expect(chatViewportAnchorRowIndex(state, 3, 150)).toBe(1);
    // anchor at top + 250 → row 2 (top 200..)
    expect(chatViewportAnchorRowIndex(state, 3, 250)).toBe(2);
  });

  it("resolves relative to the current scroll offset, not just the raw anchor pixel", () => {
    const state = stateWithRowTops([0, 100, 200], 100);
    // scroll=100, anchor offset 49 → target 149 → row 1
    expect(chatViewportAnchorRowIndex(state, 3, 49)).toBe(1);
  });

  it("maps the viewport row to the owning human user message", () => {
    const messages: ReadonlyArray<ChatMessageModel> = [
      user("u0", 1),
      assistant("a0", 2),
      user("u1", 3),
    ];
    const state = stateWithRowTops([0, 90, 180], 0);
    const rows = rowsOf(messages);
    // Default anchor offset is NAV_OFFSET + 1 = 49 → still row 0 (u0)
    expect(viewportActiveUserMessageId(state, rows, messages)).toBe("u0");
  });

  it("keeps the physical assistant row for scroll restoration", () => {
    const messages: ReadonlyArray<ChatMessageModel> = [
      user("u0", 1),
      assistant("a0", 2),
      user("u1", 3),
    ];
    const rows = rowsOf(messages);
    const state = stateWithRowTops([0, 90, 990], 400);

    expect(viewportAnchorRowKey(state, rows)).toBe("a0");
    expect(viewportActiveUserMessageId(state, rows, messages)).toBe("u0");
  });

  it("returns null when the list state cannot be measured", () => {
    const messages = [user("u0", 1)];
    expect(
      viewportActiveUserMessageId({ scroll: 0 }, rowsOf(messages), messages),
    ).toBeNull();
  });

  it("subtracts the header offset before comparing (decision #18 - positionAtIndex is content-relative, scroll is not)", () => {
    // Row 0 is short (position 0), row 1 starts right after it at content
    // position 10 - both fall within an 80px header, so an unadjusted
    // comparison against raw scroll=80 would spuriously pick row 1.
    const state = {
      scroll: 80,
      positionAtIndex: (index: number) => [0, 10][index],
      topOffsetAdjustment: 80,
    };
    // Content-relative target = scroll - topOffsetAdjustment + 0 = 0 -> row 0.
    expect(chatViewportAnchorRowIndex(state, 2, 0)).toBe(0);
  });

  it("returns null (not a partial-search bogus index) when a probed row is unmeasured", () => {
    // Only index 0 is measured; any probe that lands on 1 or 2 mid-search
    // must not fall back to a stale/initial result.
    const state = {
      scroll: 500,
      positionAtIndex: (index: number) => (index === 0 ? 0 : undefined),
    };
    expect(chatViewportAnchorRowIndex(state, 3, 0)).toBeNull();
  });
});

describe("chatTimelineGetItemType", () => {
  it("splits human-sent user rows from A2A agent-sent rows", () => {
    const human = user("h", 1);
    const a2a = a2aUser("a", 2);
    const humanRow = rowOf(human);
    const a2aRow = rowOf(a2a);
    expect(chatTimelineGetItemType(humanRow)).toBe("user:human");
    expect(chatTimelineGetItemType(a2aRow)).toBe("user:a2a");
    expect(chatTimelineGetItemType(rowOf(assistant("x", 3)))).toBe("assistant");
    expect(chatTimelineGetItemType(humanRow)).not.toBe(
      chatTimelineGetItemType(a2aRow),
    );
  });
});

describe("acceptExhaustedPersistedRestoreFallback", () => {
  it("clears both restore-pending gates", () => {
    const restorePersistencePendingRef = { current: true };
    const pendingMeasuredRestoreRef = {
      current: { messageId: "saved-row", viewOffset: 10_000 },
    };

    acceptExhaustedPersistedRestoreFallback(
      restorePersistencePendingRef,
      pendingMeasuredRestoreRef,
    );

    expect(restorePersistencePendingRef.current).toBe(false);
    expect(pendingMeasuredRestoreRef.current).toBeNull();
  });
});

describe("constants", () => {
  it("exposes the Chromium-matching arrow scroll step", () => {
    expect(CHAT_ARROW_SCROLL_STEP_PX).toBe(40);
  });

  it("exposes the navigation reveal offset", () => {
    expect(CHAT_TIMELINE_NAVIGATION_VIEW_OFFSET_PX).toBe(48);
  });
});
