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
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { type ReactElement, useCallback } from "react";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { type StoreApi } from "zustand/vanilla";
import { CHAT_ANCHOR_SETTLE_FALLBACK_MS } from "@/components/chat/chat-messages";
import {
  CHAT_TIMELINE_NAVIGATION_VIEW_OFFSET_PX,
  type ChatAnchorDriftRepairOutcome,
  chatScrollCaptureLibraryOwnedTop,
  chatTimelineGetItemType,
  scrollOnlyMovementCarriesReaderIntent,
} from "@/components/chat/chat-messages-scroll-helpers";
import { CHAT_LIST_ANCHOR_OFFSET } from "@/components/chat/chat-scroll-anchoring";
import { preserveChatScrollAcrossDisclosureChange } from "@/components/chat/chat-scroll-disclosure";
import { saveChatTabState } from "@/stores/chats/chat-tab-state-cache";
import { type ChatTabPersistenceIdentity } from "@/stores/chats/chat-tab-persistence-key";
import { type ActivityGroupOpenState } from "@/stores/chats/activity-group-open-store-context";
import { type ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import { makeMessage, makeMessageAt } from "./chat-message-fixtures";
import {
  setLegendListSyntheticScrollEventsEnabled,
  settleLegendList,
} from "./legend-list-test-environment";
import { legendListRefHolder, tileLiveness } from "./chat-messages-suite-refs";
import {
  appendAssistant,
  appendOneStreamingChunk,
  appendOptimisticUserSend,
  appendStreamingAssistantChunks,
  enterFreeScrollingAwayFromEnd,
  fireLibraryOwnedScrollTo,
  fireScrollAwayFromEnd,
  fireScrollToEnd,
  fireScrollTopAndFlush,
  forkMarkerRow,
  getScrollNode,
  getScrollToEndPill,
  isJumpPillVisible,
  LEGEND_LIST_HEADER_PX,
  makeCompletedTranscript,
  makeDefaultTestIdentity,
  makeTranscript,
  PILL_SHOW_DEBOUNCE_MS,
  registerChatMessagesSuiteHooks,
  renderChatMessages,
  selectLastChatTurnMinimapItem,
  setupCardRow,
  TICKET_13_ROW_HEIGHT_PX,
  VIEWPORT_HEIGHT_PX,
  waitForAnchorEngineSettle,
  waitForNavigationSettle,
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

  describe("H3 suppressFollowRestoreRef persists across programmatic scrolls, cleared only by a real gesture", () => {
    it("suffix removal whose viewport touched the removed region enters following-end (ticket 17 case b; no free-scrolling suppress path)", async () => {
      // Pre-ticket-17 free-scrolling suffix removal did scroll-to-index +
      // nextMode:null + suppressFollowRestoreRef and this test pinned H3
      // multi-report free-scrolling survival. Ticket 17: with scrollTop 0 the
      // last visible row is early in the list - at/past firstRemovedIndex
      // after shrinking to 3 rows - so classification is case (b): force
      // following-end + scroll-to-end. H3 suppress multi-report coverage for
      // free-scrolling programmatic landings lives on the minimap test below.
      const messages = makeTranscript(30);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "h3-suffix-multi-report",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();
      expect(isJumpPillVisible()).toBe(true);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      const next = messages.slice(0, 3);
      rerenderMessages(next);
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
    });

    it("minimap/navigateToMessage (animated) stays free-scrolling across false->true intermediate frames, then across a stream append", async () => {
      const messages = makeTranscript(24);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "h3-minimap-multi-report",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();

      // This test hand-feeds every intermediate frame and the terminal
      // scrollend itself - the environment's auto-dispatched scrollend would
      // add extra settle wakeups mid-choreography and re-issue over the
      // hand-fed positions.
      setLegendListSyntheticScrollEventsEnabled(false);

      // Select a near-tail user message on the minimap rail (last human
      // row). navigateToMessage's scroll is ANIMATED - the installed
      // LegendList forwards every native scroll event during the
      // animation, so several `false` reports (still moving toward the
      // target) arrive BEFORE the terminal `true`.
      await selectLastChatTurnMinimapItem();

      const scrollNode = getScrollNode();
      const settledScrollTop = Math.max(
        0,
        scrollNode.scrollHeight - scrollNode.clientHeight,
      );

      // Two intermediate "still animating toward the target" frames. Checked
      // via `dataset.scrollMode`, not pill visibility - the shim's fixed
      // `scrollHeight` (400 rows * 90px) is far beyond this 24-row
      // transcript's REAL measured content, so every one of these
      // `settledScrollTop`-derived offsets is already past the real content
      // end (confirmed: `isAtEnd: true` from the very first report) -
      // Ticket 11 fix #2's reader-position mirror correctly tracks that,
      // which is the point of this test (mode/suppression persistence), not
      // a claim about the pill's own decision-#16 visibility.
      await fireScrollTopAndFlush(Math.max(0, settledScrollTop - 500));
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      await fireScrollTopAndFlush(Math.max(0, settledScrollTop - 150));
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // Terminal `true` report at the animation's destination. A one-shot
      // token was already consumed by the FIRST intermediate `false` report
      // above, so THIS is the exact report that leaks under that design.
      await fireScrollTopAndFlush(settledScrollTop);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // Duplicate/correction true report - a slightly different scrollTop,
      // still within the near-end band, so LegendList does not skip it as a
      // no-op.
      await fireScrollTopAndFlush(Math.max(0, settledScrollTop - 20));
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // Settle (scrollend). Still free - the operation's own reports never
      // restored follow.
      act(() => {
        scrollNode.dispatchEvent(new Event("scrollend"));
      });
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // Suppression is never cleared by settle alone (only a real gesture or
      // an explicit following-end transition clears it), and mode is still
      // free-scrolling regardless - a subsequent stream append must not
      // auto-follow either.
      const parkedAfterSettle = scrollNode.scrollTop;
      rerenderMessages(appendAssistant(messages, "h3-nav-stream", 80_000));
      await settleLegendList();
      expect(getScrollNode().scrollTop).toBe(parkedAfterSettle);
    });

    it("a REAL subsequent near-end gesture still restores follow after a suppressed programmatic scroll settles", async () => {
      // Ticket 17 removed free-scrolling suffix removal as a suppress path
      // (case a is none; case b forces following-end). Minimap navigation is
      // still a free-scrolling programmatic landing that sets
      // suppressFollowRestoreRef - use that to pin the companion contract.
      const messages = makeTranscript(28);
      renderChatMessages({
        messages,
        scrollStateKey: "h3-companion-restore",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();

      await selectLastChatTurnMinimapItem();
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(isJumpPillVisible()).toBe(true);

      // A REAL gesture clears suppression immediately - there is no
      // settle-based auto-release to race against anymore - near-end must
      // restore follow on this gesture's OWN scroll report, not the
      // suppressed operation's.
      act(() => {
        fireEvent.wheel(getScrollNode(), { deltaY: 40 });
        fireScrollToEnd();
      });

      await waitFor(
        () => {
          expect(isJumpPillVisible()).toBe(false);
        },
        { timeout: 3_000 },
      );
    });

    it("a real gesture mid-operation clears suppression immediately, pre-empting the in-flight scroll", async () => {
      const messages = makeTranscript(24);
      renderChatMessages({
        messages,
        scrollStateKey: "h3-gesture-preempts-ownership",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();

      await selectLastChatTurnMinimapItem();

      const scrollNode = getScrollNode();
      // Mid-flight: an intermediate animation frame (still suppressed).
      act(() => {
        scrollNode.scrollTop = 200;
        fireEvent.scroll(scrollNode);
      });
      expect(isJumpPillVisible()).toBe(true);

      // A real gesture arrives BEFORE the operation would have settled on
      // its own (no scrollend/750ms fired yet) - it must still take over
      // normally: park away from the end and confirm the pill stays/shows.
      act(() => {
        fireEvent.wheel(scrollNode, { deltaY: -40 });
        fireScrollAwayFromEnd();
      });
      await waitFor(() => {
        expect(isJumpPillVisible()).toBe(true);
      });

      // And a subsequent near-end report (this gesture's own, not the
      // preempted operation's) now correctly restores follow.
      act(() => {
        fireEvent.wheel(scrollNode, { deltaY: 40 });
        fireScrollToEnd();
      });
      await waitFor(() => {
        expect(isJumpPillVisible()).toBe(false);
      });
    });

    it("a bare pointerdown mid-flight freezes the animated scroll and disarms a stray late edge echo", async () => {
      // Timing-premise test: the gesture must land while the animated nav is
      // still in flight. Keep the environment's native no-scrollend behavior
      // so the flight window stays fallback-length instead of frame-length.
      setLegendListSyntheticScrollEventsEnabled(false);
      const messages = makeTranscript(24);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "h3-pointerdown-freeze",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();

      // Animated navigateToMessage (sets suppression).
      await selectLastChatTurnMinimapItem();

      const scrollNode = getScrollNode();
      const settledScrollTop = Math.max(
        0,
        scrollNode.scrollHeight - scrollNode.clientHeight,
      );
      const midFlight = Math.max(0, settledScrollTop - 500);

      // Mid-flight intermediate frame (still suppressed). Checked via
      // `dataset.scrollMode`, not pill visibility - the shim's fixed
      // `scrollHeight` puts every one of these `settledScrollTop`-derived
      // offsets past this 24-row transcript's REAL content end, so
      // Ticket 11 fix #2/#3 correctly treat them as "at the live edge" and
      // hide the pill; mode persistence (this test's actual claim) is
      // unaffected.
      await fireScrollTopAndFlush(midFlight);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // A bare pointerdown - NO accompanying scroll - is decision #6's "ANY
      // pointerdown relinquishes follow/anchor ownership" (text selection,
      // expanding a card). Unlike wheel/touch, it produces no scroll of its
      // own, so the browser's native smooth-scroll animation would keep
      // running unless explicitly frozen.
      act(() => {
        fireEvent.pointerDown(scrollNode);
      });
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // Deliver what would have been the operation's terminal near-end
      // report, as if an already-in-flight native animation frame still
      // fired one more time despite the freeze (a jsdom-only worst case - a
      // real browser's scrollTo/scrollTop write reliably cancels the native
      // smooth-scroll immediately). Must NOT reverse the cancellation.
      await fireScrollTopAndFlush(settledScrollTop);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // The viewport must not keep moving on top of that either: a
      // subsequent stream append does not auto-follow.
      const parked = scrollNode.scrollTop;
      rerenderMessages(appendAssistant(messages, "h3-freeze-stream", 90_000));
      await settleLegendList();
      expect(scrollNode.scrollTop).toBe(parked);
    });

    it.each([-40, 40])(
      "height-shift: wheel delta %s during the initial send landing freezes the anchor animation before the reader scroll takes over",
      async (deltaY) => {
        const direction = deltaY < 0 ? "up" : "down";
        const sendId = `height-shift-mid-anchor-wheel-${direction}`;
        const messages = makeCompletedTranscript(4);
        const { rerenderMessages } = renderChatMessages({
          messages,
          scrollStateKey: `height-shift-mid-anchor-wheel-${direction}`,
          localProvenanceMessageIds: new Set([sendId]),
        });
        await settleLegendList();

        const afterSend = appendOptimisticUserSend(messages, sendId, 701_000);
        rerenderMessages(afterSend);
        // React replaces Legend List's imperative-handle object on rerender,
        // so intercept the post-send handle before the anchor's queued rAFs
        // issue their animated scroll.
        const list = legendListRefHolder.current;
        if (list === null) throw new Error("Expected an attached LegendList");
        const realScrollToIndex = list.scrollToIndex.bind(list);
        const animatedScrollControl = { release: (): void => undefined };
        const animationStillInFlight = new Promise<void>((resolve) => {
          animatedScrollControl.release = resolve;
        });
        vi.spyOn(list, "scrollToIndex").mockImplementation((options) => {
          const realCompletion = realScrollToIndex(options);
          return options.animated
            ? Promise.all([realCompletion, animationStillInFlight]).then(
                () => undefined,
              )
            : realCompletion;
        });
        await waitFor(() => {
          expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
        });
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

        // Let the two-rAF anchor chain issue its animated scrollToIndex, but do
        // not wait for its settle watchdog. `height-shift.mov` gestures in this
        // exact interval: the first wheel moves toward history, then the native
        // anchor animation keeps advancing and pulls the query back upward.
        await waitForRevealPassTick();
        expect(list.scrollToIndex).toHaveBeenCalledWith(
          expect.objectContaining({ animated: true }),
        );
        const scrollNode = getScrollNode();
        const scrollAtGesture = scrollNode.scrollTop;
        const reservedContentLength = list.getState().contentLength;
        const freezeSpy = vi.spyOn(list, "scrollToOffset");
        freezeSpy.mockClear();

        fireEvent.wheel(scrollNode, { deltaY });

        expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
        expect(freezeSpy).toHaveBeenCalledWith({
          offset: scrollAtGesture,
          animated: false,
        });

        // Model the wheel's native default movement after the passive listener.
        // The canceled anchor operation must neither resume nor reissue over it.
        const readerPosition = Math.max(
          0,
          scrollAtGesture + Math.sign(deltaY) * 40,
        );
        await fireScrollTopAndFlush(readerPosition);
        await waitForAnchorEngineSettle();
        expect(scrollNode.scrollTop).toBe(readerPosition);
        expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
        expect(list.getState().contentLength).toBeGreaterThanOrEqual(
          reservedContentLength,
        );
        animatedScrollControl.release();
      },
    );

    it("a pointerdown freeze with NO stale echo still allows a later toward-end gesture to resume", async () => {
      const messages = makeTranscript(24);
      renderChatMessages({
        messages,
        scrollStateKey: "h3-pointerdown-freeze-no-echo",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();

      // Animated navigateToMessage sets suppression; pointerdown below freezes
      // its native animation and disarms live-edge reacquisition.
      await selectLastChatTurnMinimapItem();

      const scrollNode = getScrollNode();

      // The freeze's same-offset scrollToOffset write is not guaranteed to
      // emit any scroll event (a jsdom no-op write, or a real browser deduping
      // a same-position write). No stale echo follows here.
      act(() => {
        fireEvent.pointerDown(scrollNode);
      });
      expect(isJumpPillVisible()).toBe(true);

      // A real subsequent toward-end wheel explicitly re-arms the strict-edge
      // transition; the earlier pointerdown does not permanently block it.
      act(() => {
        fireEvent.wheel(scrollNode, { deltaY: 40 });
        fireScrollToEnd();
      });

      await waitFor(() => {
        expect(isJumpPillVisible()).toBe(false);
      });
    });

    it("H1 review fix: a bare pointerdown mid-animation during a PILL-CLICK scrollToEnd still freezes (suppression alone under-covers this path)", async () => {
      // Timing-premise test (mid-animation gesture) - see the pin above.
      setLegendListSyntheticScrollEventsEnabled(false);
      // Root cause: scrollToEnd's pill-click path clears
      // suppressFollowRestoreRef unconditionally (setTimelineMode
      // ("following-end") - an explicit go-live) BEFORE its own ANIMATED
      // scroll settles. The freeze in cancelTimelineLiveFollowForUserNavigation
      // was gated solely on suppression, so a bare pointerdown mid-animation
      // found nothing to freeze - the native smooth-scroll kept running and
      // its terminal near-end report re-enabled following against the
      // cancellation. Explicit animated-operation ownership closes that gap
      // independently of suppression or the rendered mode.
      const messages = makeTranscript(24);
      renderChatMessages({
        messages,
        scrollStateKey: "h1-pill-click-freeze",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();

      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Scroll to end" }));
      });
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");

      const scrollNode = getScrollNode();

      // A bare pointerdown - NO accompanying scroll - mid-animation (no
      // scrollend/750ms fallback has fired yet). Decision #6: cancels follow
      // AND must freeze the still-in-flight scrollToEnd animation.
      act(() => {
        fireEvent.pointerDown(scrollNode);
      });
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // Deliver what would be the animation's own terminal near-end report,
      // as if it kept running unfrozen (the actual bug) or a stale frame
      // still fired despite the freeze. Must NOT reverse the cancellation.
      act(() => {
        fireScrollToEnd();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
    });

    it("Round-2 finding 1: a bare pointerdown mid-animation during the STANDARD SEND-ANCHOR path still freezes (the anchor engine's own animated scroll must be covered by the same freeze condition)", async () => {
      // Timing-premise test (mid-animation gesture) - see the pin above.
      setLegendListSyntheticScrollEventsEnabled(false);
      // Root cause: EVERY real send/steer/edit/queued-flush/A2A anchor is
      // ANIMATED (decision #12) and beginAnchoringNewTurn clears
      // suppressFollowRestoreRef unconditionally - the same gap the pill-click
      // pin above closes, but reachable via the single most ordinary path in
      // the whole app: send a message, then pointerdown to select text while
      // the anchor is still animating into position. The anchor registers
      // that animated operation explicitly, so cancellation does not have to
      // guess from the rendered mode.
      const sendId = "round2-f1-send";
      const messages = makeCompletedTranscript(10);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "round2-f1-anchor-freeze",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      const afterSend = appendOptimisticUserSend(messages, sendId, 700_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      // Let the anchor engine's OWN async chain (onAnchorReady -> two nested
      // requestAnimationFrame calls inside positionAnchor) actually ISSUE its
      // ANIMATED scrollToIndex WITHOUT waiting for its full settle
      // (CHAT_ANCHOR_SETTLE_FALLBACK_MS is 750ms; this is ~2 frames + 20ms,
      // deliberately short of that) - the operation still owns its landing.
      await waitForRevealPassTick();

      const scrollNode = getScrollNode();

      // A bare pointerdown - NO accompanying scroll - mid-animation. Decision
      // #6: cancels follow AND must freeze the anchor engine's still-in-flight
      // positioning animation (round-2 finding 1 - this is the coverage that
      // was missing pre-fix, when the freeze condition read suppression
      // alone).
      act(() => {
        fireEvent.pointerDown(scrollNode);
      });
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // Deliver what would be the animation's own terminal near-end report,
      // as if it kept running unfrozen. Must NOT reverse the cancellation.
      act(() => {
        fireScrollToEnd();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
    });

    it("Round-2 regression: an earlier suppressed nav's own pending settle timer must not prevent a later mode-changing pill click's animated scroll from freezing on pointerdown", async () => {
      // Timing-premise test: op1's/op2's 750ms fallback timers ARE the
      // subject - synthetic scrollend would settle both before the gesture.
      setLegendListSyntheticScrollEventsEnabled(false);
      // Scenario-regression pin for generation-safe operation ownership: op1
      // (a suppressed minimap nav, mode stays
      // "free-scrolling") and op2 (a pill click, mode becomes
      // "following-end") overlap in flight - op1's own 750ms settle fallback
      // is still pending when op2 issues, and still pending when the
      // pointerdown below fires. Op1's stale settle must not clear op2's newer
      // ownership token before the gesture arrives.
      const messages = makeTranscript(24);
      renderChatMessages({
        messages,
        scrollStateKey: "round2-f2-operation-token",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();

      // OP1: an animated minimap navigation - suppresses follow-restore and
      // starts its OWN 750ms awaitScrollSettle fallback (jsdom never fires
      // native scrollend). Its returned cancellation is discarded by design
      // (settleChatTimelineNavigation never invokes it), so this fallback
      // timer keeps running in the background for the rest of the test.
      await selectLastChatTurnMinimapItem();

      // Real gap so op1's and op2's independent 750ms fallbacks land at
      // clearly distinguishable real-time moments - needed only so this
      // test can isolate "op1's stale callback fires" from "op2 also
      // genuinely settles", not required by the mechanism itself.
      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 250);
        });
      });

      // OP2: pill click (scrollToEnd, animated) - setTimelineMode
      // ("following-end") both changes the mode AND clears
      // suppressFollowRestoreRef unconditionally (explicit go-live), so from
      // this point the newer animated operation's generation is the only
      // source of freeze ownership, isolating exactly what this pin exercises.
      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Scroll to end" }));
      });
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");

      // Wait until comfortably PAST op1's own fallback (750ms after op1 was
      // issued = 900ms from op1, a 150ms margin matching this file's own
      // waitForAnchorEngineSettle convention) but comfortably SHORT of op2's
      // own fallback (750ms after op2 = 1000ms from op1, still 100ms away at
      // T=900ms) - isolates "op1's stale callback fires and is a no-op" from
      // "op2 also happens to have genuinely settled on its own", so the
      // assertion below can only pass because mode is still "following-end"
      // independent of either settle callback having run.
      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 650);
        });
      });

      const scrollNode = getScrollNode();
      // A bare pointerdown now must STILL freeze op2's still-in-flight
      // animation. Op1's older generation cannot clear op2's active one,
      // regardless of its pending or fired settle callback.
      act(() => {
        fireEvent.pointerDown(scrollNode);
      });
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      act(() => {
        fireScrollToEnd();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
    });
  });

  describe("native transcript edges", () => {
    it("does not render a custom bottom-fade overpaint", async () => {
      const messages = makeCompletedTranscript(8);
      const { container } = renderChatMessages({ messages });
      await settleLegendList();

      expect(container.querySelector(".bg-linear-to-t")).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Ticket 11: live-edge reconciliation for mode + pill (scroll-only routes,
  // suppressed-nav pill bookkeeping, strict epsilon vs loose near-end).
  // -------------------------------------------------------------------------

  describe("ticket 11: live-edge reconciliation for mode + pill", () => {
    /**
     * Drive the scroll node to an absolute `scrollTop` and fire a native
     * `scroll` event ONLY - no wheel/touchmove/pointerdown. Models an OS
     * scrollbar drag that never cancels generation ownership.
     */
    async function fireScrollOnlyTo(scrollTop: number): Promise<void> {
      await fireScrollTopAndFlush(scrollTop);
    }

    async function setupOverflowingAnchoredTurn(options: {
      readonly scrollStateKey: string;
      readonly sendId: string;
      readonly additionalLocalProvenanceMessageIds?: ReadonlyArray<string>;
    }): Promise<{
      rerenderMessages: (messages: ReadonlyArray<ChatMessageModel>) => void;
      afterOverflow: ReadonlyArray<ChatMessageModel>;
    }> {
      const messages = makeCompletedTranscript(10);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: options.scrollStateKey,
        localProvenanceMessageIds: new Set([
          options.sendId,
          ...(options.additionalLocalProvenanceMessageIds ?? []),
        ]),
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();

      const afterSend = appendOptimisticUserSend(
        messages,
        options.sendId,
        888_000,
      );
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(
          screen.getByTestId(`mock-message-${options.sendId}`),
        ).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await waitForAnchorEngineSettle();

      const afterOverflow = appendStreamingAssistantChunks(
        afterSend,
        14,
        888_000,
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

      await waitFor(
        () => {
          expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
          expect(isJumpPillVisible()).toBe(true);
        },
        { timeout: 4_000 },
      );

      return { rerenderMessages, afterOverflow };
    }

    it("(a) scroll-only overflow-to-tail stays detached with its reply reserve until explicit go-live", async () => {
      const { rerenderMessages, afterOverflow } =
        await setupOverflowingAnchoredTurn({
          scrollStateKey: "t11-a-scroll-only",
          sendId: "t11-a-send",
        });

      // Scroll-ONLY route: the capture classifier recognizes a native
      // scrollbar drag even without wheel/pointerdown and releases anchor
      // ownership. Reaching the synthetic reserve's strict edge is geometry,
      // not permission to destroy the reply viewport; only explicit go-live
      // may clear that independent reserve.
      //
      // Walk scrollTop upward from the parked anchor (not the shim's huge
      // fixed scrollHeight max - that overshoots real content and leaves no
      // room for maintainScrollAtEnd to advance on the next chunk).
      const parkedAtAnchor = getScrollNode().scrollTop;
      let reachedEndAt: number | null = null;
      for (let top = parkedAtAnchor; top <= parkedAtAnchor + 4_000; top += 80) {
        await fireScrollOnlyTo(top);
        if (legendListRefHolder.current?.getState().isAtEnd === true) {
          reachedEndAt = getScrollNode().scrollTop;
          break;
        }
      }
      expect(reachedEndAt).not.toBeNull();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().dataset.replyReserveMessageId).toBe("t11-a-send");
      expect(isJumpPillVisible()).toBe(false);

      // Stream growth consumes the retained reserve without reacquiring a
      // mover or shifting the reader's physical viewport.
      const beforeChunk = getScrollNode().scrollTop;
      let afterChunk: ReadonlyArray<ChatMessageModel> = afterOverflow;
      for (let i = 0; i < 8; i += 1) {
        afterChunk = appendOneStreamingChunk(afterChunk, 900 + i, 900_000 + i);
      }
      rerenderMessages(afterChunk);
      await settleLegendList();
      await waitForRevealPassTick();
      await waitForRevealPassTick();

      expect(getScrollNode().scrollTop).toBe(beforeChunk);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().dataset.replyReserveMessageId).toBe("t11-a-send");
    });

    it("(b) ordinary wheel cancel + pill-click path stays green (no regression)", async () => {
      // Companion to (a): the gesture-driven path must still cancel ownership
      // and restore follow via the pill - Ticket 11's mirror must not break it.
      const messages = makeTranscript(20);
      renderChatMessages({
        messages,
        scrollStateKey: "t11-b-wheel-path",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(isJumpPillVisible()).toBe(true);

      fireEvent.click(screen.getByRole("button", { name: "Scroll to end" }));
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      expect(isJumpPillVisible()).toBe(false);
    });

    it("(b2) a scroll-only native scrollbar drag toward the strict tail reacquires follow", async () => {
      const messages = makeTranscript(20);
      renderChatMessages({
        messages,
        scrollStateKey: "t11-b2-scroll-only-reattach",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      const scrollNode = getScrollNode();
      await fireScrollOnlyTo(
        Math.max(0, scrollNode.scrollHeight - scrollNode.clientHeight),
      );

      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      expect(isJumpPillVisible()).toBe(false);
    });

    it("(b3) an MVCP-owned scroll adjustment does not impersonate a scrollbar drag", () => {
      const libraryOwnedScrollTop = chatScrollCaptureLibraryOwnedTop(990, 990);
      expect(
        scrollOnlyMovementCarriesReaderIntent({
          previousScrollTop: 900,
          currentScrollTop: 990,
          libraryOwnedScrollTop,
        }),
      ).toBe(false);
      expect(
        scrollOnlyMovementCarriesReaderIntent({
          previousScrollTop: 900,
          currentScrollTop: 990,
          libraryOwnedScrollTop: chatScrollCaptureLibraryOwnedTop(990, 900),
        }),
      ).toBe(true);
    });

    it("(c) pill click while anchoring immediately enters following-end", async () => {
      await setupOverflowingAnchoredTurn({
        scrollStateKey: "t11-c-pill-while-anchoring",
        sendId: "t11-c-send",
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(isJumpPillVisible()).toBe(true);

      fireEvent.click(screen.getByRole("button", { name: "Scroll to end" }));
      // scrollToEnd sets following-end unconditionally on click - no wait.
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      expect(isJumpPillVisible()).toBe(false);
    });

    it("(c2) explicit go-live can tear down reply reserve and a later send cleanly recreates it", async () => {
      const firstSendId = "t11-c2-first-send";
      const secondSendId = "t11-c2-second-send";
      const { rerenderMessages, afterOverflow } =
        await setupOverflowingAnchoredTurn({
          scrollStateKey: "t11-c2-reserve-lifecycle",
          sendId: firstSendId,
          additionalLocalProvenanceMessageIds: [secondSendId],
        });

      fireEvent.click(screen.getByRole("button", { name: "Scroll to end" }));
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");

      const trailingReply = afterOverflow.at(-1);
      if (trailingReply === undefined) {
        throw new Error("Expected a trailing assistant reply");
      }
      expect(trailingReply.role).toBe("assistant");
      const completedFirstTurn: ReadonlyArray<ChatMessageModel> = [
        ...afterOverflow.slice(0, -1),
        {
          ...trailingReply,
          completedAt: 889_000,
          runState: null,
        },
      ];
      rerenderMessages(completedFirstTurn);
      await settleLegendList();

      const afterSecondSend = appendOptimisticUserSend(
        completedFirstTurn,
        secondSendId,
        890_000,
      );
      rerenderMessages(afterSecondSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${secondSendId}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();

      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      const list = legendListRefHolder.current;
      if (list === null) throw new Error("Expected an attached LegendList");
      const secondSendViewportTop =
        list.getState().positionAtIndex(afterSecondSend.length - 1) +
        LEGEND_LIST_HEADER_PX -
        getScrollNode().scrollTop;
      expect(
        Math.abs(secondSendViewportTop - CHAT_LIST_ANCHOR_OFFSET),
      ).toBeLessThanOrEqual(1);
    });

    it("(d) suppressed nav at tail stays free, hides pill at edge, shows pill on offscreen growth without scroll event", async () => {
      // Ticket 5 F1-style: free-scrolling restore seeds suppressFollowRestore
      // from the first frame. A subsequent programmatic near-end landing
      // (no wheel) must stay free AND hide the pill via Ticket 11 fix #3's
      // suppressed-branch bookkeeping - then growth without a scroll event
      // must re-show the pill via the reveal-pass branch.
      const messages = makeCompletedTranscript(20);
      const anchorId = messages[4]?.id;
      expect(anchorId).toBeTruthy();
      const scrollStateKey = `t11-d-suppressed-${Math.random().toString(36).slice(2)}`;

      saveChatTabState({
        identity: makeDefaultTestIdentity(scrollStateKey),
        mode: "free-scrolling",
        anchorMessageId: anchorId,
        anchorIndex: null,
        offset: 40,
      });

      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey,
      });
      await settleLegendList();
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // Programmatic near-end landing (still suppressed - no real gesture).
      // Walk to a content-relative end from the restored mid-list park so we
      // don't overshoot into the shim's fixed huge scrollHeight.
      const start = getScrollNode().scrollTop;
      for (let top = start; top <= start + 6_000; top += 120) {
        await fireScrollTopAndFlush(top);
        if (!isJumpPillVisible()) break;
      }
      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, PILL_SHOW_DEBOUNCE_MS + 40);
        });
      });

      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      await waitFor(
        () => {
          expect(isJumpPillVisible()).toBe(false);
        },
        { timeout: 2_000 },
      );

      // Growth WITHOUT a scroll event: append enough that the parked free
      // position is no longer at the end. Ticket 11 fix #3's reveal-pass
      // branch is the only bookkeeping path for this (no native scroll).
      let grown: ReadonlyArray<ChatMessageModel> = messages;
      for (let i = 0; i < 20; i += 1) {
        grown = appendOneStreamingChunk(grown, 2000 + i, 1_000_000 + i);
      }
      rerenderMessages(grown);
      await settleLegendList();
      await waitForRevealPassTick();
      await waitForPillVisible();

      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(isJumpPillVisible()).toBe(true);
    });

    it("shows the pill when growth leaves an ordinary pointerdown-released reader behind", async () => {
      const messages = makeCompletedTranscript(20);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "t11-pointerdown-growth-pill",
      });
      await settleLegendList();

      const scrollNode = getScrollNode();
      expect(scrollNode.dataset.scrollMode).toBe("following-end");
      expect(isJumpPillVisible()).toBe(false);

      fireEvent.pointerDown(scrollNode);
      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
      expect(isJumpPillVisible()).toBe(false);
      const parked = scrollNode.scrollTop;

      let grown: ReadonlyArray<ChatMessageModel> = messages;
      for (let i = 0; i < 20; i += 1) {
        grown = appendOneStreamingChunk(grown, 2200 + i, 1_100_000 + i);
      }
      rerenderMessages(grown);
      await settleLegendList();
      await waitForRevealPassTick();
      await waitForPillVisible();

      expect(scrollNode.scrollTop).toBe(parked);
      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
      expect(isJumpPillVisible()).toBe(true);
    });

    it("(e) strict 1px epsilon gates mode reconciliation, not loose isNearEnd alone", async () => {
      await setupOverflowingAnchoredTurn({
        scrollStateKey: "t11-e-strict-epsilon",
        sendId: "t11-e-send",
      });

      // Find the minimal content-end scroll that flips to following-end via
      // the Ticket 11 reconciliation (scrollDeltaToRevealEnd <= 1), walking
      // from the parked anchor rather than the shim's fixed max scroll.
      //
      // Ticket 19: this probe walk must stay OWNED (still `anchoring-new-
      // turn`) at every intermediate step so the boundary it finds is the
      // ONE `onIsAtEndChange`'s strict-epsilon gate itself produces, not an
      // earlier capture-classifier cancellation. `fireScrollOnlyTo` (a bare
      // `scrollTop` write) is now correctly read as an unexplained reader
      // departure and cancels on the very first divergent step - the same
      // false-input class this ticket's classifier exists to police, which
      // is exactly why probing the boundary now needs the real library API
      // (pre-writes internal state, so the classifier stays silent) instead.
      const parkedAtAnchor = getScrollNode().scrollTop;
      let contentEndScroll: number | null = null;
      for (let top = parkedAtAnchor; top <= parkedAtAnchor + 4_000; top += 40) {
        await fireLibraryOwnedScrollTo(top);
        if (getScrollNode().dataset.scrollMode === "following-end") {
          contentEndScroll = getScrollNode().scrollTop;
          break;
        }
      }
      if (contentEndScroll === null) {
        throw new Error(
          "Never reached the content end within the probe range - test setup is wrong, not the assertion.",
        );
      }

      // Re-enter anchoring so we can probe the SHORT-OF-END case under the
      // same overflow geometry. A fresh local-provenance send does that.
      // Simpler: the probe above already proved the true edge flips; now
      // re-setup and park well short of that edge while still inside a
      // typical loose near-end band of the CONTENT range.
      //
      // Tear down and re-drive: park at contentEnd - 200 (strict fail) then
      // contentEnd (strict pass). Re-setup is the honest way after the flip
      // already consumed anchoring.
      cleanup();
      await setupOverflowingAnchoredTurn({
        scrollStateKey: "t11-e-strict-epsilon-2",
        sendId: "t11-e-send-2",
      });
      const end = contentEndScroll;

      // ~200px short of the true content end: scrollDeltaToRevealEnd >> 1,
      // so even if isNearEnd is true the strict gate must keep anchoring.
      // Library-owned (see above) - a bare write would cancel before the
      // strict-epsilon branch is even reached.
      await fireLibraryOwnedScrollTo(Math.max(0, end - 200));
      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 50);
        });
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      // True live edge: strict epsilon satisfied → following-end.
      await fireLibraryOwnedScrollTo(end);
      await waitFor(
        () => {
          expect(getScrollNode().dataset.scrollMode).toBe("following-end");
        },
        { timeout: 2_000 },
      );
    });

    it("(f) includes the LegendList header pad in the anchored live-edge gate", async () => {
      const { afterOverflow } = await setupOverflowingAnchoredTurn({
        scrollStateKey: "t11-f-header-adjusted-edge",
        sendId: "t11-f-send",
      });

      const usableViewportHeight =
        VIEWPORT_HEIGHT_PX - 80 - CHAT_LIST_ANCHOR_OFFSET;
      const oldEarlyThreshold =
        afterOverflow.length * 90 - usableViewportHeight;

      // Row positions are content-relative, while scrollTop includes the
      // measured 40px LegendList header. The old mixed-coordinate gate
      // declared following-end here, one whole header before the real edge.
      //
      // Ticket 19: library-owned (not a bare `scrollTop` write) - see the
      // matching comment on test (e) above. A bare write would cancel the
      // session on this very first probe, before the header-pad gate this
      // test targets is ever reached.
      await fireLibraryOwnedScrollTo(oldEarlyThreshold);
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      await fireLibraryOwnedScrollTo(oldEarlyThreshold + LEGEND_LIST_HEADER_PX);
      await waitFor(
        () => {
          expect(getScrollNode().dataset.scrollMode).toBe("following-end");
        },
        { timeout: 2_000 },
      );
    });
  });

  // -------------------------------------------------------------------------
  // Ticket 10: settle/re-issue generalization + item-type split.
  // ANIMATED undershoot itself is jsdom-blind (no real animation timing);
  // pins exercise the settle/validate/re-issue LOGIC by driving geometry
  // between issue and settle (F2-style).
  // -------------------------------------------------------------------------

  describe("ticket 10: settle/re-issue navigation + item-type split", () => {
    /**
     * Ticket 10 F2-style: force the scroll node to land short of wherever
     * LegendList tries to place it, so the first settle's validate fails and
     * the re-issue path must recover. `enable` toggles the undershoot so a
     * later re-issue (or the final accept) can land honestly when cleared.
     */
    function installScrollUndershoot(
      scrollNode: HTMLElement,
      undershootPx: number,
    ): { setEnabled: (enabled: boolean) => void; dispose: () => void } {
      let enabled = true;
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
          if (!enabled) {
            stored = numeric;
            return;
          }
          stored = Math.max(0, numeric - undershootPx);
        },
      });
      return {
        setEnabled: (next: boolean) => {
          enabled = next;
        },
        dispose: () => {
          // Leave the last stored value; the prototype setter from the
          // viewport-metrics shim takes over again once this own-property
          // is removed.
          Reflect.deleteProperty(scrollNode, "scrollTop");
          scrollNode.scrollTop = stored;
        },
      };
    }

    it("navigateToMessage settle detects a short landing and re-issues to the exact viewOffset", async () => {
      // Target a MID-list human user row so the exact landing has a non-zero
      // scrollTop - navigating Home→row 0 wants scrollTop≈0, where an
      // undershoot is invisible and the pin would pass vacuously without
      // re-issue.
      const messages = makeCompletedTranscript(30);
      // messages[10] is a user row (even indices); positionAtIndex ≈ 10*90.
      const targetIndex = 10;
      const targetId = messages[targetIndex]?.id;
      expect(targetId).toBeTruthy();
      expect(messages[targetIndex]?.role).toBe("user");

      const { rerenderWith } = renderChatMessages({
        messages,
        scrollStateKey: "t10-nav-reissue",
      });
      await settleLegendList();

      const scrollNode = getScrollNode();
      // First material scroll jump lands 500px short of the intended target;
      // subsequent re-issues land honestly.
      let corruptNextJump = true;
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
          if (corruptNextJump && Math.abs(numeric - stored) > 100) {
            corruptNextJump = false;
            // From a bottom-following seed the jump is upward (numeric <
            // stored). Landing "short" of an upward jump means stopping
            // higher than the target (less travel) → numeric + 500.
            stored = numeric + 500;
            return;
          }
          stored = numeric;
        },
      });
      try {
        // Deep-link scrollRequest shares navigateToMessage's choke point
        // (scrollToTimelineLocationSuppressingFollowRestore).
        rerenderWith({
          scrollRequest: {
            requestId: 10_001,
            messageId: targetId,
            blockId: "",
          },
        });
        await act(async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 50);
          });
        });

        await waitForNavigationSettle();
        await waitForNavigationSettle();

        // Exact landing: scrollTop = positionAtIndex + header - viewOffset.
        // Row height is uniform 90px under the jsdom shim; header spacer 40.
        const ROW_HEIGHT_PX = 90;
        const HARNESS_HEADER_PX = 40;
        const expectedScrollTop =
          targetIndex * ROW_HEIGHT_PX +
          HARNESS_HEADER_PX -
          CHAT_TIMELINE_NAVIGATION_VIEW_OFFSET_PX;
        expect(
          Math.abs(getScrollNode().scrollTop - expectedScrollTop),
        ).toBeLessThanOrEqual(1);
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      } finally {
        Reflect.deleteProperty(scrollNode, "scrollTop");
      }
    });

    it("scrollToEnd settle re-issues to the true end after a short first landing", async () => {
      const messages = makeCompletedTranscript(24);
      renderChatMessages({
        messages,
        scrollStateKey: "t10-scroll-to-end-reissue",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();
      const freePark = getScrollNode().scrollTop;

      const scrollNode = getScrollNode();
      // Only the FIRST end-landing undershoots; re-issues land honestly so
      // the settle/validate/re-issue chain can converge (mirrors estimate →
      // measurement mid-flight, not permanent geometry sabotage).
      let undershootNextIncrease = true;
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
          if (undershootNextIncrease && numeric > stored + 100) {
            undershootNextIncrease = false;
            stored = Math.max(0, numeric - 600);
            return;
          }
          stored = numeric;
        },
      });
      try {
        fireEvent.click(screen.getByRole("button", { name: "Scroll to end" }));
        expect(getScrollNode().dataset.scrollMode).toBe("following-end");

        await waitForNavigationSettle();
        await waitForNavigationSettle();

        const recovered = getScrollNode().scrollTop;
        // Recovered past the free-scroll park and past the intentional
        // 600px undershoot of the first landing.
        expect(recovered).toBeGreaterThan(freePark + 600);
        expect(getScrollNode().dataset.scrollMode).toBe("following-end");
        expect(isJumpPillVisible()).toBe(false);

        // A second clean pill click must not move further - exact end.
        Reflect.deleteProperty(scrollNode, "scrollTop");
        scrollNode.scrollTop = recovered;
        fireEvent.click(getScrollToEndPill());
        await waitForNavigationSettle();
        expect(
          Math.abs(getScrollNode().scrollTop - recovered),
        ).toBeLessThanOrEqual(2);
      } finally {
        Reflect.deleteProperty(scrollNode, "scrollTop");
      }
    });

    it("scrollToEnd retry exhaustion reconciles to free-scrolling with the pill visible (never stranded following-end)", async () => {
      // Timing-premise test: the undershoot trick keeps validate failing
      // only while the library's own animated settle never completes (no
      // scrollend); with the environment's synthetic scrollend the library
      // reconciles its internal isAtEnd early and the chain settles "valid"
      // instead of exhausting. Keep the native no-scrollend behavior.
      setLegendListSyntheticScrollEventsEnabled(false);
      const messages = makeCompletedTranscript(24);
      renderChatMessages({
        messages,
        scrollStateKey: "t10-scroll-to-end-exhaust",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();

      const scrollNode = getScrollNode();
      // Keep undershooting for every attempt so validate never passes across
      // the bounded 3 retries + initial attempt.
      const undershoot = installScrollUndershoot(scrollNode, 600);
      try {
        fireEvent.click(screen.getByRole("button", { name: "Scroll to end" }));
        expect(getScrollNode().dataset.scrollMode).toBe("following-end");

        // initial settle + 3 re-issue settles = 4 * fallback.
        await act(async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, (CHAT_ANCHOR_SETTLE_FALLBACK_MS + 100) * 5);
          });
        });

        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
        expect(isJumpPillVisible()).toBe(true);
      } finally {
        undershoot.dispose();
      }
    });

    it("navigateToMessage settle chain aborts on a real mid-flight wheel gesture (no snap-back)", async () => {
      // Timing-premise test: the wheel must land mid-settle-chain; keep the
      // fallback-length flight window.
      setLegendListSyntheticScrollEventsEnabled(false);
      const messages = makeCompletedTranscript(30);
      renderChatMessages({
        messages,
        scrollStateKey: "t10-nav-abort-gesture",
      });
      await settleLegendList();

      const scrollNode = getScrollNode();
      const undershoot = installScrollUndershoot(scrollNode, 800);
      try {
        const minimapButton = screen.getByTestId("chat-turn-minimap-hit-strip");
        fireEvent.keyDown(minimapButton, { key: "Home" });
        await act(async () => {
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          });
        });
        fireEvent.keyDown(minimapButton, { key: "Enter" });

        // Mid-settle: a real wheel gesture must abort the re-issue chain
        // (generation bump + suppression clear). Park at a known offset.
        await act(async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 120);
          });
        });
        undershoot.setEnabled(false);
        act(() => {
          fireEvent.wheel(scrollNode, { deltaY: -80 });
          scrollNode.scrollTop = 220;
          fireEvent.scroll(scrollNode);
        });
        const parked = getScrollNode().scrollTop;
        expect(parked).toBe(220);

        // Wait well past any remaining settle/re-issue windows. A buggy
        // non-aborted re-issue would snap scroll away from the user's park.
        await act(async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, (CHAT_ANCHOR_SETTLE_FALLBACK_MS + 100) * 4);
          });
        });

        expect(getScrollNode().scrollTop).toBe(parked);
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      } finally {
        undershoot.dispose();
      }
    });

    it("cancels the active navigation settle timer and listener on unmount", async () => {
      const messages = makeCompletedTranscript(30);
      const targetId = messages[10]?.id;
      expect(targetId).toBeTruthy();
      const { rerenderWith, unmount } = renderChatMessages({
        messages,
        scrollStateKey: "t10-nav-unmount-cleanup",
      });
      await settleLegendList();

      const scrollNode = getScrollNode();
      const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
      const removeEventListenerSpy = vi.spyOn(
        scrollNode,
        "removeEventListener",
      );
      onTestFinished(() => {
        removeEventListenerSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
      });

      rerenderWith({
        scrollRequest: {
          requestId: 10_002,
          messageId: targetId,
          blockId: "",
        },
      });
      await act(async () => {
        await Promise.resolve();
      });

      const clearCountBeforeUnmount = clearTimeoutSpy.mock.calls.length;

      unmount();

      expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(
        clearCountBeforeUnmount,
      );
      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        "scrollend",
        expect.any(Function),
      );
    });

    it("getItemType splits human-sent user rows from A2A agent-sent rows", () => {
      const human = makeMessage(0, "user");
      expect(human.agentSenderInfo).toBeNull();
      expect(chatTimelineGetItemType(human)).toBe("user:human");

      const a2a: ChatMessageModel = {
        ...makeMessage(1, "user"),
        agentSenderInfo: {
          agentId: "agent-peer-1",
          senderTitle: "Peer",
          expectReply: false,
          responseId: null,
        },
      };
      expect(chatTimelineGetItemType(a2a)).toBe("user:a2a");
      expect(chatTimelineGetItemType(makeMessage(2, "assistant"))).toBe(
        "assistant",
      );
      // Distinct pools: the two user shapes must never collapse to one string.
      expect(chatTimelineGetItemType(human)).not.toBe(
        chatTimelineGetItemType(a2a),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Ticket 12: viewport stability while free-scrolling (sizePreservationEnabled).
  // Pure size-change MVCP simulation is jsdom-blind under the fixed-height
  // shim (LegendList's size path needs real item-layout measurement churn
  // that getBoundingClientRect overrides alone do not trigger). Interaction
  // contracts that do not need a size event are pinned below.
  // -------------------------------------------------------------------------

  describe("ticket 12: sizePreservationEnabled interaction audit", () => {
    // jsdom-blind: a mounted row's measured size changing after the initial
    // estimate (MVCP size:true path). The shared shim uses fixed 90px row
    // heights; LegendList's ScrollAdjust sizeDiff only fires when its own
    // measurement pipeline observes a layout change, which the fixed-height
    // getBoundingClientRect override never produces. Extending the shim's
    // rect height alone is insufficient without driving LegendList's internal
    // size-at-index cache. Declared honestly rather than faked.

    it("L3 review fix: sizePreservationEnabled is wired true ONLY in free-scrolling, false in following-end AND anchoring-new-turn", async () => {
      // `maintainVisibleContentPosition.size` has no DOM signature to read
      // back directly - `data-size-preservation-enabled` (review-round
      // test-observability, mirrors `data-scroll-mode`'s own "not read by
      // any production code" contract) is the prop-level pin: the five
      // interaction-audit tests below only re-confirm EXISTING contracts
      // hold under the new wiring - none of them fail if the wiring itself
      // silently regresses to always-false (a mutation flip confirmed this:
      // all five stayed green).
      const sendId = "t12-l3-send";
      const messages = makeCompletedTranscript(10);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "t12-l3-wiring",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      expect(getScrollNode().dataset.sizePreservationEnabled).toBe("false");

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().dataset.sizePreservationEnabled).toBe("true");

      const afterSend = appendOptimisticUserSend(messages, sendId, 500_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(getScrollNode().dataset.sizePreservationEnabled).toBe("false");
    });

    it("(1) anchoring drift re-assert still holds with sizePreservationEnabled=false during anchoring-new-turn", async () => {
      // Re-runs the existing Ticket 4 above-anchor growth pin under the
      // Ticket 12 wiring: anchoring-new-turn never enables size:true, so the
      // reveal-pass anchorPositionDrift re-assert must still single-correct.
      const ROW_HEIGHT_PX = 90;
      const initial = makeCompletedTranscript(4);
      const turn1Id = "t12-drift-turn1";
      const turn2Id = "t12-drift-turn2";
      const { rerenderMessages } = renderChatMessages({
        messages: initial,
        scrollStateKey: "t12-anchor-drift",
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

      const afterTurn1Reply: ReadonlyArray<ChatMessageModel> = [
        ...afterTurn1Send,
        {
          ...makeMessageAt(0, "assistant", 100_001),
          id: "t12-turn1-reply",
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

      const withLateMetadata: ReadonlyArray<ChatMessageModel> = [
        ...afterTurn2Send.slice(0, turn2AnchorIndex),
        {
          ...makeMessageAt(0, "assistant", 100_003),
          id: "t12-turn1-late-metadata",
          content: "Thought for 4s",
          completedAt: 100_004,
          runState: null,
        },
        ...afterTurn2Send.slice(turn2AnchorIndex),
      ];
      rerenderMessages(withLateMetadata);
      await settleLegendList();
      await waitForRevealPassTick();
      await waitForRevealPassTick();

      // Reveal-pass re-assert: scroll advances by exactly one row (the
      // late metadata), not double-corrected by an accidental size:true.
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(getScrollNode().scrollTop - scrollAfterSettle).toBe(ROW_HEIGHT_PX);
    });

    it("(2) following-end maintainScrollAtEnd catch-up is unaffected (size:false there)", async () => {
      const messages = makeTranscript(20);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "t12-follow-catchup",
      });
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");

      const before = getScrollNode().scrollTop;
      rerenderMessages(appendAssistant(messages, "t12-follow-stream", 130_000));
      await settleLegendList();

      await waitFor(() => {
        expect(getScrollNode().scrollTop).toBeGreaterThan(before);
      });
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
    });

    it("(3) disclosure helper skips its OWN manual correction under free-scrolling - MVCP is the sole owner there (M2 fix)", async () => {
      // Review round M2: static analysis proved the manual correction below
      // and LegendList's own MVCP size-correction are ADDITIVE (not self-
      // cancelling) when both fire for the same disclosure - an
      // over-correction. Ownership is now exclusive per mode:
      // `correctionOwnedByMvcp: true` (free-scrolling, sizePreservationEnabled)
      // must skip the manual scrollToOffset write entirely (mutate still
      // runs). ChatMessage is mocked in this suite, so a real activity-group
      // expand cannot drive LegendList's own row remeasure to independently
      // prove MVCP's side of the fix - the unit-level pins in
      // chat-scroll-disclosure.test.ts cover both ownership branches
      // directly; this test proves the free-scrolling INTEGRATION context
      // (a real ChatMessages render) still reaches the "owned by MVCP,
      // skip" branch, not just the pure-function contract in isolation.
      const messages = makeCompletedTranscript(16);
      renderChatMessages({
        messages,
        scrollStateKey: "t12-disclosure-single-delta",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      const scrollNode = getScrollNode();
      await fireScrollTopAndFlush(300);
      const before = scrollNode.scrollTop;

      // Synthetic list handle mirroring what ChatMessages passes the helper.
      const scrollToOffsetCalls: Array<{ offset: number }> = [];
      const listHandle = {
        getState: () => ({ scroll: before }),
        scrollToOffset: (opts: { offset: number; animated: boolean }) => {
          scrollToOffsetCalls.push({ offset: opts.offset });
          scrollNode.scrollTop = opts.offset;
        },
      };
      const anchor = document.createElement("div");
      const rect = vi.spyOn(anchor, "getBoundingClientRect");
      rect.mockReturnValueOnce({
        x: 0,
        y: 120,
        width: 100,
        height: 40,
        top: 120,
        left: 0,
        right: 100,
        bottom: 160,
        toJSON: () => ({}),
      });
      // Expand pushes the anchor top down by 80px (content above grew).
      rect.mockReturnValueOnce({
        x: 0,
        y: 200,
        width: 100,
        height: 40,
        top: 200,
        left: 0,
        right: 100,
        bottom: 240,
        toJSON: () => ({}),
      });

      const mutate = vi.fn();
      preserveChatScrollAcrossDisclosureChange({
        list: listHandle as never,
        anchorElement: anchor,
        mutate,
        // Mirrors `requestMeasuredItemChange`'s own
        // `timelineScrollModeRef.current === "free-scrolling"` computation -
        // true here since the mode was driven to free-scrolling above.
        correctionOwnedByMvcp: true,
      });

      expect(mutate).toHaveBeenCalledOnce();
      expect(scrollToOffsetCalls).toEqual([]);
      expect(scrollNode.scrollTop).toBe(before);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      rect.mockRestore();
    });

    it("(4) suppressed programmatic nav under free-scrolling never auto-restores follow (sizePreservation active)", async () => {
      const messages = makeCompletedTranscript(20);
      const anchorId = messages[4]?.id;
      expect(anchorId).toBeTruthy();
      const scrollStateKey = `t12-suppress-${Math.random().toString(36).slice(2)}`;

      saveChatTabState({
        identity: makeDefaultTestIdentity(scrollStateKey),
        mode: "free-scrolling",
        anchorMessageId: anchorId,
        anchorIndex: null,
        offset: 40,
      });

      renderChatMessages({ messages, scrollStateKey });
      await settleLegendList();
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // Programmatic near-end landing (no real gesture): suppression must
      // hold even with sizePreservationEnabled=true on free-scrolling.
      act(() => {
        fireScrollToEnd();
      });
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().dataset.scrollMode).not.toBe("following-end");
    });

    it("(5) ticket-5 free-scrolling restore bootstrap still lands the exact pixel with sizePreservation from first render", async () => {
      const messages = makeCompletedTranscript(20);
      const scrollStateKey = `t12-restore-${Math.random().toString(36).slice(2)}`;
      const instanceId = `t12-restore-inst-${Math.random().toString(36).slice(2)}`;

      tileLiveness.live = true;
      const first = renderChatMessages({
        messages,
        scrollStateKey,
        instanceId,
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await fireScrollTopAndFlush(360);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      const originalScrollTop = getScrollNode().scrollTop;
      expect(originalScrollTop).toBe(360);

      first.unmount();

      const second = renderChatMessages({
        messages,
        scrollStateKey,
        instanceId,
      });
      await settleLegendList();
      await settleLegendList();

      // Exact-pixel restore must not fight MVCP size-correction on bootstrap.
      expect(getScrollNode().scrollTop).toBe(originalScrollTop);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      second.unmount();
    });
  });

  describe("ticket 13: fork-marker candidacy (decision #27)", () => {
    /**
     * jsdom note: mount-time fresh-open seeds `timelineAnchorMessageId` and
     * mode correctly, but the LegendList anchor engine does not actually move
     * `scrollTop` on that first paint (scrollTop stays 0). The late-history
     * path (`empty → snapshot` through `beginAnchoringNewTurn`) DOES land a
     * real scrollTop - same candidate predicate, effect-driven. Pins (a)/(b)
     * therefore use late-history for the geometric assertion; a separate
     * mount-time pin below covers mode seed + row presence.
     */
    async function lateHistoryAnchor(
      history: ReadonlyArray<ChatMessageModel>,
      keyPrefix: string,
    ): Promise<{ scrollTop: number; unmount: () => void }> {
      // Ticket 15 review (live pass S5): a unique `epicId` per call, not just
      // a unique `scrollStateKey` - callers in this describe block invoke
      // this twice per test (control, subject) against the SAME default
      // epicId/taskId, so without this they share one durable chat-key.
      // Control's non-live unmount below commits its landed position to
      // THAT shared durable entry (F1's fix), which the hydration-retry
      // effect (live pass S5 fix) now genuinely chases as subject's
      // `messages` grows from `[]` - a real fix correctly acting on
      // leftover state that used to be silently dropped, surfacing this
      // test's own cross-call sharing rather than a defect in the fix.
      const { rerenderMessages, unmount } = renderChatMessages({
        messages: [],
        scrollStateKey: `${keyPrefix}-${Math.random().toString(36).slice(2)}`,
        epicId: `${keyPrefix}-epic-${Math.random().toString(36).slice(2)}`,
        freshOpen: true,
      });
      await settleLegendList();
      expect(screen.getByText("Start the conversation")).toBeTruthy();
      rerenderMessages(history);
      await settleLegendList();
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      return { scrollTop: getScrollNode().scrollTop, unmount };
    }

    it("(pin a) fresh fork open anchors the fork marker, not the last copied user query", async () => {
      // Copied history ends with a user/assistant pair; the fork marker sits
      // after every copied row. Decision #27 lands on the marker; pre-#27
      // lands on the last user two indices earlier. Uniform 90px rows.
      const prefix = makeCompletedTranscript(20);
      // last user = message-18 at index 18; marker at index 20 → delta 2.
      const lastUserId = "message-18";
      const markerId = "forked-chat-link:fork-open-a";
      const withMarker: ReadonlyArray<ChatMessageModel> = [
        ...prefix,
        forkMarkerRow(markerId, 10_000),
      ];

      const control = await lateHistoryAnchor(prefix, "t13-pin-a-control");
      expect(control.scrollTop).toBeGreaterThan(0);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${lastUserId}`)).toBeTruthy();
      });
      control.unmount();

      const subject = await lateHistoryAnchor(withMarker, "t13-pin-a-subject");
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${markerId}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(subject.scrollTop - control.scrollTop).toBe(
        2 * TICKET_13_ROW_HEIGHT_PX,
      );
      subject.unmount();
    });

    it("(pin b) fork with a newer user turn anchors that turn (self-superseding)", async () => {
      // Same long prefix + marker as pin (a), plus a real user send after the
      // marker. findLast must pick the newer user, not stick on the marker.
      const prefix = makeCompletedTranscript(20);
      const markerId = "forked-chat-link:fork-open-b";
      const newUserId = "user-fork-turn-b";
      const withMarker: ReadonlyArray<ChatMessageModel> = [
        ...prefix,
        forkMarkerRow(markerId, 10_000),
      ];
      const withNewTurn: ReadonlyArray<ChatMessageModel> = [
        ...withMarker,
        {
          ...makeMessageAt(0, "user", 20_000),
          id: newUserId,
          content: "first turn in the fork",
          completedAt: null,
        },
      ];

      const control = await lateHistoryAnchor(withMarker, "t13-pin-b-control");
      expect(control.scrollTop).toBeGreaterThan(0);
      control.unmount();

      const subject = await lateHistoryAnchor(withNewTurn, "t13-pin-b-subject");
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${newUserId}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(subject.scrollTop - control.scrollTop).toBe(
        TICKET_13_ROW_HEIGHT_PX,
      );
      subject.unmount();
    });

    it("mount-time freshOpen seed enters anchoring-new-turn on a fork-marker-only transcript", async () => {
      // Complements the late-history geometric pins: the mount-time
      // `freshOpenAnchorMessageId` initializer must also accept the marker
      // (mode seed is sync; jsdom does not land scrollTop on this path).
      // Marker-ONLY so a user-only candidate regression cannot hide behind a
      // copied user row still seeding anchoring-new-turn.
      const markerId = "forked-chat-link:mount-seed";
      const messages: ReadonlyArray<ChatMessageModel> = [
        forkMarkerRow(markerId, 10_000),
      ];
      renderChatMessages({
        messages,
        scrollStateKey: `t13-mount-seed-${Math.random().toString(36).slice(2)}`,
        freshOpen: true,
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await settleLegendList();
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${markerId}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
    });

    it("late-history empty→fork-marker-only snapshot anchors the marker (effect path, not just mount seed)", async () => {
      // Mount-time `freshOpenAnchorMessageId` sees an empty transcript and
      // seeds null. The late-history branch of `classifyChatEdgeMutation`
      // (`!hadSavedScrollState`) must still widen to the fork marker when the
      // snapshot arrives - same decision #27 predicate as the mount seed.
      const markerId = "forked-chat-link:late-history";
      const history: ReadonlyArray<ChatMessageModel> = [
        forkMarkerRow(markerId, 1),
      ];
      const { rerenderMessages } = renderChatMessages({
        messages: [],
        scrollStateKey: `t13-late-fork-${Math.random().toString(36).slice(2)}`,
        freshOpen: true,
      });
      await settleLegendList();
      expect(screen.getByText("Start the conversation")).toBeTruthy();

      rerenderMessages(history);
      await settleLegendList();
      await waitForAnchorEngineSettle();

      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${markerId}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
    });
  });

  describe("ticket 13: setup-card turn-group anchoring (decision #28)", () => {
    it("(pin c) beginAnchoringNewTurn with a setup card already above the send lands on the card", async () => {
      // Decision #28 at begin time (card already woven when the send is
      // classified - genesis pin and mid-chat card that raced ahead of the
      // optimistic row both look like this). Control: send with no card →
      // anchors the send at history.length. Subject: card + send arrive
      // together → resolveChatAnchorTargetWithSetupCard rewrites the target
      // to the card, which occupies the SAME index the control's send used
      // (content above is identical) → bit-for-bit same scrollTop. Without
      // the resolve, subject lands on the send one slot later (+90px).
      // (Mount-time fresh-open leaves scrollTop at 0 in jsdom, so the
      // geometric pin uses the live beginAnchoringNewTurn path; pure-function
      // pin c covers the genesis-shaped array walk.)
      const history = makeCompletedTranscript(16);
      const sendId = "user-pin-c-send";
      const cardId = "setup-card:owner-1:0:pin-c";

      // Ticket 15 review (live pass S5 round 3): a unique `epicId` per
      // render, not just a unique `scrollStateKey` - `control` and
      // `subject` otherwise share the default epicId/taskId durable
      // chat-key. `control`'s unmount below now (correctly, per the round-3
      // fix) commits a coherent durable entry for its active anchor session;
      // without this
      // isolation, `subject`'s own mount would inherit it via
      // `hasSavedChatTabState`/`restoredTabState`, skipping the
      // following-end default this test's `subject` assumes.
      const control = renderChatMessages({
        messages: history,
        scrollStateKey: `t13-pin-c-control-${Math.random().toString(36).slice(2)}`,
        epicId: `t13-pin-c-control-epic-${Math.random().toString(36).slice(2)}`,
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();
      const controlAfterSend = appendOptimisticUserSend(
        history,
        sendId,
        500_000,
      );
      control.rerenderMessages(controlAfterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      const controlScrollTop = getScrollNode().scrollTop;
      expect(controlScrollTop).toBeGreaterThan(0);
      control.unmount();

      const subject = renderChatMessages({
        messages: history,
        scrollStateKey: `t13-pin-c-subject-${Math.random().toString(36).slice(2)}`,
        epicId: `t13-pin-c-subject-epic-${Math.random().toString(36).slice(2)}`,
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();
      // Card already above the send when the anchor-new-turn fires (no mid-
      // weave retarget - pure begin-time substitution).
      const subjectAfter: ReadonlyArray<ChatMessageModel> = [
        ...history,
        setupCardRow(cardId, 499_999, sendId),
        {
          ...makeMessageAt(0, "user", 500_000),
          id: sendId,
          content: "hello from send",
          persistentMessageId: null,
        },
      ];
      subject.rerenderMessages(subjectAfter);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${cardId}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(getScrollNode().scrollTop).toBe(controlScrollTop);
      // Provenance consumed with the RAW send id, not the card substitute.
      expect(subject.getLocalProvenanceMessageIds().has(sendId)).toBe(false);
      subject.unmount();
    });

    it("(pin d) mid-anchoring setup-card weave retargets the anchor to the card, without exiting anchoring-new-turn", async () => {
      // Row height is uniform (90px, ITEM_HEIGHT_PX) under the jsdom shim: the
      // card takes over the EXACT array slot the send row occupied before the
      // weave, so a correct retarget lands at the bit-for-bit SAME scrollTop -
      // not shifted by one row height, which is what leaving
      // `maintainVisibleContentPosition` to keep the send row pixel-stable
      // (the pre-ticket-13 behavior) would do, scrolling the new card
      // off-screen above the still-anchored send row instead of revealing it.
      // Also pins that `consumeLocalProvenance` still receives the RAW send
      // id (the card is never a provenance entry; substituting it would leave
      // the real send never consumed).
      const initial = makeCompletedTranscript(6);
      const sendId = "user-worktree-send";
      const { rerenderMessages, getLocalProvenanceMessageIds } =
        renderChatMessages({
          messages: initial,
          scrollStateKey: "t13-retarget-key",
          localProvenanceMessageIds: new Set([sendId]),
        });
      await settleLegendList();

      const afterSend = appendOptimisticUserSend(initial, sendId, 500_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      // Provenance for the send is consumed on the anchor-new-turn outcome,
      // before any card weave - still the raw send id.
      expect(getLocalProvenanceMessageIds().has(sendId)).toBe(false);
      const scrollBeforeCard = getScrollNode().scrollTop;

      // The `setup.creating` event lands async - the card weaves in directly
      // above the send row (by `triggeringMessageId`), at the exact index
      // the send row used to occupy.
      const sendIndex = afterSend.findIndex((message) => message.id === sendId);
      const card = setupCardRow(
        `setup-card:owner-1:0:${sendId}`,
        499_999,
        sendId,
      );
      const afterCard: ReadonlyArray<ChatMessageModel> = [
        ...afterSend.slice(0, sendIndex),
        card,
        ...afterSend.slice(sendIndex),
      ];
      rerenderMessages(afterCard);
      await waitForAnchorEngineSettle();

      // Still the SAME anchoring session - a retarget, not a cancel/exit.
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(screen.getByTestId(`mock-message-${card.id}`)).toBeTruthy();

      const scrollAfterCard = getScrollNode().scrollTop;
      expect(scrollAfterCard).toBe(scrollBeforeCard);
      // Card weave is a `none` outcome - provenance set stays empty (the
      // send was already consumed; we never re-added the card id).
      expect(getLocalProvenanceMessageIds().has(sendId)).toBe(false);
      expect(getLocalProvenanceMessageIds().has(card.id)).toBe(false);
    });

    it("(pin e) mid-chat setup card woven above a NON-anchored message leaves the active anchor untouched", async () => {
      // Anchoring turn N (the latest send). A setup card for an EARLIER turn
      // weaves in elsewhere in the transcript - classify as `none`, and
      // `resolveChatAnchorTargetWithSetupCard` from the CURRENT target finds
      // no card above it, so retarget is a no-op. scrollTop and mode hold.
      const initial = makeCompletedTranscript(6);
      const sendId = "user-turn-n-send";
      const earlierUserId = "message-2"; // index 2 in the prefix
      const { rerenderMessages } = renderChatMessages({
        messages: initial,
        scrollStateKey: "t13-pin-e-key",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      const afterSend = appendOptimisticUserSend(initial, sendId, 500_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      const scrollBeforeWeave = getScrollNode().scrollTop;

      // Weave a card above an EARLIER user row (not the anchored send).
      const earlierIndex = afterSend.findIndex(
        (message) => message.id === earlierUserId,
      );
      expect(earlierIndex).toBeGreaterThanOrEqual(0);
      const foreignCard = setupCardRow(
        `setup-card:owner-1:0:${earlierUserId}`,
        100,
        earlierUserId,
      );
      const afterForeignCard: ReadonlyArray<ChatMessageModel> = [
        ...afterSend.slice(0, earlierIndex),
        foreignCard,
        ...afterSend.slice(earlierIndex),
      ];
      // Inserting above an earlier row shifts every later row (including the
      // anchored send) down by one slot. MVCP should keep the anchored send's
      // pixel position stable for a `none` non-retarget outcome - scrollTop
      // rises by exactly one row height so the SAME row stays on-screen at
      // the same visual place. Retargeting to the foreign card would jump
      // scrollTop back toward the earlier index (a multi-row shift).
      rerenderMessages(afterForeignCard);
      await waitForAnchorEngineSettle();

      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      // Still showing the send, not retargeted onto the foreign card.
      expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      // MVCP holds the anchored row's visual place: +1 row of content above.
      expect(getScrollNode().scrollTop).toBe(
        scrollBeforeWeave + TICKET_13_ROW_HEIGHT_PX,
      );
    });

    it("newer user send after a setup-card retarget re-derives on the new send (decision #28 never sticks)", async () => {
      // After pin (d)'s retarget has pointed the session at a setup card, a
      // REAL subsequent user send must begin a new anchoring session on that
      // send - not stick to the stale card from the previous turn. Delta from
      // card → second send is exactly 2 rows (card, firstSend, secondSend).
      const history = makeCompletedTranscript(16);
      const firstSendId = "user-sticky-first-send";
      const secondSendId = "user-sticky-second-send";
      const cardId = "setup-card:owner-1:0:sticky";
      const { rerenderMessages, getLocalProvenanceMessageIds } =
        renderChatMessages({
          messages: history,
          scrollStateKey: `t13-sticky-${Math.random().toString(36).slice(2)}`,
          localProvenanceMessageIds: new Set([firstSendId, secondSendId]),
        });
      await settleLegendList();

      // First send + card weave → retarget onto the card (decision #28 live).
      const afterFirstSend = appendOptimisticUserSend(
        history,
        firstSendId,
        500_000,
      );
      rerenderMessages(afterFirstSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${firstSendId}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();
      const firstSendIndex = afterFirstSend.findIndex(
        (message) => message.id === firstSendId,
      );
      const card = setupCardRow(cardId, 499_999, firstSendId);
      const afterCard: ReadonlyArray<ChatMessageModel> = [
        ...afterFirstSend.slice(0, firstSendIndex),
        card,
        ...afterFirstSend.slice(firstSendIndex),
      ];
      rerenderMessages(afterCard);
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      const scrollOnCard = getScrollNode().scrollTop;
      expect(scrollOnCard).toBeGreaterThan(0);

      // Second send: no setup card for this turn. Must re-derive onto the
      // new send. Array: [...history, card, firstSend, secondSend] → delta 2.
      const afterSecondSend = appendOptimisticUserSend(
        afterCard,
        secondSendId,
        600_000,
      );
      rerenderMessages(afterSecondSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${secondSendId}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(getScrollNode().scrollTop - scrollOnCard).toBe(
        2 * TICKET_13_ROW_HEIGHT_PX,
      );
      // Second send's provenance was consumed on the anchor-new-turn outcome
      // (raw send id, not the previous turn's card).
      expect(getLocalProvenanceMessageIds().has(secondSendId)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Ticket 18: send-anchor validated convergence (rootcause-send-undershoot).
  // The engine now shares ticket 10's settle/re-issue helper, writes
  // settledTimelineAnchorRef ONLY on a validated landing, fails safe to
  // free-scrolling + pill on exhaustion, and repairs anchor-position drift
  // BEFORE the reveal pass's overflow early-return.
  //
  // jsdom-blind (declared): the ANIMATED-vs-INSTANT visual undershoot mid-
  // flight (smooth scroll physically not arrived when rows remeasure) is not
  // reproducible here - the shared scrollTo shim applies offsets
  // synchronously. What jsdom CAN pin is (A) validated reissue CONVERGENCE
  // math and (B) near/far ANIMATED-FLAG selection via scrollTo behavior.
  // -------------------------------------------------------------------------
});
