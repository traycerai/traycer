/**
 * Split from the original single-file chat-messages.test.tsx (10.7k lines,
 * the slowest file in the suite) along describe boundaries; shared fixtures,
 * helpers and root hooks live in chat-messages-suite-harness.tsx, shared
 * mutable refs in chat-messages-suite-refs.ts, and the vi.mock block below is
 * repeated per file because vi.mock registration is per-test-file. All split
 * files keep the original root describe title so test full names (and CI
 * history) are unchanged.
 */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { type ReactElement, StrictMode, useCallback } from "react";
import { describe, expect, it, vi } from "vitest";
import { type StoreApi } from "zustand/vanilla";
import {
  CHAT_TIMELINE_ANCHOR_SCROLL_PROMISE_TIMEOUT_MS,
  ChatMessages,
} from "@/components/chat/chat-messages";
import {
  anchorMoverShouldYieldToReader,
  type ChatAnchorDriftRepairOutcome,
} from "@/components/chat/chat-messages-scroll-helpers";
import { CHAT_LIST_ANCHOR_OFFSET } from "@/components/chat/chat-scroll-anchoring";
import { appLogger } from "@/lib/logger";
import { preserveChatScrollAcrossDisclosureChange } from "@/components/chat/chat-scroll-disclosure";
import {
  hasSavedChatTabState,
  saveChatTabState,
} from "@/stores/chats/chat-tab-state-cache";
import { type ChatTabPersistenceIdentity } from "@/stores/chats/chat-tab-persistence-key";
import { type ActivityGroupOpenState } from "@/stores/chats/activity-group-open-store-context";
import { type ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import { makeMessageAt } from "./chat-message-fixtures";
import {
  setLegendListScrollContainerScrollHeightOverride,
  setLegendListSyntheticScrollEventsEnabled,
  settleLegendList,
} from "./legend-list-test-environment";
import {
  applyChatAnchorDriftRepairCallCountRef,
  legendListRefHolder,
} from "./chat-messages-suite-refs";
import {
  appendOneStreamingChunk,
  appendOptimisticUserSend,
  appendPersistentUserRow,
  appendStreamingAssistantChunks,
  enterFreeScrollingAwayFromEnd,
  fireLibraryOwnedScrollTo,
  fireScrollTopAndFlush,
  getScrollNode,
  isJumpPillVisible,
  LEGEND_LIST_HEADER_PX,
  makeCompletedTranscript,
  makeDefaultTestIdentity,
  makeTestIdentity,
  pillVisibleLabel,
  registerChatMessagesSuiteHooks,
  renderChatMessages,
  triggerLegendListResizeObserverEntry,
  VIEWPORT_HEIGHT_PX,
  VIEWPORT_WIDTH_PX,
  waitForAnchorEngineSettle,
  waitForPillVisible,
  waitForRevealPassTick,
} from "./chat-messages-suite-harness";

vi.mock("@/lib/keybindings/platform", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/keybindings/platform")>();
  const { platformMock } = await import("./chat-messages-suite-refs");
  return {
    ...actual,
    isMac: () => platformMock.isMac,
  };
});

vi.mock("@/stores/epics/canvas/tile-instance-liveness", async () => {
  const { tileLiveness } = await import("./chat-messages-suite-refs");
  return {
    isEpicCanvasTileInstanceLive: () => tileLiveness.live,
  };
});

// Lightweight rows: ChatMessages mounts real ChatTimeline/LegendList; full
// ChatMessage UI is heavy and unrelated to scroll-policy assertions.
vi.mock("@/components/chat/chat-message", () => ({
  ChatMessage: function MockChatMessage(props: {
    message: ChatMessageModel;
  }): ReactElement {
    return (
      <div data-testid={`mock-message-${props.message.id}`}>
        {props.message.role}:{props.message.id}
        {props.message.content}
      </div>
    );
  },
}));

// Thin, behavior-preserving pass-through around the REAL `LegendList` that
// tees its ref into `legendListRefHolder` - see that ref's doc comment in
// chat-messages-suite-refs.ts for the full ticket 17 rationale.
vi.mock("@legendapp/list/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@legendapp/list/react")>();
  const { legendListRefHolder } = await import("./chat-messages-suite-refs");
  const TeedLegendList: typeof actual.LegendList = (props) => {
    const { ref, ...rest } = props;
    const teeRef = useCallback(
      (instance: import("@legendapp/list/react").LegendListRef | null) => {
        legendListRefHolder.current = instance;
        if (typeof ref === "function") {
          ref(instance);
        } else if (ref) {
          ref.current = instance;
        }
      },
      [ref],
    );
    return <actual.LegendList {...rest} ref={teeRef} />;
  };
  return { ...actual, LegendList: TeedLegendList };
});

// Thin pass-through around the REAL `applyChatAnchorDriftRepair` teeing its
// call count - see `applyChatAnchorDriftRepairCallCountRef`'s doc comment in
// chat-messages-suite-refs.ts for the full ticket 22 rationale.
vi.mock(
  "@/components/chat/chat-messages-scroll-helpers",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/chat/chat-messages-scroll-helpers")
      >();
    const { applyChatAnchorDriftRepairCallCountRef } =
      await import("./chat-messages-suite-refs");
    return {
      ...actual,
      applyChatAnchorDriftRepair: (
        ...args: Parameters<typeof actual.applyChatAnchorDriftRepair>
      ): ChatAnchorDriftRepairOutcome["kind"] => {
        applyChatAnchorDriftRepairCallCountRef.current += 1;
        return actual.applyChatAnchorDriftRepair(...args);
      },
    };
  },
);

vi.mock(
  "@/stores/chats/activity-group-open-store-core",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/stores/chats/activity-group-open-store-core")
      >();
    const { activityGroupOpenIds } = await import("./chat-messages-suite-refs");
    // Ticket 5's registry (`getOrCreateActivityGroupOpenStore`) can hand back
    // the SAME real store object across multiple calls for one tileInstanceId
    // (e.g. a remount-simulating test); track which store objects are already
    // wrapped so re-wrapping never double-counts a single `setOpen` call.
    const wrappedStores = new WeakSet<object>();
    function wrapWithSetOpenTracking(
      store: StoreApi<ActivityGroupOpenState>,
    ): StoreApi<ActivityGroupOpenState> {
      if (wrappedStores.has(store)) return store;
      wrappedStores.add(store);
      const originalGetState = store.getState.bind(store);
      store.getState = () => {
        const state = originalGetState();
        return {
          ...state,
          setOpen: (groupId: string, open: boolean) => {
            activityGroupOpenIds.setOpenCalls.push({ groupId, open });
            state.setOpen(groupId, open);
            activityGroupOpenIds.lastOpenIds = new Set(
              originalGetState().openIds,
            );
          },
        };
      };
      return store;
    }
    return {
      ...actual,
      createActivityGroupOpenStore: (
        initialOpenIds: ReadonlySet<string> | null,
      ) =>
        wrapWithSetOpenTracking(
          actual.createActivityGroupOpenStore(initialOpenIds),
        ),
      getOrCreateActivityGroupOpenStore: (
        identity: ChatTabPersistenceIdentity,
      ) =>
        wrapWithSetOpenTracking(
          actual.getOrCreateActivityGroupOpenStore(identity),
        ),
    };
  },
);

