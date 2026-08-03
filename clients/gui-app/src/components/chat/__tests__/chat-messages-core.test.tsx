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
import {
  CHAT_ARROW_SCROLL_STEP_PX,
  type ChatAnchorDriftRepairOutcome,
} from "@/components/chat/chat-messages-scroll-helpers";
import { saveChatTabState } from "@/stores/chats/chat-tab-state-cache";
import { type ChatTabPersistenceIdentity } from "@/stores/chats/chat-tab-persistence-key";
import { type ActivityGroupOpenState } from "@/stores/chats/activity-group-open-store-context";
import { deriveActivityGroupRenderId } from "@/components/chat/chat-collapsible-key";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { type ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import { type BackgroundItem } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  makeAssistantMessage,
  makeMessage,
  makeMessageAt,
} from "./chat-message-fixtures";
import {
  setLegendListScrollContainerScrollHeightOverride,
  setLegendListSyntheticScrollEventsEnabled,
  settleLegendList,
} from "./legend-list-test-environment";
import {
  activityGroupOpenIds,
  legendListRefHolder,
  platformMock,
} from "./chat-messages-suite-refs";
import {
  appendAssistant,
  appendOptimisticUserSend,
  dispatchKeyInScope,
  enterFreeScrollingAwayFromEnd,
  fireLibraryOwnedScrollTo,
  fireScrollAwayFromEnd,
  fireScrollToEnd,
  fireScrollTopAndFlush,
  getScrollNode,
  isJumpPillVisible,
  LEGEND_LIST_HEADER_PX,
  makeCompletedTranscript,
  makeDefaultTestIdentity,
  makeTranscript,
  PILL_SHOW_DEBOUNCE_MS,
  registerChatMessagesSuiteHooks,
  renderChatMessages,
  selectLastChatTurnMinimapItem,
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

  it("starts following-end (no jump pill) when scroll cache is bottom-following", async () => {
    const messages = makeTranscript(12);
    renderChatMessages({ messages, scrollStateKey: "fresh-follow-key" });
    await settleLegendList();

    await waitFor(() => {
      expect(screen.getByTestId("chat-messages-scroll")).toBeTruthy();
    });
    expect(isJumpPillVisible()).toBe(false);
  });

  it("preserves free-scrolling restored from the scroll-state cache (pill visible)", async () => {
    const messages = makeTranscript(12);
    const scrollStateKey = "restored-free-key";
    saveChatTabState({
      identity: makeDefaultTestIdentity(scrollStateKey),
      mode: "free-scrolling",
      anchorMessageId: messages[0]?.id ?? null,
      anchorIndex: null,
      offset: 0,
    });

    renderChatMessages({ messages, scrollStateKey });
    await settleLegendList();

    await waitFor(() => {
      expect(isJumpPillVisible()).toBe(true);
    });
  });

  describe("pill debounce", () => {
    it("does not show the Jump-to-latest chip immediately on leaving the end, then shows after 150ms", async () => {
      const messages = makeTranscript(20);
      renderChatMessages({ messages, scrollStateKey: "pill-debounce-key" });
      await settleLegendList();

      expect(isJumpPillVisible()).toBe(false);

      // Fake timers make the debounce boundary exact: the old real-timer
      // version slept `PILL_SHOW_DEBOUNCE_MS - 30` and asserted "not yet" -
      // a 30ms scheduler stall on a loaded runner fires the debounce early
      // and flips that assertion (an observed CI shard-2 flake).
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        act(() => {
          enterFreeScrollingAwayFromEnd();
        });

        // Debounced show: still hidden before 150ms.
        expect(isJumpPillVisible()).toBe(false);

        act(() => {
          vi.advanceTimersByTime(PILL_SHOW_DEBOUNCE_MS - 1);
        });
        expect(isJumpPillVisible()).toBe(false);

        act(() => {
          vi.advanceTimersByTime(1);
        });
        expect(isJumpPillVisible()).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("hides the pill immediately when clicking Jump to latest", async () => {
      const messages = makeTranscript(20);
      renderChatMessages({ messages, scrollStateKey: "pill-hide-key" });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, PILL_SHOW_DEBOUNCE_MS + 30);
        });
      });
      expect(isJumpPillVisible()).toBe(true);

      fireEvent.click(screen.getByRole("button", { name: "Scroll to end" }));
      expect(isJumpPillVisible()).toBe(false);
    });
  });

  it("wheel/pointerdown/touchmove cancel live-follow (generation token) so stream growth stays parked", async () => {
    const messages = makeTranscript(20);

    for (const gesture of ["wheel", "pointerdown", "touchmove"] as const) {
      const scrollStateKey = `manual-${gesture}-key`;
      const { rerenderMessages, unmount } = renderChatMessages({
        messages,
        scrollStateKey,
      });
      await settleLegendList();

      const scrollNode = getScrollNode();
      if (gesture === "wheel") {
        fireEvent.wheel(scrollNode, { deltaY: -80 });
      } else if (gesture === "pointerdown") {
        fireEvent.pointerDown(scrollNode);
      } else {
        fireEvent.touchMove(scrollNode);
      }
      fireScrollAwayFromEnd();
      // Park at a stable non-zero offset after leaving the end.
      scrollNode.scrollTop = 90;
      fireEvent.scroll(scrollNode);
      const parked = getScrollNode().scrollTop;
      expect(parked).toBe(90);

      rerenderMessages(appendAssistant(messages, `stream-${gesture}`, 10_000));
      await settleLegendList();
      expect(getScrollNode().scrollTop).toBe(parked);

      unmount();
    }
  });

  /**
   * Ticket 14 (direction A): edge-aware wheel cancellation. A downward wheel
   * at the true live edge must not cancel follow (clamped momentum shape:
   * wheel with no accompanying scroll). Upward / ambiguous wheels and
   * directionless touch movement are departures; explicit toward-end touch
   * movement may arm a later strict-edge resume.
   */

  describe("edge-aware wheel live-follow cancellation (ticket 14)", () => {
    async function renderFollowingAtLiveEdge(
      scrollStateKey: string,
    ): Promise<HTMLElement> {
      const messages = makeTranscript(20);
      renderChatMessages({ messages, scrollStateKey });
      await settleLegendList();
      act(() => {
        fireScrollToEnd();
      });
      const scrollNode = getScrollNode();
      expect(scrollNode.dataset.scrollMode).toBe("following-end");
      return scrollNode;
    }

    it("downward wheel at the live edge does not cancel follow", async () => {
      const scrollNode = await renderFollowingAtLiveEdge(
        "t14-down-at-edge-key",
      );
      const scrollTopBefore = scrollNode.scrollTop;

      fireEvent.wheel(scrollNode, { deltaY: 40 });

      expect(scrollNode.scrollTop).toBe(scrollTopBefore);
      expect(scrollNode.dataset.scrollMode).toBe("following-end");
    });

    it("upward wheel at the live edge cancels follow", async () => {
      const scrollNode = await renderFollowingAtLiveEdge("t14-up-at-edge-key");

      fireEvent.wheel(scrollNode, { deltaY: -40 });

      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
    });

    it("repeated downward clamped-momentum wheels at the live edge keep follow", async () => {
      const scrollNode = await renderFollowingAtLiveEdge(
        "t14-momentum-at-edge-key",
      );
      const scrollTopBefore = scrollNode.scrollTop;

      for (let tick = 0; tick < 5; tick += 1) {
        fireEvent.wheel(scrollNode, { deltaY: 40 });
        expect(scrollNode.scrollTop).toBe(scrollTopBefore);
        expect(scrollNode.dataset.scrollMode).toBe("following-end");
      }
    });

    it("touchmove without directional coordinates fails safe to departure", async () => {
      const scrollNode = await renderFollowingAtLiveEdge(
        "t14-touchmove-at-edge-key",
      );

      fireEvent.touchMove(scrollNode);

      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
    });

    it("touch direction must explicitly approach the strict edge before follow resumes", async () => {
      const scrollNode = await renderFollowingAtLiveEdge(
        "t14-touch-direction-key",
      );

      fireEvent.touchStart(scrollNode, {
        touches: [{ clientY: 300 }],
      });
      fireEvent.touchMove(scrollNode, {
        touches: [{ clientY: 320 }],
      });
      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");

      fireEvent.touchStart(scrollNode, {
        touches: [{ clientY: 320 }],
      });
      fireEvent.touchMove(scrollNode, {
        touches: [{ clientY: 300 }],
      });
      expect(scrollNode.dataset.scrollMode).toBe("following-end");
    });

    it("a scrollbar drag resumes follow only after it actually moves toward the strict edge", async () => {
      setLegendListScrollContainerScrollHeightOverride(2_000);
      const scrollNode = await renderFollowingAtLiveEdge(
        "t14-pointer-direction-key",
      );
      const atEnd = scrollNode.scrollTop;
      expect(atEnd).toBeGreaterThan(40);

      // Pointerdown alone is ambiguous (it may be text selection or an
      // inline-link click), so it relinquishes ownership without granting a
      // path back to follow. The scroll positions reported while that pointer
      // remains active provide the missing scrollbar-drag direction.
      fireEvent.pointerDown(scrollNode);
      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
      await fireScrollTopAndFlush(atEnd - 40);
      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");

      fireEvent.pointerMove(scrollNode);
      await fireScrollTopAndFlush(atEnd);
      expect(scrollNode.dataset.scrollMode).toBe("following-end");
      fireEvent.pointerUp(scrollNode);
    });

    it("an active text-selection pointer does not turn list-owned motion into scrollbar intent", async () => {
      setLegendListScrollContainerScrollHeightOverride(2_000);
      const scrollNode = await renderFollowingAtLiveEdge(
        "t14-pointer-list-owned-key",
      );
      const atEnd = scrollNode.scrollTop;

      fireEvent.pointerDown(scrollNode);
      await fireScrollTopAndFlush(atEnd - 40);
      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");

      // Pointer movement can be ordinary text selection. Legend List's
      // pre-written scroll state is the ownership proof that this later
      // toward-tail correction is MVCP/app motion, not a thumb drag.
      fireEvent.pointerMove(scrollNode);
      await fireLibraryOwnedScrollTo(atEnd);

      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
      fireEvent.pointerUp(scrollNode);
    });

    it("ambiguous wheel (deltaY 0) at the live edge still cancels follow", async () => {
      const scrollNode = await renderFollowingAtLiveEdge(
        "t14-ambiguous-at-edge-key",
      );

      fireEvent.wheel(scrollNode, { deltaY: 0 });

      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
    });

    it("downward wheel during a non-overflowing anchoring-new-turn session still cancels (review fix: isAtEnd alone is not 'the live edge')", async () => {
      // anchoredEndSpace parks a non-overflowing anchor at the maximum
      // REACHABLE scroll - a reserve/natural-bottom clamp, not necessarily
      // the turn's true content end - so LegendList's own getState().isAtEnd
      // can read true while the mode machine is still legitimately
      // "anchoring-new-turn" (the overflow-gated reconciliation branch in
      // onIsAtEndChange never fires, since anchoredTurnOverflowsViewportRef
      // stays false for a turn this short). A downward wheel arriving there
      // is real departure intent and must still cancel - the direction-A
      // exemption only applies while genuinely `following-end`.
      const sendId = "t14-anchoring-isatend-send";
      const messages = makeCompletedTranscript(10);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "t14-anchoring-isatend-key",
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
      // Precondition the finding depends on: the anchor settled without ever
      // reconciling to following-end - still legitimately anchoring.
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      const scrollNode = getScrollNode();
      fireEvent.wheel(scrollNode, { deltaY: 40 });

      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
    });
  });

  it("free-scrolling NEVER moves scroll position on streamed growth", async () => {
    const messages = makeTranscript(20);
    const { rerenderMessages } = renderChatMessages({
      messages,
      scrollStateKey: "free-stream-key",
    });
    await settleLegendList();

    const scrollNode = getScrollNode();
    fireEvent.wheel(scrollNode, { deltaY: -120 });
    scrollNode.scrollTop = 80;
    fireEvent.scroll(scrollNode);

    const parked = getScrollNode().scrollTop;
    expect(parked).toBe(80);

    const next = appendAssistant(messages, "streamed-a", 99_000);
    rerenderMessages(next);
    await settleLegendList();

    expect(getScrollNode().scrollTop).toBe(parked);
  });

  it("stays detached inside the near-end band and resumes only at the strict edge", async () => {
    const messages = makeTranscript(20);
    setLegendListScrollContainerScrollHeightOverride(
      LEGEND_LIST_HEADER_PX + messages.length * 90 + 40,
    );
    const { rerenderMessages } = renderChatMessages({
      messages,
      scrollStateKey: "near-end-restore-key",
    });
    await settleLegendList();

    act(() => {
      enterFreeScrollingAwayFromEnd();
    });
    await act(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, PILL_SHOW_DEBOUNCE_MS + 30);
      });
    });
    expect(isJumpPillVisible()).toBe(true);

    const scrollNode = getScrollNode();
    const maxScrollTop = Math.max(
      0,
      scrollNode.scrollHeight - scrollNode.clientHeight,
    );
    await fireScrollTopAndFlush(maxScrollTop - 30);
    expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");

    const parkedNearEnd = scrollNode.scrollTop;
    const streamedMessages = appendAssistant(
      messages,
      "near-end-stream",
      99_000,
    );
    rerenderMessages(streamedMessages);
    await settleLegendList();
    expect(getScrollNode().scrollTop).toBe(parkedNearEnd);
    expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

    setLegendListScrollContainerScrollHeightOverride(
      LEGEND_LIST_HEADER_PX + streamedMessages.length * 90 + 40,
    );
    act(() => {
      fireEvent.wheel(scrollNode, { deltaY: 40 });
      fireScrollToEnd();
    });

    await waitFor(
      () => {
        expect(isJumpPillVisible()).toBe(false);
        expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      },
      { timeout: 3_000 },
    );
  });

  describe("keyboard scrolling", () => {
    it("ArrowUp and ArrowDown both cancel live-follow (symmetric, decision #7)", async () => {
      const messages = makeTranscript(16);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "kbd-sym-key",
      });
      await settleLegendList();

      act(() => {
        dispatchKeyInScope("ArrowDown");
      });
      getScrollNode().scrollTop = 40;
      fireEvent.scroll(getScrollNode());
      const afterDown = getScrollNode().scrollTop;

      let next = appendAssistant(messages, "k-stream-1", 50_000);
      rerenderMessages(next);
      await settleLegendList();
      expect(getScrollNode().scrollTop).toBe(afterDown);

      // Re-enter following via the pill after free-scrolling away.
      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, PILL_SHOW_DEBOUNCE_MS + 30);
        });
      });
      fireEvent.click(screen.getByRole("button", { name: "Scroll to end" }));
      await settleLegendList();

      act(() => {
        dispatchKeyInScope("ArrowUp");
      });
      getScrollNode().scrollTop = 60;
      fireEvent.scroll(getScrollNode());
      const afterUp = getScrollNode().scrollTop;

      next = appendAssistant(next, "k-stream-2", 60_000);
      rerenderMessages(next);
      await settleLegendList();
      expect(getScrollNode().scrollTop).toBe(afterUp);
    });

    it("does not claim arrows when the target is an input/textarea/combobox", async () => {
      const messages = makeTranscript(8);
      renderChatMessages({ messages, scrollStateKey: "kbd-owner-key" });
      await settleLegendList();

      const input = document.createElement("input");
      const scope = document.querySelector("[data-chat-keyboard-scroll-scope]");
      scope?.appendChild(input);

      const scrollBefore = getScrollNode().scrollTop;
      act(() => {
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "ArrowDown",
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      expect(getScrollNode().scrollTop).toBe(scrollBefore);

      act(() => {
        getScrollNode().dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "ArrowDown",
            bubbles: true,
            cancelable: true,
            shiftKey: true,
          }),
        );
      });
      expect(getScrollNode().scrollTop).toBe(scrollBefore);
    });

    it("Home steps the scroller to the top while canceling follow", async () => {
      const messages = makeTranscript(24);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "kbd-home-key",
      });
      await settleLegendList();

      // Confirm we start away from 0 after initialScrollAtEnd.
      expect(getScrollNode().scrollTop).toBeGreaterThan(0);

      act(() => {
        dispatchKeyInScope("Home");
      });
      // Programmatic scrollTop fires a native scroll event in real browsers;
      // jsdom's shim does not, so synthesize one so LegendList refreshes
      // isAtEnd/isNearEnd (otherwise maintainScrollAtEnd still thinks the
      // viewport is at the tail and re-pins on the next data change).
      fireEvent.scroll(getScrollNode());
      await waitFor(() => {
        expect(getScrollNode().scrollTop).toBe(0);
      });

      // Free-scrolling after Home: streamed growth must not move.
      const next = appendAssistant(messages, "page-stream", 70_000);
      rerenderMessages(next);
      await settleLegendList();
      expect(getScrollNode().scrollTop).toBe(0);
    });
  });

  describe("edge-mutation wiring", () => {
    it("suffix removal while free-scrolling does not throw and remounts the list", async () => {
      // Ticket 17: free-scrolling at the top (scrollTop 0) means the last
      // visible row is early in the transcript - at/past firstRemovedIndex
      // when shrinking to 4 rows - so this lands case (b) (following-end),
      // not the old unconditional free-scrolling scroll-to-index. Only the
      // "does not throw / stays mounted" contract is pinned here; the three
      // viewport cases have dedicated pins below.
      const messages = makeTranscript(24);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "edge-suffix-key",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });

      const next = messages.slice(0, 4);
      rerenderMessages(next);
      await settleLegendList();

      expect(screen.getByTestId("chat-messages-scroll")).toBeTruthy();
      // Suffix of 4 rows fits the viewport after shrink; list remains mounted.
      expect(getScrollNode()).toBeTruthy();
    });

    it("new user send at the tail anchors near the top even while free-scrolling (decision #8, unconditional)", async () => {
      // Ticket 4 replaces the old plain scroll-to-end + following bridge for
      // this transition with the full anchor-new-turn treatment: the sent
      // row is targeted by the anchor engine and the viewport moves toward
      // it regardless of the reader's current mode.
      const messages = makeTranscript(20);
      // Registered up front, mirroring chat-session-store.ts's dispatch-time
      // registration (decision #8/#9 review round 2: unconditional anchoring
      // is decided by local-provenance registry membership, not row shape).
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "edge-send-key",
        localProvenanceMessageIds: new Set(["user-send-new"]),
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, PILL_SHOW_DEBOUNCE_MS + 30);
        });
      });
      expect(isJumpPillVisible()).toBe(true);
      // Parked at the top (scrollTop 0), the sent row (would-be index 20) is
      // nowhere near the mounted virtualization window.
      expect(screen.queryByTestId("mock-message-user-send-new")).toBeNull();

      const next: ReadonlyArray<ChatMessageModel> = [
        ...messages,
        {
          ...makeMessageAt(0, "user", 999_000),
          id: "user-send-new",
          content: "hello",
        },
      ];
      rerenderMessages(next);
      await settleLegendList();

      // The anchor engine moved the viewport toward the sent row - it is now
      // mounted (virtualization only mounts rows near the viewport).
      await waitFor(() => {
        expect(screen.getByTestId("mock-message-user-send-new")).toBeTruthy();
      });
      // No reply yet - the anchored turn's content doesn't overflow the
      // usable viewport, so the pill has nothing to signal.
      await waitFor(
        () => {
          expect(isJumpPillVisible()).toBe(false);
        },
        { timeout: 3_000 },
      );
    });
  });

  describe("aria-live turn completion", () => {
    it("announces when the trailing assistant gains a completedAt and was not stopped", async () => {
      const userMsg = makeMessage(0, "user");
      const assistantStreaming: ChatMessageModel = {
        ...makeMessage(1, "assistant"),
        completedAt: null,
        stopped: null,
        runState: "running",
      };
      const { rerenderMessages } = renderChatMessages({
        messages: [userMsg, assistantStreaming],
        scrollStateKey: "aria-complete-key",
        taskTitle: "Build plan",
      });
      await settleLegendList();

      const live = document.querySelector('[aria-live="polite"]');
      expect(live).not.toBeNull();
      expect(live?.textContent ?? "").toBe("");

      rerenderMessages([
        userMsg,
        {
          ...assistantStreaming,
          completedAt: 1_700_000_000_000,
          stopped: null,
          runState: null,
        },
      ]);
      await settleLegendList();

      await waitFor(() => {
        expect(live?.textContent).toBe("Build plan finished responding.");
      });
    });

    it("announces when a pending live row is replaced by its completed persisted row", async () => {
      const userMsg = makeMessage(0, "user");
      const pendingAssistant: ChatMessageModel = {
        ...makeMessage(1, "assistant"),
        id: "assistant:live",
        completedAt: null,
        stopped: null,
        runState: "running",
      };
      const { rerenderMessages } = renderChatMessages({
        messages: [userMsg, pendingAssistant],
        scrollStateKey: "aria-complete-row-replacement",
        taskTitle: "Build plan",
      });
      await settleLegendList();

      const live = document.querySelector('[aria-live="polite"]');
      expect(live?.textContent ?? "").toBe("");

      rerenderMessages([
        userMsg,
        {
          ...pendingAssistant,
          id: "assistant:turn-1",
          completedAt: 1_700_000_000_000,
          runState: null,
        },
      ]);
      await settleLegendList();

      await waitFor(() => {
        expect(live?.textContent).toBe("Build plan finished responding.");
      });
    });

    it("does not announce completed history on initial mount", async () => {
      const completedAssistant: ChatMessageModel = {
        ...makeMessage(1, "assistant"),
        completedAt: 1_700_000_000_000,
        stopped: null,
        runState: null,
      };
      renderChatMessages({
        messages: [makeMessage(0, "user"), completedAssistant],
        scrollStateKey: "aria-completed-history",
        taskTitle: "Build plan",
      });
      await settleLegendList();

      expect(
        document.querySelector('[aria-live="polite"]')?.textContent ?? "",
      ).toBe("");
    });

    it("replaces the live-region child when a later turn repeats the same announcement", async () => {
      const firstUser = makeMessage(0, "user");
      const firstAssistantStreaming: ChatMessageModel = {
        ...makeMessage(1, "assistant"),
        completedAt: null,
        stopped: null,
        runState: "running",
      };
      const firstAssistantCompleted: ChatMessageModel = {
        ...firstAssistantStreaming,
        completedAt: 1_700_000_000_000,
        runState: null,
      };
      const secondUser = makeMessage(2, "user");
      const secondAssistantStreaming: ChatMessageModel = {
        ...makeMessage(3, "assistant"),
        completedAt: null,
        stopped: null,
        runState: "running",
      };
      const { rerenderMessages } = renderChatMessages({
        messages: [firstUser, firstAssistantStreaming],
        scrollStateKey: "aria-repeat",
        taskTitle: "Build plan",
      });
      await settleLegendList();

      const live = document.querySelector('[aria-live="polite"]');
      rerenderMessages([firstUser, firstAssistantCompleted]);
      await settleLegendList();
      await waitFor(() => {
        expect(live?.textContent).toBe("Build plan finished responding.");
      });
      const firstAnnouncementNode = live?.firstElementChild;
      expect(firstAnnouncementNode).not.toBeNull();

      rerenderMessages([
        firstUser,
        firstAssistantCompleted,
        secondUser,
        secondAssistantStreaming,
      ]);
      await settleLegendList();
      rerenderMessages([
        firstUser,
        firstAssistantCompleted,
        secondUser,
        {
          ...secondAssistantStreaming,
          completedAt: 1_700_000_001_000,
          runState: null,
        },
      ]);
      await settleLegendList();

      await waitFor(() => {
        expect(live?.textContent).toBe("Build plan finished responding.");
        expect(live?.firstElementChild).not.toBe(firstAnnouncementNode);
      });
    });

    it("announces a completed assistant even when a queued turn appends a new running assistant in the same render", async () => {
      const firstUser = makeMessage(0, "user");
      const firstAssistantStreaming: ChatMessageModel = {
        ...makeMessage(1, "assistant"),
        completedAt: null,
        stopped: null,
        runState: "running",
      };
      const secondUser = makeMessage(2, "user");
      const secondAssistantStreaming: ChatMessageModel = {
        ...makeMessage(3, "assistant"),
        completedAt: null,
        stopped: null,
        runState: "running",
      };
      const { rerenderMessages } = renderChatMessages({
        messages: [firstUser, firstAssistantStreaming],
        scrollStateKey: "aria-queued-turn",
        taskTitle: "Build plan",
      });
      await settleLegendList();

      const live = document.querySelector('[aria-live="polite"]');
      rerenderMessages([
        firstUser,
        {
          ...firstAssistantStreaming,
          completedAt: 1_700_000_000_000,
          runState: null,
        },
        secondUser,
        secondAssistantStreaming,
      ]);
      await settleLegendList();

      await waitFor(() => {
        expect(live?.textContent).toBe("Build plan finished responding.");
      });
    });

    it("does not announce when the turn was user-stopped", async () => {
      const userMsg = makeMessage(0, "user");
      const assistantStreaming: ChatMessageModel = {
        ...makeMessage(1, "assistant"),
        completedAt: null,
        stopped: null,
        runState: "running",
      };
      const { rerenderMessages } = renderChatMessages({
        messages: [userMsg, assistantStreaming],
        scrollStateKey: "aria-stopped-key",
        taskTitle: "Build plan",
      });
      await settleLegendList();

      const live = document.querySelector('[aria-live="polite"]');
      expect(live?.textContent ?? "").toBe("");

      rerenderMessages([
        userMsg,
        {
          ...assistantStreaming,
          completedAt: 1_700_000_000_000,
          stopped: {
            stoppedAt: 1_700_000_000_000,
            reason: "user",
            turnHadOutput: true,
            turnReplyText: "partial",
          },
          runState: null,
        },
      ]);
      await settleLegendList();

      expect(live?.textContent ?? "").toBe("");
    });
  });

  describe("H2 intent-listener lifecycle across empty/repopulate", () => {
    it("attaches cancel-on-gesture listeners after empty -> first messages", async () => {
      const { rerenderMessages } = renderChatMessages({
        messages: [],
        scrollStateKey: "h2-empty-first",
      });
      // Empty transcript: no LegendList / no scroll node yet.
      expect(screen.queryByTestId("chat-messages-scroll")).toBeNull();

      const messages = makeTranscript(16);
      rerenderMessages(messages);
      await settleLegendList();

      const scrollNode = getScrollNode();
      fireEvent.wheel(scrollNode, { deltaY: -80 });
      scrollNode.scrollTop = 100;
      fireEvent.scroll(scrollNode);
      const parked = getScrollNode().scrollTop;

      rerenderMessages(appendAssistant(messages, "h2-stream", 50_000));
      await settleLegendList();
      // Listener attached after first content → free-scrolling, stream parked.
      expect(getScrollNode().scrollTop).toBe(parked);
    });

    it("re-arms listeners after non-empty -> empty -> repopulated", async () => {
      const messages = makeTranscript(16);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "h2-repopulate",
      });
      await settleLegendList();

      // Tear down the LegendList (empty state).
      rerenderMessages([]);
      expect(screen.queryByTestId("chat-messages-scroll")).toBeNull();

      // New node after repopulate - listeners must re-attach (hasContent toggle).
      const again = makeTranscript(18);
      rerenderMessages(again);
      await settleLegendList();

      const scrollNode = getScrollNode();
      fireEvent.pointerDown(scrollNode);
      scrollNode.scrollTop = 120;
      fireEvent.scroll(scrollNode);
      const parked = getScrollNode().scrollTop;

      rerenderMessages(appendAssistant(again, "h2-repop-stream", 60_000));
      await settleLegendList();
      expect(getScrollNode().scrollTop).toBe(parked);
    });
  });

  describe("minimap rail remains available in constrained panes", () => {
    function mockNarrowTranscriptWidth(widthPx: number): void {
      const container = screen.getByTestId("chat-transcript-container");
      vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
        x: 0,
        y: 0,
        width: widthPx,
        height: VIEWPORT_HEIGHT_PX,
        top: 0,
        left: 0,
        right: widthPx,
        bottom: VIEWPORT_HEIGHT_PX,
        toJSON: () => ({}),
      });
    }

    // No targeted spy teardown needed: each test renders a fresh container
    // element (the spy lives on that instance), and the outer `afterEach`'s
    // `cleanup()` unmounts it - `vi.restoreAllMocks()` is deliberately not
    // used here (see the outer `afterEach`'s own comment: it would clear the
    // file's `vi.mock` module mocks for isMac / activity store).

    it("stays visible but leaves a narrow epic canvas transcript interactive", async () => {
      const messages = makeTranscript(20);
      renderChatMessages({ messages, scrollStateKey: "always-on-minimap" });
      // The rail stays painted as an orientation aid, but its transparent hit
      // strip must not cover transcript text when the centered content column
      // consumes the full pane width.
      mockNarrowTranscriptWidth(420);
      await settleLegendList();

      const rail = screen.getByTestId("chat-turn-minimap");
      const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
      expect(rail.classList).toContain("opacity-100");
      expect(rail.classList).not.toContain("opacity-0");
      expect(hitStrip.hasAttribute("inert")).toBe(true);
      expect(hitStrip.getAttribute("aria-hidden")).toBe("true");
      expect(hitStrip.classList.contains("pointer-events-none")).toBe(true);
      expect(hitStrip.tabIndex).toBe(-1);
      expect(
        screen.queryByRole("button", { name: "Message minimap" }),
      ).toBeNull();
    });

    it("navigates from the painted narrow rail through the real transcript viewport", async () => {
      const messages = makeTranscript(20);
      renderChatMessages({
        messages,
        scrollStateKey: "narrow-painted-minimap-click",
      });
      mockNarrowTranscriptWidth(420);
      await settleLegendList();

      const interactionRegion = document.querySelector<HTMLElement>(
        "[data-chat-turn-minimap-interaction-region]",
      );
      if (interactionRegion === null) {
        throw new Error("expected minimap interaction region");
      }
      vi.spyOn(interactionRegion, "getBoundingClientRect").mockReturnValue({
        x: 420,
        y: 100,
        width: 0,
        height: 200,
        top: 100,
        left: 420,
        right: 420,
        bottom: 300,
        toJSON: () => ({}),
      });
      const list = legendListRefHolder.current;
      if (list === null) throw new Error("expected LegendListRef");
      const scrollToIndex = vi.spyOn(list, "scrollToIndex");
      const transcriptTarget = screen.getByTestId("mock-message-message-10");
      const click = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        clientX: 419,
        clientY: 100,
      });

      act(() => {
        transcriptTarget.dispatchEvent(click);
      });

      expect(click.defaultPrevented).toBe(true);
      await waitFor(() => expect(scrollToIndex).toHaveBeenCalled());
      expect(
        screen.getByTestId("chat-turn-minimap-hit-strip").hasAttribute("inert"),
      ).toBe(true);
    });

    it("stays interactive at the harness's default pane width", async () => {
      const messages = makeTranscript(20);
      renderChatMessages({ messages, scrollStateKey: "m3b-usable-hit-strip" });
      await settleLegendList();

      const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
      expect(hitStrip.hasAttribute("inert")).toBe(false);
      expect(hitStrip.getAttribute("aria-hidden")).toBeNull();
      expect(hitStrip.classList.contains("pointer-events-auto")).toBe(true);
      expect(screen.getByRole("button", { name: "Message minimap" })).toBe(
        hitStrip,
      );
    });

    it("does not mount the minimap when its placement is hidden", async () => {
      useSettingsStore.setState({ chatTurnMinimapSide: "hide" });
      renderChatMessages({
        messages: makeTranscript(20),
        scrollStateKey: "hidden-minimap",
      });
      await settleLegendList();

      expect(screen.queryByTestId("chat-turn-minimap")).toBeNull();
      expect(screen.queryByTestId("chat-turn-minimap-hit-strip")).toBeNull();
    });
  });

  // O2 (ticket 16 listener consolidation, F8): proves the FULL production
  // chain end to end - a real LegendList scroll -> ChatTimeline's own
  // `onScroll` -> ChatMessages's `handleScroll` ->
  // `minimapInViewRefreshRef.current()` -> the minimap's `updateInView` ->
  // the strip's `data-in-view` dataset write. chat-turn-minimap.test.tsx's
  // own pins call `inViewRefreshRef.current()` directly (proving the
  // minimap's OWN contract in isolation); this one is the wiring pin that a
  // deleted link anywhere in that chain would fail.

  describe("minimap in-view highlighting via the real scroll chain (O2, ticket 16)", () => {
    it("updates minimap strip in-view state through a real fireEvent.scroll, not a direct inViewRefreshRef call", async () => {
      const messages = makeCompletedTranscript(12);
      renderChatMessages({
        messages,
        scrollStateKey: "o2-minimap-real-scroll-chain",
      });
      await settleLegendList();

      // Free-scrolling, not the default following-end - a stable, non-
      // drifting position (M3b's own comment above: following-end's reveal
      // pass keeps chasing the jsdom shim's fixed large scrollHeight).
      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();

      await waitFor(() => {
        expect(screen.getByTestId("chat-turn-minimap")).toBeTruthy();
      });

      const firstUserStrip = (): Element | null =>
        document.querySelector(
          '[data-chat-turn-minimap-strip][data-message-id="message-0"]',
        );
      const lastUserStrip = (): Element | null =>
        document.querySelector(
          '[data-chat-turn-minimap-strip][data-message-id="message-10"]',
        );

      // Parked at scrollTop 0: the first user turn is in view, the last is not.
      await waitFor(() => {
        expect(firstUserStrip()?.getAttribute("data-in-view")).toBe("true");
        expect(lastUserStrip()?.getAttribute("data-in-view")).toBe("false");
      });

      // Scroll deep into real (non-fake-ceiling) content - well below the
      // ~540px natural max for this 12-row/90px-shim transcript.
      await fireScrollTopAndFlush(500);

      await waitFor(() => {
        expect(lastUserStrip()?.getAttribute("data-in-view")).toBe("true");
        expect(firstUserStrip()?.getAttribute("data-in-view")).toBe("false");
      });
    });
  });

  describe("intent-latched strict-edge follow", () => {
    it("keeps a sub-pixel upward departure detached across repeated streaming row growth", async () => {
      const messages = makeTranscript(20);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "scroll-push-subpixel-departure",
      });
      await settleLegendList();

      // `scroll-push.mov`: the first slow trackpad samples move less than
      // Legend List's one-pixel strict-edge epsilon. Geometry therefore still
      // says isAtEnd=true, but the negative wheel has already declared the
      // reader's intent to leave and must revoke follow synchronously.
      const scrollNode = getScrollNode();
      const atEnd = scrollNode.scrollTop;
      fireEvent.wheel(scrollNode, { deltaY: -0.1 });
      await fireScrollTopAndFlush(atEnd - 0.25);
      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
      expect(isJumpPillVisible()).toBe(false);

      // Grow the SAME live assistant row several times. Each pass exercises
      // both the messages-driven reveal scheduler and Legend List's genuine
      // item-layout path. None may translate repeated edge geometry back into
      // follow intent or erase the 0.25px reading departure.
      const tailId = messages.at(-1)?.id;
      if (tailId === undefined) throw new Error("Expected a transcript tail");
      let current = messages;
      for (let growth = 0; growth < 3; growth += 1) {
        current = current.map((message) =>
          message.id === tailId
            ? {
                ...message,
                content: `${message.content}\nstream growth ${growth}`,
              }
            : message,
        );
        rerenderMessages(current);
        act(() => {
          legendListRefHolder.current?.setItemSize(tailId, {
            height: 120 + growth * 40,
            width: VIEWPORT_WIDTH_PX,
          });
        });
        await waitForRevealPassTick();
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
        expect(getScrollNode().scrollTop).toBe(atEnd - 0.25);
      }

      // A later, explicit toward-end gesture arms exactly one legitimate
      // strict-edge transition. Geometry still cannot do this on its own.
      fireEvent.wheel(scrollNode, { deltaY: 0.1 });
      await fireScrollTopAndFlush(atEnd);
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
    });

    it("still shows the pill when a gesture genuinely leaves the near-end band", async () => {
      const messages = makeTranscript(20);
      renderChatMessages({
        messages,
        scrollStateKey: "m1-leave-band",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();
      expect(isJumpPillVisible()).toBe(true);
    });
  });

  describe("M2 onEndReachedThreshold 10% (not library default 50%)", () => {
    it("treats a ~200px distance-from-end park as NOT near-end (pill stays)", async () => {
      // Library math: isNearEnd when distanceFromEnd <= onEndReachedThreshold * scrollLength.
      // Default 0.5 → 350px of a 700px viewport; decision #5 wants 0.1 → 70px.
      // A 200px park is near-end under the old default and NOT under 0.1.
      const messages = makeTranscript(40);
      renderChatMessages({
        messages,
        scrollStateKey: "m2-threshold",
        // Zero dock inset so distanceFromEnd is not complicated by content
        // inset end adjustment in this threshold pin.
        composerOverlayHeight: 0,
      });
      await settleLegendList();

      const scrollNode = getScrollNode();
      const settledEnd = scrollNode.scrollTop;
      expect(settledEnd).toBeGreaterThan(0);

      act(() => {
        fireEvent.wheel(scrollNode, { deltaY: -40 });
      });

      const distanceFromEnd = 200;
      expect(distanceFromEnd).toBeGreaterThan(scrollNode.clientHeight * 0.1);
      expect(distanceFromEnd).toBeLessThan(scrollNode.clientHeight * 0.5);

      scrollNode.scrollTop = Math.max(0, settledEnd - distanceFromEnd);
      fireEvent.scroll(scrollNode);

      await waitForPillVisible();
      expect(isJumpPillVisible()).toBe(true);
    });
  });

  describe("followEnabled gates LegendList's own maintainScrollAtEnd (review fix)", () => {
    it("free-scrolling parked near the true end does NOT auto-follow a subsequent append", async () => {
      // Manual-scrollend choreography (settles the nav by hand, then parks):
      // an auto-dispatched scrollend queued by the nav's own scrollTo would
      // wake the settle chain again after the park and re-issue over it.
      setLegendListSyntheticScrollEventsEnabled(false);
      // Pre-ticket-17 setup used free-scrolling suffix removal (H3:
      // scroll-to-index + suppress) to land near the true max while free.
      // Ticket 17: that path is gone (viewport-touching suffix removal
      // forces following-end). Mirror the H3 minimap suppress path: navigate
      // near-tail (sets suppressFollowRestoreRef), settle the operation,
      // park a forced near-end scrollTop under free-scrolling, then assert
      // followEnabled keeps LegendList stick-to-bottom off on append.
      const messages = makeTranscript(30);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "follow-gate-free-near-end",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();
      expect(isJumpPillVisible()).toBe(true);

      await selectLastChatTurnMinimapItem();
      const scrollNode = getScrollNode();
      // Settle the animated nav (clears in-flight re-issue; suppression stays).
      act(() => {
        scrollNode.dispatchEvent(new Event("scrollend"));
      });
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // Park inside the near-end band under suppress (same trick as H3's
      // multi-report pin - faked scrollHeight is huge, so a large scrollTop
      // is still free-scrolling thanks to suppress, not following-end).
      const nearEndPark = Math.max(
        0,
        scrollNode.scrollHeight - scrollNode.clientHeight - 40,
      );
      await fireScrollTopAndFlush(nearEndPark);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      const parkedScrollTop = getScrollNode().scrollTop;
      rerenderMessages(
        appendAssistant(messages, "follow-gate-stream", 120_000),
      );
      await settleLegendList();

      expect(getScrollNode().scrollTop).toBe(parkedScrollTop);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
    });

    it("following-end still catches up on append when parked at the true end (companion, no regression)", async () => {
      const messages = makeTranscript(20);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "follow-gate-following",
      });
      await settleLegendList();
      expect(isJumpPillVisible()).toBe(false);

      const before = getScrollNode().scrollTop;
      rerenderMessages(
        appendAssistant(messages, "follow-gate-catchup", 130_000),
      );
      await settleLegendList();

      await waitFor(() => {
        expect(getScrollNode().scrollTop).toBeGreaterThan(before);
      });
    });
  });

  describe("following-end catch-up (coverage restore)", () => {
    it("releases follow after a scroll-only upward departure and keeps later growth parked", async () => {
      const messages = makeTranscript(20);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "follow-scroll-only-departure",
      });
      await settleLegendList();

      const scrollNode = getScrollNode();
      const liveEdgeScrollTop = scrollNode.scrollTop;
      expect(liveEdgeScrollTop).toBeGreaterThan(200);

      const streaming = appendAssistant(
        messages,
        "growth-before-scroll-only-departure",
        100_000,
      );
      rerenderMessages(streaming);
      await settleLegendList();
      await waitForRevealPassTick();
      expect(scrollNode.dataset.scrollMode).toBe("following-end");
      expect(scrollNode.scrollTop).toBeGreaterThanOrEqual(liveEdgeScrollTop);

      // jsdom does not emit the terminal event from LegendList's
      // programmatic catch-up, so report the settled owned position before
      // simulating the browser's scroll-only scrollbar-drag event.
      const settledOwnedScrollTop = scrollNode.scrollTop;
      await fireScrollTopAndFlush(settledOwnedScrollTop);
      await fireScrollTopAndFlush(settledOwnedScrollTop - 200);

      await waitFor(() => {
        expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
      });
      await waitForPillVisible();

      const parked = scrollNode.scrollTop;
      rerenderMessages(
        appendAssistant(
          streaming,
          "growth-after-scroll-only-departure",
          100_001,
        ),
      );
      await settleLegendList();
      await waitForRevealPassTick();

      expect(scrollNode.scrollTop).toBe(parked);
      expect(scrollNode.dataset.scrollMode).toBe("free-scrolling");
    });

    it("keeps follow through pure streaming growth bursts whose scrollTop never decreases", async () => {
      const messages = makeTranscript(20);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "follow-growth-bursts",
      });
      await settleLegendList();

      const scrollNode = getScrollNode();
      let previousScrollTop = scrollNode.scrollTop;
      let next: ReadonlyArray<ChatMessageModel> = messages;
      for (let burst = 0; burst < 4; burst += 1) {
        next = appendAssistant(next, `growth-burst-${burst}`, 110_000 + burst);
        rerenderMessages(next);
        await settleLegendList();
        await waitForRevealPassTick();

        expect(scrollNode.dataset.scrollMode).toBe("following-end");
        expect(scrollNode.scrollTop).toBeGreaterThanOrEqual(previousScrollTop);
        previousScrollTop = scrollNode.scrollTop;
      }
      expect(isJumpPillVisible()).toBe(false);
    });

    it("scrolls to reveal appended assistant growth while following", async () => {
      const messages = makeTranscript(20);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "follow-append",
      });
      await settleLegendList();

      const before = getScrollNode().scrollTop;
      expect(before).toBeGreaterThan(0);

      // Append many rows so content clearly overflows further.
      let next: ReadonlyArray<ChatMessageModel> = messages;
      for (let i = 0; i < 12; i += 1) {
        next = appendAssistant(next, `follow-a-${i}`, 100_000 + i);
      }
      rerenderMessages(next);
      await settleLegendList();

      await waitFor(() => {
        expect(getScrollNode().scrollTop).toBeGreaterThan(before);
      });
    });

    it("keeps following-end on in-place streaming content growth (same message id)", async () => {
      const base = makeTranscript(18);
      const streaming: ChatMessageModel = {
        ...makeMessage(18, "assistant"),
        content: "partial",
        runState: "running",
      };
      const messages = [...base, streaming];
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "follow-inplace",
      });
      await settleLegendList();

      const before = getScrollNode().scrollTop;
      expect(isJumpPillVisible()).toBe(false);

      // Same id, longer content (token stream). The estimated-item-size shim
      // does not grow row height with content, so we assert mode stays
      // following (pill hidden) rather than a pixel delta that the shim
      // cannot produce.
      rerenderMessages([
        ...base,
        {
          ...streaming,
          content: "partial ".repeat(200),
        },
      ]);
      await settleLegendList();

      expect(isJumpPillVisible()).toBe(false);
      expect(getScrollNode().scrollTop).toBeGreaterThanOrEqual(before - 1);
    });
  });

  describe("scrollRequest wiring (coverage restore)", () => {
    it("routes row-only external jumps through navigation and highlights for three seconds", async () => {
      const messages = makeCompletedTranscript(6);
      const target = messages[2];
      const { rerenderWith } = renderChatMessages({
        messages,
        scrollStateKey: "scroll-req-row-only",
      });
      await settleLegendList();

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        rerenderWith({
          scrollRequest: {
            messageId: target.id,
            blockId: null,
            requestId: 41,
          },
        });

        const targetRow = document.querySelector<HTMLElement>(
          `[data-message-id="${target.id}"]`,
        );
        expect(targetRow?.dataset.navigationHighlighted).toBe("true");
        expect(activityGroupOpenIds.setOpenCalls).toHaveLength(0);
        // The request shares navigateToMessage's suppression/settle choke
        // point rather than creating an external raw-scroll side channel.
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

        act(() => {
          vi.advanceTimersByTime(2_999);
        });
        expect(targetRow?.dataset.navigationHighlighted).toBe("true");

        act(() => {
          vi.advanceTimersByTime(1);
        });
        expect(targetRow?.dataset.navigationHighlighted).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("dismisses an external-jump highlight on transcript pointerdown", async () => {
      const messages = makeCompletedTranscript(6);
      const target = messages[2];
      const { rerenderWith } = renderChatMessages({
        messages,
        scrollStateKey: "scroll-req-highlight-user-takeover",
      });
      await settleLegendList();

      rerenderWith({
        scrollRequest: {
          messageId: target.id,
          blockId: null,
          requestId: 42,
        },
      });

      const targetRow = document.querySelector<HTMLElement>(
        `[data-message-id="${target.id}"]`,
      );
      expect(targetRow?.dataset.navigationHighlighted).toBe("true");

      act(() => {
        fireEvent.pointerDown(getScrollNode());
      });

      expect(targetRow?.dataset.navigationHighlighted).toBeUndefined();
    });

    it("does not highlight an in-tile minimap navigation", async () => {
      renderChatMessages({
        messages: makeCompletedTranscript(6),
        scrollStateKey: "scroll-req-minimap-no-highlight",
      });
      await settleLegendList();

      await selectLastChatTurnMinimapItem();

      expect(
        document.querySelector("[data-navigation-highlighted]"),
      ).toBeNull();
    });

    it("opens the owning activity group and navigates once per requestId", async () => {
      const commandId = "cmd-block-1";
      const assistant = {
        ...makeAssistantMessage("assistant-target", "act-1"),
        segments: [
          {
            id: commandId,
            kind: "command" as const,
            command: "echo hi",
            cwd: null,
            exitCode: 0,
            isStreaming: false,
            endState: null,
            stopped: false,
            progress: null,
            startedAt: 0,
            backgroundTask: null,
            parentId: null,
          },
        ],
        completedAt: 1,
      };
      const messages: ReadonlyArray<ChatMessageModel> = [
        makeMessage(0, "user"),
        makeMessage(1, "assistant"),
        makeMessage(2, "user"),
        assistant,
      ];
      const expectedGroupId = deriveActivityGroupRenderId(commandId);

      const { rerenderWith } = renderChatMessages({
        messages,
        scrollStateKey: "scroll-req",
        scrollRequest: {
          messageId: assistant.id,
          blockId: commandId,
          requestId: 42,
        },
      });
      await settleLegendList();

      await waitFor(() => {
        expect(
          activityGroupOpenIds.setOpenCalls.some(
            (call) => call.groupId === expectedGroupId && call.open,
          ),
        ).toBe(true);
      });

      const callsAfterFirst = activityGroupOpenIds.setOpenCalls.length;
      const scrollAfterFirst = getScrollNode().scrollTop;

      // Same requestId + unrelated backgroundItems change must NOT re-navigate.
      rerenderWith({
        backgroundItems: [
          {
            taskId: "task-bg-1",
            kind: "command",
            title: "sleep 1",
            blockId: "bg-1",
            parentTaskId: null,
            scheduledFor: null,
          } satisfies BackgroundItem,
        ],
        scrollRequest: {
          messageId: assistant.id,
          blockId: commandId,
          requestId: 42,
        },
      });
      await settleLegendList();

      expect(activityGroupOpenIds.setOpenCalls.length).toBe(callsAfterFirst);
      // Dedup: scroll position not re-driven by a second navigateToMessage.
      expect(getScrollNode().scrollTop).toBe(scrollAfterFirst);
    });

    // Deep-link opens the owning activity group (via requestMeasuredItemChange
    // / flushSync) before navigateToMessage so the expanded measurement is
    // already committed. Assert the group ends open in store state - the
    // existing case above only checks setOpen was invoked.
    it("leaves the owning activity group open after a deep-link scrollRequest settles", async () => {
      const commandId = "cmd-block-deep-link-open";
      const assistant = {
        ...makeAssistantMessage("assistant-deep-link", "act-deep"),
        segments: [
          {
            id: commandId,
            kind: "command" as const,
            command: "echo deep-link",
            cwd: null,
            exitCode: 0,
            isStreaming: false,
            endState: null,
            stopped: false,
            progress: null,
            startedAt: 0,
            backgroundTask: null,
            parentId: null,
          },
        ],
        completedAt: 1,
      };
      const messages: ReadonlyArray<ChatMessageModel> = [
        makeMessage(0, "user"),
        makeMessage(1, "assistant"),
        makeMessage(2, "user"),
        assistant,
      ];
      const expectedGroupId = deriveActivityGroupRenderId(commandId);

      // Group starts collapsed (registry store empty for this instance).
      expect(activityGroupOpenIds.lastOpenIds.has(expectedGroupId)).toBe(false);

      renderChatMessages({
        messages,
        scrollStateKey: "scroll-req-open-state",
        scrollRequest: {
          messageId: assistant.id,
          blockId: commandId,
          requestId: 77,
        },
      });
      await settleLegendList();

      await waitFor(() => {
        expect(activityGroupOpenIds.lastOpenIds.has(expectedGroupId)).toBe(
          true,
        );
      });
      expect(
        activityGroupOpenIds.setOpenCalls.some(
          (call) => call.groupId === expectedGroupId && call.open,
        ),
      ).toBe(true);
    });
  });

  describe("quote gating under systemOverlayActive (coverage restore)", () => {
    it("disables the quote-selection hook while a system overlay is active", async () => {
      useSettingsStore.setState({ quoteReplyEnabled: true });
      const messages: ReadonlyArray<ChatMessageModel> = [
        makeMessage(0, "user"),
        {
          ...makeMessage(1, "assistant"),
          content: "Quotable assistant text for overlay gating.",
        },
      ];
      const { rerenderWith } = renderChatMessages({
        messages,
        scrollStateKey: "quote-overlay",
        systemOverlayActive: true,
      });
      await settleLegendList();

      const transcript = screen.getByTestId("chat-transcript-container");
      const addListenerSpy = vi.spyOn(transcript, "addEventListener");
      const removeListenerSpy = vi.spyOn(transcript, "removeEventListener");
      try {
        rerenderWith({ systemOverlayActive: false });
        expect(addListenerSpy).toHaveBeenCalledWith(
          "mouseup",
          expect.any(Function),
        );

        rerenderWith({ systemOverlayActive: true });
        expect(removeListenerSpy).toHaveBeenCalledWith(
          "mouseup",
          expect.any(Function),
        );
      } finally {
        addListenerSpy.mockRestore();
        removeListenerSpy.mockRestore();
      }
    });
  });

  describe("keyboard matrix (coverage restore)", () => {
    it("PageUp and PageDown both cancel follow and step by clientHeight", async () => {
      const messages = makeTranscript(30);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "kbd-page",
      });
      await settleLegendList();

      const scrollNode = getScrollNode();
      // Use the settled content end (not shim scrollHeight) as the range base.
      const settledEnd = scrollNode.scrollTop;
      const mid = Math.floor(settledEnd / 2);
      scrollNode.scrollTop = mid;
      fireEvent.scroll(scrollNode);

      act(() => {
        dispatchKeyInScope("PageDown");
      });
      fireEvent.scroll(getScrollNode());
      const afterDown = getScrollNode().scrollTop;
      // Stepped toward the end by approximately clientHeight (clamped).
      expect(afterDown).toBeGreaterThan(mid);
      expect(afterDown - mid).toBeGreaterThanOrEqual(
        Math.min(CHAT_ARROW_SCROLL_STEP_PX, scrollNode.clientHeight) - 1,
      );

      // Free after PageDown: park well away from end, then stream must not move.
      scrollNode.scrollTop = 40;
      fireEvent.scroll(scrollNode);
      const parkedDown = getScrollNode().scrollTop;
      let next = appendAssistant(messages, "page-down-stream", 110_000);
      rerenderMessages(next);
      await settleLegendList();
      expect(getScrollNode().scrollTop).toBe(parkedDown);

      // Re-follow via pill, then PageUp from a mid offset.
      fireEvent.click(screen.getByRole("button", { name: "Scroll to end" }));
      await settleLegendList();
      const endAgain = getScrollNode().scrollTop;
      getScrollNode().scrollTop = Math.max(0, endAgain - 100);
      fireEvent.scroll(getScrollNode());

      const beforeUp = getScrollNode().scrollTop;
      act(() => {
        dispatchKeyInScope("PageUp");
      });
      fireEvent.scroll(getScrollNode());
      const afterUp = getScrollNode().scrollTop;
      expect(afterUp).toBeLessThan(beforeUp);

      // Free after PageUp: park and stream must not move.
      getScrollNode().scrollTop = 50;
      fireEvent.scroll(getScrollNode());
      const parkedUp = getScrollNode().scrollTop;
      next = appendAssistant(next, "page-up-stream", 120_000);
      rerenderMessages(next);
      await settleLegendList();
      expect(getScrollNode().scrollTop).toBe(parkedUp);
    });

    it("does not claim keys when the tile is inactive and the target is outside the scope", async () => {
      const messages = makeTranscript(12);
      renderChatMessages({
        messages,
        scrollStateKey: "kbd-inactive",
        tileActive: false,
      });
      await settleLegendList();

      const outside = document.createElement("button");
      document.body.appendChild(outside);
      const before = getScrollNode().scrollTop;

      act(() => {
        outside.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "ArrowDown",
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      expect(getScrollNode().scrollTop).toBe(before);
      outside.remove();
    });

    it("claims keys from a sibling in the same canvas pane when the tile is active", async () => {
      const messages = makeTranscript(16);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "kbd-sibling",
        withSiblingChrome: true,
        tileActive: true,
      });
      await settleLegendList();

      const sibling = screen.getByTestId("pane-sibling-chrome");
      act(() => {
        sibling.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "ArrowDown",
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      // Claimed: cancel free-scrolling. Park and prove stream does not follow.
      getScrollNode().scrollTop = 50;
      fireEvent.scroll(getScrollNode());
      const parked = getScrollNode().scrollTop;

      rerenderMessages(appendAssistant(messages, "sibling-stream", 130_000));
      await settleLegendList();
      expect(getScrollNode().scrollTop).toBe(parked);
    });

    it("ticket 21 slice 4: claims keys from a pane sibling even when the tile itself is hosted (no physical data-group-id ancestor)", async () => {
      const messages = makeTranscript(16);
      renderChatMessages({
        messages,
        scrollStateKey: "kbd-hosted-sibling",
        withSiblingChrome: true,
        tileActive: true,
        hostedPaneId: "pane-hosted-1",
      });
      await settleLegendList();

      const sibling = screen.getByTestId("pane-sibling-chrome");
      const event = new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        sibling.dispatchEvent(event);
      });
      // `handleKeyDownCapture` synchronously `preventDefault`s only when it
      // claims the key (`chat-messages.tsx`) - the direct, gesture-heuristic-
      // free signal that the hosted-record pane-id fallback matched.
      expect(event.defaultPrevented).toBe(true);
    });

    it("ticket 21 slice 4: does NOT claim keys from an unrelated pane's chrome when the tile is hosted", async () => {
      const messages = makeTranscript(16);
      renderChatMessages({
        messages,
        scrollStateKey: "kbd-hosted-unrelated",
        tileActive: true,
        hostedPaneId: "pane-hosted-1",
      });
      await settleLegendList();

      const unrelated = document.createElement("div");
      unrelated.setAttribute("data-group-id", "pane-hosted-2");
      document.body.appendChild(unrelated);

      const event = new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        unrelated.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(false);
      unrelated.remove();
    });

    it("on macOS, plain Home is claimed even from an editable target", async () => {
      platformMock.isMac = true;
      const messages = makeTranscript(20);
      renderChatMessages({ messages, scrollStateKey: "kbd-mac-home" });
      await settleLegendList();

      const textarea = document.createElement("textarea");
      document
        .querySelector("[data-chat-keyboard-scroll-scope]")
        ?.appendChild(textarea);

      expect(getScrollNode().scrollTop).toBeGreaterThan(0);
      act(() => {
        textarea.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Home",
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      fireEvent.scroll(getScrollNode());
      await waitFor(() => {
        expect(getScrollNode().scrollTop).toBe(0);
      });
    });

    it("on non-mac, plain Home is NOT claimed from an editable target", async () => {
      platformMock.isMac = false;
      const messages = makeTranscript(20);
      renderChatMessages({ messages, scrollStateKey: "kbd-win-home" });
      await settleLegendList();

      const textarea = document.createElement("textarea");
      document
        .querySelector("[data-chat-keyboard-scroll-scope]")
        ?.appendChild(textarea);

      const before = getScrollNode().scrollTop;
      expect(before).toBeGreaterThan(0);
      act(() => {
        textarea.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Home",
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      // Editable keeps Home on non-mac; scroller stays put.
      expect(getScrollNode().scrollTop).toBe(before);
    });
  });
});
