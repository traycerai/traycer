import { describe, expect, it } from "vitest";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import type { SetupCardViewModel } from "@/components/chat/segments/setup-card-segment";
import {
  buildMessageIdToIndex,
  chatAnchorScrollCaptureIsExactBrowserClamp,
  chatAnchorScrollCaptureShouldCancel,
  chatTimelineAnchorShouldAnimateInitialIssue,
  chatTimelineLocationForMessage,
  chatTimelineNavigationLandedAtLocation,
  chatViewportAnchorRowIndex,
  chatWheelShouldCancelLiveFollow,
  chatWheelVerticalDirection,
  classifyChatEdgeMutation,
  isChatAnchorCandidateMessage,
  resolveChatAnchorTargetWithSetupCard,
  CHAT_ARROW_SCROLL_STEP_PX,
  CHAT_TIMELINE_NAVIGATION_VIEW_OFFSET_PX,
  selectActiveUserMessageId,
  viewportActiveUserMessageId,
  type ChatAnchorScrollCapturePhysicalSnapshot,
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

/** Ticket 13 (decision #27): the fork-marker system row a fresh-open fork
 *  should be able to anchor on. */
function forkMarker(id: string, createdAt: number): ChatMessageModel {
  return {
    ...makeMessageAt(0, "system", createdAt),
    id,
    segments: [
      {
        id: `${id}:link`,
        kind: "forked-chat-link",
        viewTabId: "tab-1",
        sourceChatId: "source-chat-1",
        sourceChatTitle: "Original chat",
        sourceHostId: "source-host-1",
      },
    ],
  };
}

const SETUP_MODEL: SetupCardViewModel = {
  aggregate: {
    epicId: "epic-1",
    ownerId: "owner-1",
    ownerKind: "chat",
    state: "setting-up",
  },
  workspaces: [
    {
      workspacePath: "/repo",
      label: "repo",
      state: "setting-up",
      setupExitCode: null,
      terminalSessionId: "term-1",
      worktreePath: "/worktrees/repo/feature",
      branch: "feature",
      errorMessage: null,
      retryFolderIntent: null,
    },
  ],
  createdAt: 1500,
  isActive: true,
};

/** Ticket 13 (decision #28): a setup-card system row genuinely owned by
 *  `anchorMessageId` (`SetupCardRow.triggeringMessageId` match) - the
 *  interleaved-and-matching shape the resolver must substitute onto. */
function anchoredSetupCard(
  id: string,
  createdAt: number,
  anchorMessageId: string,
): ChatMessageModel {
  return {
    ...makeMessageAt(0, "system", createdAt),
    id,
    segments: [
      {
        id: `${id}:card`,
        kind: "setup-card",
        model: SETUP_MODEL,
        viewTabId: "tab-1",
        anchorMessageId,
        isGenesisPin: false,
      },
    ],
  };
}

/** Ticket 13 (decision #28): the pinned genesis card - no real trigger to
 *  match, substitutes unconditionally for whatever the array's first row is. */
function genesisSetupCard(id: string, createdAt: number): ChatMessageModel {
  return {
    ...makeMessageAt(0, "system", createdAt),
    id,
    segments: [
      {
        id: `${id}:card`,
        kind: "setup-card",
        model: SETUP_MODEL,
        viewTabId: "tab-1",
        anchorMessageId: null,
        isGenesisPin: true,
      },
    ],
  };
}

/** Ticket 13 (decision #28): a FLOATING setup-card row - its triggering
 *  message never became an anchor target (queued/steered/branched/deleted),
 *  so `rendered-messages.ts` sorts it by `createdAt` with no guaranteed
 *  relation to its neighbor. `anchorMessageId` points at some OTHER message
 *  (or is `null`) - never the row it happens to land next to. */
function floatingSetupCard(
  id: string,
  createdAt: number,
  anchorMessageId: string | null,
): ChatMessageModel {
  return {
    ...makeMessageAt(0, "system", createdAt),
    id,
    segments: [
      {
        id: `${id}:card`,
        kind: "setup-card",
        model: SETUP_MODEL,
        viewTabId: "tab-1",
        anchorMessageId,
        isGenesisPin: false,
      },
    ],
  };
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

/** Ticket 14 (direction A): pure sign classification for wheel intent. */
describe("chatWheelVerticalDirection", () => {
  it("classifies positive deltaY as down", () => {
    expect(chatWheelVerticalDirection(40)).toBe("down");
    expect(chatWheelVerticalDirection(0.1)).toBe("down");
  });

  it("classifies negative deltaY as up", () => {
    expect(chatWheelVerticalDirection(-40)).toBe("up");
    expect(chatWheelVerticalDirection(-0.1)).toBe("up");
  });

  it("classifies zero deltaY as ambiguous", () => {
    expect(chatWheelVerticalDirection(0)).toBe("ambiguous");
  });
});

/**
 * Ticket 14 (direction A): edge-aware live-follow cancellation policy.
 * Downward at the live edge while following-end must NOT cancel; every other
 * combination (upward, ambiguous, or downward-at-edge in any non-following
 * mode - e.g. `anchoring-new-turn`'s reserve-capped `isAtEnd`) always does.
 */
describe("chatWheelShouldCancelLiveFollow", () => {
  it("does not cancel a downward wheel at the live edge while following-end", () => {
    expect(chatWheelShouldCancelLiveFollow(40, true, true)).toBe(false);
  });

  it("cancels a downward wheel when not at the live edge (following-end)", () => {
    expect(chatWheelShouldCancelLiveFollow(40, false, true)).toBe(true);
  });

  it("cancels a downward wheel at the live edge when not following-end (e.g. anchoring-new-turn's reserve-capped isAtEnd)", () => {
    expect(chatWheelShouldCancelLiveFollow(40, true, false)).toBe(true);
  });

  it("cancels a downward wheel when neither at the live edge nor following-end", () => {
    expect(chatWheelShouldCancelLiveFollow(40, false, false)).toBe(true);
  });

  it("cancels an upward wheel at the live edge regardless of mode", () => {
    expect(chatWheelShouldCancelLiveFollow(-40, true, true)).toBe(true);
    expect(chatWheelShouldCancelLiveFollow(-40, true, false)).toBe(true);
  });

  it("cancels an upward wheel when not at the live edge regardless of mode", () => {
    expect(chatWheelShouldCancelLiveFollow(-40, false, true)).toBe(true);
    expect(chatWheelShouldCancelLiveFollow(-40, false, false)).toBe(true);
  });

  it("cancels an ambiguous (zero) wheel regardless of edge or mode", () => {
    expect(chatWheelShouldCancelLiveFollow(0, true, true)).toBe(true);
    expect(chatWheelShouldCancelLiveFollow(0, false, true)).toBe(true);
    expect(chatWheelShouldCancelLiveFollow(0, true, false)).toBe(true);
    expect(chatWheelShouldCancelLiveFollow(0, false, false)).toBe(true);
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

describe("chatTimelineAnchorShouldAnimateInitialIssue (Ticket 18)", () => {
  // 700px viewport, 1.5x threshold -> 1050px is the exact near/far boundary.
  const VIEWPORT_LENGTH_PX = 700;
  const MAX_ANIMATE_VIEWPORTS = 1.5;

  it("(truth table: near + animated) returns true when the target is within the viewport multiple", () => {
    expect(
      chatTimelineAnchorShouldAnimateInitialIssue({
        anchorAnimated: true,
        currentScrollTop: 1_000,
        expectedTargetScrollTop: 1_900, // distance 900 <= 1050
        viewportLength: VIEWPORT_LENGTH_PX,
        maxAnimateViewports: MAX_ANIMATE_VIEWPORTS,
      }),
    ).toBe(true);
  });

  it("(truth table: far + animated) returns false when the target is beyond the viewport multiple", () => {
    expect(
      chatTimelineAnchorShouldAnimateInitialIssue({
        anchorAnimated: true,
        currentScrollTop: 0,
        expectedTargetScrollTop: 2_000, // distance 2000 > 1050
        viewportLength: VIEWPORT_LENGTH_PX,
        maxAnimateViewports: MAX_ANIMATE_VIEWPORTS,
      }),
    ).toBe(false);
  });

  it("(truth table: unmeasured target) returns false regardless of how close the current position happens to be", () => {
    expect(
      chatTimelineAnchorShouldAnimateInitialIssue({
        anchorAnimated: true,
        currentScrollTop: 1_000,
        expectedTargetScrollTop: null,
        viewportLength: VIEWPORT_LENGTH_PX,
        maxAnimateViewports: MAX_ANIMATE_VIEWPORTS,
      }),
    ).toBe(false);
  });

  it("(truth table: fresh-open / animated intent false) returns false regardless of distance", () => {
    expect(
      chatTimelineAnchorShouldAnimateInitialIssue({
        anchorAnimated: false,
        currentScrollTop: 1_000,
        expectedTargetScrollTop: 1_000, // distance 0 - would be "near" if intent were true
        viewportLength: VIEWPORT_LENGTH_PX,
        maxAnimateViewports: MAX_ANIMATE_VIEWPORTS,
      }),
    ).toBe(false);
  });

  it("is inclusive at the exact threshold boundary", () => {
    expect(
      chatTimelineAnchorShouldAnimateInitialIssue({
        anchorAnimated: true,
        currentScrollTop: 0,
        expectedTargetScrollTop: 1_050, // distance exactly maxAnimateViewports * viewportLength
        viewportLength: VIEWPORT_LENGTH_PX,
        maxAnimateViewports: MAX_ANIMATE_VIEWPORTS,
      }),
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

/** Every existing call site passes all six fields explicitly (no optional
 *  params/defaults, per repo convention) - this just saves re-typing the
 *  common `hadSavedScrollState: true, localProvenanceMessageIds: NO_PROVENANCE`
 *  pair for the many tests that don't care about either. Ticket 17 adds
 *  `lastVisibleMessageId` (inert outside the suffix-removal branch; pass
 *  `null` there). */
function classify(input: {
  readonly previousMessages: ReadonlyArray<ChatMessageModel> | null;
  readonly nextMessages: ReadonlyArray<ChatMessageModel>;
  readonly isFollowingEnd: boolean;
  readonly hadSavedScrollState: boolean;
  readonly isChatStreaming: boolean;
  readonly localProvenanceMessageIds: ReadonlySet<string>;
  readonly lastVisibleMessageId: string | null;
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
          isChatStreaming: false,
          localProvenanceMessageIds: NO_PROVENANCE,
          lastVisibleMessageId: null,
        }),
      ).toEqual({ action: { kind: "none" }, nextMode: "following-end" });
    });
  });

  describe("(b) first non-empty render (decision #8/#15)", () => {
    it("anchors unconditionally when the first row is a local-provenance match and there is no saved state (send into a brand-new empty chat)", () => {
      const firstMessage = userWithPersistentId("first-local-send", 1, null);
      expect(
        classify({
          previousMessages: null,
          nextMessages: [firstMessage],
          isFollowingEnd: false,
          hadSavedScrollState: false,
          isChatStreaming: false,
          localProvenanceMessageIds: provenance("first-local-send"),
          lastVisibleMessageId: null,
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

    it("RESTORE-FIRST is literal (ticket 15 review F9): a saved scroll state wins over a mount-time local-provenance match", () => {
      // A send that was in flight when the tab was last closed and has
      // since completed - the restored position is what the reader asked
      // for by returning to this chat, not a jump to their own old send.
      const firstMessage = userWithPersistentId("first-local-send", 1, null);
      expect(
        classify({
          previousMessages: null,
          nextMessages: [firstMessage],
          isFollowingEnd: false,
          hadSavedScrollState: true,
          isChatStreaming: false,
          localProvenanceMessageIds: provenance("first-local-send"),
          lastVisibleMessageId: null,
        }),
      ).toEqual({ action: { kind: "none" }, nextMode: null });
    });

    it("re-derives fresh-open (non-animated, last user message) when no saved state and no local match", () => {
      // ChatMessages mounts only after the authoritative snapshot. A null
      // previous value is therefore the initial render whose fresh-open
      // policy belongs here.
      expect(
        classify({
          previousMessages: null,
          nextMessages: base,
          isFollowingEnd: false,
          hadSavedScrollState: false,
          isChatStreaming: false,
          localProvenanceMessageIds: NO_PROVENANCE,
          lastVisibleMessageId: null,
        }),
      ).toEqual({
        action: { kind: "anchor-new-turn", messageId: "u1", animated: false },
        nextMode: null,
      });
    });

    it("ticket 15: streaming fresh-open does not re-derive the idle anchor (stays none)", () => {
      // Mount-seed and classifier share ownership of the first authoritative
      // snapshot. Decision #29: while the chat is actively streaming, the
      // idle last-user anchor must not fire - following-end owns the tail.
      expect(
        classify({
          previousMessages: null,
          nextMessages: base,
          isFollowingEnd: true,
          hadSavedScrollState: false,
          isChatStreaming: true,
          localProvenanceMessageIds: NO_PROVENANCE,
          lastVisibleMessageId: null,
        }),
      ).toEqual({ action: { kind: "none" }, nextMode: null });
    });

    it("does nothing on the initial saved-state snapshot when there is no local match", () => {
      expect(
        classify({
          previousMessages: null,
          nextMessages: base,
          isFollowingEnd: false,
          hadSavedScrollState: true,
          isChatStreaming: false,
          localProvenanceMessageIds: NO_PROVENANCE,
          lastVisibleMessageId: null,
        }),
      ).toEqual({ action: { kind: "none" }, nextMode: null });
    });

    it("anchors a passive first turn arriving live after a saved empty snapshot only while following", () => {
      expect(
        classify({
          previousMessages: [],
          nextMessages: base,
          isFollowingEnd: true,
          hadSavedScrollState: true,
          isChatStreaming: false,
          localProvenanceMessageIds: NO_PROVENANCE,
          lastVisibleMessageId: null,
        }),
      ).toEqual({
        action: {
          kind: "anchor-new-turn",
          messageId: "u1",
          animated: true,
        },
        nextMode: null,
      });

      expect(
        classify({
          previousMessages: [],
          nextMessages: base,
          isFollowingEnd: false,
          hadSavedScrollState: true,
          isChatStreaming: false,
          localProvenanceMessageIds: NO_PROVENANCE,
          lastVisibleMessageId: null,
        }),
      ).toEqual({ action: { kind: "none" }, nextMode: null });
    });

    it("anchors unconditionally on local provenance for a live empty->non-empty send, regardless of isFollowingEnd or hadSavedScrollState (decisions #8/#18)", () => {
      const firstMessage = userWithPersistentId("live-local-send", 1, null);
      // Not following, AND a saved state exists - neither should matter
      // here: `hadSavedScrollState` is a mount-only concern (ticket 15
      // review F9), and this is the reader's OWN live send in an already
      // open chat, not a restore.
      expect(
        classify({
          previousMessages: [],
          nextMessages: [firstMessage],
          isFollowingEnd: false,
          hadSavedScrollState: true,
          isChatStreaming: false,
          localProvenanceMessageIds: provenance("live-local-send"),
          lastVisibleMessageId: null,
        }),
      ).toEqual({
        action: {
          kind: "anchor-new-turn",
          messageId: "live-local-send",
          animated: true,
        },
        nextMode: null,
      });
    });

    it("does nothing when there is no saved state but also no user row to anchor", () => {
      const assistantOnly = [assistant("a0", 1)];
      expect(
        classify({
          previousMessages: null,
          nextMessages: assistantOnly,
          isFollowingEnd: false,
          hadSavedScrollState: false,
          isChatStreaming: false,
          localProvenanceMessageIds: NO_PROVENANCE,
          lastVisibleMessageId: null,
        }),
      ).toEqual({ action: { kind: "none" }, nextMode: null });
    });

    // Ticket 13 (decision #27): widens the mount-time fresh-open seed
    // (`previousMessages === null` - `ChatMessages` mounts only after the
    // authoritative snapshot, per the base's own "anchor passive turns after
    // saved empty snapshots" fix, so a fork's copied history + marker are
    // already present at THIS classify call) from user-only to accept a
    // `forked-chat-link` marker, self-superseding via the shared `findLast`
    // once a real user turn exists.
    it("(pin a) anchors the fork marker when it is the only candidate (a freshly opened fork with no new turn yet)", () => {
      const messages = [forkMarker("forked-chat-link:fork-1", 1)];
      expect(
        classify({
          previousMessages: null,
          nextMessages: messages,
          isFollowingEnd: false,
          hadSavedScrollState: false,
          isChatStreaming: false,
          localProvenanceMessageIds: NO_PROVENANCE,
          lastVisibleMessageId: null,
        }),
      ).toEqual({
        action: {
          kind: "anchor-new-turn",
          messageId: "forked-chat-link:fork-1",
          animated: false,
        },
        nextMode: null,
      });
    });

    it("(pin b) anchors a newer user turn over the fork marker (self-superseding)", () => {
      const messages = [
        forkMarker("forked-chat-link:fork-1", 1),
        user("u-new", 2),
      ];
      expect(
        classify({
          previousMessages: null,
          nextMessages: messages,
          isFollowingEnd: false,
          hadSavedScrollState: false,
          isChatStreaming: false,
          localProvenanceMessageIds: NO_PROVENANCE,
          lastVisibleMessageId: null,
        }),
      ).toEqual({
        action: {
          kind: "anchor-new-turn",
          messageId: "u-new",
          animated: false,
        },
        nextMode: null,
      });
    });

    it("widens the gated live-arrival branch too, defensively (a genuinely empty chat's first live turn is never actually a fork, but the predicate stays consistent)", () => {
      const messages = [forkMarker("forked-chat-link:fork-1", 1)];
      expect(
        classify({
          previousMessages: [],
          nextMessages: messages,
          isFollowingEnd: true,
          hadSavedScrollState: true,
          isChatStreaming: false,
          localProvenanceMessageIds: NO_PROVENANCE,
          lastVisibleMessageId: null,
        }),
      ).toEqual({
        action: {
          kind: "anchor-new-turn",
          messageId: "forked-chat-link:fork-1",
          animated: true,
        },
        nextMode: null,
      });

      expect(
        classify({
          previousMessages: [],
          nextMessages: messages,
          isFollowingEnd: false,
          hadSavedScrollState: true,
          isChatStreaming: false,
          localProvenanceMessageIds: NO_PROVENANCE,
          lastVisibleMessageId: null,
        }),
      ).toEqual({ action: { kind: "none" }, nextMode: null });
    });
  });

  describe("(c) suffix removal", () => {
    // base = [u0, a0, u1, a1]; next keeps the first two → firstRemovedIndex = 2.
    // Ticket 17 viewport cases (a)/(b)/(c) are independent of this describe's
    // own "(c)" label (third category of message-array transition).
    const next = base.slice(0, 2);
    const FOLLOWING_END_OUTCOME = {
      action: { kind: "scroll-to-end" as const },
      nextMode: "following-end" as const,
    };

    it("scrolls to end and stays following when isFollowingEnd (ticket 17 case c)", () => {
      // Already following: viewport position is irrelevant.
      expect(
        classify({
          previousMessages: base,
          nextMessages: next,
          isFollowingEnd: true,
          hadSavedScrollState: true,
          isChatStreaming: false,
          localProvenanceMessageIds: NO_PROVENANCE,
          lastVisibleMessageId: null,
        }),
      ).toEqual(FOLLOWING_END_OUTCOME);
    });

    it("does nothing when free-scrolling and last visible row is strictly above the removed suffix (ticket 17 case a)", () => {
      // last visible = a0 (index 1) < firstRemovedIndex 2 → viewport untouched.
      expect(
        classify({
          previousMessages: base,
          nextMessages: next,
          isFollowingEnd: false,
          hadSavedScrollState: true,
          isChatStreaming: false,
          localProvenanceMessageIds: NO_PROVENANCE,
          lastVisibleMessageId: "a0",
        }),
      ).toEqual({ action: { kind: "none" }, nextMode: null });
    });

    it("forces following-end + scroll-to-end when free-scrolling and last visible row is at/past the first removed index (ticket 17 case b)", () => {
      // last visible = u1 (index 2) === firstRemovedIndex → content vanished.
      expect(
        classify({
          previousMessages: base,
          nextMessages: next,
          isFollowingEnd: false,
          hadSavedScrollState: true,
          isChatStreaming: false,
          localProvenanceMessageIds: NO_PROVENANCE,
          lastVisibleMessageId: "u1",
        }),
      ).toEqual(FOLLOWING_END_OUTCOME);
    });

    it("forces following-end + scroll-to-end when free-scrolling and last visible id is unknown/unmeasured (ticket 17 case b, unknown defaults to b never a)", () => {
      // null is "never measured" - must NOT be treated as safely above the
      // boundary (old unconditional scroll-to-index polarity flipped here).
      expect(
        classify({
          previousMessages: base,
          nextMessages: next,
          isFollowingEnd: false,
          hadSavedScrollState: true,
          isChatStreaming: false,
          localProvenanceMessageIds: NO_PROVENANCE,
          lastVisibleMessageId: null,
        }),
      ).toEqual(FOLLOWING_END_OUTCOME);
    });

    it("forces following-end + scroll-to-end when free-scrolling and last visible id is no longer in previousMessages", () => {
      // Stale id that does not resolve → treated as unknown → case b.
      expect(
        classify({
          previousMessages: base,
          nextMessages: next,
          isFollowingEnd: false,
          hadSavedScrollState: true,
          isChatStreaming: false,
          localProvenanceMessageIds: NO_PROVENANCE,
          lastVisibleMessageId: "already-gone",
        }),
      ).toEqual(FOLLOWING_END_OUTCOME);
    });

    it("does not treat a non-prefix shrink as suffix removal", () => {
      // Different first row → not a strict prefix. Candidate detection sees
      // a new user id ("other") with no local provenance while following-end
      // → decision #9 gated anchor (NOT suffix-removal's scroll-to-end +
      // following-end, and not the deleted scroll-to-index outcome).
      const diverged = [user("other", 1), assistant("a0", 2)];
      const outcome = classify({
        previousMessages: base,
        nextMessages: diverged,
        isFollowingEnd: true,
        hadSavedScrollState: true,
        isChatStreaming: false,
        localProvenanceMessageIds: NO_PROVENANCE,
        lastVisibleMessageId: null,
      });
      expect(outcome).toEqual({
        action: {
          kind: "anchor-new-turn",
          messageId: "other",
          animated: true,
        },
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
          isChatStreaming: false,
          localProvenanceMessageIds: provenance("u-branch"),
          lastVisibleMessageId: null,
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
          isChatStreaming: false,
          localProvenanceMessageIds: provenance("u-send"),
          lastVisibleMessageId: null,
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
        isChatStreaming: false,
        localProvenanceMessageIds: provenance("history-0"),
        lastVisibleMessageId: null,
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
          isChatStreaming: false,
          localProvenanceMessageIds: NO_PROVENANCE,
          lastVisibleMessageId: null,
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
          isChatStreaming: false,
          localProvenanceMessageIds: NO_PROVENANCE,
          lastVisibleMessageId: null,
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
          isChatStreaming: false,
          localProvenanceMessageIds: NO_PROVENANCE,
          lastVisibleMessageId: null,
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
          isChatStreaming: false,
          localProvenanceMessageIds: NO_PROVENANCE,
          lastVisibleMessageId: null,
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
          isChatStreaming: false,
          localProvenanceMessageIds: NO_PROVENANCE,
          lastVisibleMessageId: null,
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
          isChatStreaming: false,
          localProvenanceMessageIds: NO_PROVENANCE,
          lastVisibleMessageId: null,
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
          isChatStreaming: false,
          localProvenanceMessageIds: provenance("local-co-arrival"),
          lastVisibleMessageId: null,
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
          isChatStreaming: false,
          localProvenanceMessageIds: NO_PROVENANCE,
          lastVisibleMessageId: null,
        }),
      ).toEqual({ action: { kind: "none" }, nextMode: null });

      expect(
        classify({
          previousMessages: base,
          nextMessages: next,
          isFollowingEnd: false,
          hadSavedScrollState: true,
          isChatStreaming: false,
          localProvenanceMessageIds: NO_PROVENANCE,
          lastVisibleMessageId: null,
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
          isChatStreaming: false,
          localProvenanceMessageIds: NO_PROVENANCE,
          lastVisibleMessageId: null,
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
          isChatStreaming: false,
          localProvenanceMessageIds: NO_PROVENANCE,
          lastVisibleMessageId: null,
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
          isChatStreaming: false,
          localProvenanceMessageIds: NO_PROVENANCE,
          lastVisibleMessageId: null,
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
          isChatStreaming: false,
          localProvenanceMessageIds: NO_PROVENANCE,
          lastVisibleMessageId: null,
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
          isChatStreaming: false,
          localProvenanceMessageIds: NO_PROVENANCE,
          lastVisibleMessageId: null,
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
        isChatStreaming: false,
        localProvenanceMessageIds: NO_PROVENANCE,
        lastVisibleMessageId: null,
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
          isChatStreaming: false,
          localProvenanceMessageIds: NO_PROVENANCE,
          lastVisibleMessageId: null,
        }),
      ).toEqual({ action: { kind: "none" }, nextMode: "following-end" });
    });

    it("checks suffix removal before candidate detection", () => {
      // A shorter strict prefix could also look like a "change" but suffix
      // removal is first and must win. Unknown last-visible (`null`) defaults
      // to ticket 17 case (b) — scroll-to-end + following-end — which is
      // clearly different from any candidate-detection outcome (anchor /
      // none) for this shape.
      const next = base.slice(0, 3);
      expect(
        classify({
          previousMessages: base,
          nextMessages: next,
          isFollowingEnd: false,
          hadSavedScrollState: true,
          isChatStreaming: false,
          localProvenanceMessageIds: NO_PROVENANCE,
          lastVisibleMessageId: null,
        }),
      ).toEqual({
        action: { kind: "scroll-to-end" },
        nextMode: "following-end",
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
          isChatStreaming: false,
          localProvenanceMessageIds: provenance("prepended-local"),
          lastVisibleMessageId: null,
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
          isChatStreaming: false,
          localProvenanceMessageIds: provenance("u-send"),
          lastVisibleMessageId: null,
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
          isChatStreaming: false,
          localProvenanceMessageIds: NO_PROVENANCE,
          lastVisibleMessageId: null,
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
          isChatStreaming: false,
          localProvenanceMessageIds: NO_PROVENANCE,
          lastVisibleMessageId: null,
        }),
      ).toEqual({ action: { kind: "none" }, nextMode: null });
    });
  });
});

describe("isChatAnchorCandidateMessage (ticket 13 / decision #27)", () => {
  it("accepts user rows and forked-chat-link markers", () => {
    expect(isChatAnchorCandidateMessage(user("u0", 1))).toBe(true);
    expect(
      isChatAnchorCandidateMessage(forkMarker("forked-chat-link:fork-1", 1)),
    ).toBe(true);
  });

  it("rejects assistant rows and setup-card markers (non-goal: the card is never a findLast candidate itself)", () => {
    expect(isChatAnchorCandidateMessage(assistant("a0", 1))).toBe(false);
    expect(
      isChatAnchorCandidateMessage(
        anchoredSetupCard("setup-card:owner-1:0:1", 1, "u0"),
      ),
    ).toBe(false);
  });
});

describe("resolveChatAnchorTargetWithSetupCard (ticket 13 / decision #28)", () => {
  it("(pin c) substitutes a card genuinely owned by the target (mid-chat weave, anchorMessageId match)", () => {
    const messages = [
      anchoredSetupCard("setup-card:owner-1:0:1", 1, "u0"),
      user("u0", 2),
      assistant("a0", 3),
    ];
    expect(resolveChatAnchorTargetWithSetupCard(messages, "u0")).toBe(
      "setup-card:owner-1:0:1",
    );
  });

  it("substitutes the pinned genesis card unconditionally (no trigger to match)", () => {
    const messages = [
      genesisSetupCard("setup-card:owner-1:0:0", 0),
      user("u0", 2),
      assistant("a0", 3),
    ];
    expect(resolveChatAnchorTargetWithSetupCard(messages, "u0")).toBe(
      "setup-card:owner-1:0:0",
    );
  });

  // Reviewer-caught bug (ticket 13 review round): array adjacency alone is
  // NOT proof of ownership. A card whose triggering message never became an
  // anchor target (queued/steered/branched/deleted) floats by `createdAt`
  // (`rendered-messages.ts`'s `floatingCards`) and can land directly above a
  // completely unrelated row by coincidence - substituting onto it would
  // anchor the reader on an unrelated card's worktree-setup progress.
  it("does NOT substitute a FLOATING card merely adjacent to an unrelated message (anchorMessageId points elsewhere)", () => {
    const messages = [
      floatingSetupCard("setup-card:owner-1:0:1", 1, "some-other-message"),
      user("u0", 2),
      assistant("a0", 3),
    ];
    expect(resolveChatAnchorTargetWithSetupCard(messages, "u0")).toBe("u0");
  });

  it("does NOT substitute a FLOATING card with a null anchorMessageId (defensive creating-event-without-id shape)", () => {
    const messages = [
      floatingSetupCard("setup-card:owner-1:0:1", 1, null),
      user("u0", 2),
    ];
    expect(resolveChatAnchorTargetWithSetupCard(messages, "u0")).toBe("u0");
  });

  it("walks past more than one consecutive OWNED card to the topmost (defensive: same-anchor card stack)", () => {
    // Today's model consolidates one send's consecutive `setup.creating`
    // events into a single window/card (`buildSetupCardRows.ts`), so two
    // windows sharing one triggeringMessageId isn't a case production
    // currently produces - this is defensive robustness for that array
    // shape, not a chain (card1 does not anchor to card0; both would anchor
    // to "u0" directly if it ever occurred).
    const messages = [
      anchoredSetupCard("setup-card:owner-1:0:1", 1, "u0"),
      anchoredSetupCard("setup-card:owner-1:1:1", 1, "u0"),
      user("u0", 2),
    ];
    expect(resolveChatAnchorTargetWithSetupCard(messages, "u0")).toBe(
      "setup-card:owner-1:0:1",
    );
  });

  it("stops the walk at the first card that does NOT own the target, even mid-stack", () => {
    // card0 floats (owns nothing here); card1 genuinely owns "u0". The walk
    // must stop at card1, not credit card0 just because it's consecutively
    // stacked above an owned card.
    const messages = [
      floatingSetupCard("setup-card:owner-1:0:1", 1, "unrelated"),
      anchoredSetupCard("setup-card:owner-1:1:1", 1, "u0"),
      user("u0", 2),
    ];
    expect(resolveChatAnchorTargetWithSetupCard(messages, "u0")).toBe(
      "setup-card:owner-1:1:1",
    );
  });

  it("returns messageId unchanged when no card sits above it", () => {
    const messages = [assistant("a0", 1), user("u0", 2)];
    expect(resolveChatAnchorTargetWithSetupCard(messages, "u0")).toBe("u0");
  });

  it("returns messageId unchanged when messageId is not found or is the first row", () => {
    const messages = [user("u0", 1), assistant("a0", 2)];
    expect(resolveChatAnchorTargetWithSetupCard(messages, "missing")).toBe(
      "missing",
    );
    expect(resolveChatAnchorTargetWithSetupCard(messages, "u0")).toBe("u0");
  });

  it("(pin d groundwork) is idempotent once retargeted to the card - re-deriving from the card itself finds nothing further above", () => {
    const messages = [
      anchoredSetupCard("setup-card:owner-1:0:1", 1, "u0"),
      user("u0", 2),
    ];
    const retargeted = resolveChatAnchorTargetWithSetupCard(messages, "u0");
    expect(resolveChatAnchorTargetWithSetupCard(messages, retargeted)).toBe(
      retargeted,
    );
  });
});

describe("chatAnchorScrollCaptureIsExactBrowserClamp (Ticket 19, decision #31 binding condition b)", () => {
  function snapshot(
    scrollTop: number,
    maxScrollTop: number,
  ): ChatAnchorScrollCapturePhysicalSnapshot {
    return { scrollTop, maxScrollTop };
  }

  it("(exact clamp) recognizes an ordinary downward clamp to a newly-smaller maximum", () => {
    expect(
      chatAnchorScrollCaptureIsExactBrowserClamp(
        snapshot(1_200, 1_200),
        snapshot(1_000, 1_000),
      ),
    ).toBe(true);
  });

  it("(fractional clamp) the 1px equality tolerance absorbs sub-pixel scrollTop/max values", () => {
    expect(
      chatAnchorScrollCaptureIsExactBrowserClamp(
        snapshot(1_200.7, 1_200.25),
        snapshot(1_000.6, 1_000.3),
      ),
    ).toBe(true);
  });

  it("(no prior-over-max evidence) does not guess a clamp merely from landing near a maximum", () => {
    // previous.scrollTop (900) was never above the NEW maximum (1000) - the
    // reader could simply have scrolled there normally. Table row: "Position
    // at maximum without prior-over-max evidence" -> cancel, not a clamp.
    expect(
      chatAnchorScrollCaptureIsExactBrowserClamp(
        snapshot(900, 1_200),
        snapshot(1_000, 1_000),
      ),
    ).toBe(false);
  });

  it("(maximum did not shrink) a same-position report with an unchanged or grown maximum is not a clamp", () => {
    expect(
      chatAnchorScrollCaptureIsExactBrowserClamp(
        snapshot(1_200, 1_000),
        snapshot(1_000, 1_000),
      ),
    ).toBe(false);
  });

  it("(current top not at the new maximum) a large drop that overshoots past the new max is not a clamp", () => {
    // Same shrink, but current.scrollTop lands well short of the new max -
    // a real clamp always lands (near) exactly at the new maximum.
    expect(
      chatAnchorScrollCaptureIsExactBrowserClamp(
        snapshot(1_200, 1_200),
        snapshot(500, 1_000),
      ),
    ).toBe(false);
  });

  it("is exclusive at the exact 1px boundary of 'previous over new max'", () => {
    // previous.scrollTop must EXCEED currentMax + 1px, not merely equal it.
    expect(
      chatAnchorScrollCaptureIsExactBrowserClamp(
        snapshot(1_001, 1_200), // exactly currentMax(1000) + 1, not > it
        snapshot(1_000, 1_000),
      ),
    ).toBe(false);
    expect(
      chatAnchorScrollCaptureIsExactBrowserClamp(
        snapshot(1_001.01, 1_200),
        snapshot(1_000, 1_000),
      ),
    ).toBe(true);
  });
});

describe("chatAnchorScrollCaptureShouldCancel (Ticket 19, decision #31)", () => {
  const OWNED_NO_MOTION = {
    isAnchoringSessionOwned: true,
    activeAnchorMotionOwnsGeneration: false,
  };

  it("(truth table: mismatch while owned) cancels an unexplained departure while anchoring + generation owned", () => {
    expect(
      chatAnchorScrollCaptureShouldCancel({
        ...OWNED_NO_MOTION,
        domScrollTop: 900,
        listStateScroll: 100,
        previousSnapshot: null,
        currentMaxScrollTop: 5_000,
      }),
    ).toBe(true);
  });

  it("(truth table: following/free mode) stays silent whenever the session is not anchoring-owned", () => {
    expect(
      chatAnchorScrollCaptureShouldCancel({
        isAnchoringSessionOwned: false,
        activeAnchorMotionOwnsGeneration: false,
        domScrollTop: 900,
        listStateScroll: 100,
        previousSnapshot: null,
        currentMaxScrollTop: 5_000,
      }),
    ).toBe(false);
  });

  it("(truth table: generation unowned) stays silent - `isAnchoringSessionOwned` already folds in the generation-ownership gate", () => {
    // The caller computes `isAnchoringSessionOwned` as `mode ===
    // "anchoring-new-turn" && generationOwned` - a mode-matched but
    // generation-stale report reaches this classifier as `false` here.
    expect(
      chatAnchorScrollCaptureShouldCancel({
        isAnchoringSessionOwned: false,
        activeAnchorMotionOwnsGeneration: false,
        domScrollTop: 5_000,
        listStateScroll: 0,
        previousSnapshot: null,
        currentMaxScrollTop: 6_000,
      }),
    ).toBe(false);
  });

  it("(truth table: active anchor imperative motion) defers silently regardless of how far DOM/list state diverge", () => {
    expect(
      chatAnchorScrollCaptureShouldCancel({
        isAnchoringSessionOwned: true,
        activeAnchorMotionOwnsGeneration: true,
        domScrollTop: 50,
        listStateScroll: 4_000,
        previousSnapshot: null,
        currentMaxScrollTop: 5_000,
      }),
    ).toBe(false);
  });

  it("(truth table: stale active-motion generation does not exempt) a caller-computed `false` for an older generation's motion is evaluated normally, not exempted", () => {
    // Design: "activeAnchorImperativeMotionGenerationRef must be compared
    // with the CURRENT generation - a stale completion from an older anchor
    // cannot exempt a newer session." The comparison itself is the caller's
    // job (chat-messages.tsx); this classifier only ever sees the resulting
    // boolean. A stale generation must therefore resolve to `false` here,
    // which - unlike the true case above - does NOT defer, and the mismatch
    // is classified as a real departure.
    expect(
      chatAnchorScrollCaptureShouldCancel({
        isAnchoringSessionOwned: true,
        activeAnchorMotionOwnsGeneration: false,
        domScrollTop: 50,
        listStateScroll: 4_000,
        previousSnapshot: null,
        currentMaxScrollTop: 5_000,
      }),
    ).toBe(true);
  });

  it("(truth table: DOM/list equal within 1px) a sub-pixel difference is read as a library/app-owned correction, not a departure", () => {
    expect(
      chatAnchorScrollCaptureShouldCancel({
        ...OWNED_NO_MOTION,
        domScrollTop: 500.4,
        listStateScroll: 500.0,
        previousSnapshot: null,
        currentMaxScrollTop: 5_000,
      }),
    ).toBe(false);
  });

  it("(truth table: exact downward clamp) a browser clamp to a newly-smaller maximum stays silent even though DOM/list state diverge", () => {
    expect(
      chatAnchorScrollCaptureShouldCancel({
        ...OWNED_NO_MOTION,
        domScrollTop: 1_000,
        listStateScroll: 1_200, // library state never told about the clamp
        previousSnapshot: { scrollTop: 1_200, maxScrollTop: 1_200 },
        currentMaxScrollTop: 1_000,
      }),
    ).toBe(false);
  });

  it("(truth table: position at maximum without prior-over-max evidence) cancels rather than guessing a clamp", () => {
    expect(
      chatAnchorScrollCaptureShouldCancel({
        ...OWNED_NO_MOTION,
        domScrollTop: 1_000,
        listStateScroll: 400,
        previousSnapshot: { scrollTop: 900, maxScrollTop: 1_200 },
        currentMaxScrollTop: 1_000,
      }),
    ).toBe(true);
  });

  it("(truth table: large library-owned correction) exact state equality stays silent no matter how large the jump", () => {
    expect(
      chatAnchorScrollCaptureShouldCancel({
        ...OWNED_NO_MOTION,
        domScrollTop: 4_800,
        listStateScroll: 4_800, // MVCP/non-animated scrollToOffset pre-wrote this
        previousSnapshot: { scrollTop: 50, maxScrollTop: 5_000 },
        currentMaxScrollTop: 5_000,
      }),
    ).toBe(false);
  });

  it("(truth table: small real mismatch above 1px) cancels with no anchor-distance threshold - a 2px unexplained move is as real as a 2000px one", () => {
    expect(
      chatAnchorScrollCaptureShouldCancel({
        ...OWNED_NO_MOTION,
        domScrollTop: 502,
        listStateScroll: 500,
        previousSnapshot: { scrollTop: 500, maxScrollTop: 5_000 },
        currentMaxScrollTop: 5_000,
      }),
    ).toBe(true);
  });

  it("(no previous snapshot) an owned mismatch with nothing to compare against for a clamp still cancels - unsure biases toward cancel, not silence", () => {
    expect(
      chatAnchorScrollCaptureShouldCancel({
        ...OWNED_NO_MOTION,
        domScrollTop: 990,
        listStateScroll: 0,
        previousSnapshot: null,
        currentMaxScrollTop: 990,
      }),
    ).toBe(true);
  });

  it("(same-window max shrink ambiguity, review finding 3) a user move ending exactly at a shrunk maximum is indistinguishable from a clamp - documented, not a bug", () => {
    // The design-review's own accepted ambiguity table: "User thumb ends at
    // the new max in the same delivery window as a max shrink" -> silent.
    // This pin exists to make that acceptance explicit and mutation-visible,
    // not to assert a distinguishing capability that does not exist.
    expect(
      chatAnchorScrollCaptureShouldCancel({
        ...OWNED_NO_MOTION,
        domScrollTop: 1_000,
        listStateScroll: 1_200,
        previousSnapshot: { scrollTop: 1_200, maxScrollTop: 1_200 },
        currentMaxScrollTop: 1_000,
      }),
    ).toBe(false);
  });
});

describe("constants", () => {
  it("exposes the Chromium-matching arrow scroll step", () => {
    expect(CHAT_ARROW_SCROLL_STEP_PX).toBe(40);
  });
});
