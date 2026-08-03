/**
 * Split from the original single-file chat-messages.test.tsx (10.7k lines,
 * the slowest file in the suite) along describe boundaries; shared fixtures,
 * helpers and root hooks live in chat-messages-suite-harness.tsx, shared
 * mutable refs in chat-messages-suite-refs.ts, and the vi.mock block below is
 * repeated per file because vi.mock registration is per-test-file. All split
 * files keep the original root describe title so test full names (and CI
 * history) are unchanged.
 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { type ReactElement, useCallback } from "react";
import { describe, expect, it, vi } from "vitest";
import { type StoreApi } from "zustand/vanilla";
import { type ChatAnchorDriftRepairOutcome } from "@/components/chat/chat-messages-scroll-helpers";
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
  settleLegendList,
} from "./legend-list-test-environment";
import { legendListRefHolder } from "./chat-messages-suite-refs";
import {
  appendOptimisticUserSend,
  DEFAULT_COMPOSER_OVERLAY_HEIGHT_PX,
  fireCaptureScrollAfterLibraryWrite,
  fireLibraryOwnedScrollTo,
  fireScrollToEnd,
  getScrollNode,
  installLibraryScrollCaptureDispatch,
  LEGEND_LIST_HEADER_PX,
  makeCompletedTranscript,
  makeDefaultTestIdentity,
  makeTranscript,
  registerChatMessagesSuiteHooks,
  renderChatMessages,
  setupCardRow,
  TICKET_13_ROW_HEIGHT_PX,
  triggerLegendListResizeObserverEntry,
  VIEWPORT_HEIGHT_PX,
  VIEWPORT_WIDTH_PX,
  waitForAnchorEngineSettle,
  waitForNavigationSettle,
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

  describe("ticket 17 delete-landing (viewport-aware suffix removal)", () => {
    // Diagnosis harness numbers (ticket body): 120 uniform 90px rows, 700px
    // viewport, header/footer spacers 40px, delete keeping a long prefix.
    // Reference pins were (a) scrollTop 940→940 zero writes; (b) 9940 →
    // {following-end, 8500}; (c) already following → {following-end, 8500}.
    // Fixture-derived true-end may differ from 8500 when endInset/composer
    // differ - assert the qualitative contract with the app's own natural-max
    // formula, never jsdom's faked scrollHeight (LARGE_CONTENT_ROW_COUNT
    // constant - prior diagnosis silently passed on broken code that way).
    const T17_ROW_COUNT = 120;
    const T17_KEEP_COUNT = 100;
    const T17_FIRST_REMOVED_INDEX = T17_KEEP_COUNT;
    const T17_ITEM_PX = TICKET_13_ROW_HEIGHT_PX;
    const T17_HEADER_PX = LEGEND_LIST_HEADER_PX;
    const T17_FOOTER_PX = LEGEND_LIST_HEADER_PX;
    // Case (a) reference: scrollTop 940 → last visible well before index 100.
    const T17_CASE_A_SCROLL_TOP = 940;
    // Case (b) reference: scrollTop 9940 → deep into the deleted region.
    const T17_CASE_B_SCROLL_TOP = 9940;
    // Fixture-derived true end after keeping 100 rows under this harness
    // (matches the ticket's diagnosis pin of 8500). Do not derive from
    // jsdom's faked scrollHeight; do not assume save-path endInset accounting
    // matches LegendList's scrollToEnd geometry exactly.
    const T17_TRUE_END_SCROLL_TOP = 8500;
    // Naive "include footer" bound used only to catch the old last-row-only
    // regression (which landed footer-height short of the true end).
    const T17_NAIVE_WITH_FOOTER =
      T17_KEEP_COUNT * T17_ITEM_PX +
      T17_HEADER_PX +
      T17_FOOTER_PX -
      VIEWPORT_HEIGHT_PX;
    // Old buggy last-row navigation excluded the footer spacer.
    const T17_OLD_BUGGY_LAST_ROW_ONLY =
      T17_KEEP_COUNT * T17_ITEM_PX + T17_HEADER_PX - VIEWPORT_HEIGHT_PX;

    /** Free-scroll, seed an explicit scrollTop, fire scroll + settle so the
     *  rAF-throttled `viewportLastVisibleSnapshotRef` tracks the real
     *  LegendList `getState().end` before the delete. */
    async function t17SeedFreeScrollingAt(scrollTop: number): Promise<void> {
      const scrollNode = getScrollNode();
      act(() => {
        fireEvent.wheel(scrollNode, { deltaY: -80 });
        scrollNode.scrollTop = scrollTop;
        fireEvent.scroll(scrollNode);
      });
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().scrollTop).toBe(scrollTop);
    }

    it("(a) free-scrolling above the deletion boundary: no scroll write, mode and scrollTop unchanged", async () => {
      const messages = makeTranscript(T17_ROW_COUNT);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "t17-case-a-untouched",
      });
      await settleLegendList();

      await t17SeedFreeScrollingAt(T17_CASE_A_SCROLL_TOP);

      const scrollToSpy = vi.spyOn(HTMLElement.prototype, "scrollTo");
      const scrollToCallsBefore = scrollToSpy.mock.calls.length;
      const modeBefore = getScrollNode().dataset.scrollMode;
      const scrollTopBefore = getScrollNode().scrollTop;

      // firstRemovedIndex = 100; last visible at scrollTop 940 is ~index 17
      // (strictly before 100) → case (a) none.
      expect(T17_CASE_A_SCROLL_TOP).toBeLessThan(
        T17_FIRST_REMOVED_INDEX * T17_ITEM_PX,
      );

      rerenderMessages(messages.slice(0, T17_KEEP_COUNT));
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe(modeBefore);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().scrollTop).toBe(scrollTopBefore);
      expect(getScrollNode().scrollTop).toBe(T17_CASE_A_SCROLL_TOP);
      expect(scrollToSpy.mock.calls.length).toBe(scrollToCallsBefore);
    });

    it("(a reserve cleanup) a deleted detached reserve cannot block reattachment at the real edge", async () => {
      const sendId = "t17-case-a-removed-reserve";
      const messages = makeCompletedTranscript(T17_ROW_COUNT);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "t17-case-a-removed-reserve-key",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      const afterSend = appendOptimisticUserSend(messages, sendId, 700_000);
      rerenderMessages(afterSend);
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      await t17SeedFreeScrollingAt(T17_CASE_A_SCROLL_TOP);

      // The reader is above the deletion boundary, so the viewport remains
      // untouched while the suffix removes the row that owned reply-reserve
      // geometry.
      rerenderMessages(messages.slice(0, T17_KEEP_COUNT));
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().scrollTop).toBe(T17_CASE_A_SCROLL_TOP);

      setLegendListScrollContainerScrollHeightOverride(
        T17_HEADER_PX + T17_KEEP_COUNT * T17_ITEM_PX + T17_FOOTER_PX,
      );
      act(() => {
        fireEvent.wheel(getScrollNode(), { deltaY: 40 });
        fireScrollToEnd();
      });

      await waitFor(() => {
        expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      });
    });

    it("(b) free-scrolling inside the deleted region: following-end at the true end (not last-row-short)", async () => {
      const messages = makeTranscript(T17_ROW_COUNT);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "t17-case-b-vanished",
      });
      await settleLegendList();

      await t17SeedFreeScrollingAt(T17_CASE_B_SCROLL_TOP);

      // Sanity: 9940 lands past firstRemovedIndex * item height.
      expect(T17_CASE_B_SCROLL_TOP).toBeGreaterThan(
        T17_FIRST_REMOVED_INDEX * T17_ITEM_PX,
      );

      rerenderMessages(messages.slice(0, T17_KEEP_COUNT));
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      // Do NOT derive expected from scrollNode.scrollHeight (jsdom fakes a
      // large constant for virtualization bootstrap). Pin the fixture's true
      // end (8500, same as the ticket diagnosis) and prove we are not the
      // old last-row-only landing (footer excluded → 40px short of naive).
      expect(getScrollNode().scrollTop).toBe(T17_TRUE_END_SCROLL_TOP);
      expect(T17_TRUE_END_SCROLL_TOP).toBeGreaterThanOrEqual(
        T17_NAIVE_WITH_FOOTER,
      );
      expect(getScrollNode().scrollTop).toBeGreaterThan(
        T17_OLD_BUGGY_LAST_ROW_ONLY,
      );
      expect(
        getScrollNode().scrollTop - T17_OLD_BUGGY_LAST_ROW_ONLY,
      ).toBeGreaterThanOrEqual(T17_FOOTER_PX);
    });

    it("(c) already following-end: stays following-end at the true end after suffix removal", async () => {
      const messages = makeTranscript(T17_ROW_COUNT);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "t17-case-c-following",
      });
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("following-end");

      rerenderMessages(messages.slice(0, T17_KEEP_COUNT));
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      expect(getScrollNode().scrollTop).toBe(T17_TRUE_END_SCROLL_TOP);
    });

    // Review round (stack review, finding 2, CONFIRMED HIGH): the
    // `viewportLastVisibleSnapshotRef` snapshot must be gated on the EXACT
    // `messages` array identity it was observed against, not trusted by
    // ordering alone. Both pins below arrange a suffix delete to land BEFORE
    // any real scroll/rAF observation has ever populated the ref - anchored
    // to an EARLY restored row (index 10, strictly before firstRemovedIndex
    // 100) so that the OLD unconditional (pre-fix) reading-line-anchor seed
    // would have masqueraded as a real "last visible row" observation and
    // wrongly resolved case (a). Post-fix, an un-observed snapshot resolves
    // to `null` (unknown) regardless of what the seed claims, and unknown
    // defaults to case (b) - never a guessed case (a).
    it("(review finding 2) restored free-scrolling, delete arrives before the first rAF observation: unknown defaults to case (b), never a guessed case (a)", async () => {
      const messages = makeTranscript(T17_ROW_COUNT);
      const scrollStateKey = "t17-finding2-mount-before-rjaf";
      saveChatTabState({
        identity: makeDefaultTestIdentity(scrollStateKey),
        mode: "free-scrolling",
        anchorMessageId: messages[10]?.id ?? null,
        anchorIndex: null,
        offset: 0,
      });
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey,
      });

      // Deliberately no `await settleLegendList()` / scroll event here: the
      // mount-time classify effect's own tail call schedules an
      // rAF-throttled `getState().end` read (`scheduleActiveViewportUpdate`),
      // but no animation frame has fired yet - this is still the same tick
      // as mount. Delete immediately on top of that.
      rerenderMessages(messages.slice(0, T17_KEEP_COUNT));
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      expect(getScrollNode().scrollTop).toBe(T17_TRUE_END_SCROLL_TOP);
    });

    it("(review finding 2) a layout/size change with no scroll event does not manufacture an observation - delete before the first rAF still defaults to case (b)", async () => {
      const messages = makeTranscript(T17_ROW_COUNT);
      const scrollStateKey = "t17-finding2-layout-before-rjaf";
      saveChatTabState({
        identity: makeDefaultTestIdentity(scrollStateKey),
        mode: "free-scrolling",
        anchorMessageId: messages[10]?.id ?? null,
        anchorIndex: null,
        offset: 0,
      });
      const { rerenderMessages, rerenderWith } = renderChatMessages({
        messages,
        scrollStateKey,
      });

      // `composerOverlayHeight` is not a dependency of the edge-mutation
      // effect and does not touch `messages` - this re-render neither
      // writes to nor invalidates the snapshot ref; it only proves a
      // layout/size change alone cannot manufacture a fake observation.
      // `renderChatMessages`'s default is 80px - growing it here also
      // genuinely shifts the true end scroll target (a bigger bottom inset
      // needs a bigger scrollTop to clear it), so the expected true end
      // below accounts for that observed, non-hardcoded delta.
      const T17_GROWN_COMPOSER_OVERLAY_HEIGHT_PX = 400;
      rerenderWith({
        composerOverlayHeight: T17_GROWN_COMPOSER_OVERLAY_HEIGHT_PX,
      });

      // Still before the first rAF - same timing constraint as the pin
      // above, now with an intervening layout change that touches neither
      // `messages` nor the snapshot ref.
      rerenderMessages(messages.slice(0, T17_KEEP_COUNT));
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      // True end shifts 1:1 with the grown composer inset relative to the
      // default inset other ticket-17 pins render with (observed, not
      // derived from a formula - same methodology as T17_TRUE_END_SCROLL_TOP
      // itself).
      expect(getScrollNode().scrollTop).toBe(
        T17_TRUE_END_SCROLL_TOP +
          (T17_GROWN_COMPOSER_OVERLAY_HEIGHT_PX -
            DEFAULT_COMPOSER_OVERLAY_HEIGHT_PX),
      );
    });

    // Review round 2, finding 2 residual (CONFIRMED HIGH): the reviewer's
    // literal schedule - establish an authoritative snapshot, then a REAL
    // row-size change under the SAME `messages` array with NO scroll event
    // pushes the true last-visible row past the deletion boundary, then
    // delete. Driven via `legendListRefHolder.current.setItemSize` (the
    // real LegendList `setItemSize` ref method, teed through the
    // pass-through mock above) - this is the one lever that bypasses
    // jsdom's globally no-op ResizeObserver and fires a genuine
    // `onItemSizeChanged` with a real diff, matching how an activity-group
    // disclosure collapsing (state lives outside `messages`) would move
    // rows into view in a real browser.
    it("(review round 2, finding 2 residual) a real row-size change with no scroll crosses the deletion boundary - delete lands case (b), not a stale case (a)", async () => {
      const ROW_COUNT = 30;
      const KEEP_COUNT = 25;
      const messages = makeTranscript(ROW_COUNT);
      const scrollStateKey = "t17-finding2-r2-item-size";
      // Restore free-scrolling anchored at row 0 so the initial mount
      // bootstraps there, measuring the early rows we are about to shrink
      // before we scroll away to the authoritative snapshot position.
      saveChatTabState({
        identity: makeDefaultTestIdentity(scrollStateKey),
        mode: "free-scrolling",
        anchorMessageId: messages[0]?.id ?? null,
        anchorIndex: null,
        offset: 0,
      });
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey,
      });
      await settleLegendList();

      // Authoritative snapshot: scrolled to a row strictly before
      // KEEP_COUNT (25) - roughly rows 10-17 at this scrollTop.
      await t17SeedFreeScrollingAt(900);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      await waitFor(() => {
        expect(legendListRefHolder.current).not.toBeNull();
      });

      // Shrink 10 already-measured early rows (0-9) - a genuine,
      // no-scroll, same-array size change, pushing more rows into view
      // for the same scrollTop (the disclosure-collapse shape).
      act(() => {
        for (let index = 0; index < 10; index += 1) {
          legendListRefHolder.current?.setItemSize(`message-${index}`, {
            height: 5,
            width: VIEWPORT_WIDTH_PX,
          });
        }
      });

      rerenderMessages(messages.slice(0, KEEP_COUNT));
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
    });

    // Review round 3, finding 2 residual (CONFIRMED HIGH): a height-only
    // pane resize changes LegendList's `state.scrollLength` via its internal
    // `handleLayout`, WITHOUT firing a scroll event, a row remeasure
    // (`onTimelineItemSizeChanged`), or a header/footer change
    // (`onListMetricsChange`) - none of the earlier hooks see it. Driven via
    // `triggerLegendListResizeObserverEntry` (the controllable global
    // `ResizeObserver` installed at module-load time above) firing a
    // synthetic entry for the scroll container itself - this flows through
    // LegendList's REAL `useOnLayoutSync` -> `onLayoutChange` ->
    // `handleLayout` pipeline exactly as a genuine browser resize would,
    // recalculating items-in-view for the unchanged scrollTop.
    it("(review round 3, finding 2 residual) a height-only pane resize with no scroll/no row-remeasure/no header-footer-change crosses the deletion boundary - delete lands case (b)", async () => {
      const ROW_COUNT = 30;
      const KEEP_COUNT = 25;
      const messages = makeTranscript(ROW_COUNT);
      const scrollStateKey = "t17-finding2-r3-viewport-resize";
      saveChatTabState({
        identity: makeDefaultTestIdentity(scrollStateKey),
        mode: "free-scrolling",
        anchorMessageId: messages[0]?.id ?? null,
        anchorIndex: null,
        offset: 0,
      });
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey,
      });
      await settleLegendList();

      // Authoritative snapshot: scrolled to a row strictly before
      // KEEP_COUNT (25) - roughly rows 10-17 at this scrollTop.
      await t17SeedFreeScrollingAt(900);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      const stateBeforeResize = legendListRefHolder.current?.getState();
      expect(stateBeforeResize?.scrollLength).toBe(VIEWPORT_HEIGHT_PX);
      expect(stateBeforeResize?.end).toBeLessThan(KEEP_COUNT);

      // Height-only pane resize: same messages array, no scroll event, no
      // row remeasure, no header/footer change - grows the viewport so more
      // rows fit at the same scrollTop, crossing KEEP_COUNT (25). Real
      // evidence this reaches LegendList's genuine `handleLayout`, not a
      // no-op: `scrollLength`/`end` are asserted below to have actually
      // moved, through the real library, before the delete even happens.
      const GROWN_VIEWPORT_HEIGHT_PX = VIEWPORT_HEIGHT_PX + 800;
      act(() => {
        triggerLegendListResizeObserverEntry(getScrollNode(), {
          width: VIEWPORT_WIDTH_PX,
          height: GROWN_VIEWPORT_HEIGHT_PX,
        });
      });
      const stateAfterResize = legendListRefHolder.current?.getState();
      expect(stateAfterResize?.scrollLength).toBe(GROWN_VIEWPORT_HEIGHT_PX);
      expect(stateAfterResize?.end).toBeGreaterThanOrEqual(KEEP_COUNT);

      rerenderMessages(messages.slice(0, KEEP_COUNT));
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
    });
  });

  describe("live pass S4B: suffix delete during a programmatically-parked anchoring session", () => {
    // Live shape (retest/S4B, run-1275860c): a real composer send entered
    // `anchoring-new-turn`; the reader then parked deep in the transcript via
    // a PROGRAMMATIC `scrollTop` write (no wheel/touchmove/pointerdown/
    // keydown - the harness's own JS-driven scroll, not a real gesture); mode
    // stayed `anchoring-new-turn` since nothing in that path cancels it.
    // Deleting a user message above the parked position (a real suffix
    // removal) was then expected to land at the new live edge
    // (`following-end`) but did not move.
    it("(ticket 19 pin) a settled anchoring session cedes ownership on a scroll-only DOM departure - the scrollbar-thumb gesture the reachability pin above used to document as undetected", async () => {
      const sendId = "s4b-reachability-send";
      const messages = makeCompletedTranscript(30);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "s4b-reachability-key",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      const afterSend = appendOptimisticUserSend(messages, sendId, 700_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      // Same scroll-only departure the old (pre-ticket-19) reachability pin
      // documented as undetected: a direct DOM `scrollTop` write with no
      // wheel/touch/pointerdown event of its own - the live harness's exact
      // native-thumb-drag shape. Critically, this is also NOT a library
      // call of any kind, so `list.getState().scroll` never advances to
      // match - the capture-provenance classifier's state-equality check
      // (chat-messages-scroll-helpers.ts) sees the mismatch and cancels on
      // the very first captured event, before LegendList's own non-capture
      // target listener ever consumes it.
      const scrollNode = getScrollNode();
      act(() => {
        scrollNode.scrollTop = 900;
        fireEvent.scroll(scrollNode);
      });

      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
      expect(scrollNode.scrollTop).toBe(900);

      // Ownership oracle (design's integrated pin, item 3): the departed
      // generation must never again receive a reveal/follow correction.
      // Spying on the REAL LegendList instance's own imperative API is the
      // strongest available negative - it is the exact surface the reveal
      // pass and anchor engine would call to pull a still-owned reader back.
      const list = legendListRefHolder.current;
      if (!list) throw new Error("expected LegendListRef to be attached");
      const scrollToOffsetSpy = vi.spyOn(list, "scrollToOffset");
      const scrollToIndexSpy = vi.spyOn(list, "scrollToIndex");
      const withReply: ReadonlyArray<ChatMessageModel> = [
        ...afterSend,
        {
          ...makeMessageAt(0, "assistant", 700_001),
          id: "s4b-reachability-reply-1",
          content: "chunk",
          completedAt: null,
          runState: "running",
        },
      ];
      rerenderMessages(withReply);
      await settleLegendList();

      expect(scrollToOffsetSpy).not.toHaveBeenCalled();
      expect(scrollToIndexSpy).not.toHaveBeenCalled();
      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
      expect(scrollNode.scrollTop).toBe(900);
    });

    it("(delete pin) a suffix delete that sweeps a scroll-only-departed (now free-scrolling) reader lands at the new live edge", async () => {
      const sendId = "s4b-delete-send";
      const ROW_COUNT = 30;
      const KEEP_COUNT = 10;
      const messages = makeCompletedTranscript(ROW_COUNT);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "s4b-delete-key",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      const afterSend = appendOptimisticUserSend(messages, sendId, 700_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      // Same scroll-only departure as the ticket-19 pin above - lands well
      // past KEEP_COUNT (10), so the reader's current viewport (and the
      // anchored send itself, at index ROW_COUNT=30) both fall inside the
      // to-be-deleted suffix. Post-ticket-19, the capture-provenance
      // classifier cancels anchoring ownership on this SAME event (mode
      // transitions to `free-scrolling` immediately, not merely at delete
      // time) - the delete below now exercises `classifySuffixRemoval`'s
      // ordinary free-scrolling-viewport-touched branch, not the old
      // anchoring-reserve teardown this pin originally targeted; the
      // observable outcome (lands at the new live edge) is unchanged.
      const scrollNode = getScrollNode();
      act(() => {
        scrollNode.scrollTop = 900;
        fireEvent.scroll(scrollNode);
      });
      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");

      // Real suffix delete: a user message above the parked viewport is
      // removed, taking everything after it (including the parked position
      // and the anchored send) with it.
      rerenderMessages(afterSend.slice(0, KEEP_COUNT));
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
    });

    // Review round (fix 1's own pin gap): the delete pin above always
    // deletes the anchored send ITSELF, where `resolveChatListAnchoredEndSpace`
    // already fails to find the row post-delete regardless of whether
    // `timelineAnchorMessageId` was cleared - it cannot distinguish "the
    // teardown ran" from "the row is simply gone". This pin covers the
    // OTHER shape the reviewer named: the anchored message SURVIVES a case
    // (b) delete (only later content is removed) - the only schedule where
    // the teardown's own effect (clearing `timelineAnchorMessageId`) is
    // observable at all.
    it("(fix 1 pin) a surviving anchored message's end-space reserve is torn down by a case (b) delete", async () => {
      const sendId = "s4b-survives-send";
      const messages = makeCompletedTranscript(30);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "s4b-survives-key",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      const afterSend = appendOptimisticUserSend(messages, sendId, 700_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      // A streamed reply chunk arrives after the send - `sendId` (index 30)
      // now survives well before the array's own tail.
      const withReply: ReadonlyArray<ChatMessageModel> = [
        ...afterSend,
        {
          ...makeMessageAt(0, "assistant", 700_001),
          id: "s4b-survives-reply-1",
          content: "chunk",
          completedAt: null,
          runState: "running",
        },
      ];
      rerenderMessages(withReply);
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      // Case (b): delete removes only the reply chunk, keeping `sendId` -
      // the anchored row's own reserved end-space sits within the
      // anchoring-new-turn viewport, so the classifier's viewport snapshot
      // reads this as touched by the removed suffix.
      rerenderMessages(afterSend);
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");

      // Fix 1's own observable, empirically isolated: `resolveChatListAnchored
      // EndSpace` (chat-scroll-anchoring.ts) only returns truthy while
      // `timelineAnchorMessageId` is non-null AND that row still exists (it
      // does here - `sendId` survived) - its reserve inflates the target
      // `scrollToEnd({animated:false})` (issued by this same "scroll-to-end"
      // case, unconditionally) computes. Fixture-observed (not derived from a
      // formula, same methodology as this file's other true-end pins):
      // WITHOUT the teardown, the stale reserve for the now-inert `sendId`
      // session pushes the landing to 2764; WITH it (`timelineAnchorMessageId`
      // cleared, `anchoredEndSpace` undefined, no reserve), it lands at the
      // true natural end, 2290 - a 474px gap matching the reserve exactly.
      expect(getScrollNode().scrollTop).toBe(2290);
    });
  });

  // Ticket 19 (decision #31 binding condition c): these two pins are a HARD
  // dependency-upgrade gate against the INSTALLED @legendapp/list@3.2.0, not
  // ordinary behavior coverage. `chatAnchorScrollCaptureShouldCancel`'s
  // entire state-equality/clamp classification (chat-messages-scroll-
  // helpers.ts) depends on the library's OWN listener-ordering and pre-write
  // contract - these pins assert THAT contract directly, against a REAL
  // mounted LegendList instance, independent of the classifier's own logic.
  // A future @legendapp/list bump can break this contract in two OPPOSITE
  // directions - triage a red pin here by which one actually broke, they
  // are not interchangeable:
  //
  // (a) Losing the imperative/MVCP PRE-WRITE (the non-animated-scrollToOffset
  //     pin, or the MVCP pin below, goes red): a legitimate library-owned
  //     correction no longer advances `state.scroll` before its DOM event
  //     reaches ancestor capture, so it now mismatches the state-equality
  //     check. Effect: FALSE CANCELS - the classifier treats a real
  //     library-owned scroll as a departure. Reader-safe (the fail-safe bias
  //     is unsure -> cancel), degrades send UX with an extra unwanted
  //     free-scrolling transition. This is the safety net working exactly as
  //     designed - do NOT "fix" this direction by loosening the classifier;
  //     re-audit and restore the dependency contract instead.
  //
  // (b) Losing CAPTURE-BEFORE-CONSUMPTION ordering (the direct-DOM-write pin
  //     goes red): if the library's own consuming listener ever runs before
  //     this ancestor's capture-phase listener, then by the time capture
  //     observes an event, LegendList has ALREADY consumed and often
  //     resynchronized `state.scroll` to match DOM - including for a genuine
  //     native thumb-drag departure. Effect: FALSE SILENCE - a real reader
  //     departure now looks state-equal and slips past the classifier
  //     un-cancelled, recreating the exact intent violation ticket 19 exists
  //     to fix. This is the dangerous direction: it cannot be caught by
  //     "make the classifier stricter," because the classifier never even
  //     sees a mismatch to act on - only re-establishing capture-phase
  //     ordering (or an entirely different detection mechanism) fixes it.
  //
  // (See the module doc comment on chat-messages-scroll-helpers.ts for the
  // full writer-site table these pins are drawn from.)

  describe("ticket 19: installed @legendapp/list 3.2.0 contract pins (hard upgrade gate)", () => {
    it("a direct DOM scrollTop move is STALE at ancestor capture - react.mjs:5663-5671 installs the consuming listener on the scroll node with no capture flag", async () => {
      const sendId = "t19-contract-direct-send";
      const messages = makeCompletedTranscript(30);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "t19-contract-direct-key",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();
      const afterSend = appendOptimisticUserSend(messages, sendId, 700_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();

      const list = legendListRefHolder.current;
      if (!list) throw new Error("expected LegendListRef to be attached");
      const wrapper = screen.getByTestId("chat-transcript-container");
      const scrollNode = getScrollNode();
      const observedListStateAtCapture: Array<number> = [];
      const observer = (event: Event): void => {
        if (event.target !== scrollNode) return;
        observedListStateAtCapture.push(list.getState().scroll);
      };
      wrapper.addEventListener("scroll", observer, { capture: true });
      try {
        const domScrollTopBeforeWrite = scrollNode.scrollTop;
        act(() => {
          scrollNode.scrollTop = domScrollTopBeforeWrite + 300;
          fireEvent.scroll(scrollNode);
        });
        expect(observedListStateAtCapture).toHaveLength(1);
        expect(observedListStateAtCapture[0]).toBe(domScrollTopBeforeWrite);
        expect(observedListStateAtCapture[0]).not.toBe(
          domScrollTopBeforeWrite + 300,
        );
      } finally {
        wrapper.removeEventListener("scroll", observer, { capture: true });
      }
    });

    it("a non-animated scrollToOffset call is ALREADY SYNCHRONIZED at ancestor capture - react.mjs:2104-2110 calls updateScroll before doScrollTo", async () => {
      const sendId = "t19-contract-scrollto-send";
      const messages = makeCompletedTranscript(30);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "t19-contract-scrollto-key",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();
      const afterSend = appendOptimisticUserSend(messages, sendId, 700_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();

      const list = legendListRefHolder.current;
      if (!list) throw new Error("expected LegendListRef to be attached");
      const wrapper = screen.getByTestId("chat-transcript-container");
      const scrollNode = getScrollNode();
      const observedListStateAtCapture: Array<number> = [];
      const observer = (event: Event): void => {
        if (event.target !== scrollNode) return;
        observedListStateAtCapture.push(list.getState().scroll);
      };
      wrapper.addEventListener("scroll", observer, { capture: true });
      try {
        await act(async () => {
          void list.scrollToOffset({
            offset: scrollNode.scrollTop + 40,
            animated: false,
          });
          fireEvent.scroll(scrollNode);
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          });
        });
        expect(observedListStateAtCapture).toHaveLength(1);
        // Whatever position the (possibly clamped) call actually landed at,
        // the library's internal state must already equal it BEFORE this
        // ancestor capture listener ever runs - the load-bearing property
        // `chatAnchorScrollCaptureShouldCancel`'s state-equality check
        // depends on, proven here independent of that classifier's own code.
        expect(observedListStateAtCapture[0]).toBe(scrollNode.scrollTop);
      } finally {
        wrapper.removeEventListener("scroll", observer, { capture: true });
      }
    });

    // Decision #31 binding condition (c), third writer site: MVCP
    // `requestAdjust` (react.mjs:1611-1629) advances `state.scroll` before
    // the deferred web `ScrollAdjust` path issues DOM `scrollBy`
    // (:5849-5899,6456-6467). A future @legendapp/list bump that stops
    // pre-writing for data adjustments would break the state-equality
    // silence path for every above-anchor weave during anchoring - this
    // pin is the hard upgrade gate for that writer, same observation
    // shape as the two pins above.
    it("an MVCP data adjustment (row insertion above the anchor) is ALREADY SYNCHRONIZED at ancestor capture - react.mjs:1611-1629 requestAdjust pre-writes state.scroll before scrollBy", async () => {
      const sendId = "t19-contract-mvcp-send";
      const earlierUserId = "message-2";
      const initial = makeCompletedTranscript(12);
      const { rerenderMessages } = renderChatMessages({
        messages: initial,
        scrollStateKey: "t19-contract-mvcp-key",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();
      const afterSend = appendOptimisticUserSend(initial, sendId, 700_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      const scrollBeforeWeave = getScrollNode().scrollTop;

      const list = legendListRefHolder.current;
      if (!list) throw new Error("expected LegendListRef to be attached");
      const wrapper = screen.getByTestId("chat-transcript-container");
      const scrollNode = getScrollNode();
      const observedAtCapture: Array<{
        listScroll: number;
        domScroll: number;
      }> = [];
      const observer = (event: Event): void => {
        if (event.target !== scrollNode) return;
        observedAtCapture.push({
          listScroll: list.getState().scroll,
          domScroll: scrollNode.scrollTop,
        });
      };
      wrapper.addEventListener("scroll", observer, { capture: true });

      // jsdom does not fire `scroll` on Element.scrollBy (LegendList's web
      // MVCP path: react.mjs:5840). Polyfill on THIS node only so the
      // capture-phase observation actually runs for the library's own
      // scrollBy - without inventing a second production listener. The
      // load-bearing property is still "list state already matches DOM at
      // ancestor capture", not the polyfill itself.
      const originalScrollBy = scrollNode.scrollBy.bind(scrollNode);
      // `Element.scrollBy`'s overloaded native signature (`(options?)` /
      // `(x, y)`) genuinely permits fewer arguments than this polyfill
      // declares - house style bans `?:` (a caller-omittable parameter),
      // but the caller here is jsdom/LegendList's own internal invocation,
      // not code this file controls, so the params stay required-typed
      // (`| undefined`) and the assignment cast documents the real,
      // load-bearing arity gap instead of a redundant one: every code path
      // already treats a missing value as `undefined` correctly.
      scrollNode.scrollBy = ((
        options: ScrollToOptions | number | undefined,
        yArg: number | undefined,
      ): void => {
        if (typeof options === "number") {
          scrollNode.scrollLeft += options;
          scrollNode.scrollTop += typeof yArg === "number" ? yArg : 0;
        } else if (options && typeof options === "object") {
          if (typeof options.left === "number") {
            scrollNode.scrollLeft += options.left;
          }
          if (typeof options.top === "number") {
            scrollNode.scrollTop += options.top;
          }
        }
        fireEvent.scroll(scrollNode);
      }) as typeof scrollNode.scrollBy;

      try {
        // Same natural MVCP trigger as ticket 13 pin (e): a non-retarget
        // setup-card weave ABOVE an earlier (non-anchored) row - classify
        // as `none`, so the only scroll motion is LegendList's own data
        // MVCP adjustment keeping the anchored send pixel-stable
        // (+1 row height). Not a messages-array tail append (which would
        // not shift content above the viewport).
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
        rerenderMessages(afterForeignCard);
        await waitForAnchorEngineSettle();

        // Behavioral ownership: mode + generation still owned across the
        // weave (classifier stayed silent for every library-owned event).
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
        expect(getScrollNode().scrollTop).toBe(
          scrollBeforeWeave + TICKET_13_ROW_HEIGHT_PX,
        );

        // Hard-gate observation: at least one capture-phase event during
        // the MVCP path must already show list state equal to DOM (the
        // pre-write). If the library never issued scrollBy for this
        // weave in this harness, fall through is impossible - the
        // behavioral +1-row assert above would have failed first.
        const synchronizedCaptures = observedAtCapture.filter(
          (sample) => Math.abs(sample.listScroll - sample.domScroll) <= 1,
        );
        expect(synchronizedCaptures.length).toBeGreaterThan(0);
        for (const sample of synchronizedCaptures) {
          expect(sample.listScroll).toBe(sample.domScroll);
        }
      } finally {
        scrollNode.scrollBy = originalScrollBy;
        wrapper.removeEventListener("scroll", observer, { capture: true });
      }
    });
  });

  // Ticket 19 (decision #31): remaining non-gesture sources from the
  // design's audit table. Each pin settles an `anchoring-new-turn`
  // session, drives ONE library/app/browser-owned scroll source, and
  // asserts the capture-provenance classifier stays SILENT (mode remains
  // `anchoring-new-turn`, session still owned). The core defect pin and
  // pure truth-table live elsewhere; these are the silence side of the
  // audit. Do NOT add production machinery to make a pin possible - if a
  // source cannot be expressed in jsdom, fall back to a behavioral mode/
  // generation-owned assertion and document the proof shape.

  describe("ticket 19: non-gesture sources stay silent during settled anchoring", () => {
    it("(browser-clamp integration) a content-height shrink that clamps scrollTop to the new max does not cancel anchoring", async () => {
      // Pure clamp-predicate unit tests already cover the math
      // (chat-messages-scroll-helpers.test.ts). This pin is the DOM-level
      // integration: settle anchoring, shrink the scroller's reported
      // scrollHeight so the new max falls BELOW the parked scrollTop
      // (previous.scrollTop > currentMax + 1 AND currentMax < previousMax),
      // then write scrollTop to the new max exactly as a real browser clamp
      // would - no library scroll call, no wheel/touch/pointer. The
      // classifier must recognize the exact clamp signature and stay silent
      // (design audit table: "Browser clamping after content/reserve/
      // viewport shrink"). A bare write that is NOT this signature is
      // exactly what the S4B defect pin proves DOES cancel.
      const sendId = "t19-clamp-integration-send";
      const messages = makeCompletedTranscript(30);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "t19-clamp-integration-key",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();
      const afterSend = appendOptimisticUserSend(messages, sendId, 700_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      const scrollNode = getScrollNode();
      const parkedTop = scrollNode.scrollTop;
      expect(parkedTop).toBeGreaterThan(100);
      // Seed the capture listener's previousSnapshot at the parked
      // position against the (still-large) default max - one library-owned
      // no-op re-write so the next event has a real "previous" to compare.
      await fireLibraryOwnedScrollTo(parkedTop);
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      // Shrink content so the new max is well below the parked top. New
      // max = scrollHeight - clientHeight. Pick scrollHeight so
      // max = parkedTop - 120 (prior-over-max evidence with room for the
      // 1px exclusivity boundary).
      const clientHeight = scrollNode.clientHeight;
      const newMax = parkedTop - 120;
      expect(newMax).toBeGreaterThan(0);
      setLegendListScrollContainerScrollHeightOverride(newMax + clientHeight);
      try {
        act(() => {
          // Bare DOM write landing within 1px of the new max - the exact
          // browser-clamp shape (list state still at parkedTop → mismatch,
          // so state-equality does NOT silence; the clamp predicate must).
          scrollNode.scrollTop = newMax;
          fireEvent.scroll(scrollNode);
        });
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
        expect(getScrollNode().scrollTop).toBe(newMax);
      } finally {
        setLegendListScrollContainerScrollHeightOverride(null);
      }
    });

    it("(fresh-open / settle re-issue) undershoot-then-reissue during anchor settle never leaves anchoring-new-turn", async () => {
      // Ticket 10/18 F2-style: force the first large programmatic jumps
      // short of target so the settle loop re-issues. Ticket 19's capture
      // classifier must treat those issue/reissue DOM moves as
      // library-owned (guard 2: active-motion ref armed across the
      // scrollToIndex call; and/or state pre-write on non-animated path),
      // never as a scroll-only departure.
      //
      // Load-bearing shape: wrap list.scrollToIndex/scrollToOffset so each
      // real LegendList call also fires a capture-phase `scroll` event
      // (jsdom never auto-dispatches). Without that wrap the classifier is
      // dead code and this pin stays green under a maximally-broken
      // "cancel every owned scroll" mutation. F2 undershoot stays in place
      // so issue/reissue actually cycles; the fire happens inside the spy
      // while activeAnchorImperativeMotionGenerationRef is still armed.
      const history = makeCompletedTranscript(40);
      const sendId = "t19-reissue-silence-send";
      const { rerenderMessages } = renderChatMessages({
        messages: history,
        scrollStateKey: "t19-reissue-silence-key",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      const scrollNode = getScrollNode();
      const modesAtCapture: Array<string | undefined> = [];
      const wrapper = screen.getByTestId("chat-transcript-container");
      const captureObserver = (event: Event): void => {
        if (event.target !== scrollNode) return;
        modesAtCapture.push(scrollNode.dataset.scrollMode);
      };
      wrapper.addEventListener("scroll", captureObserver, { capture: true });

      // Local F2-style undershoot (same shape as ticket 18's helper).
      let remainingCorrupt = 2;
      let stored = scrollNode.scrollTop;
      const undershootPx = 500;
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
          if (remainingCorrupt > 0 && Math.abs(numeric - stored) > 80) {
            remainingCorrupt -= 1;
            stored =
              numeric > stored
                ? Math.max(0, numeric - undershootPx)
                : numeric + undershootPx;
            return;
          }
          stored = numeric;
        },
      });

      const dispatch = installLibraryScrollCaptureDispatch();
      try {
        const afterSend = appendOptimisticUserSend(history, sendId, 700_000);
        rerenderMessages(afterSend);
        await waitFor(() => {
          expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
        });
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
        // Wait for the classifier to have sampled at least one library
        // write, then hold a tail window that comfortably covers a would-be
        // fast fail-safe exit (retries wake on synthetic scrollend within
        // frames now, so exhaustion - the failure mode this pin guards
        // against - would flip the mode well inside this tail, no longer
        // only at multi-second watchdog expiries).
        await waitFor(() => {
          expect(dispatch.scrollToIndexCallCount()).toBeGreaterThan(0);
        });
        await act(async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 2_500);
          });
        });
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
        // Classifier actually ran: at least one capture-phase sample from
        // the scrollToIndex wrap, all while still anchoring.
        expect(dispatch.scrollToIndexCallCount()).toBeGreaterThan(0);
        expect(modesAtCapture.length).toBeGreaterThan(0);
        for (const mode of modesAtCapture) {
          expect(mode).toBe("anchoring-new-turn");
        }
      } finally {
        dispatch.dispose();
        wrapper.removeEventListener("scroll", captureObserver, {
          capture: true,
        });
        Reflect.deleteProperty(scrollNode, "scrollTop");
        scrollNode.scrollTop = stored;
      }
    });

    it("(fresh-open instant positioning) mount-time freshOpen seed never cancels itself via the capture classifier", async () => {
      // Decision #15: fresh-open with no saved scroll state seeds
      // anchoring-new-turn and positions non-animated at mount. That
      // initial positioning (and any settle re-issue it triggers) must not
      // be misclassified as a scroll-only departure.
      //
      // After settle, explicitly fire a capture-phase scroll at the
      // post-position DOM (library state already synchronized) so the
      // classifier runs. A "cancel every owned scroll" mutation must
      // redden this pin; without the fire it stayed green vacuously.
      const messages = makeCompletedTranscript(24);
      const scrollStateKey = `t19-fresh-open-silence-${Math.random().toString(36).slice(2)}`;
      expect(
        hasSavedChatTabState(makeDefaultTestIdentity(scrollStateKey)),
      ).toBe(false);

      renderChatMessages({
        messages,
        scrollStateKey,
        freshOpen: true,
      });
      // Mode seed is sync; capture listener is mounted via layout effect.
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await settleLegendList();
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await waitFor(() => {
        expect(screen.getByTestId("mock-message-message-22")).toBeTruthy();
      });

      // Deliver the capture event the harness never auto-fires after the
      // bootstrap scroll path. List state matches DOM → healthy silence;
      // a broken always-cancel classifier trips free-scrolling here.
      await fireCaptureScrollAfterLibraryWrite();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
    });

    it("(hydration-retry navigation) navigateToMessage cancels anchoring before its own scroll - capture does not misclassify the landing", async () => {
      // Design audit: "Hydration-retry navigation" - navigateToMessage
      // cancels ownership BEFORE issuing its own scroll (chat-messages.tsx),
      // so the capture classifier sees an unowned session for that landing.
      //
      // Load-bearing proof is cancel-first ordering observed AT CAPTURE:
      // wrap scrollToOffset/scrollToIndex so the landing write fires a
      // real capture-phase scroll, and assert mode is already
      // free-scrolling when that event is observed (not still
      // anchoring-new-turn). Ending free-scrolling alone is not enough -
      // without a capture fire the classifier never runs.
      //
      // Note on mutation shape: a "cancel every owned scroll" mutation
      // does NOT redden this pin by design - the landing event is already
      // unowned (`isAnchoringSessionOwned=false`). The capture-phase mode
      // sample is the load-bearing assertion for cancel-first ordering.
      const messages = makeCompletedTranscript(20);
      const sendId = "t19-hydration-nav-send";
      const targetId = messages[4]?.id;
      expect(targetId).toBeTruthy();
      const { rerenderMessages, rerenderWith } = renderChatMessages({
        messages,
        scrollStateKey: "t19-hydration-nav-key",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();
      const afterSend = appendOptimisticUserSend(messages, sendId, 700_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      const scrollNode = getScrollNode();
      const modesAtCapture: Array<string | undefined> = [];
      const wrapper = screen.getByTestId("chat-transcript-container");
      const captureObserver = (event: Event): void => {
        if (event.target !== scrollNode) return;
        modesAtCapture.push(scrollNode.dataset.scrollMode);
      };
      wrapper.addEventListener("scroll", captureObserver, { capture: true });
      const dispatch = installLibraryScrollCaptureDispatch();
      try {
        rerenderWith({
          scrollRequest: {
            messageId: targetId,
            blockId: null,
            requestId: 19_001,
          },
        });
        await waitForNavigationSettle();
        // Also flush one explicit capture in case the nav path used a
        // route that did not go through the wrapped list methods.
        await fireCaptureScrollAfterLibraryWrite();

        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
        expect(getScrollNode().dataset.scrollMode).not.toBe(
          "anchoring-new-turn",
        );
        // Capture-phase evidence: the classifier ran (at least one scroll
        // event reached the wrapper). dataset.scrollMode can lag one React
        // paint behind the ref cancel (cancel sets timelineScrollModeRef
        // synchronously but setScrollMode is async), so samples taken
        // mid-navigateToMessage may still read anchoring-new-turn on the
        // DOM attribute even though the classifier already saw unowned via
        // the ref. After settle the attribute is free-scrolling; the final
        // fire above must stay free-scrolling (classifier silent for
        // unowned). That post-settle capture is the cancel-first proof
        // that does not race React paint.
        expect(modesAtCapture.length).toBeGreaterThan(0);
        expect(modesAtCapture[modesAtCapture.length - 1]).toBe(
          "free-scrolling",
        );
      } finally {
        dispatch.dispose();
        wrapper.removeEventListener("scroll", captureObserver, {
          capture: true,
        });
      }
    });

    it("(disclosure preservation) a disclosure helper correction during settled anchoring does not cancel the session", async () => {
      // Design audit: "Disclosure preservation correction" - non-animated
      // scrollToOffset advances list state before DOM, so the classifier's
      // state-equality path silences it. After the helper writes, explicitly
      // fire capture-phase scroll (jsdom never does) so a broken always-
      // cancel classifier would free-scroll and redden this pin.
      const history = makeCompletedTranscript(10);
      const sendId = "t19-disclosure-silence-send";
      const { rerenderMessages } = renderChatMessages({
        messages: history,
        scrollStateKey: "t19-disclosure-silence-key",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();
      const afterSend = appendOptimisticUserSend(history, sendId, 830_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      await waitFor(() => {
        expect(legendListRefHolder.current).not.toBeNull();
      });
      const list = legendListRefHolder.current;
      if (!list) throw new Error("expected LegendListRef to be attached");
      // Auto-fire capture scroll on every library scroll write the helper
      // or geometry-repair path issues during mutate.
      const dispatch = installLibraryScrollCaptureDispatch();

      const DISCLOSURE_DELTA_PX = 180;
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
        y: 100 + DISCLOSURE_DELTA_PX,
        width: 100,
        height: 20,
        top: 100 + DISCLOSURE_DELTA_PX,
        left: 0,
        right: 100,
        bottom: 120 + DISCLOSURE_DELTA_PX,
        toJSON: () => ({}),
      });

      try {
        act(() => {
          preserveChatScrollAcrossDisclosureChange({
            list,
            anchorElement,
            mutate: () => {
              legendListRefHolder.current?.setItemSize("message-2", {
                height: 90 + DISCLOSURE_DELTA_PX,
                width: VIEWPORT_WIDTH_PX,
              });
            },
            correctionOwnedByMvcp: false,
          });
        });
        await waitForRevealPassTick();
        await waitForRevealPassTick();
        // Final capture flush: covers any write that bypassed the wrap and
        // ensures at least one classifier invocation while still owned.
        await fireCaptureScrollAfterLibraryWrite();

        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
        expect(
          dispatch.scrollToOffsetCallCount() +
            dispatch.scrollToIndexCallCount(),
        ).toBeGreaterThan(0);
      } finally {
        dispatch.dispose();
        rectSpy.mockRestore();
      }
    });

    it("(setup-card weave) mid-anchoring setup-card retarget does not cancel via the capture classifier", async () => {
      // Design audit: "Setup-card weave/anchor retarget" is the composition
      // of MVCP data adjustment + a new anchor issue under the current
      // settle generation. Wrap list scroll APIs (and polyfill scrollBy for
      // MVCP) so every library-owned DOM write delivers a capture-phase
      // scroll - without that the classifier is never invoked and a
      // broken always-cancel mutation would leave this pin green.
      const initial = makeCompletedTranscript(6);
      const sendId = "t19-setup-card-weave-send";
      const { rerenderMessages } = renderChatMessages({
        messages: initial,
        scrollStateKey: "t19-setup-card-weave-key",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();
      const afterSend = appendOptimisticUserSend(initial, sendId, 500_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      const scrollBeforeCard = getScrollNode().scrollTop;

      const scrollNode = getScrollNode();
      const originalScrollBy = scrollNode.scrollBy.bind(scrollNode);
      // `Element.scrollBy`'s overloaded native signature (`(options?)` /
      // `(x, y)`) genuinely permits fewer arguments than this polyfill
      // declares - house style bans `?:` (a caller-omittable parameter),
      // but the caller here is jsdom/LegendList's own internal invocation,
      // not code this file controls, so the params stay required-typed
      // (`| undefined`) and the assignment cast documents the real,
      // load-bearing arity gap instead of a redundant one: every code path
      // already treats a missing value as `undefined` correctly.
      scrollNode.scrollBy = ((
        options: ScrollToOptions | number | undefined,
        yArg: number | undefined,
      ): void => {
        if (typeof options === "number") {
          scrollNode.scrollLeft += options;
          scrollNode.scrollTop += typeof yArg === "number" ? yArg : 0;
        } else if (options && typeof options === "object") {
          if (typeof options.left === "number") {
            scrollNode.scrollLeft += options.left;
          }
          if (typeof options.top === "number") {
            scrollNode.scrollTop += options.top;
          }
        }
        fireEvent.scroll(scrollNode);
      }) as typeof scrollNode.scrollBy;

      const dispatch = installLibraryScrollCaptureDispatch();
      try {
        const sendIndex = afterSend.findIndex(
          (message) => message.id === sendId,
        );
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
        // Explicit capture flush after settle so a retarget path that
        // only repositioned via already-fired wraps still has a final
        // owned event for the classifier to silence.
        await fireCaptureScrollAfterLibraryWrite();

        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
        expect(screen.getByTestId(`mock-message-${card.id}`)).toBeTruthy();
        // Uniform 90px rows: card takes the send's prior slot → same
        // scrollTop after a correct retarget (ticket 13 pin d geometry).
        expect(getScrollNode().scrollTop).toBe(scrollBeforeCard);
      } finally {
        dispatch.dispose();
        scrollNode.scrollBy = originalScrollBy;
      }
    });

    it("(endInset / lower-dock resize) composerOverlayHeight change while anchoring does not cancel the session", async () => {
      // Design audit: "endInset / lower-dock resize" - LegendList may
      // reprocess or requestAdjust on contentInsetEndAdjustment changes;
      // a pure max shrink uses the clamp predicate. Either path must stay
      // silent. After the prop change, fire a capture-phase scroll so the
      // classifier actually runs (library state equals DOM → silence;
      // broken always-cancel while owned → free-scrolling).
      const sendId = "t19-endinset-silence-send";
      const messages = makeCompletedTranscript(20);
      const { rerenderMessages, rerenderWith } = renderChatMessages({
        messages,
        scrollStateKey: "t19-endinset-silence-key",
        localProvenanceMessageIds: new Set([sendId]),
        composerOverlayHeight: 80,
      });
      await settleLegendList();
      const afterSend = appendOptimisticUserSend(messages, sendId, 700_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      const scrollBefore = getScrollNode().scrollTop;

      const scrollNode = getScrollNode();
      const originalScrollBy = scrollNode.scrollBy.bind(scrollNode);
      // `Element.scrollBy`'s overloaded native signature (`(options?)` /
      // `(x, y)`) genuinely permits fewer arguments than this polyfill
      // declares - house style bans `?:` (a caller-omittable parameter),
      // but the caller here is jsdom/LegendList's own internal invocation,
      // not code this file controls, so the params stay required-typed
      // (`| undefined`) and the assignment cast documents the real,
      // load-bearing arity gap instead of a redundant one: every code path
      // already treats a missing value as `undefined` correctly.
      scrollNode.scrollBy = ((
        options: ScrollToOptions | number | undefined,
        yArg: number | undefined,
      ): void => {
        if (typeof options === "number") {
          scrollNode.scrollLeft += options;
          scrollNode.scrollTop += typeof yArg === "number" ? yArg : 0;
        } else if (options && typeof options === "object") {
          if (typeof options.left === "number") {
            scrollNode.scrollLeft += options.left;
          }
          if (typeof options.top === "number") {
            scrollNode.scrollTop += options.top;
          }
        }
        fireEvent.scroll(scrollNode);
      }) as typeof scrollNode.scrollBy;
      const dispatch = installLibraryScrollCaptureDispatch();
      try {
        rerenderWith({ composerOverlayHeight: 240 });
        await settleLegendList();
        await waitForRevealPassTick();
        // Ensure the classifier sees at least one event while still owned
        // even if inset change produced no library write in this harness.
        await fireCaptureScrollAfterLibraryWrite();

        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
        expect(getScrollNode().dataset.scrollMode).not.toBe("free-scrolling");
        expect(Math.abs(getScrollNode().scrollTop - scrollBefore)).toBeLessThan(
          500,
        );
      } finally {
        dispatch.dispose();
        scrollNode.scrollBy = originalScrollBy;
      }
    });
  });
});
