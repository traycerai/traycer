import { describe, expect, it } from "vitest";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import {
  buildMessageIdToIndex,
  chatTimelineLocationForMessage,
  chatTimelineNavigationLandedAtLocation,
  chatViewportAnchorRowIndex,
  classifyChatEdgeMutation,
  CHAT_ARROW_SCROLL_STEP_PX,
  CHAT_TIMELINE_NAVIGATION_VIEW_OFFSET_PX,
  selectActiveUserMessageId,
  viewportActiveUserMessageId,
} from "@/components/chat/chat-messages-scroll-helpers";
import { makeMessageAt } from "./chat-message-fixtures";

function user(id: string, createdAt: number): ChatMessageModel {
  return userWithPersistentId(id, createdAt, null);
}

/**
 * Models a message with an explicit `persistentMessageId` - `null` is a
 * same-frame optimistic echo (composer send); the message's own id models a
 * real host-confirmed row (queued flush / A2A / steer-or-edit round-trip).
 * Decision #9's gating tests need this distinction; every other test uses
 * the `user`/`a2aUser` shorthand (implicitly `null`, matching
 * `makeMessageAt`'s default).
 */
function userWithPersistentId(
  id: string,
  createdAt: number,
  persistentMessageId: string | null,
): ChatMessageModel {
  return {
    ...makeMessageAt(0, "user", createdAt),
    id,
    content: `User ${id}`,
    persistentMessageId,
  };
}

function assistant(id: string, createdAt: number): ChatMessageModel {
  return {
    ...makeMessageAt(0, "assistant", createdAt),
    id,
  };
}

function a2aUser(id: string, createdAt: number): ChatMessageModel {
  return a2aUserWithPersistentId(id, createdAt, null);
}

function a2aUserWithPersistentId(
  id: string,
  createdAt: number,
  persistentMessageId: string | null,
): ChatMessageModel {
  return {
    ...userWithPersistentId(id, createdAt, persistentMessageId),
    agentSenderInfo: {
      agentId: "agent-1",
      senderTitle: "Peer",
      expectReply: false,
      responseId: null,
    },
  };
}

function idsOf(
  messages: ReadonlyArray<ChatMessageModel>,
): ReadonlyArray<string> {
  return messages.map((message) => message.id);
}

describe("buildMessageIdToIndex", () => {
  it("maps each message id to its index", () => {
    const messages = [user("a", 1), assistant("b", 2), user("c", 3)];
    expect(buildMessageIdToIndex(messages).get("a")).toBe(0);
    expect(buildMessageIdToIndex(messages).get("b")).toBe(1);
    expect(buildMessageIdToIndex(messages).get("c")).toBe(2);
    expect(buildMessageIdToIndex(messages).get("missing")).toBeUndefined();
  });
});