describe("ChatMessages scroll policy", () => {
  registerChatMessagesSuiteHooks();

  describe("ticket 4: anchor engine integration (decisions #8-10, #15-16)", () => {
    it("composer-send optimistic row anchors while free-scrolling, settles, and keeps mode through stream growth (decision #8)", async () => {
      // Honest pin for unconditional local-provenance: free-scroll FIRST so a
      // bug that only anchors while following-end cannot pass. Registry
      // membership (not row shape / persistentMessageId) is the ground truth.
      const messages = makeCompletedTranscript(16);
      const sendId = "user-optimistic-send";
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "t4-optimistic-anchor-key",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      // Parked at top: the would-be send row is outside the mounted window.
      expect(screen.queryByTestId(`mock-message-${sendId}`)).toBeNull();

      const afterSend = appendOptimisticUserSend(messages, sendId, 999_000);
      rerenderMessages(afterSend);
      await settleLegendList();

      // Honest #8 pin: free-scrolling + local registry → mode flips and the
      // target row mounts (a following-only bug would leave free-scrolling).
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      await waitForAnchorEngineSettle();
      const scrollAfterSettle = getScrollNode().scrollTop;
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      // Streamed growth after settle: still anchoring; compare two real
      // scrollTops (never a scrollHeight-derived maxScroll). Leaving
      // anchoring-new-turn would be the blank end-space chase regression.
      const afterStream = appendStreamingAssistantChunks(afterSend, 3, 999_000);
      rerenderMessages(afterStream);
      await settleLegendList();
      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 100);
        });
      });

      expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      const scrollAfterStream = getScrollNode().scrollTop;
      expect(Math.abs(scrollAfterStream - scrollAfterSettle)).toBeLessThan(
        2_000,
      );
    });

    it("keeps a completed-turn composer send below the top fade and retains its reply viewport after a slight departure", async () => {
      const messages = makeCompletedTranscript(10);
      const sendId = "composer-send-reserve-departure";
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "composer-send-reserve-departure",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      const afterSend = appendOptimisticUserSend(messages, sendId, 205_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();

      const list = legendListRefHolder.current;
      if (list === null) throw new Error("Expected an attached LegendList");
      const sendIndex = afterSend.length - 1;
      const queryViewportTop =
        list.getState().positionAtIndex(sendIndex) +
        LEGEND_LIST_HEADER_PX -
        getScrollNode().scrollTop;
      // The compact fade is 40px tall. The query must start at or below its
      // fully opaque edge instead of the old 16px clipped position.
      expect(queryViewportTop).toBeGreaterThanOrEqual(LEGEND_LIST_HEADER_PX);

      const reservedContentLength = list.getState().contentLength;
      const anchoredScrollTop = getScrollNode().scrollTop;
      fireEvent.wheel(getScrollNode(), { deltaY: -0.1 });
      await fireScrollTopAndFlush(anchoredScrollTop - 0.25);
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().scrollTop).toBe(anchoredScrollTop - 0.25);
      // Detaching the mover must not destroy the independent reply reserve;
      // otherwise the browser clamps the now-shorter range and yanks the
      // viewport exactly as reported.
      expect(list.getState().contentLength).toBeGreaterThanOrEqual(
        reservedContentLength,
      );
    });

    it("distinguishes a scroll-only settle departure from an ordinary anchor undershoot", () => {
      // The initial anchor started at 300 and targets 940. A landing between
      // those positions is an ordinary animated undershoot and must be
      // re-issued; only a position meaningfully ABOVE the starting/target
      // floor means the reader moved upward during the settle window.
      expect(anchorMoverShouldYieldToReader(100, 300, 940)).toBe(true);
      expect(anchorMoverShouldYieldToReader(700, 300, 940)).toBe(false);
    });

    it("overflowing anchored turn (from free-scroll send) shows streaming pill then New reply with no mode flip on completion (decision #10)", async () => {
      // Enough rows to free-scroll away from the would-be send, but not so many
      // that LegendList measurement of the anchor index is flaky under the
      // jsdom shim (overflow metrics need a measured anchor + last row).
      const messages = makeCompletedTranscript(10);
      const sendId = "user-overflow-send";
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "t4-overflow-new-reply-key",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(screen.queryByTestId(`mock-message-${sendId}`)).toBeNull();

      const afterSend = appendOptimisticUserSend(messages, sendId, 888_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      // Settle must complete before the reveal pass will accept size growth
      // (positioned === settled). jsdom relies on the 750ms scrollend fallback.
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      // 14 * 90px ≈ 1260 > usable viewport (~580 with endInset 80 + offset 40)
      // so the reveal pass flips anchoredTurnOverflowsViewport → streaming pill.
      const afterOverflow = appendStreamingAssistantChunks(
        afterSend,
        14,
        888_000,
      );
      rerenderMessages(afterOverflow);
      await settleLegendList();
      // Two-rAF reveal pass + state commit for overflowsUsableViewport.
      await act(async () => {
        for (let frame = 0; frame < 6; frame += 1) {
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          });
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 300);
        });
      });

      await waitFor(
        () => {
          expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
          expect(isJumpPillVisible()).toBe(true);
          expect(screen.getByTestId("scroll-to-end-pill-spinner")).toBeTruthy();
          expect(pillVisibleLabel()).toMatch(/…$/);
        },
        { timeout: 4_000 },
      );

      const scrollWhileStreaming = getScrollNode().scrollTop;

      // Complete the trailing assistant while still anchored / not following.
      const trailing = afterOverflow[afterOverflow.length - 1];
      const afterComplete: ReadonlyArray<ChatMessageModel> = [
        ...afterOverflow.slice(0, -1),
        {
          ...trailing,
          completedAt: 1_700_000_000_000,
          runState: null,
        },
      ];
      rerenderMessages(afterComplete);
      await settleLegendList();
      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 200);
        });
      });

      // Decision #10: stay anchored - no flip to following-end (that would be
      // the auto-reveal regression). Compare two real scrollTops, never a
      // shim scrollHeight-derived maxScroll.
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      const scrollAfterComplete = getScrollNode().scrollTop;
      expect(Math.abs(scrollAfterComplete - scrollWhileStreaming)).toBeLessThan(
        500,
      );

      await waitFor(
        () => {
          expect(isJumpPillVisible()).toBe(true);
          expect(screen.queryByTestId("scroll-to-end-pill-spinner")).toBeNull();
          expect(pillVisibleLabel()).toContain("New reply");
        },
        { timeout: 3_000 },
      );
    });

    it("second- and third-turn anchor engagement lands at the EXACT anchor offset, not merely 'somewhere far' (live-E2E merge-blocker: multi-turn anchor engagement)", async () => {
      // Row height is uniform (90px, ITEM_HEIGHT_PX) under the jsdom shim,
      // so a correctly-landed anchor's scrollTop must differ from another
      // correctly-landed anchor's scrollTop by EXACTLY (indexDelta * 90),
      // regardless of any header/inset constant this test doesn't know.
      // This is what distinguishes a real landing from an undershoot: the
      // live third-turn regression settled ~512px SHORT of the target
      // (528px landed vs the fade-safe offset expected) while holding
      // rock-steady there -
      // a loose "moved far enough" check cannot see that at all.
      const ROW_HEIGHT_PX = 90;
      const initial = makeCompletedTranscript(4);
      const turn1Id = "user-turn1-send";
      const turn2Id = "user-turn2-send";
      const turn3Id = "user-turn3-send";
      const { rerenderMessages } = renderChatMessages({
        messages: initial,
        scrollStateKey: "t4-multiturn-engagement-key",
        localProvenanceMessageIds: new Set([turn1Id, turn2Id, turn3Id]),
      });
      await settleLegendList();

      // Turn 1: send + full anchor-lifecycle settle - its refs must be
      // SETTLED, not merely pending, before turn 2 begins (stale-ref hint).
      const afterTurn1Send = appendOptimisticUserSend(
        initial,
        turn1Id,
        100_000,
      );
      rerenderMessages(afterTurn1Send);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${turn1Id}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      const scrollAfterTurn1 = getScrollNode().scrollTop;
      const turn1AnchorIndex = afterTurn1Send.length - 1;

      // Grow + complete turn 1's reply to substantial size (~70 rows ≈
      // 6300px, matching the live trace's "~7000px content").
      const afterOverflow = appendStreamingAssistantChunks(
        afterTurn1Send,
        70,
        100_000,
      );
      rerenderMessages(afterOverflow);
      await settleLegendList();
      await act(async () => {
        for (let frame = 0; frame < 6; frame += 1) {
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          });
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 300);
        });
      });
      const trailing1 = afterOverflow[afterOverflow.length - 1];
      const afterTurn1Complete: ReadonlyArray<ChatMessageModel> = [
        ...afterOverflow.slice(0, -1),
        { ...trailing1, completedAt: 1_700_000_000_000, runState: null },
      ];
      rerenderMessages(afterTurn1Complete);
      await settleLegendList();

      // Free-scroll far from wherever turn 1's anchor left us. jsdom's flat
      // getBoundingClientRect makes scrollTop the only trustworthy geometry
      // signal, so parking at the very top makes "did the anchor scroll
      // actually land" an unmissable jump rather than a coincidental no-op.
      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(screen.queryByTestId(`mock-message-${turn2Id}`)).toBeNull();

      // Turn 2: second send. Decision #8: unconditional anchor regardless
      // of current mode/position.
      const afterTurn2Send = appendOptimisticUserSend(
        afterTurn1Complete,
        turn2Id,
        300_000,
      );
      rerenderMessages(afterTurn2Send);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${turn2Id}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await waitForAnchorEngineSettle();
      const scrollAfterTurn2 = getScrollNode().scrollTop;
      const turn2AnchorIndex = afterTurn2Send.length - 1;

      // Exact-landing check: turn 2's anchor must sit precisely
      // (indexDelta * rowHeight) away from turn 1's - not merely "moved
      // far", which an undershot-but-still-large jump would also satisfy.
      expect(scrollAfterTurn2 - scrollAfterTurn1).toBe(
        (turn2AnchorIndex - turn1AnchorIndex) * ROW_HEIGHT_PX,
      );

      // Grow + complete turn 2's reply too, mirroring a real multi-turn
      // chat (the live regression only showed up on the THIRD anchor
      // session - a bare unfilled send for turn 2, as this test used to
      // do, may not exercise the same compounding-reserve state).
      // `appendOneStreamingChunk` (globally-unique ids), not
      // `appendStreamingAssistantChunks` (scoped `stream-chunk-0..9`,
      // which would collide with turn 1's own `stream-chunk-0..69`
      // still in the array and corrupt LegendList's keyExtractor).
      let turn2Overflow: ReadonlyArray<ChatMessageModel> = afterTurn2Send;
      for (let chunkIndex = 0; chunkIndex < 10; chunkIndex += 1) {
        turn2Overflow = appendOneStreamingChunk(
          turn2Overflow,
          100 + chunkIndex,
          300_000,
        );
      }
      rerenderMessages(turn2Overflow);
      await settleLegendList();
      await act(async () => {
        for (let frame = 0; frame < 6; frame += 1) {
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          });
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 300);
        });
      });
      const trailing2 = turn2Overflow[turn2Overflow.length - 1];
      const afterTurn2Complete: ReadonlyArray<ChatMessageModel> = [
        ...turn2Overflow.slice(0, -1),
        { ...trailing2, completedAt: 1_700_000_100_000, runState: null },
      ];
      rerenderMessages(afterTurn2Complete);
      await settleLegendList();

      // Third turn (twice-settled refs): turn 1's AND turn 2's anchor
      // lifecycles have both already run to settle before this begins -
      // exactly the "stale refs from a prior turn" shape the live finding's
      // hint #1 called out.
      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(screen.queryByTestId(`mock-message-${turn3Id}`)).toBeNull();

      const afterTurn3Send = appendOptimisticUserSend(
        afterTurn2Complete,
        turn3Id,
        500_000,
      );
      rerenderMessages(afterTurn3Send);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${turn3Id}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await waitForAnchorEngineSettle();
      const scrollAfterTurn3 = getScrollNode().scrollTop;
      const turn3AnchorIndex = afterTurn3Send.length - 1;

      // The live regression: turn 3 settled ~512px SHORT of its target
      // (missing-reserve undershoot) while turn 2 landed exactly. This
      // must fail loudly, not just "still moved some" - same exact-delta
      // check as turn 1 -> turn 2 above.
      expect(scrollAfterTurn3 - scrollAfterTurn2).toBe(
        (turn3AnchorIndex - turn2AnchorIndex) * ROW_HEIGHT_PX,
      );
    });

    it("re-asserts the anchor position when content ABOVE it grows after settle (live-E2E: late-arriving prior-turn metadata following a short reply)", async () => {
      // The bug this guards: a prior turn's completion metadata (e.g. a
      // "Thought for Xs" disclosure) can land ABOVE the current anchor
      // AFTER this turn's anchor has already settled -
      // `maintainVisibleContentPosition` has `size:false`, so LegendList never
      // compensates, and nothing else corrects it: the reveal-delta check only
      // accounts for growth BELOW the anchor.
      const ROW_HEIGHT_PX = 90;
      const initial = makeCompletedTranscript(4);
      const turn1Id = "user-turn1-send";
      const turn2Id = "user-turn2-send";
      const { rerenderMessages } = renderChatMessages({
        messages: initial,
        scrollStateKey: "t4-anchor-drift-key",
        localProvenanceMessageIds: new Set([turn1Id, turn2Id]),
      });
      await settleLegendList();

      const afterTurn1Send = appendOptimisticUserSend(
        initial,
        turn1Id,
        100_000,
      );
      rerenderMessages(afterTurn1Send);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${turn1Id}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();

      // Turn 1 gets a short reply that completes immediately - the shape
      // t9's live repro isolated (long prior turns don't show this, only
      // short ones).
      const afterTurn1Reply: ReadonlyArray<ChatMessageModel> = [
        ...afterTurn1Send,
        {
          ...makeMessageAt(0, "assistant", 100_001),
          id: "turn1-reply",
          content: "OK",
          completedAt: 100_002,
          runState: null,
        },
      ];
      rerenderMessages(afterTurn1Reply);
      await settleLegendList();

      const afterTurn2Send = appendOptimisticUserSend(
        afterTurn1Reply,
        turn2Id,
        200_000,
      );
      rerenderMessages(afterTurn2Send);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${turn2Id}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await waitForAnchorEngineSettle();
      const scrollAfterSettle = getScrollNode().scrollTop;
      const turn2AnchorIndex = afterTurn2Send.length - 1;

      // Late-arriving metadata for turn 1: a new row lands ABOVE turn 2's
      // anchor via the SAME `messages` array the reveal-pass effect
      // already watches - not a new data source, just a delayed update to
      // existing history.
      const withLateMetadata: ReadonlyArray<ChatMessageModel> = [
        ...afterTurn2Send.slice(0, turn2AnchorIndex),
        {
          ...makeMessageAt(0, "assistant", 100_003),
          id: "turn1-late-metadata",
          content: "Thought for 4s",
          completedAt: 100_004,
          runState: null,
        },
        ...afterTurn2Send.slice(turn2AnchorIndex),
      ];
      rerenderMessages(withLateMetadata);
      await waitForRevealPassTick();

      // The anchor must hold its EXACT offset from the viewport top - the
      // inserted row grew content above it by one row height, so scroll
      // must grow by exactly that much to compensate. A flat (zero) delta
      // here is the live regression: the anchor silently drifts down by
      // the inserted row's height instead.
      const scrollAfterMetadata = getScrollNode().scrollTop;
      expect(scrollAfterMetadata - scrollAfterSettle).toBe(ROW_HEIGHT_PX);
    });

    it("does not re-assert anchor drift after a scroll-only upward departure", async () => {
      const initial = makeCompletedTranscript(10);
      const sendId = "anchor-drift-scroll-only-departure";
      const { rerenderMessages } = renderChatMessages({
        messages: initial,
        scrollStateKey: "anchor-drift-scroll-only-departure",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      const afterSend = appendOptimisticUserSend(initial, sendId, 210_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();

      const scrollNode = getScrollNode();
      const departedScrollTop = scrollNode.scrollTop - 180;
      expect(departedScrollTop).toBeGreaterThan(0);
      // Ticket 19: `anchorMoverShouldYieldToReader`'s yield check is a pure
      // position comparison - it does not care HOW `scrollTop` ended up
      // below the expected anchor position, only that it did. Using the
      // real library API to set up that precondition (instead of a bare
      // `scrollTop` write, which the capture-provenance classifier now
      // correctly cancels as an unexplained departure) keeps this test
      // inside `anchoring-new-turn` so it still reaches the SAME reveal-
      // pass yield branch it always exercised.
      await fireLibraryOwnedScrollTo(departedScrollTop);
      expect(scrollNode.dataset.scrollMode).toBe("anchoring-new-turn");

      const anchorIndex = afterSend.length - 1;
      const withLateMetadata: ReadonlyArray<ChatMessageModel> = [
        ...afterSend.slice(0, anchorIndex),
        {
          ...makeMessageAt(0, "assistant", 210_001),
          id: "anchor-drift-late-metadata",
          content: "Thought for 4s",
          completedAt: 210_002,
          runState: null,
        },
        ...afterSend.slice(anchorIndex),
      ];
      rerenderMessages(withLateMetadata);
      await waitForRevealPassTick();

      expect(scrollNode.scrollTop).toBe(departedScrollTop);
      expect(scrollNode.dataset.scrollMode).toBe("anchoring-new-turn");
    });

    describe("reveal pass stops advancing once the anchored turn overflows (live-E2E merge-blocker: decisions #1/#10/#16)", () => {
      // The bug this guards: a single batched jump to N streamed rows (like
      // the test above) only fires the reveal-pass effect ONCE, which can
      // never expose an indefinite-chase regression - real streaming is
      // incremental (one effect run per token/delta). These tests drive
      // growth one chunk at a time, awaiting a reveal-pass tick between each,
      // to mirror that shape.
      it("holds the anchor position (no drift, no pill) while growth stays within the usable viewport", async () => {
        const messages = makeCompletedTranscript(10);
        const sendId = "user-fits-send";
        const { rerenderMessages } = renderChatMessages({
          messages,
          scrollStateKey: "t4-reveal-fits-key",
          localProvenanceMessageIds: new Set([sendId]),
        });
        await settleLegendList();

        const afterSend = appendOptimisticUserSend(messages, sendId, 500_000);
        rerenderMessages(afterSend);
        await waitFor(() => {
          expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
        });
        await waitForAnchorEngineSettle();
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
        const scrollAtAnchor = getScrollNode().scrollTop;

        // Usable viewport ≈ 580px / 90px rows ≈ 6.4 rows - well under overflow.
        // With uniform 90px rows, `anchoredEndSpace`'s reserved trailing
        // space absorbs each new row exactly (decision #12's fade-safe offset
        // budgets ~564px below the anchor before overflow) - growth inside
        // that budget needs no scroll adjustment at all, since the newly
        // measured row simply replaces reserved blank space that was
        // already within the viewport. scrollTop staying put here is the
        // correct behavior, not an absence of coverage: the sibling "STOPS
        // scrolling" test below exercises the one case that DOES require a
        // scroll response (crossing into overflow).
        let current = afterSend;
        for (let chunkIndex = 0; chunkIndex < 5; chunkIndex += 1) {
          current = appendOneStreamingChunk(current, chunkIndex, 500_000);
          rerenderMessages(current);
          await waitForRevealPassTick();
          // Still fits - the pill must not show a streaming/overflow state,
          // and the anchor must not drift off its settled position.
          expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
          expect(getScrollNode().scrollTop).toBe(scrollAtAnchor);
        }
        expect(isJumpPillVisible()).toBe(false);
      });

      it("STOPS scrolling the instant the turn overflows, flips the pill to streaming, and never moves again across further chunks (red-on-baseline: fails pre-fix with continuous movement)", async () => {
        const messages = makeCompletedTranscript(10);
        const sendId = "user-overflow-stop-send";
        const { rerenderMessages } = renderChatMessages({
          messages,
          scrollStateKey: "t4-reveal-stops-key",
          localProvenanceMessageIds: new Set([sendId]),
        });
        await settleLegendList();

        const afterSend = appendOptimisticUserSend(messages, sendId, 600_000);
        rerenderMessages(afterSend);
        await waitFor(() => {
          expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
        });
        await waitForAnchorEngineSettle();

        // Grow one chunk at a time until the pill reports streaming (first
        // overflow), then keep growing 4 MORE chunks and assert scrollTop is
        // frozen across every one of them - not just "eventually settles."
        let current = afterSend;
        let scrollAtFirstOverflow: number | null = null;
        for (let chunkIndex = 0; chunkIndex < 20; chunkIndex += 1) {
          current = appendOneStreamingChunk(current, chunkIndex, 600_000);
          rerenderMessages(current);
          await waitForRevealPassTick();
          if (isJumpPillVisible()) {
            scrollAtFirstOverflow = getScrollNode().scrollTop;
            break;
          }
        }
        if (scrollAtFirstOverflow === null) {
          throw new Error(
            "Turn never overflowed the usable viewport within 20 chunks - test setup is wrong, not the assertion.",
          );
        }
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
        expect(screen.getByTestId("scroll-to-end-pill-spinner")).toBeTruthy();

        for (let more = 0; more < 4; more += 1) {
          current = appendOneStreamingChunk(current, 100 + more, 600_000);
          rerenderMessages(current);
          await waitForRevealPassTick();
          // The live-E2E bug: this kept advancing (163 -> 7494px) instead of
          // staying frozen at the overflow boundary.
          expect(getScrollNode().scrollTop).toBe(scrollAtFirstOverflow);
          expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
          expect(isJumpPillVisible()).toBe(true);
        }

        // Completion below the fold: decision #10, still zero movement.
        const trailingId = `incremental-chunk-${103}`;
        const completed = current.map((message) =>
          message.id === trailingId
            ? { ...message, completedAt: 1_700_000_000_000, runState: null }
            : message,
        );
        rerenderMessages(completed);
        await waitForRevealPassTick();
        await act(async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 200);
          });
        });

        expect(getScrollNode().scrollTop).toBe(scrollAtFirstOverflow);
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
        await waitFor(() => {
          expect(isJumpPillVisible()).toBe(true);
          expect(screen.queryByTestId("scroll-to-end-pill-spinner")).toBeNull();
          expect(pillVisibleLabel()).toContain("New reply");
        });
      });
    });

    it("queued-flush/A2A row (no local provenance) anchors while following-end (decision #9)", async () => {
      // No localProvenance: proves the gated path, not the unconditional one.
      // data-scroll-mode is the honest signal that the anchor engine engaged
      // (following-end catchup alone would not leave "following-end").
      const messages = makeCompletedTranscript(16);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "t4-gated-follow-key",
      });
      await settleLegendList();
      expect(isJumpPillVisible()).toBe(false);
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");

      const afterFlush = appendPersistentUserRow(
        messages,
        "user-queued-flush-follow",
        777_000,
      );
      rerenderMessages(afterFlush);
      await settleLegendList();

      await waitFor(() => {
        expect(
          screen.getByTestId("mock-message-user-queued-flush-follow"),
        ).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
    });

    it("queued-flush/A2A row while free-scrolling does not move scrollTop and keeps free-scroll mode (decision #9)", async () => {
      const messages = makeCompletedTranscript(20);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "t4-gated-free-key",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(isJumpPillVisible()).toBe(true);
      expect(pillVisibleLabel()).toContain("Scroll to end");
      expect(screen.queryByTestId("scroll-to-end-pill-spinner")).toBeNull();
      expect(pillVisibleLabel()).not.toContain("New reply");

      const parkedScrollTop = getScrollNode().scrollTop;
      expect(
        screen.queryByTestId("mock-message-user-queued-flush-free"),
      ).toBeNull();

      const afterFlush = appendPersistentUserRow(
        messages,
        "user-queued-flush-free",
        666_000,
      );
      rerenderMessages(afterFlush);
      await settleLegendList();
      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 100);
        });
      });

      // Classifier returned none: park + free-scrolling mode both hold.
      expect(getScrollNode().scrollTop).toBe(parkedScrollTop);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(
        screen.queryByTestId("mock-message-user-queued-flush-free"),
      ).toBeNull();
      expect(isJumpPillVisible()).toBe(true);
      expect(pillVisibleLabel()).toContain("Scroll to end");
      expect(screen.queryByTestId("scroll-to-end-pill-spinner")).toBeNull();
      expect(pillVisibleLabel()).not.toContain("New reply");
    });

    it("fresh open with no saved scroll state anchors the last user message (decision #15)", async () => {
      // 20 rows: last is assistant (message-19); last user is message-18.
      // data-scroll-mode is the honest pin (not scrollHeight-derived maxScroll).
      const messages = makeCompletedTranscript(20);
      const scrollStateKey = `t4-fresh-open-${Math.random().toString(36).slice(2)}`;
      expect(
        hasSavedChatTabState(makeDefaultTestIdentity(scrollStateKey)),
      ).toBe(false);

      renderChatMessages({
        messages,
        scrollStateKey,
        freshOpen: true,
      });
      // Mode seed is synchronous at construction
      // (`resolveChatTimelineInitialModeSeed`) - first render, before settle.
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await settleLegendList();
      await waitForAnchorEngineSettle();

      await waitFor(() => {
        expect(screen.getByTestId("mock-message-message-18")).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(isJumpPillVisible()).toBe(false);
    });

    it("empty transcript still renders ChatEmptyState under the fresh-open path", async () => {
      const scrollStateKey = `t4-fresh-empty-${Math.random().toString(36).slice(2)}`;
      renderChatMessages({
        messages: [],
        scrollStateKey,
        freshOpen: true,
      });
      await settleLegendList();

      expect(screen.getByText("Start the conversation")).toBeTruthy();
      expect(screen.getByText("Send a message to get started.")).toBeTruthy();
      expect(screen.queryByTestId("chat-messages-scroll")).toBeNull();
    });

    describe("H1: empty -> non-empty live edge", () => {
      it("local-provenance first message anchors even with a saved bottom-following state", async () => {
        // Mount empty with a cache entry (freshOpen: false default seed). The
        // mount-time fresh-open seed has nothing to target; the local send on
        // the later transition must still anchor unconditionally via the
        // registry - proving that branch is independent of saved state.
        const sendId = "first-local-send";
        const { rerenderMessages } = renderChatMessages({
          messages: [],
          scrollStateKey: "t4-h1-local-empty-key",
          freshOpen: false,
          localProvenanceMessageIds: new Set([sendId]),
        });
        await settleLegendList();
        expect(screen.getByText("Start the conversation")).toBeTruthy();

        const next: ReadonlyArray<ChatMessageModel> = [
          {
            ...makeMessageAt(0, "user", 1_000),
            id: sendId,
            content: "hello empty chat",
            persistentMessageId: null,
          },
        ];
        rerenderMessages(next);
        await settleLegendList();

        await waitFor(() => {
          expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
        });
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      });

      it("saved empty chat anchors a live passive first turn while following", async () => {
        // ChatMessages mounts only after ChatSessionMessagesSurface has an
        // authoritative snapshot. An empty mount is therefore a real empty
        // chat, and this later non-local batch is a live passive arrival
        // governed by decision #9 rather than initial hydration.
        const history = makeCompletedTranscript(8);
        const { rerenderMessages } = renderChatMessages({
          messages: [],
          scrollStateKey: "t4-h1-saved-no-local-key",
          freshOpen: false,
        });
        await settleLegendList();

        rerenderMessages(history);
        await settleLegendList();

        await waitFor(() => {
          expect(screen.getByTestId("chat-messages-scroll")).toBeTruthy();
        });
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      });

      it("saved empty chat keeps a live passive first turn parked after a pointerdown relinquishes follow", async () => {
        const history = makeCompletedTranscript(8);
        const { rerenderMessages } = renderChatMessages({
          messages: [],
          scrollStateKey: "t4-h1-saved-user-departed-key",
          freshOpen: false,
        });
        await settleLegendList();

        fireEvent.pointerDown(screen.getByTestId("chat-transcript-container"));
        rerenderMessages(history);
        await settleLegendList();
        await waitForPillVisible();

        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
        expect(getScrollNode().scrollTop).toBe(0);
        expect(isJumpPillVisible()).toBe(true);
      });
    });

    describe("H2: same-turn steer-shaped insert (new user before still-present trailing assistant)", () => {
      it("anchors when the inserted user id is in the local-provenance registry", async () => {
        // Not a pure append and not a clean first-divergence replacement:
        // the trailing assistant keeps its id while a new user row is
        // spliced ahead of it (same-turn steer row-splitting shape). Prefix
        // history keeps the free-scroll park far from the insert so
        // row-mount is a real virtualization signal.
        const prefix = makeCompletedTranscript(16);
        const userTail = {
          ...makeMessageAt(0, "user", 200),
          id: "u-tail",
          completedAt: null,
        };
        const assistantLive = {
          ...makeMessageAt(1, "assistant", 201),
          id: "a-live",
          content: "still streaming",
          completedAt: null,
          runState: "running" as const,
        };
        const messages: ReadonlyArray<ChatMessageModel> = [
          ...prefix,
          userTail,
          assistantLive,
        ];
        const steerId = "u-steer";
        const { rerenderMessages } = renderChatMessages({
          messages,
          scrollStateKey: "t4-h2-steer-local-key",
          localProvenanceMessageIds: new Set([steerId]),
        });
        await settleLegendList();

        act(() => {
          enterFreeScrollingAwayFromEnd();
        });
        await waitForPillVisible();
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
        expect(screen.queryByTestId(`mock-message-${steerId}`)).toBeNull();

        const afterSteer: ReadonlyArray<ChatMessageModel> = [
          ...prefix,
          userTail,
          {
            ...makeMessageAt(0, "user", 202),
            id: steerId,
            content: "steer instruction",
            persistentMessageId: null,
          },
          assistantLive,
        ];
        rerenderMessages(afterSteer);
        await settleLegendList();

        await waitFor(() => {
          expect(screen.getByTestId(`mock-message-${steerId}`)).toBeTruthy();
        });
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

        await waitForAnchorEngineSettle();
        const list = legendListRefHolder.current;
        if (list === null) throw new Error("Expected an attached LegendList");
        const reservedContentLength = list.getState().contentLength;
        const anchoredScrollTop = getScrollNode().scrollTop;
        fireEvent.wheel(getScrollNode(), { deltaY: -0.1 });
        await fireScrollTopAndFlush(anchoredScrollTop - 0.25);
        await settleLegendList();

        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
        expect(getScrollNode().scrollTop).toBe(anchoredScrollTop - 0.25);
        expect(list.getState().contentLength).toBeGreaterThanOrEqual(
          reservedContentLength,
        );
      });

      it("stays free-scrolling when the inserted user id is NOT in the registry", async () => {
        const prefix = makeCompletedTranscript(16);
        const userTail = {
          ...makeMessageAt(0, "user", 200),
          id: "u-tail-gate",
          completedAt: null,
        };
        const assistantDone = {
          ...makeMessageAt(1, "assistant", 201),
          id: "a-live-gate",
          content: "done",
          completedAt: 300,
          runState: null,
        };
        const messages: ReadonlyArray<ChatMessageModel> = [
          ...prefix,
          userTail,
          assistantDone,
        ];
        const foreignId = "u-foreign-steer";
        const { rerenderMessages } = renderChatMessages({
          messages,
          scrollStateKey: "t4-h2-steer-foreign-key",
          // Empty registry: foreign window / A2A-shaped insert.
        });
        await settleLegendList();

        act(() => {
          enterFreeScrollingAwayFromEnd();
        });
        await waitForPillVisible();
        const parkedScrollTop = getScrollNode().scrollTop;
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

        const afterForeign: ReadonlyArray<ChatMessageModel> = [
          ...prefix,
          userTail,
          {
            ...makeMessageAt(0, "user", 202),
            id: foreignId,
            content: "other window edit",
            persistentMessageId: foreignId,
          },
          assistantDone,
        ];
        rerenderMessages(afterForeign);
        await settleLegendList();
        await act(async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 100);
          });
        });

        expect(getScrollNode().scrollTop).toBe(parkedScrollTop);
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
        expect(screen.queryByTestId(`mock-message-${foreignId}`)).toBeNull();
      });
    });
  });

  describe("ticket 18: send-anchor validated convergence", () => {
    const T18_ROW_HEIGHT_PX = 90;
    const T18_HEADER_PX = LEGEND_LIST_HEADER_PX;

    /**
     * Ticket 10 F2-style undershoot: force programmatic scroll jumps short of
     * their requested target so the first settle's validate fails and the
     * re-issue path must recover. `maxCorruptJumps` limits how many large
     * jumps are sabotaged (cleared afterward so a later reissue can land).
     *
     * Harness note: free-scroll-to-top + anchor scrollToIndex does not stick
     * scrollTop in this jsdom LegendList setup (0 HTMLElement.scrollTo calls
     * observed) - the same limitation ticket 4's free-scroll send pin never
     * asserted absolute offsets for. Pins below drive from following-end
     * (where scrollToIndex is known to stick) and sabotage landings instead.
     */
    function installAnchorScrollUndershoot(
      scrollNode: HTMLElement,
      undershootPx: number,
      maxCorruptJumps: number,
    ): { setEnabled: (enabled: boolean) => void; dispose: () => void } {
      let enabled = true;
      let remainingCorrupt = maxCorruptJumps;
      let stored = scrollNode.scrollTop;
      Object.defineProperty(scrollNode, "scrollTop", {
        configurable: true,
        get() {
          return stored;
        },
        set(value: number) {
          const numeric = Number(value);
          if (!Number.isFinite(numeric)) {
            stored = 0;
            return;
          }
          if (
            enabled &&
            remainingCorrupt > 0 &&
            Math.abs(numeric - stored) > 80
          ) {
            remainingCorrupt -= 1;
            // Jump toward the end is numeric > stored; short landing = less
            // travel. Jump upward is the inverse.
            stored =
              numeric > stored
                ? Math.max(0, numeric - undershootPx)
                : numeric + undershootPx;
            return;
          }
          stored = numeric;
        },
      });
      return {
        setEnabled: (next: boolean) => {
          enabled = next;
        },
        dispose: () => {
          Reflect.deleteProperty(scrollNode, "scrollTop");
          scrollNode.scrollTop = stored;
        },
      };
    }

    function expectedAnchorScrollTopForIndex(anchorIndex: number): number {
      return (
        anchorIndex * T18_ROW_HEIGHT_PX +
        T18_HEADER_PX -
        CHAT_LIST_ANCHOR_OFFSET
      );
    }

    async function waitForMultiRetryAnchorSettle(
      reachedTerminalState: () => boolean,
    ): Promise<void> {
      // Initial issue + up to 3 reissues. Attempts normally wake on the
      // environment's synthetic scrollend within frames, so poll the
      // caller's terminal condition and return as soon as it holds; the
      // full per-attempt watchdog budget below is only ever consumed by
      // tests that hang the library promise on purpose (pin G) or opt out
      // of synthetic scroll events (pin D). On budget expiry the caller's
      // own assertions report the failure.
      const budgetMs =
        (CHAT_TIMELINE_ANCHOR_SCROLL_PROMISE_TIMEOUT_MS + 100) * 5;
      const stepMs = 100;
      for (let waited = 0; waited < budgetMs; waited += stepMs) {
        if (reachedTerminalState()) return;
        await act(async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, stepMs);
          });
        });
      }
    }

    function scrollToOptionsFromCallArg(
      arg: unknown,
    ):
      | { readonly top: number; readonly behavior: ScrollBehavior | undefined }
      | undefined {
      if (arg === null || typeof arg !== "object") return undefined;
      if (!("top" in arg)) return undefined;
      const record = arg as { top: unknown; behavior?: unknown };
      if (typeof record.top !== "number" || !Number.isFinite(record.top)) {
        return undefined;
      }
      const behavior =
        typeof record.behavior === "string"
          ? (record.behavior as ScrollBehavior)
          : undefined;
      return { top: record.top, behavior };
    }

    function firstScrollBehaviorAfter(
      scrollToSpy: {
        readonly mock: {
          readonly calls: ReadonlyArray<ReadonlyArray<unknown>>;
        };
      },
      callsBefore: number,
    ): ScrollBehavior | undefined {
      const newCalls = scrollToSpy.mock.calls.slice(callsBefore);
      for (const call of newCalls) {
        const options = scrollToOptionsFromCallArg(call[0]);
        if (options === undefined) continue;
        return options.behavior;
      }
      return undefined;
    }

    async function flushAnchorPositionFrames(): Promise<void> {
      await act(async () => {
        for (let frame = 0; frame < 10; frame += 1) {
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          });
        }
      });
    }

    it("(pin A) send recovers via validated reissue to the exact fade-safe anchor offset after short landings", async () => {
      // Regression pin for the validated-convergence loop (rootcause probe's
      // "instant OR animated + reissue → fade-safe offset" half). jsdom
      // cannot freeze a mid-flight animated pixel endpoint; F2 undershoot is
      // the deterministic stand-in for estimate drift.
      const history = makeCompletedTranscript(40);
      const sendId = "t18-pin-a-send";
      const { rerenderMessages } = renderChatMessages({
        messages: history,
        scrollStateKey: "t18-pin-a",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      const scrollNode = getScrollNode();
      // Sabotage the first two large jumps; the next reissue lands honestly.
      const undershoot = installAnchorScrollUndershoot(scrollNode, 500, 2);
      try {
        const afterSend = appendOptimisticUserSend(history, sendId, 700_000);
        rerenderMessages(afterSend);
        await waitFor(() => {
          expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
        });
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
        const expected = expectedAnchorScrollTopForIndex(afterSend.length - 1);
        await waitForMultiRetryAnchorSettle(
          () => Math.abs(getScrollNode().scrollTop - expected) <= 1,
        );

        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
        expect(
          Math.abs(getScrollNode().scrollTop - expected),
        ).toBeLessThanOrEqual(1);
      } finally {
        undershoot.dispose();
      }
    });

    it("(pin B near) initial scrollToIndex is animated for a near multi-turn send", async () => {
      // Second turn from a settled first: distance is one short reply + send
      // (~2 rows) ≪ 1.5 viewports, and prior rows are measured so
      // expectedScrollTopAtIssue is finite (unmeasured targets default to
      // far/instant). Real send keeps anchorAnimatedRef true → smooth.
      const initial = makeCompletedTranscript(8);
      const turn1Id = "t18-pin-b-near-t1";
      const turn2Id = "t18-pin-b-near-t2";
      const realisticScrollHeight =
        (initial.length + 12) * T18_ROW_HEIGHT_PX + T18_HEADER_PX + 2_000;
      setLegendListScrollContainerScrollHeightOverride(realisticScrollHeight);
      try {
        const { rerenderMessages } = renderChatMessages({
          messages: initial,
          scrollStateKey: "t18-pin-b-near",
          localProvenanceMessageIds: new Set([turn1Id, turn2Id]),
        });
        await settleLegendList();

        const afterTurn1 = appendOptimisticUserSend(initial, turn1Id, 100_000);
        rerenderMessages(afterTurn1);
        await waitFor(() => {
          expect(screen.getByTestId(`mock-message-${turn1Id}`)).toBeTruthy();
        });
        await waitForAnchorEngineSettle();

        const afterTurn1Reply: ReadonlyArray<ChatMessageModel> = [
          ...afterTurn1,
          {
            ...makeMessageAt(0, "assistant", 100_001),
            id: "t18-pin-b-near-reply",
            content: "OK",
            completedAt: 100_002,
            runState: null,
          },
        ];
        rerenderMessages(afterTurn1Reply);
        await settleLegendList();

        const scrollToSpy = vi.spyOn(HTMLElement.prototype, "scrollTo");
        const callsBefore = scrollToSpy.mock.calls.length;

        const afterTurn2 = appendOptimisticUserSend(
          afterTurn1Reply,
          turn2Id,
          200_000,
        );
        rerenderMessages(afterTurn2);
        await waitFor(() => {
          expect(screen.getByTestId(`mock-message-${turn2Id}`)).toBeTruthy();
        });
        await flushAnchorPositionFrames();

        const expectedTop = expectedAnchorScrollTopForIndex(
          afterTurn2.length - 1,
        );
        const newCalls = scrollToSpy.mock.calls.slice(callsBefore);
        let anchorBehavior: ScrollBehavior | undefined;
        for (const call of newCalls) {
          const options = scrollToOptionsFromCallArg(call[0]);
          if (options === undefined) continue;
          if (Math.abs(options.top - expectedTop) > 2) continue;
          anchorBehavior = options.behavior;
          break;
        }
        expect(anchorBehavior).toBe("smooth");
      } finally {
        setLegendListScrollContainerScrollHeightOverride(null);
      }
    });

    it("(pin B far/instant intent) fresh-open seed issues instant scroll (animated:false)", async () => {
      // Distance-based far jump is jsdom-limited (park-away leaves
      // scrollToIndex unissued in this harness). Pin the OTHER half of
      // shouldAnimateInitialIssue: anchorAnimatedRef is false for the
      // fresh-open seed (decision #15) → instant regardless of distance.
      const messages = makeCompletedTranscript(24);
      const scrollStateKey = `t18-pin-b-fresh-${Math.random().toString(36).slice(2)}`;
      expect(
        hasSavedChatTabState(makeDefaultTestIdentity(scrollStateKey)),
      ).toBe(false);

      const scrollToSpy = vi.spyOn(HTMLElement.prototype, "scrollTo");
      const callsBefore = scrollToSpy.mock.calls.length;

      renderChatMessages({
        messages,
        scrollStateKey,
        freshOpen: true,
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await settleLegendList();
      await flushAnchorPositionFrames();
      await waitForAnchorEngineSettle();

      // Fresh-open may bootstrap via initialScrollIndex rather than a later
      // scrollToIndex; when a post-mount scroll DOES fire it must be instant.
      const behavior = firstScrollBehaviorAfter(scrollToSpy, callsBefore);
      if (behavior !== undefined) {
        expect(behavior).toBe("auto");
      }
      // Mode + target row still pin the seed path ran.
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await waitFor(() => {
        expect(screen.getByTestId("mock-message-message-22")).toBeTruthy();
      });
    });

    it("(pin C) retry exhaustion fails safe to free-scrolling + pill and warns once (never writes settled)", async () => {
      const history = makeCompletedTranscript(24);
      const sendId = "t18-pin-c-exhaust-send";
      const { rerenderMessages } = renderChatMessages({
        messages: history,
        scrollStateKey: "t18-pin-c-exhaust",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      const warnSpy = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
      const scrollNode = getScrollNode();
      // Permanent undershoot: every attempt lands short → validate never
      // passes across initial + 3 retries.
      const undershoot = installAnchorScrollUndershoot(scrollNode, 400, 99);
      try {
        const afterSend = appendOptimisticUserSend(history, sendId, 740_000);
        rerenderMessages(afterSend);
        await waitFor(() => {
          expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
        });
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

        await waitForMultiRetryAnchorSettle(
          () => getScrollNode().dataset.scrollMode === "free-scrolling",
        );

        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
        expect(isJumpPillVisible()).toBe(true);

        const exhaustWarns = warnSpy.mock.calls.filter(
          (call) =>
            call[0] ===
            "[chat-messages] anchor settle exhausted retries without a validated landing",
        );
        expect(exhaustWarns).toHaveLength(1);
        expect(exhaustWarns[0]?.[1]).toMatchObject({
          messageId: sendId,
        });
      } finally {
        undershoot.dispose();
        warnSpy.mockRestore();
      }
    });

    it("(pin D) scroll-only reader departure mid-settle fails safe without the exhaust warn", async () => {
      // Timing-premise test: the drag must land mid-retry-loop, before the
      // bounded retries exhaust; keep the fallback-length attempt cadence.
      setLegendListSyntheticScrollEventsEnabled(false);
      // OS-scrollbar-drag style: scrollTop moves up with no wheel/touch/
      // pointerdown generation bump. shouldYieldToReader must win and
      // onSettledInvalid must NOT log the non-convergence warn.
      // Pure-function coverage of anchorMoverShouldYieldToReader already
      // exists in ticket 4 ("distinguishes a scroll-only settle departure…");
      // this pin is the NEW loop-integration behavior.
      const history = makeCompletedTranscript(24);
      const sendId = "t18-pin-d-yield-send";
      const { rerenderMessages } = renderChatMessages({
        messages: history,
        scrollStateKey: "t18-pin-d-yield",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      const warnSpy = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
      const scrollNode = getScrollNode();
      // Keep landings short so settle stays in-flight long enough for a
      // mid-loop yield without converging first.
      const undershoot = installAnchorScrollUndershoot(scrollNode, 400, 99);
      try {
        const afterSend = appendOptimisticUserSend(history, sendId, 750_000);
        rerenderMessages(afterSend);
        await waitFor(() => {
          expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
        });
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

        // Let the first issue land short, then simulate an OS-scrollbar drag
        // upward (no generation-bumping gesture).
        await act(async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 120);
          });
        });
        undershoot.setEnabled(false);
        const departed = Math.max(0, getScrollNode().scrollTop - 500);
        act(() => {
          scrollNode.scrollTop = departed;
          fireEvent.scroll(scrollNode);
        });

        await waitForMultiRetryAnchorSettle(
          () => getScrollNode().dataset.scrollMode === "free-scrolling",
        );

        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
        const exhaustWarns = warnSpy.mock.calls.filter(
          (call) =>
            call[0] ===
            "[chat-messages] anchor settle exhausted retries without a validated landing",
        );
        expect(exhaustWarns).toHaveLength(0);
      } finally {
        undershoot.dispose();
        warnSpy.mockRestore();
      }
    });

    it("(pin E) overflowed anchored turn still repairs content-above drift (reveal-effect reorder regression)", async () => {
      // Pre-ticket-18 order: overflow early-return ran BEFORE the anchor-
      // position repair, so a turn that already overflows never corrected
      // content-above growth. Existing ticket 4 pin covers the non-overflow
      // content-above case; this one requires overflow first.
      const history = makeCompletedTranscript(10);
      const sendId = "t18-pin-e-overflow-repair";
      const { rerenderMessages } = renderChatMessages({
        messages: history,
        scrollStateKey: "t18-pin-e-overflow-repair",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      const afterSend = appendOptimisticUserSend(history, sendId, 760_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      // Grow past usable viewport → streaming pill (overflow true).
      let current = afterSend;
      let overflowed = false;
      for (let chunkIndex = 0; chunkIndex < 20; chunkIndex += 1) {
        current = appendOneStreamingChunk(current, chunkIndex, 760_000);
        rerenderMessages(current);
        await waitForRevealPassTick();
        if (isJumpPillVisible()) {
          overflowed = true;
          break;
        }
      }
      expect(overflowed).toBe(true);
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      const scrollAtOverflow = getScrollNode().scrollTop;

      // Content ABOVE the still-anchored send grows after overflow.
      const anchorIndex = current.findIndex((message) => message.id === sendId);
      expect(anchorIndex).toBeGreaterThan(0);
      const withLateMetadata: ReadonlyArray<ChatMessageModel> = [
        ...current.slice(0, anchorIndex),
        {
          ...makeMessageAt(0, "assistant", 759_000),
          id: "t18-pin-e-late-above",
          content: "Thought for 4s",
          completedAt: 759_001,
          runState: null,
        },
        ...current.slice(anchorIndex),
      ];
      rerenderMessages(withLateMetadata);
      await waitForRevealPassTick();
      await waitForRevealPassTick();

      // Repair must still run despite overflowsUsableViewport: scroll grows
      // by exactly one row so the anchor holds its fade-safe offset.
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(getScrollNode().scrollTop - scrollAtOverflow).toBe(
        T18_ROW_HEIGHT_PX,
      );
    });

    it("(pin F) same-turn steer path also converges to the exact fade-safe offset (not send-only)", async () => {
      // Decision #8 events share beginAnchoringNewTurn. Ticket 4 already pins
      // mode engagement for send/steer/queued/fresh-open; this extends the
      // NEW convergence landing assertion to the steer-shaped insert.
      const base = makeCompletedTranscript(24);
      const trailingAssistant: ChatMessageModel = {
        ...makeMessageAt(0, "assistant", 400_000),
        id: "t18-pin-f-trailing-asst",
        content: "still running",
        completedAt: null,
        runState: "running",
      };
      const initial: ReadonlyArray<ChatMessageModel> = [
        ...base,
        trailingAssistant,
      ];
      const steerId = "t18-pin-f-steer";
      const { rerenderMessages } = renderChatMessages({
        messages: initial,
        scrollStateKey: "t18-pin-f-steer",
        localProvenanceMessageIds: new Set([steerId]),
      });
      await settleLegendList();

      const scrollNode = getScrollNode();
      const undershoot = installAnchorScrollUndershoot(scrollNode, 400, 2);
      try {
        // Steer shape: new local user spliced BEFORE the still-present
        // trailing assistant (H2 / same-turn steering).
        const afterSteer: ReadonlyArray<ChatMessageModel> = [
          ...base,
          {
            ...makeMessageAt(0, "user", 401_000),
            id: steerId,
            content: "steer instruction",
            persistentMessageId: null,
          },
          trailingAssistant,
        ];
        rerenderMessages(afterSteer);
        await waitFor(() => {
          expect(screen.getByTestId(`mock-message-${steerId}`)).toBeTruthy();
        });
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
        const steerIndex = afterSteer.findIndex(
          (message) => message.id === steerId,
        );
        const expected = expectedAnchorScrollTopForIndex(steerIndex);
        await waitForMultiRetryAnchorSettle(
          () => Math.abs(getScrollNode().scrollTop - expected) <= 1,
        );
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
        expect(
          Math.abs(getScrollNode().scrollTop - expected),
        ).toBeLessThanOrEqual(1);
      } finally {
        undershoot.dispose();
      }
    });

    it("(pin G, review round 2 residual) a watchdog-timeout wakeup never settles even when the DOM sits exactly at the target - it reissues/fails safe instead", async () => {
      // Source-proven residual: LegendList's own contract is TWO sequential
      // windows before its promise resolves - a readiness poll up to
      // IMPERATIVE_SCROLL_SETTLE_MAX_WAIT_MS (800ms) BEFORE it even issues
      // the scroll, then SCROLL_END_MAX_MS (1500ms) of animated ownership
      // after. A finite fallback can still fire while the DOM is
      // TRANSIENTLY at the target without the library's own promise having
      // resolved. `validate` must therefore treat a timed-out wakeup as an
      // unconditional failure - never settle off it - regardless of what
      // the geometry says. Simulated here by applying the REAL scroll (so
      // the DOM lands exactly where the library would place it - the
      // "transient crossing" case) but returning a promise that never
      // resolves, so only the watchdog can ever wake this settle.
      const history = makeCompletedTranscript(24);
      const sendId = "t18-pin-g-watchdog-send";
      const { rerenderMessages } = renderChatMessages({
        messages: history,
        scrollStateKey: "t18-pin-g-watchdog",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      await waitFor(() => {
        expect(legendListRefHolder.current).not.toBeNull();
      });
      const list = legendListRefHolder.current;
      if (!list) throw new Error("expected LegendListRef to be attached");
      const originalScrollToIndex = list.scrollToIndex.bind(list);
      const hangingScrollToIndex = vi
        .spyOn(list, "scrollToIndex")
        .mockImplementation((params) => {
          void originalScrollToIndex(params);
          return new Promise<void>(() => {});
        });
      const warnSpy = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
      try {
        const afterSend = appendOptimisticUserSend(history, sendId, 770_000);
        rerenderMessages(afterSend);
        await waitFor(() => {
          expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
        });
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

        // Every attempt's promise hangs -> every attempt times out ->
        // validate is unconditionally false regardless of the (actually
        // correct) DOM position -> retries exhaust -> fail-safe, never a
        // phantom settle at the transiently-correct position. Real watchdog
        // windows must elapse here (~4 x 2600ms) - the poll exits at the
        // fail-safe flip instead of padding a fifth window on top.
        await waitForMultiRetryAnchorSettle(
          () => getScrollNode().dataset.scrollMode === "free-scrolling",
        );

        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
        expect(isJumpPillVisible()).toBe(true);

        const exhaustWarns = warnSpy.mock.calls.filter(
          (call) =>
            call[0] ===
            "[chat-messages] anchor settle exhausted retries without a validated landing",
        );
        expect(exhaustWarns).toHaveLength(1);
        expect(exhaustWarns[0]?.[1]).toMatchObject({ messageId: sendId });
      } finally {
        hangingScrollToIndex.mockRestore();
        warnSpy.mockRestore();
      }
    });
  });

  describe("ticket 22: geometry-only changes repair the anchored turn", () => {
    const T22_GEOMETRY_DELTA_PX = 220;

    /** Sends, then streams chunks until the turn genuinely overflows the
     *  usable viewport (mirrors ticket 18 pin E's own recipe exactly). */
    async function sendAndOverflowAnchor(
      rerenderMessages: (messages: ReadonlyArray<ChatMessageModel>) => void,
      history: ReadonlyArray<ChatMessageModel>,
      sendId: string,
      createdAt: number,
    ): Promise<ReadonlyArray<ChatMessageModel>> {
      const afterSend = appendOptimisticUserSend(history, sendId, createdAt);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      let current = afterSend;
      let overflowed = false;
      for (let chunkIndex = 0; chunkIndex < 20; chunkIndex += 1) {
        current = appendOneStreamingChunk(current, chunkIndex, createdAt);
        rerenderMessages(current);
        await waitForRevealPassTick();
        if (isJumpPillVisible()) {
          overflowed = true;
          break;
        }
      }
      expect(overflowed).toBe(true);
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      return current;
    }

    it("(pin 1) a same-messages row-remeasure above a settled anchor re-asserts the anchor offset", async () => {
      const history = makeCompletedTranscript(10);
      const sendId = "t22-pin1-geometry-repair";
      const { rerenderMessages } = renderChatMessages({
        messages: history,
        scrollStateKey: "t22-pin1-geometry-repair",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      await sendAndOverflowAnchor(rerenderMessages, history, sendId, 810_000);
      const scrollBefore = getScrollNode().scrollTop;

      await waitFor(() => {
        expect(legendListRefHolder.current).not.toBeNull();
      });
      const list = legendListRefHolder.current;
      if (!list) throw new Error("expected LegendListRef to be attached");
      const scrollToOffsetSpy = vi.spyOn(list, "scrollToOffset");

      // Grow a row strictly ABOVE the anchor - SAME `messages` array, no
      // scroll, no rerender. Driven via the real LegendList `setItemSize`
      // ref method (teed through the pass-through mock) - the one lever
      // that fires a genuine, no-scroll `onItemSizeChanged`, matching how a
      // disclosure collapse/expand or a rewrap from a divider/pane resize
      // would move rows under the anchor in a real browser.
      act(() => {
        legendListRefHolder.current?.setItemSize("message-2", {
          height: 90 + T22_GEOMETRY_DELTA_PX,
          width: VIEWPORT_WIDTH_PX,
        });
      });

      await waitForRevealPassTick();

      // The anchor must hold its EXACT offset from the viewport top - the
      // grown row pushed content above it down by exactly this much, so
      // scroll must grow by the same amount to compensate. A flat (zero)
      // delta here is the ticket-22 defect: the anchor silently drifts.
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(getScrollNode().scrollTop - scrollBefore).toBe(
        T22_GEOMETRY_DELTA_PX,
      );
      // Review round 1 (finding 3, CONFIRMED MEDIUM): decision #31's
      // non-animated departure classifier depends on every anchor
      // correction being instant - assert the exact `scrollToOffset`
      // params, not just the resulting position.
      expect(scrollToOffsetSpy).toHaveBeenCalledWith(
        expect.objectContaining({ animated: false }),
      );
    });

    it("(pin 2) a viewport resize coalesces with a coincident item-size change into exactly one repair", async () => {
      const history = makeCompletedTranscript(10);
      const sendId = "t22-pin2-viewport-resize";
      const { rerenderMessages } = renderChatMessages({
        messages: history,
        scrollStateKey: "t22-pin2-viewport-resize",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      await sendAndOverflowAnchor(rerenderMessages, history, sendId, 820_000);
      const scrollBefore = getScrollNode().scrollTop;

      await waitFor(() => {
        expect(legendListRefHolder.current).not.toBeNull();
      });
      const list = legendListRefHolder.current;
      if (!list) throw new Error("expected LegendListRef to be attached");

      const scrollToOffsetSpy = vi.spyOn(list, "scrollToOffset");

      // A pure viewport-length change alone (no row remeasure) never moves
      // `positionAtIndex` for a single-column vertical list - it changes
      // what's REVEALED, not the anchor's own content-relative position.
      // Fired here to prove the new wiring is inert (no spurious
      // correction) when there is genuinely nothing to repair.
      act(() => {
        triggerLegendListResizeObserverEntry(getScrollNode(), {
          width: VIEWPORT_WIDTH_PX + 200,
          height: VIEWPORT_HEIGHT_PX,
        });
      });
      await waitForRevealPassTick();
      expect(scrollToOffsetSpy).not.toHaveBeenCalled();
      expect(getScrollNode().scrollTop).toBe(scrollBefore);

      // Now pair the SAME resize signal with the real-browser consequence
      // it would cause (a rewrapped row above the anchor growing) - jsdom's
      // shim never rewraps text on its own, so the row-height change is
      // driven explicitly alongside the resize event. Both signals land in
      // the same coalescing window; the repair must fire exactly ONCE, not
      // once per trigger. Review round 1 (finding 4): a single
      // `scrollToOffset` call alone survives a missing coalescing guard (a
      // second scheduled pass can settle at zero drift and never write), so
      // also assert the shared repair function itself ran exactly once -
      // two independent triggers (resize + item-size) collapsing to ONE
      // scheduled pass, not two.
      const repairCallsBefore = applyChatAnchorDriftRepairCallCountRef.current;
      act(() => {
        triggerLegendListResizeObserverEntry(getScrollNode(), {
          width: VIEWPORT_WIDTH_PX + 400,
          height: VIEWPORT_HEIGHT_PX,
        });
        legendListRefHolder.current?.setItemSize("message-2", {
          height: 90 + T22_GEOMETRY_DELTA_PX,
          width: VIEWPORT_WIDTH_PX + 400,
        });
      });
      await waitForRevealPassTick();

      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(getScrollNode().scrollTop - scrollBefore).toBe(
        T22_GEOMETRY_DELTA_PX,
      );
      expect(scrollToOffsetSpy).toHaveBeenCalledOnce();
      expect(
        applyChatAnchorDriftRepairCallCountRef.current - repairCallsBefore,
      ).toBe(1);
    });

    it("(pin 3) no double-correction with the disclosure helper's own manual correction during anchoring", async () => {
      const history = makeCompletedTranscript(10);
      const sendId = "t22-pin3-no-double-correction";
      const { rerenderMessages } = renderChatMessages({
        messages: history,
        scrollStateKey: "t22-pin3-no-double-correction",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      await sendAndOverflowAnchor(rerenderMessages, history, sendId, 830_000);
      const scrollBefore = getScrollNode().scrollTop;

      await waitFor(() => {
        expect(legendListRefHolder.current).not.toBeNull();
      });

      // Simulates a disclosure toggle whose own trigger row sits above the
      // anchor and genuinely shifts on-screen by the SAME delta the real
      // row growth below produces - `correctionOwnedByMvcp: false` matches
      // production's own `timelineScrollModeRef.current === "free-scrolling"`
      // computation while anchoring (M2, tickets 10-12): the disclosure
      // helper owns and applies the correction synchronously.
      const anchorElement = document.createElement("div");
      const rectSpy = vi.spyOn(anchorElement, "getBoundingClientRect");
      rectSpy.mockReturnValueOnce({
        x: 0,
        y: 100,
        width: 100,
        height: 20,
        top: 100,
        left: 0,
        right: 100,
        bottom: 120,
        toJSON: () => ({}),
      });
      rectSpy.mockReturnValueOnce({
        x: 0,
        y: 100 + T22_GEOMETRY_DELTA_PX,
        width: 100,
        height: 20,
        top: 100 + T22_GEOMETRY_DELTA_PX,
        left: 0,
        right: 100,
        bottom: 120 + T22_GEOMETRY_DELTA_PX,
        toJSON: () => ({}),
      });

      act(() => {
        preserveChatScrollAcrossDisclosureChange({
          list: legendListRefHolder.current,
          anchorElement,
          mutate: () => {
            legendListRefHolder.current?.setItemSize("message-2", {
              height: 90 + T22_GEOMETRY_DELTA_PX,
              width: VIEWPORT_WIDTH_PX,
            });
          },
          correctionOwnedByMvcp: false,
        });
      });

      // The disclosure helper's own delta-based correction issues
      // synchronously; the real `setItemSize` call inside `mutate` also
      // fires a genuine `onItemSizeChanged` - ticket 22's new coalesced
      // geometry scheduler reacts to it independently. Let BOTH settle
      // (LegendList's own geometry bookkeeping is not guaranteed to reflect
      // a `scrollToOffset` call within the same act() it was issued in, and
      // the scheduler's own pass needs its two-rAF window) before checking
      // where the anchor landed.
      await waitForRevealPassTick();
      await waitForRevealPassTick();

      // Exactly the delta the row growth produced - not double-applied by
      // two independent correctors racing the same shift.
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(getScrollNode().scrollTop - scrollBefore).toBe(
        T22_GEOMETRY_DELTA_PX,
      );

      // Idempotence: with both correctors already settled and drift at
      // zero, a further settle window must not move it again - the
      // regression this pin guards is a SECOND correction stacking a
      // further +220 on top (landing at +440), not merely "some correction
      // happened".
      await waitForRevealPassTick();
      expect(getScrollNode().scrollTop - scrollBefore).toBe(
        T22_GEOMETRY_DELTA_PX,
      );
    });

    it("(pin 4) a departed/cancelled session gets no geometry repair", async () => {
      const history = makeCompletedTranscript(10);
      const sendId = "t22-pin4-departure-guard";
      const { rerenderMessages } = renderChatMessages({
        messages: history,
        scrollStateKey: "t22-pin4-departure-guard",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      await sendAndOverflowAnchor(rerenderMessages, history, sendId, 840_000);

      const scrollNode = getScrollNode();
      // A real downward-wheel departure gesture cancels the anchoring
      // session unconditionally (decision #14/ticket 14) - bumps the
      // generation the same way any other real-gesture cancel does.
      fireEvent.wheel(scrollNode, { deltaY: 40 });
      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
      const departedScrollTop = scrollNode.scrollTop;

      await waitFor(() => {
        expect(legendListRefHolder.current).not.toBeNull();
      });
      const list = legendListRefHolder.current;
      if (!list) throw new Error("expected LegendListRef to be attached");

      const scrollToOffsetSpy = vi.spyOn(list, "scrollToOffset");

      // The exact same geometry change pin 1 proves DOES repair while
      // still anchoring - here the session has already departed, so this
      // must be a pure no-op.
      act(() => {
        legendListRefHolder.current?.setItemSize("message-2", {
          height: 90 + T22_GEOMETRY_DELTA_PX,
          width: VIEWPORT_WIDTH_PX,
        });
      });

      await waitForRevealPassTick();

      expect(scrollToOffsetSpy).not.toHaveBeenCalled();
      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
      expect(scrollNode.scrollTop).toBe(departedScrollTop);
    });

    it("(pin 4b) departure DURING the deferred two-rAF window still blocks the repair", async () => {
      const history = makeCompletedTranscript(10);
      const sendId = "t22-pin4b-mid-window-departure";
      const { rerenderMessages } = renderChatMessages({
        messages: history,
        scrollStateKey: "t22-pin4b-mid-window-departure",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      await sendAndOverflowAnchor(rerenderMessages, history, sendId, 845_000);
      const scrollNode = getScrollNode();
      const scrollBefore = scrollNode.scrollTop;

      await waitFor(() => {
        expect(legendListRefHolder.current).not.toBeNull();
      });
      const list = legendListRefHolder.current;
      if (!list) throw new Error("expected LegendListRef to be attached");
      const scrollToOffsetSpy = vi.spyOn(list, "scrollToOffset");

      // Review round 1 (finding 2, CONFIRMED MEDIUM): pin 4 departs BEFORE
      // scheduling, so it only exercises the schedule-time mode guard - the
      // deferred callback's OWN fire-time mode/generation checks never run
      // in that pin at all. Schedule a real repair here (the same
      // setItemSize trigger pin 1 uses), let only the FIRST of the two rAFs
      // elapse - arms the second frame, does not run it yet, the
      // scheduler's own pending window - THEN depart with a real
      // downward-wheel gesture, THEN let the deferred frame actually fire.
      act(() => {
        list.setItemSize("message-2", {
          height: 90 + T22_GEOMETRY_DELTA_PX,
          width: VIEWPORT_WIDTH_PX,
        });
      });
      expect(scrollNode.dataset.scrollMode).toBe("anchoring-new-turn");

      await act(async () => {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
      });

      fireEvent.wheel(scrollNode, { deltaY: 40 });
      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");

      await waitForRevealPassTick();

      // The already-scheduled pass must see the departure at fire time and
      // yield - pin 1's repair signature (+T22_GEOMETRY_DELTA_PX via
      // `scrollToOffset`) must never land for this departed session.
      expect(scrollToOffsetSpy).not.toHaveBeenCalled();
      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
      expect(scrollNode.scrollTop).toBe(scrollBefore);
    });

    it("geometry repair does not fire while following-end", async () => {
      // Pure following-end (never entered anchoring-new-turn). The scheduler
      // mode-gates at schedule time and again inside the deferred frame -
      // pin 1's +T22_GEOMETRY_DELTA_PX signature is the anchoring-only path.
      const history = makeCompletedTranscript(12);
      renderChatMessages({
        messages: history,
        scrollStateKey: "t22-mode-following-end",
      });
      await settleLegendList();

      const scrollNode = getScrollNode();
      expect(scrollNode.dataset.scrollMode).toBe("following-end");
      const scrollBefore = scrollNode.scrollTop;

      await waitFor(() => {
        expect(legendListRefHolder.current).not.toBeNull();
      });

      act(() => {
        legendListRefHolder.current?.setItemSize("message-2", {
          height: 90 + T22_GEOMETRY_DELTA_PX,
          width: VIEWPORT_WIDTH_PX,
        });
      });
      await waitForRevealPassTick();

      // following-end may still move for maintainScrollAtEnd end-stick; the
      // load-bearing contract is mode stays non-anchoring and we never see
      // the anchor-hold repair signature from pin 1.
      expect(scrollNode.dataset.scrollMode).toBe("following-end");
      expect(scrollNode.scrollTop - scrollBefore).not.toBe(
        T22_GEOMETRY_DELTA_PX,
      );
    });

    it("geometry repair does not fire while free-scrolling", async () => {
      // Pure free-scrolling seed (not a post-departure pin-4 shape): park
      // away from the end, grow a history row, confirm the geometry
      // scheduler does not apply the anchoring-new-turn repair signature.
      // MVCP size-preservation may adjust scrollTop for reading stability -
      // that is a different mechanism; pin 4 already pins zero
      // scrollToOffset for a departed overflowing session.
      const history = makeCompletedTranscript(12);
      const scrollStateKey = "t22-mode-free-scrolling";
      saveChatTabState({
        identity: makeDefaultTestIdentity(scrollStateKey),
        mode: "free-scrolling",
        anchorMessageId: history[0]?.id ?? null,
        anchorIndex: 0,
        offset: 0,
      });
      renderChatMessages({
        messages: history,
        scrollStateKey,
      });
      await settleLegendList();

      const scrollNode = getScrollNode();
      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
      const scrollBefore = scrollNode.scrollTop;

      await waitFor(() => {
        expect(legendListRefHolder.current).not.toBeNull();
      });
      const freeScrollingList = legendListRefHolder.current;
      if (!freeScrollingList) {
        throw new Error("expected LegendListRef to be attached");
      }
      const scrollToOffsetSpy = vi.spyOn(freeScrollingList, "scrollToOffset");

      act(() => {
        legendListRefHolder.current?.setItemSize("message-2", {
          height: 90 + T22_GEOMETRY_DELTA_PX,
          width: VIEWPORT_WIDTH_PX,
        });
      });
      await waitForRevealPassTick();

      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
      expect(scrollNode.scrollTop - scrollBefore).not.toBe(
        T22_GEOMETRY_DELTA_PX,
      );
      // Mirror pin 4 when MVCP has nothing to compensate at scrollTop=0:
      // the geometry scheduler itself must not have called scrollToOffset.
      // If MVCP did compensate via another path, scrollTop would move but
      // still must not land on the pure anchor-repair signature above.
      if (scrollNode.scrollTop === scrollBefore) {
        expect(scrollToOffsetSpy).not.toHaveBeenCalled();
      }
    });

    it("a row growing BELOW the anchor produces no geometry correction", async () => {
      const history = makeCompletedTranscript(10);
      const sendId = "t22-below-anchor-no-repair";
      const { rerenderMessages } = renderChatMessages({
        messages: history,
        scrollStateKey: "t22-below-anchor-no-repair",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      const overflowing = await sendAndOverflowAnchor(
        rerenderMessages,
        history,
        sendId,
        850_000,
      );
      const scrollBefore = getScrollNode().scrollTop;

      // Streaming reply rows sit AFTER the anchored user send - growing one
      // of those changes content below the anchor only. positionAtIndex for
      // the anchor is unchanged, so the repair must see zero drift.
      const belowAnchorId = overflowing.find(
        (message) => message.id === "incremental-chunk-0",
      )?.id;
      expect(belowAnchorId).toBe("incremental-chunk-0");

      await waitFor(() => {
        expect(legendListRefHolder.current).not.toBeNull();
      });
      const belowAnchorList = legendListRefHolder.current;
      if (!belowAnchorList) {
        throw new Error("expected LegendListRef to be attached");
      }
      const scrollToOffsetSpy = vi.spyOn(belowAnchorList, "scrollToOffset");

      act(() => {
        legendListRefHolder.current?.setItemSize("incremental-chunk-0", {
          height: 90 + T22_GEOMETRY_DELTA_PX,
          width: VIEWPORT_WIDTH_PX,
        });
      });
      await waitForRevealPassTick();

      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(getScrollNode().scrollTop).toBe(scrollBefore);
      expect(scrollToOffsetSpy).not.toHaveBeenCalled();
    });

    it("multiple same-frame item-size changes above the anchor coalesce into one repair", async () => {
      const history = makeCompletedTranscript(10);
      const sendId = "t22-coalesce-multi-item-size";
      const { rerenderMessages } = renderChatMessages({
        messages: history,
        scrollStateKey: "t22-coalesce-multi-item-size",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      await sendAndOverflowAnchor(rerenderMessages, history, sendId, 860_000);

      await waitFor(() => {
        expect(legendListRefHolder.current).not.toBeNull();
      });
      const coalesceList = legendListRefHolder.current;
      if (!coalesceList) {
        throw new Error("expected LegendListRef to be attached");
      }
      const scrollToOffsetSpy = vi.spyOn(coalesceList, "scrollToOffset");
      const scrollBefore = getScrollNode().scrollTop;

      // Review round 1 (finding 4, CONFIRMED LOW): a single `scrollToOffset`
      // call proves idempotence, not "one scheduled pass" - if the
      // coalescing ref were missing, several independent two-rAF chains
      // would run, but only the FIRST observes non-zero drift and writes;
      // the rest settle at zero and never call `scrollToOffset`, so that
      // oracle alone survives the guard's removal. Count invocations of the
      // shared repair function itself instead (via the module-level
      // call-count tee above) - deterministic, unlike spying on
      // `window.requestAnimationFrame`, which also picks up LegendList's own
      // unrelated internal rAF usage.
      const repairCallsBefore = applyChatAnchorDriftRepairCallCountRef.current;

      // Four separate setItemSize notifications in one act() - each would
      // schedule its OWN two-rAF chain if the coalescing ref were missing;
      // the scheduler must collapse them into a single repair pass.
      const rowsAboveAnchor = [
        "message-0",
        "message-2",
        "message-4",
        "message-6",
      ] as const;
      act(() => {
        for (const rowId of rowsAboveAnchor) {
          legendListRefHolder.current?.setItemSize(rowId, {
            height: 90 + T22_GEOMETRY_DELTA_PX,
            width: VIEWPORT_WIDTH_PX,
          });
        }
      });
      await waitForRevealPassTick();

      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(getScrollNode().scrollTop - scrollBefore).toBe(
        T22_GEOMETRY_DELTA_PX * rowsAboveAnchor.length,
      );
      expect(scrollToOffsetSpy).toHaveBeenCalledOnce();
      expect(
        applyChatAnchorDriftRepairCallCountRef.current - repairCallsBefore,
      ).toBe(1);
    });

    it("unmount while a geometry repair is scheduled cancels cleanly (no throw, no late scrollToOffset)", async () => {
      const history = makeCompletedTranscript(10);
      const sendId = "t22-unmount-mid-repair";
      const { rerenderMessages, unmount } = renderChatMessages({
        messages: history,
        scrollStateKey: "t22-unmount-mid-repair",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      await sendAndOverflowAnchor(rerenderMessages, history, sendId, 870_000);

      await waitFor(() => {
        expect(legendListRefHolder.current).not.toBeNull();
      });
      const list = legendListRefHolder.current;
      if (!list) throw new Error("expected LegendListRef to be attached");
      const scrollToOffsetSpy = vi.spyOn(list, "scrollToOffset");
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const consoleWarnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});

      try {
        // Schedule the two-rAF geometry repair, then unmount before the
        // deferred frame runs - the cleanup effect must cancel the pending
        // frame so the callback never touches an unmounted list.
        act(() => {
          list.setItemSize("message-2", {
            height: 90 + T22_GEOMETRY_DELTA_PX,
            width: VIEWPORT_WIDTH_PX,
          });
          unmount();
        });

        await waitForRevealPassTick();

        expect(scrollToOffsetSpy).not.toHaveBeenCalled();
        expect(consoleErrorSpy).not.toHaveBeenCalled();
        expect(consoleWarnSpy).not.toHaveBeenCalled();
      } finally {
        consoleErrorSpy.mockRestore();
        consoleWarnSpy.mockRestore();
      }
    });

    it("(pin 1b) survives a StrictMode setup->cleanup->setup replay while already anchoring at mount (finding 1)", async () => {
      // Fresh-open (decision #15): no saved scroll state + a transcript
      // ending in a user send, so this mounts DIRECTLY into
      // `anchoring-new-turn` - the exact shape the review flagged (LegendList's
      // initial `onLayout` arms the coalescing sentinel during the FIRST
      // StrictMode setup; the dev-only cleanup->setup replay must not leave
      // it poisoned).
      const history = makeCompletedTranscript(10);
      const sendId = "t22-strict-fresh-open-anchor";
      const baseCreatedAt = 895_000;
      const messages = appendOptimisticUserSend(history, sendId, baseCreatedAt);
      const instanceId = `t22-strict-fresh-open-${Math.random().toString(36).slice(2)}`;
      const epicId = "epic-1";
      const taskId = "task-1";
      const identity = makeTestIdentity(instanceId, epicId, taskId);
      expect(hasSavedChatTabState(identity)).toBe(false);

      const { unmount } = render(
        <StrictMode>
          <div
            data-chat-keyboard-scroll-scope
            data-active="true"
            style={{ height: VIEWPORT_HEIGHT_PX, width: VIEWPORT_WIDTH_PX }}
          >
            <ChatMessages
              taskTitle="Test chat"
              taskId={taskId}
              epicId={epicId}
              messages={messages}
              localProvenanceMessageIds={new Set()}
              consumeLocalProvenance={() => undefined}
              backgroundItems={undefined}
              getMessageActions={() => null}
              nextStepActions={null}
              instanceId={instanceId}
              visible
              systemOverlayActive={false}
              isChatStreaming={false}
              scrollRequest={null}
              composerOverlayHeight={80}
            />
          </div>
        </StrictMode>,
      );

      // Mode seed is synchronous at construction (decision #15) - already
      // anchoring before StrictMode's dev-only setup->cleanup->setup replay
      // has even finished. This is the exact commit the review flagged:
      // LegendList's initial `onLayout` arms the coalescing sentinel WHILE
      // mode is already `anchoring-new-turn`, then StrictMode's replay
      // cancels those frames.
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await settleLegendList();
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      await waitFor(() => {
        expect(legendListRefHolder.current).not.toBeNull();
      });
      const list = legendListRefHolder.current;
      if (!list) throw new Error("expected LegendListRef to be attached");

      // The replay is long over by now - this is an ORDINARY later trigger,
      // identical to pin 1's own recipe. Pre-fix, the sentinel armed during
      // the first StrictMode setup stays non-null forever (the cleanup
      // cancels those frames without clearing it), so every later trigger
      // for the lifetime of this mount silently no-ops here.
      //
      // Signal choice: neither `scrollTop` nor the `applyChatAnchorDriftRepair`
      // call-count tee (finding 4's signal) work for THIS specific
      // construction - a SEPARATE, pre-existing harness limitation (fresh-
      // open's own `scrollToIndex` bootstrap never converges `scrollTop` for
      // a raw-StrictMode mount in this jsdom setup, so the anchor reaches
      // "positioned" but never "settled" - unrelated to ticket 22, flagged
      // to the reviewer rather than worked around here) means the deferred
      // callback's OWN unsettled-anchor guard always blocks it BEFORE
      // reaching the repair function, on both healthy and poisoned code.
      // Count synchronous `requestAnimationFrame` registrations instead,
      // scoped tightly to this one `act()`: `scheduleChatAnchorGeometryRepair`
      // returns at its entry guard (`pendingGeometryRepairCancelRef.current
      // !== null`) BEFORE calling `scheduleChatTimelineDoubleRaf` - which
      // itself always registers exactly one synchronous rAF per call - so a
      // poisoned sentinel drops the count by exactly one relative to a
      // healthy one. Mutation-verified directly against this exact test: 2
      // calls with the cleanup fix in place, 1 with it reverted (the `1` is
      // LegendList's own unrelated internal rAF usage for this `setItemSize`
      // call, present either way).
      const rafSpy = vi.spyOn(window, "requestAnimationFrame");
      rafSpy.mockClear();
      act(() => {
        list.setItemSize("message-2", {
          height: 90 + T22_GEOMETRY_DELTA_PX,
          width: VIEWPORT_WIDTH_PX,
        });
      });

      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(rafSpy.mock.calls.length).toBeGreaterThan(1);

      unmount();
    });

    it("geometry repair does not run while a new anchor is still pending/positioning (not yet settled)", async () => {
      const history = makeCompletedTranscript(10);
      const sendId = "t22-mid-flight-anchor-guard";
      const { rerenderMessages } = renderChatMessages({
        messages: history,
        scrollStateKey: "t22-mid-flight-anchor-guard",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      await waitFor(() => {
        expect(legendListRefHolder.current).not.toBeNull();
      });
      const list = legendListRefHolder.current;
      if (!list) throw new Error("expected LegendListRef to be attached");

      // Hang the library's scroll promise so the engine stays in
      // positioned-but-not-settled (pendingTimelineAnchorRef cleared on
      // onAnchorReady, settledTimelineAnchorRef still null) - the same
      // mid-flight window the scheduler's "no anchor navigation currently
      // mid-flight" guard is meant to refuse.
      const originalScrollToIndex = list.scrollToIndex.bind(list);
      const hangingScrollToIndex = vi
        .spyOn(list, "scrollToIndex")
        .mockImplementation((params) => {
          void originalScrollToIndex(params);
          return new Promise<void>(() => {});
        });
      const scrollToOffsetSpy = vi.spyOn(list, "scrollToOffset");

      try {
        const afterSend = appendOptimisticUserSend(history, sendId, 880_000);
        rerenderMessages(afterSend);
        await waitFor(() => {
          expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
        });
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

        // Wait until the hang is engaged (positioning issued) but well
        // before the settle watchdog fails safe out of anchoring-new-turn.
        await waitFor(() => {
          expect(hangingScrollToIndex).toHaveBeenCalled();
        });
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

        scrollToOffsetSpy.mockClear();
        const scrollBefore = getScrollNode().scrollTop;

        act(() => {
          list.setItemSize("message-2", {
            height: 90 + T22_GEOMETRY_DELTA_PX,
            width: VIEWPORT_WIDTH_PX,
          });
        });
        await waitForRevealPassTick();

        // Still mid-flight - must not apply the settled-session repair
        // signature (+T22_GEOMETRY_DELTA_PX via scrollToOffset).
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
        expect(getScrollNode().scrollTop - scrollBefore).not.toBe(
          T22_GEOMETRY_DELTA_PX,
        );
        expect(scrollToOffsetSpy).not.toHaveBeenCalled();
      } finally {
        hangingScrollToIndex.mockRestore();
      }
    });

    it("a genuine shrink of a row above the anchor repairs with negative drift", async () => {
      const history = makeCompletedTranscript(10);
      const sendId = "t22-shrink-above-anchor";
      const { rerenderMessages } = renderChatMessages({
        messages: history,
        scrollStateKey: "t22-shrink-above-anchor",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      await sendAndOverflowAnchor(rerenderMessages, history, sendId, 890_000);
      const scrollBefore = getScrollNode().scrollTop;

      await waitFor(() => {
        expect(legendListRefHolder.current).not.toBeNull();
      });

      // Shrink, not grow - all four required pins only exercise positive
      // delta. The repair math is signed; a shorter row above the anchor
      // must pull scrollTop down by the same amount.
      const shrinkPx = 50;
      act(() => {
        legendListRefHolder.current?.setItemSize("message-2", {
          height: 90 - shrinkPx,
          width: VIEWPORT_WIDTH_PX,
        });
      });
      await waitForRevealPassTick();

      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(getScrollNode().scrollTop - scrollBefore).toBe(-shrinkPx);
    });

    it("(pin 4c) a scroll-only departure through following-end still blocks a pending repair (review round 2, finding 2 residual)", async () => {
      // Review round 2 (finding 2 residual): pin 4b's wheel departure nulls
      // `activeTimelineAnchorIndexRef` (via `cancelTimelineLiveFollowFor
      // UserNavigation`), so `getActiveTimelineTurnMetrics` independently
      // returns null there and backstops a deleted mode/generation check -
      // pin 4b stays green even if those checks are removed. A REAL
      // reachable route does not null that ref at all: a scroll-only
      // reconcile (ticket 11 fix #1, `chat-messages.tsx` ~1915-1929) takes
      // an overflowing anchoring session to `following-end` purely from
      // reaching the true content edge - no wheel/touchmove/pointerdown ever
      // fires - and a SUBSEQUENT native-OS-scrollbar-style decrease (the
      // equality fast-path's else branch, ~1931-1941) then takes it to
      // `free-scrolling`. Neither transition touches
      // `activeTimelineAnchorIndexRef`/`positionedTimelineAnchorRef`/
      // `settledTimelineAnchorRef` (only `cancelTimelineLiveFollowForUser
      // Navigation` - the wheel/touch/pointerdown path - does). On this
      // route the fire-time mode/generation checks are the SOLE barrier.
      const history = makeCompletedTranscript(10);
      const sendId = "t22-pin4c-scroll-only-departure";
      const { rerenderMessages } = renderChatMessages({
        messages: history,
        scrollStateKey: "t22-pin4c-scroll-only-departure",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      await sendAndOverflowAnchor(rerenderMessages, history, sendId, 900_000);

      await waitFor(() => {
        expect(legendListRefHolder.current).not.toBeNull();
      });
      const list = legendListRefHolder.current;
      if (!list) throw new Error("expected LegendListRef to be attached");
      const scrollToOffsetSpy = vi.spyOn(list, "scrollToOffset");

      const scrollNode = getScrollNode();
      // Learn the REAL "true end" offset from LegendList's own
      // `getMaxScrollOffset()` via the public `scrollToEnd` imperative API -
      // NOT jsdom's shimmed `scrollHeight - clientHeight` (memory:
      // legendlist-jsdom-shim-scrollheight-trap - the fake scrollHeight sits
      // nowhere near LegendList's own tracked content size, and any offset
      // derived from it reads as permanently "past the end"). This call
      // alone does not report through `onIsAtEndChange` in this harness (no
      // synthetic 'scroll' event follows it), so mode stays untouched.
      act(() => {
        // Intentionally not awaited: this call alone does not report
        // through `onIsAtEndChange` in this harness (see comment above), so
        // nothing here depends on its resolution - the very next line reads
        // the synchronous DOM side effect it already produced.
        void list.scrollToEnd({ animated: false });
      });
      const trueEnd = scrollNode.scrollTop;

      // Schedule the two-rAF geometry repair while still anchoring (arms
      // the entry guard's cancel function) - same trigger pin 1/4b use.
      act(() => {
        list.setItemSize("message-2", {
          height: 90 + T22_GEOMETRY_DELTA_PX,
          width: VIEWPORT_WIDTH_PX,
        });
      });
      expect(scrollNode.dataset.scrollMode).toBe("anchoring-new-turn");

      // First scroll-only report: reaching the true end reconciles mode to
      // `following-end` (ticket 11 fix #1) without touching the anchor refs.
      await act(async () => {
        scrollNode.scrollTop = trueEnd;
        fireEvent.scroll(scrollNode);
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
      });
      expect(scrollNode.dataset.scrollMode).toBe("following-end");

      // Second scroll-only report: a real decrease (an OS-scrollbar drag
      // away from the tail, no gesture event) takes `following-end` to
      // `free-scrolling` via the equality fast-path's else branch - nulling
      // `liveFollowUserScrollGenerationRef` but NOT `activeTimelineAnchor
      // IndexRef`. This is where the still-pending geometry repair's
      // deferred frame actually fires (confirmed empirically: this second
      // report flushes synchronously - `following-end`'s own MVCP-active
      // state short-circuits the scroll coalescer - so the already-armed
      // second rAF from the schedule above elapses after this transition
      // has already landed, not before it).
      await act(async () => {
        scrollNode.scrollTop = trueEnd - 900;
        fireEvent.scroll(scrollNode);
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
      });
      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");

      await waitForRevealPassTick();

      // The already-scheduled repair must see the departure at fire time and
      // yield, exactly like pin 4b - but here `getActiveTimelineTurnMetrics`
      // would NOT independently return null (the anchor refs were never
      // cleared), so this is a genuine, isolated proof that the mode/
      // generation checks alone are load-bearing on this route.
      expect(scrollToOffsetSpy).not.toHaveBeenCalled();
      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
      expect(scrollNode.scrollTop).toBe(trueEnd - 900);
    });
  });
});