describe("chatTimelineLocationForMessage", () => {
  it("returns navigation location with the fixed view offset", () => {
    const indexById = buildMessageIdToIndex([user("a", 1), assistant("b", 2)]);
    expect(chatTimelineLocationForMessage("b", indexById, true)).toEqual({
      index: 1,
      viewOffset: CHAT_TIMELINE_NAVIGATION_VIEW_OFFSET_PX,
      animated: true,
    });
  });

  it("returns null when the message id is unknown", () => {
    const indexById = buildMessageIdToIndex([user("a", 1)]);
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
    // Several viewports short - the video-evidence root cause class.
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
    // Default anchor offset is NAV_OFFSET + 1 = 49 → still row 0 (u0)
    expect(viewportActiveUserMessageId(state, messages)).toBe("u0");
  });

  it("returns null when the list state cannot be measured", () => {
    expect(
      viewportActiveUserMessageId({ scroll: 0 }, [user("u0", 1)]),
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

/** Every existing call site passes all five fields explicitly (no optional
 *  params/defaults, per repo convention) - this just saves re-typing the
 *  common `hadSavedScrollState: true, localProvenanceMessageIds: NO_PROVENANCE`
 *  pair for the many tests that don't care about either. */
function classify(input: {
  readonly previousMessages: ReadonlyArray<ChatMessageModel> | null;
  readonly nextMessages: ReadonlyArray<ChatMessageModel>;
  readonly isFollowingEnd: boolean;
  readonly hadSavedScrollState: boolean;
  readonly localProvenanceMessageIds: ReadonlySet<string>;
}) {
  return classifyChatEdgeMutation(input);
}

const NO_PROVENANCE: ReadonlySet<string> = new Set();

function provenance(...ids: ReadonlyArray<string>): ReadonlySet<string> {
  return new Set(ids);
}

describe("classifyChatEdgeMutation", () => {
  const base: ReadonlyArray<ChatMessageModel> = [
    user("u0", 1),
    assistant("a0", 2),
    user("u1", 3),
    assistant("a1", 4),
  ];

  describe("(a) empty next", () => {
    it("resets to following-end with no action", () => {
      expect(
        classify({
          previousMessages: base,
          nextMessages: [],
          isFollowingEnd: false,
          hadSavedScrollState: true,
          localProvenanceMessageIds: NO_PROVENANCE,
        }),
      ).toEqual({ action: { kind: "none" }, nextMode: "following-end" });
    });
  });

  describe("(b) first non-empty render (decision #8/#15)", () => {
    it("anchors unconditionally when the first row is a local-provenance match (send into a brand-new empty chat)", () => {
      const firstMessage = userWithPersistentId("first-local-send", 1, null);
      expect(
        classify({
          previousMessages: null,
          nextMessages: [firstMessage],
          isFollowingEnd: false,
          hadSavedScrollState: true,
          localProvenanceMessageIds: provenance("first-local-send"),
        }),
      ).toEqual({
        action: {
          kind: "anchor-new-turn",
          messageId: "first-local-send",
          animated: true,
        },
        nextMode: null,
      });
    });

    it("re-derives fresh-open (non-animated, last user message) when no saved state and no local match", () => {
      // A chat tile can mount empty (before its snapshot loads); this
      // transition is the snapshot finally bringing in real history - not a
      // local action.
      expect(
        classify({
          previousMessages: [],
          nextMessages: base,
          isFollowingEnd: false,
          hadSavedScrollState: false,
          localProvenanceMessageIds: NO_PROVENANCE,
        }),
      ).toEqual({
        action: { kind: "anchor-new-turn", messageId: "u1", animated: false },
        nextMode: null,
      });
    });

    it("does nothing when a saved scroll state exists and there is no local match (a restored free-scrolling mode must survive)", () => {
      expect(
        classify({
          previousMessages: null,
          nextMessages: base,
          isFollowingEnd: false,
          hadSavedScrollState: true,
          localProvenanceMessageIds: NO_PROVENANCE,
        }),
      ).toEqual({ action: { kind: "none" }, nextMode: null });

      expect(
        classify({
          previousMessages: [],
          nextMessages: base,
          isFollowingEnd: true,
          hadSavedScrollState: true,
          localProvenanceMessageIds: NO_PROVENANCE,
        }),
      ).toEqual({ action: { kind: "none" }, nextMode: null });
    });

    it("does nothing when there is no saved state but also no user row to anchor", () => {
      const assistantOnly = [assistant("a0", 1)];
      expect(
        classify({
          previousMessages: null,
          nextMessages: assistantOnly,
          isFollowingEnd: false,
          hadSavedScrollState: false,
          localProvenanceMessageIds: NO_PROVENANCE,
        }),
      ).toEqual({ action: { kind: "none" }, nextMode: null });
    });
  });

  describe("(c) suffix removal", () => {
    const next = base.slice(0, 2);

    it("scrolls to end and stays following when isFollowingEnd", () => {
      expect(
        classify({
          previousMessages: base,
          nextMessages: next,
          isFollowingEnd: true,
          hadSavedScrollState: true,
          localProvenanceMessageIds: NO_PROVENANCE,
        }),
      ).toEqual({
        action: { kind: "scroll-to-end" },
        nextMode: "following-end",
      });
    });

    it("scrolls to the new last index without forcing mode when free-scrolling", () => {
      expect(
        classify({
          previousMessages: base,
          nextMessages: next,
          isFollowingEnd: false,
          hadSavedScrollState: true,
          localProvenanceMessageIds: NO_PROVENANCE,
        }),
      ).toEqual({
        action: { kind: "scroll-to-index", index: 1 },
        nextMode: null,
      });
    });

    it("does not treat a non-prefix shrink as suffix removal", () => {
      // Different first row → not a strict prefix.
      const diverged = [user("other", 1), assistant("a0", 2)];
      const outcome = classify({
        previousMessages: base,
        nextMessages: diverged,
        isFollowingEnd: true,
        hadSavedScrollState: true,
        localProvenanceMessageIds: NO_PROVENANCE,
      });
      // Hits the candidate-detection / fallback path instead of suffix
      // removal's scroll-to-end + following-end.
      expect(outcome).not.toEqual({
        action: { kind: "scroll-to-index", index: 1 },
        nextMode: null,
      });
    });
  });

  describe("(d) new/replaced user row - local provenance is unconditional (decision #8)", () => {
    it("anchors a first-divergence replacement (steer / inline edit) when its id is a local-provenance match, even while free-scrolling", () => {
      // Replace the second user turn with a brand-new user message
      // (editUserMessage's branch-edit / same-turn-steer shape).
      const next: ReadonlyArray<ChatMessageModel> = [
        base[0],
        base[1],
        userWithPersistentId("u-branch", 10, "u-branch"),
      ];
      expect(
        classify({
          previousMessages: base,
          nextMessages: next,
          isFollowingEnd: false,
          hadSavedScrollState: true,
          localProvenanceMessageIds: provenance("u-branch"),
        }),
      ).toEqual({
        action: {
          kind: "anchor-new-turn",
          messageId: "u-branch",
          animated: true,
        },
        nextMode: null,
      });
    });

    it("anchors a tail append (composer send) when its id is a local-provenance match, even while free-scrolling", () => {
      const next: ReadonlyArray<ChatMessageModel> = [
        ...base,
        userWithPersistentId("u-send", 100, null),
      ];
      expect(
        classify({
          previousMessages: base,
          nextMessages: next,
          isFollowingEnd: false,
          hadSavedScrollState: true,
          localProvenanceMessageIds: provenance("u-send"),
        }),
      ).toEqual({
        action: {
          kind: "anchor-new-turn",
          messageId: "u-send",
          animated: true,
        },
        nextMode: null,
      });
    });

    it("does not treat a pure prepend as a candidate, even when the prepended id is locally provenanced", () => {
      // Decision #14: older-history hydration never anchors, whatever ids
      // it introduces - a coincidental registry match must not override it.
      const next: ReadonlyArray<ChatMessageModel> = [
        user("history-0", 0),
        ...base,
      ];
      const outcome = classify({
        previousMessages: base,
        nextMessages: next,
        isFollowingEnd: true,
        hadSavedScrollState: true,
        localProvenanceMessageIds: provenance("history-0"),
      });
      expect(outcome).toEqual({ action: { kind: "none" }, nextMode: null });
    });
  });

  describe("(e) new/replaced user row - not locally provenanced is gated on isFollowingEnd (decision #9)", () => {
    it("anchors a host-confirmed tail append (queued auto-flush / A2A row) when already following-end", () => {
      const next: ReadonlyArray<ChatMessageModel> = [
        ...base,
        userWithPersistentId("u-flush", 100, "u-flush"),
      ];
      expect(
        classify({
          previousMessages: base,
          nextMessages: next,
          isFollowingEnd: true,
          hadSavedScrollState: true,
          localProvenanceMessageIds: NO_PROVENANCE,
        }),
      ).toEqual({
        action: {
          kind: "anchor-new-turn",
          messageId: "u-flush",
          animated: true,
        },
        nextMode: null,
      });
    });

    it("stays put (no action, no mode change) for the same row while free-scrolling", () => {
      const next: ReadonlyArray<ChatMessageModel> = [
        ...base,
        userWithPersistentId("u-flush-free", 100, "u-flush-free"),
      ];
      expect(
        classify({
          previousMessages: base,
          nextMessages: next,
          isFollowingEnd: false,
          hadSavedScrollState: true,
          localProvenanceMessageIds: NO_PROVENANCE,
        }),
      ).toEqual({ action: { kind: "none" }, nextMode: null });
    });

    it("gates a first-divergence replacement the same way when its id is NOT a local match (another window's edit reaching this one via a reconnect snapshot)", () => {
      const next: ReadonlyArray<ChatMessageModel> = [
        base[0],
        base[1],
        userWithPersistentId(
          "u-replaced-elsewhere",
          50,
          "u-replaced-elsewhere",
        ),
        assistant("a1", 4),
      ];
      expect(
        classify({
          previousMessages: base,
          nextMessages: next,
          isFollowingEnd: true,
          hadSavedScrollState: true,
          localProvenanceMessageIds: NO_PROVENANCE,
        }),
      ).toEqual({
        action: {
          kind: "anchor-new-turn",
          messageId: "u-replaced-elsewhere",
          animated: true,
        },
        nextMode: null,
      });

      expect(
        classify({
          previousMessages: base,
          nextMessages: next,
          isFollowingEnd: false,
          hadSavedScrollState: true,
          localProvenanceMessageIds: NO_PROVENANCE,
        }),
      ).toEqual({ action: { kind: "none" }, nextMode: null });
    });

    it("bridges an A2A role=user append at the tail the same way (following-end anchors, free-scrolling stays put)", () => {
      const next: ReadonlyArray<ChatMessageModel> = [
        ...base,
        a2aUserWithPersistentId("a2a-send", 100, "a2a-send"),
      ];
      expect(
        classify({
          previousMessages: base,
          nextMessages: next,
          isFollowingEnd: true,
          hadSavedScrollState: true,
          localProvenanceMessageIds: NO_PROVENANCE,
        }),
      ).toEqual({
        action: {
          kind: "anchor-new-turn",
          messageId: "a2a-send",
          animated: true,
        },
        nextMode: null,
      });

      expect(
        classify({
          previousMessages: base,
          nextMessages: next,
          isFollowingEnd: false,
          hadSavedScrollState: true,
          localProvenanceMessageIds: NO_PROVENANCE,
        }),
      ).toEqual({ action: { kind: "none" }, nextMode: null });
    });

    it("prefers a local-provenance match over a co-arriving non-local candidate, else gates on the tail-most one", () => {
      // Two new user rows in the same batch: an A2A row mid-array and a
      // local send at the tail. The local match wins regardless of order.
      const next: ReadonlyArray<ChatMessageModel> = [
        base[0],
        base[1],
        a2aUserWithPersistentId("a2a-co-arrival", 3.5, "a2a-co-arrival"),
        base[2],
        base[3],
        userWithPersistentId("local-co-arrival", 100, null),
      ];
      expect(
        classify({
          previousMessages: base,
          nextMessages: next,
          isFollowingEnd: false,
          hadSavedScrollState: true,
          localProvenanceMessageIds: provenance("local-co-arrival"),
        }),
      ).toEqual({
        action: {
          kind: "anchor-new-turn",
          messageId: "local-co-arrival",
          animated: true,
        },
        nextMode: null,
      });
    });
  });

  describe("(f) append-only streamed growth", () => {
    it("takes no action for assistant (or non-user) appends", () => {
      const next: ReadonlyArray<ChatMessageModel> = [
        ...base,
        assistant("a-stream", 5),
      ];
      expect(
        classify({
          previousMessages: base,
          nextMessages: next,
          isFollowingEnd: true,
          hadSavedScrollState: true,
          localProvenanceMessageIds: NO_PROVENANCE,
        }),
      ).toEqual({ action: { kind: "none" }, nextMode: null });

      expect(
        classify({
          previousMessages: base,
          nextMessages: next,
          isFollowingEnd: false,
          hadSavedScrollState: true,
          localProvenanceMessageIds: NO_PROVENANCE,
        }),
      ).toEqual({ action: { kind: "none" }, nextMode: null });
    });
  });

  describe("(g) trailing-assistant in-place change", () => {
    it("takes no action when only the last assistant object's identity changes", () => {
      const previous = base;
      const next: ReadonlyArray<ChatMessageModel> = [
        previous[0],
        previous[1],
        previous[2],
        { ...previous[3], content: "token" },
      ];
      expect(idsOf(previous)).toEqual(idsOf(next));
      expect(
        classify({
          previousMessages: previous,
          nextMessages: next,
          isFollowingEnd: true,
          hadSavedScrollState: true,
          localProvenanceMessageIds: NO_PROVENANCE,
        }),
      ).toEqual({ action: { kind: "none" }, nextMode: null });
    });

    it("does not treat a trailing user identity change as trailing-assistant", () => {
      const previous: ReadonlyArray<ChatMessageModel> = [
        user("u0", 1),
        assistant("a0", 2),
        user("u1", 3),
      ];
      const next: ReadonlyArray<ChatMessageModel> = [
        previous[0],
        previous[1],
        { ...previous[2], content: "edited" },
      ];
      // Same ids, trailing is user not assistant → falls through to none.
      expect(
        classify({
          previousMessages: previous,
          nextMessages: next,
          isFollowingEnd: false,
          hadSavedScrollState: true,
          localProvenanceMessageIds: NO_PROVENANCE,
        }),
      ).toEqual({ action: { kind: "none" }, nextMode: null });
    });
  });

  describe("(h) shifted retained row", () => {
    it("takes no action when following (trusts the reveal-pass + maintainScrollAtEnd catch-up)", () => {
      // Weave: insert an assistant row near the head so retained rows shift
      // right - not a candidate (assistant, not user); not append-only. A
      // dedicated scroll-to-end branch for this case was removed as
      // redundant with the reveal-pass effect and `maintainScrollAtEnd`
      // while following - both isFollowingEnd values land on `none`.
      const next: ReadonlyArray<ChatMessageModel> = [
        user("u0", 1),
        assistant("a-insert", 1.5),
        assistant("a0", 2),
        user("u1", 3),
        assistant("a1", 4),
      ];
      expect(
        classify({
          previousMessages: base,
          nextMessages: next,
          isFollowingEnd: true,
          hadSavedScrollState: true,
          localProvenanceMessageIds: NO_PROVENANCE,
        }),
      ).toEqual({
        action: { kind: "none" },
        nextMode: null,
      });
    });

    it("takes no action when free-scrolling (trusts maintainVisibleContentPosition)", () => {
      const next: ReadonlyArray<ChatMessageModel> = [
        user("u0", 1),
        assistant("a-insert", 1.5),
        assistant("a0", 2),
        user("u1", 3),
        assistant("a1", 4),
      ];
      expect(
        classify({
          previousMessages: base,
          nextMessages: next,
          isFollowingEnd: false,
          hadSavedScrollState: true,
          localProvenanceMessageIds: NO_PROVENANCE,
        }),
      ).toEqual({ action: { kind: "none" }, nextMode: null });
    });
  });

  describe("(i) fallback", () => {
    it("takes no action for identical lists", () => {
      expect(
        classify({
          previousMessages: base,
          nextMessages: base,
          isFollowingEnd: true,
          hadSavedScrollState: true,
          localProvenanceMessageIds: NO_PROVENANCE,
        }),
      ).toEqual({ action: { kind: "none" }, nextMode: null });
    });

    it("takes no action for a pure history prepend of non-user rows", () => {
      const next: ReadonlyArray<ChatMessageModel> = [
        assistant("hist-a", 0),
        ...base,
      ];
      const outcome = classify({
        previousMessages: base,
        nextMessages: next,
        isFollowingEnd: false,
        hadSavedScrollState: true,
        localProvenanceMessageIds: NO_PROVENANCE,
      });
      expect(outcome).toEqual({ action: { kind: "none" }, nextMode: null });
    });
  });

  describe("priority order", () => {
    it("checks empty next before first-render semantics", () => {
      // previous null + next empty still hits empty-next first
      expect(
        classify({
          previousMessages: null,
          nextMessages: [],
          isFollowingEnd: false,
          hadSavedScrollState: true,
          localProvenanceMessageIds: NO_PROVENANCE,
        }),
      ).toEqual({ action: { kind: "none" }, nextMode: "following-end" });
    });

    it("checks suffix removal before candidate detection", () => {
      // A shorter strict prefix could also look like a "change" but suffix
      // removal is first and must win.
      const next = base.slice(0, 3);
      expect(
        classify({
          previousMessages: base,
          nextMessages: next,
          isFollowingEnd: false,
          hadSavedScrollState: true,
          localProvenanceMessageIds: NO_PROVENANCE,
        }),
      ).toEqual({
        action: { kind: "scroll-to-index", index: 2 },
        nextMode: null,
      });
    });

    it("checks the prepend guard before candidate detection", () => {
      // Prepend of a locally-provenanced user id: the prepend guard must
      // win, or this would wrongly anchor via registry membership.
      const next: ReadonlyArray<ChatMessageModel> = [
        user("prepended-local", 0),
        ...base,
      ];
      expect(
        classify({
          previousMessages: base,
          nextMessages: next,
          isFollowingEnd: true,
          hadSavedScrollState: true,
          localProvenanceMessageIds: provenance("prepended-local"),
        }),
      ).toEqual({ action: { kind: "none" }, nextMode: null });
    });

    it("checks candidate detection before append-only so a new user append is not none", () => {
      const next: ReadonlyArray<ChatMessageModel> = [
        ...base,
        userWithPersistentId("u-send", 99, null),
      ];
      expect(
        classify({
          previousMessages: base,
          nextMessages: next,
          isFollowingEnd: true,
          hadSavedScrollState: true,
          localProvenanceMessageIds: provenance("u-send"),
        }),
      ).toEqual({
        action: {
          kind: "anchor-new-turn",
          messageId: "u-send",
          animated: true,
        },
        nextMode: null,
      });
    });

    it("checks append-only before trailing-assistant (length grows wins)", () => {
      const previous: ReadonlyArray<ChatMessageModel> = [
        user("u0", 1),
        assistant("a0", 2),
      ];
      const next: ReadonlyArray<ChatMessageModel> = [
        ...previous,
        assistant("a1", 3),
      ];
      expect(
        classify({
          previousMessages: previous,
          nextMessages: next,
          isFollowingEnd: true,
          hadSavedScrollState: true,
          localProvenanceMessageIds: NO_PROVENANCE,
        }),
      ).toEqual({ action: { kind: "none" }, nextMode: null });
    });

    it("checks trailing-assistant before shifted-retained", () => {
      // Same ids/order; only last assistant object identity changes - no shift.
      const previous = base;
      const next: ReadonlyArray<ChatMessageModel> = [
        previous[0],
        previous[1],
        previous[2],
        { ...previous[3] },
      ];
      expect(
        classify({
          previousMessages: previous,
          nextMessages: next,
          isFollowingEnd: true,
          hadSavedScrollState: true,
          localProvenanceMessageIds: NO_PROVENANCE,
        }),
      ).toEqual({ action: { kind: "none" }, nextMode: null });
    });
  });
});

describe("constants", () => {
  it("exposes the Chromium-matching arrow scroll step", () => {
    expect(CHAT_ARROW_SCROLL_STEP_PX).toBe(40);
  });
});
