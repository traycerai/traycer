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
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { type ReactElement, StrictMode, useCallback } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type StoreApi } from "zustand/vanilla";
import { ChatMessages } from "@/components/chat/chat-messages";
import {
  acceptExhaustedPersistedRestoreFallback,
  type ChatAnchorDriftRepairOutcome,
} from "@/components/chat/chat-messages-scroll-helpers";
import {
  captureChatFreeScrollingOffset,
  CHAT_LIST_ANCHOR_OFFSET,
} from "@/components/chat/chat-scroll-anchoring";
import {
  evictChatTabState,
  evictChatTabStateForChat,
  hasSavedChatTabState,
  peekSavedChatTabState,
  restoreChatTabState,
  saveChatTabState,
} from "@/stores/chats/chat-tab-state-cache";
import { type ChatTabPersistenceIdentity } from "@/stores/chats/chat-tab-persistence-key";
import { flushChatTabViewportHandoff } from "@/stores/chats/chat-tab-viewport-handoff";
import { evictChatTabPersistenceForEpic } from "@/stores/chats/chat-tab-persistence-eviction";
import { getOrCreateActivityGroupOpenStore } from "@/stores/chats/activity-group-open-store-core";
import { type ActivityGroupOpenState } from "@/stores/chats/activity-group-open-store-context";
import { getOrCreateA2AOpenStore } from "@/stores/chats/a2a-open-store-context";
import { useToolOpenStore } from "@/stores/chats/tool-open-store";
import { useSubagentOpenStore } from "@/stores/chats/subagent-open-store";
import { scopedChatOpenId } from "@/stores/chats/open-store-scope";
import { type ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import {
  setLegendListMessageRowHeightOverrides,
  setLegendListScrollContainerScrollHeightOverride,
  settleLegendList,
} from "./legend-list-test-environment";
import { legendListRefHolder, tileLiveness } from "./chat-messages-suite-refs";
import {
  appendOptimisticUserSend,
  appendStreamingAssistantChunks,
  enterFreeScrollingAwayFromEnd,
  fireScrollToEnd,
  fireScrollTopAndFlush,
  fireScrollTopWithoutFlush,
  getScrollNode,
  isJumpPillVisible,
  LEGEND_LIST_HEADER_PX,
  makeA2AOnlyCompletedTranscript,
  makeCompletedTranscript,
  makeDefaultTestIdentity,
  makeTestIdentity,
  makeTranscript,
  registerChatMessagesSuiteHooks,
  renderChatMessages,
  selectLastChatTurnMinimapItem,
  TICKET_13_ROW_HEIGHT_PX,
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

  describe("ticket 5: per-tab persistence across whole-tile remounts", () => {
    afterEach(() => {
      useToolOpenStore.setState({ openIds: new Set() });
      useSubagentOpenStore.setState({ openIds: new Set() });
    });

    it(
      "restores the exact free-scrolling pixel position across unmount+remount " +
        "(round-trip through real capture, not a seeded value)",
      async () => {
        const messages = makeCompletedTranscript(20);
        const scrollStateKey = `t5-free-restore-${Math.random().toString(36).slice(2)}`;
        const instanceId = `t5-free-instance-${Math.random().toString(36).slice(2)}`;

        tileLiveness.live = true;
        const first = renderChatMessages({
          messages,
          scrollStateKey,
          instanceId,
        });
        await settleLegendList();

        // A real gesture first, to leave the default following-end seed -
        // a bare scrollTop write alone is read as transient settling while
        // still following-end (onIsAtEndChange's own "WE own the scroll"
        // guard), not a departure.
        act(() => {
          enterFreeScrollingAwayFromEnd();
        });
        // Then a single, deterministic scroll write (the same mechanism many
        // existing tests in this file already use) to a KNOWN position -
        // deliberately NOT a multi-frame settle window, which would let
        // LegendList's own virtualization keep adjusting scroll afterward and
        // make "the exact position at unmount" a moving target rather than a
        // controlled one.
        await fireScrollTopAndFlush(360);
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

        const originalScrollTop = getScrollNode().scrollTop;
        expect(originalScrollTop).toBe(360);

        first.unmount();

        // The unmount save captured THIS exact scrollTop via the real
        // capture pipeline (whichever row it anchored to) - not a value this
        // test invented via a seeded saveChatTabState call. Tab-key is the
        // tile instanceId (ticket 15).
        const saved = restoreChatTabState(
          makeDefaultTestIdentity(instanceId),
          messages,
        );
        expect(saved.mode).toBe("free-scrolling");
        expect(saved.anchorMessageId).not.toBeNull();
        // Capture folds topOffsetAdjustment (header) into the saved viewOffset
        // so it matches LegendList's restore math (decision #18 exact pixels).
        expect(typeof saved.offset).toBe("number");
        expect(saved.offset).not.toBe(0);

        const second = renderChatMessages({
          messages,
          scrollStateKey,
          instanceId,
        });
        await settleLegendList();
        await settleLegendList();

        // Exact-position contract: restored geometry equals the pre-unmount
        // scrollTop. Without initialScrollIndex wiring this parks at 0; without
        // the header pad in capture it lands original+header instead.
        expect(getScrollNode().scrollTop).toBe(originalScrollTop);
        // F1: programmatic bootstrap must not flip free-scrolling to following.
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
        expect(getScrollNode().dataset.scrollMode).not.toBe("following-end");

        second.unmount();
      },
    );

    it("anchors a variable-height reading position to the actual assistant row", async () => {
      const messages = makeCompletedTranscript(12);
      const tallAssistantId = messages[1].id;
      setLegendListMessageRowHeightOverrides(new Map([[tallAssistantId, 900]]));
      setLegendListScrollContainerScrollHeightOverride(2_000);

      const instanceId = `t5-tall-assistant-${Math.random().toString(36).slice(2)}`;
      tileLiveness.live = true;
      const first = renderChatMessages({
        messages,
        scrollStateKey: instanceId,
        instanceId,
      });
      await settleLegendList();

      act(() => enterFreeScrollingAwayFromEnd());
      // Header (40) + first row (90) + 300px into the tall assistant.
      await fireScrollTopAndFlush(430);
      expect(getScrollNode().scrollTop).toBe(430);

      first.unmount();

      const saved = restoreChatTabState(
        makeDefaultTestIdentity(instanceId),
        messages,
      );
      expect(saved.anchorMessageId).toBe(tallAssistantId);
      expect(saved.anchorIndex).toBe(1);
      expect(saved.offset).toBe(-300);

      const second = renderChatMessages({
        messages,
        scrollStateKey: instanceId,
        instanceId,
      });
      await settleLegendList();
      await settleLegendList();

      expect(getScrollNode().scrollTop).toBe(430);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      second.unmount();
    });

    it("captures inline-navigation source positions synchronously and replaces stale captures", async () => {
      const messages = makeCompletedTranscript(24);
      const instanceId = `t5-inline-source-${Math.random().toString(36).slice(2)}`;
      tileLiveness.live = true;
      const view = renderChatMessages({
        messages,
        scrollStateKey: instanceId,
        instanceId,
      });
      await settleLegendList();

      act(() => enterFreeScrollingAwayFromEnd());
      await fireScrollTopAndFlush(360);
      fireEvent.pointerDown(screen.getByTestId("chat-transcript-container"));

      const firstCapture = restoreChatTabState(
        makeDefaultTestIdentity(instanceId),
        messages,
      );
      expect(firstCapture.mode).toBe("free-scrolling");
      expect(firstCapture.anchorMessageId).not.toBeNull();

      await fireScrollTopAndFlush(720);
      fireEvent.pointerDown(screen.getByTestId("chat-transcript-container"));

      const secondCapture = restoreChatTabState(
        makeDefaultTestIdentity(instanceId),
        messages,
      );
      expect(secondCapture.mode).toBe("free-scrolling");
      expect(secondCapture.anchorMessageId).not.toBe(
        firstCapture.anchorMessageId,
      );
      expect(secondCapture.anchorIndex).toBeGreaterThan(
        firstCapture.anchorIndex ?? -1,
      );
      view.unmount();
    });

    it("corrects a restored landing with an absolute measured offset when index restoration is a no-op", async () => {
      const messages = makeCompletedTranscript(20);
      const targetIndex = 8;
      const targetId = messages[targetIndex].id;
      const instanceId = `t5-validated-restore-${Math.random().toString(36).slice(2)}`;
      const identity = makeDefaultTestIdentity(instanceId);
      saveChatTabState({
        identity,
        mode: "free-scrolling",
        anchorMessageId: targetId,
        anchorIndex: targetIndex,
        offset: -12,
      });

      tileLiveness.live = true;
      const view = renderChatMessages({
        messages,
        scrollStateKey: instanceId,
        instanceId,
      });
      const list = legendListRefHolder.current;
      expect(list).not.toBeNull();
      if (list === null) throw new Error("LegendList ref did not mount");
      const scrollNode = getScrollNode();
      scrollNode.scrollTop = 0;
      const indexRestore = vi
        .spyOn(list, "scrollToIndex")
        .mockResolvedValue(undefined);
      const absoluteRestore = vi.spyOn(list, "scrollToOffset");

      await settleLegendList();
      await settleLegendList();

      const expectedScrollTop = LEGEND_LIST_HEADER_PX + targetIndex * 90 + 12;
      expect(indexRestore).not.toHaveBeenCalled();
      expect(absoluteRestore).toHaveBeenCalledWith({
        offset: expectedScrollTop,
        animated: false,
      });
      expect(getScrollNode().scrollTop).toBe(expectedScrollTop);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      view.unmount();
    });

    it("restores the validated reading anchor without waiting for a deleted reply reserve after streaming ends", async () => {
      const messages = makeCompletedTranscript(20);
      const targetIndex = 8;
      const targetId = messages[targetIndex].id;
      const instanceId = `t5-deleted-reserve-restore-${Math.random().toString(36).slice(2)}`;
      const identity = makeDefaultTestIdentity(instanceId);
      saveChatTabState({
        identity,
        mode: "free-scrolling",
        anchorMessageId: targetId,
        anchorIndex: targetIndex,
        offset: -12,
        replyReserveMessageId: "deleted-reply-reserve",
      });

      tileLiveness.live = true;
      const view = renderChatMessages({
        messages,
        scrollStateKey: instanceId,
        instanceId,
        isChatStreaming: true,
      });
      const list = legendListRefHolder.current;
      if (list === null) throw new Error("LegendList ref did not mount");
      getScrollNode().scrollTop = 0;
      vi.spyOn(list, "scrollToIndex").mockResolvedValue(undefined);
      const absoluteRestore = vi.spyOn(list, "scrollToOffset");

      await settleLegendList();
      await settleLegendList();

      expect(absoluteRestore).not.toHaveBeenCalled();

      view.rerenderWith({ isChatStreaming: false });
      await settleLegendList();
      await settleLegendList();

      const expectedScrollTop = LEGEND_LIST_HEADER_PX + targetIndex * 90 + 12;
      expect(absoluteRestore).toHaveBeenCalledWith({
        offset: expectedScrollTop,
        animated: false,
      });
      expect(getScrollNode().scrollTop).toBe(expectedScrollTop);
      expect(getScrollNode().dataset.replyReserveMessageId).toBe("");
      view.unmount();
    });

    it("retains a validated detached reply reserve after streaming ends", async () => {
      const messages = makeCompletedTranscript(20);
      const anchorIndex = 1;
      const reserveIndex = 18;
      const instanceId = `t5-completed-valid-reserve-${Math.random().toString(36).slice(2)}`;
      saveChatTabState({
        identity: makeDefaultTestIdentity(instanceId),
        mode: "free-scrolling",
        anchorMessageId: messages[anchorIndex].id,
        anchorIndex,
        offset: -300,
        replyReserveMessageId: messages[reserveIndex].id,
      });

      const view = renderChatMessages({
        messages,
        scrollStateKey: instanceId,
        instanceId,
        isChatStreaming: false,
      });
      await settleLegendList();
      await settleLegendList();

      expect(getScrollNode().dataset.replyReserveMessageId).toBe(
        messages[reserveIndex].id,
      );
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      view.unmount();
    });

    it("keeps the pre-restore snapshot authoritative when a bootstrap mount unmounts before convergence", () => {
      const messages = makeCompletedTranscript(20);
      const anchorIndex = 8;
      const reserveIndex = 18;
      const instanceId = `t5-bootstrap-unmount-${Math.random().toString(36).slice(2)}`;
      const identity = makeDefaultTestIdentity(instanceId);
      const expected = {
        mode: "free-scrolling" as const,
        anchorMessageId: messages[anchorIndex].id,
        anchorIndex,
        offset: -1_185,
        replyReserveMessageId: messages[reserveIndex].id,
      };
      saveChatTabState({ identity, ...expected });

      tileLiveness.live = true;
      const bootstrap = renderChatMessages({
        messages,
        scrollStateKey: instanceId,
        instanceId,
        isChatStreaming: true,
      });

      // Strict Mode and rapid canvas switches can destroy this mount before
      // the reserve and measured-row convergence complete. Its transient DOM
      // geometry is not a reader decision and must not become last-writer-wins.
      bootstrap.unmount();

      expect(restoreChatTabState(identity, messages)).toEqual(expected);
    });

    it("publishes an explicit wheel detachment even when no follow-up scroll event fires before unmount", async () => {
      const messages = makeCompletedTranscript(20);
      const anchorIndex = 18;
      const instanceId = `t5-bootstrap-reader-detach-${Math.random().toString(36).slice(2)}`;
      const identity = makeDefaultTestIdentity(instanceId);
      saveChatTabState({
        identity,
        mode: "anchoring-new-turn",
        anchorMessageId: messages[anchorIndex].id,
        anchorIndex,
        offset: 0,
      });

      tileLiveness.live = true;
      const bootstrap = renderChatMessages({
        messages,
        scrollStateKey: instanceId,
        instanceId,
        isChatStreaming: true,
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      // The scroll node can appear one frame after the component's layout
      // effect; wait only for its passive wheel listener, not anchor settle.
      await act(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          }),
      );
      fireEvent.wheel(getScrollNode(), { deltaY: -0.1 });
      getScrollNode().scrollTop = 360;
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      bootstrap.unmount();

      const saved = restoreChatTabState(identity, messages);
      expect(saved.mode).toBe("free-scrolling");
      expect(saved.anchorMessageId).not.toBeNull();
      expect(saved.anchorIndex).not.toBeNull();
    });

    it("treats Strict Mode initial-index placement as a bootstrap and converges from measured reserve geometry", async () => {
      const messages = makeCompletedTranscript(20);
      const anchorIndex = 1;
      const reserveIndex = 18;
      const instanceId = `t5-strict-measured-restore-${Math.random().toString(36).slice(2)}`;
      const identity = makeDefaultTestIdentity(instanceId);
      setLegendListMessageRowHeightOverrides(
        new Map([[messages[anchorIndex].id, 6_049]]),
      );
      saveChatTabState({
        identity,
        mode: "free-scrolling",
        anchorMessageId: messages[anchorIndex].id,
        anchorIndex,
        offset: -300,
        replyReserveMessageId: messages[reserveIndex].id,
      });

      tileLiveness.live = true;
      const view = renderChatMessages({
        messages,
        scrollStateKey: instanceId,
        instanceId,
        isChatStreaming: true,
        strictMode: true,
      });
      await settleLegendList();
      await settleLegendList();

      const expectedScrollTop = LEGEND_LIST_HEADER_PX + 90 + 300;
      expect(getScrollNode().scrollTop).toBe(expectedScrollTop);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      view.unmount();
      expect(restoreChatTabState(identity, messages)).toEqual({
        mode: "free-scrolling",
        anchorMessageId: messages[anchorIndex].id,
        anchorIndex,
        offset: -300,
        replyReserveMessageId: messages[reserveIndex].id,
      });
    });

    it("captures the live DOM offset when an animated navigation has not settled before unmount", async () => {
      const messages = makeCompletedTranscript(30);
      const targetIndex = 10;
      const targetId = messages[targetIndex]?.id;
      expect(targetId).toBeTruthy();
      const scrollStateKey = `t5-live-dom-capture-${Math.random().toString(36).slice(2)}`;
      const instanceId = `t5-live-dom-instance-${Math.random().toString(36).slice(2)}`;

      tileLiveness.live = true;
      const first = renderChatMessages({
        messages,
        scrollStateKey,
        instanceId,
      });
      await settleLegendList();

      first.rerenderWith({
        scrollRequest: {
          requestId: 5_001,
          messageId: targetId,
          blockId: null,
        },
      });
      const liveScrollTop = getScrollNode().scrollTop;
      expect(liveScrollTop).toBeGreaterThan(0);

      // Unmount before scrollend/the fallback can reconcile LegendList's
      // tracked scroll. The DOM is already at the visible navigation landing,
      // so persistence must capture that live position rather than the
      // controller's previous internal value.
      first.unmount();

      const second = renderChatMessages({
        messages,
        scrollStateKey,
        instanceId,
      });
      await settleLegendList();
      await settleLegendList();

      expect(getScrollNode().scrollTop).toBe(liveScrollTop);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      second.unmount();
    });

    it(
      "P4 review fix: an A2A-only transcript (zero human user rows) still " +
        "persists and restores an exact free-scroll anchor",
      async () => {
        // Root cause: selectActiveUserMessageId/viewportActiveUserMessageId
        // are human-only gated (isHumanUserMessage) - correct for the
        // minimap rail, but the ticket-5 save path shares the same gate, so
        // a transcript with ZERO human user rows (pure agent-to-agent child
        // chat) never had a candidate to track, freezing the saved anchor at
        // whatever it was on mount instead of the reader's actual position.
        const messages = makeA2AOnlyCompletedTranscript(20);
        expect(
          messages.some(
            (message) =>
              message.role === "user" && message.agentSenderInfo === null,
          ),
        ).toBe(false);
        const scrollStateKey = `t5-p4-a2a-only-${Math.random().toString(36).slice(2)}`;
        const instanceId = `t5-p4-a2a-instance-${Math.random().toString(36).slice(2)}`;

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

        // Red-on-baseline: before the fix, `anchorMessageId` is `null` here
        // (the human-only gate never resolved a candidate for this
        // transcript shape) and the position is lost.
        const saved = restoreChatTabState(
          makeDefaultTestIdentity(instanceId),
          messages,
        );
        expect(saved.mode).toBe("free-scrolling");
        expect(saved.anchorMessageId).not.toBeNull();
        expect(typeof saved.offset).toBe("number");
        expect(saved.offset).not.toBe(0);

        const second = renderChatMessages({
          messages,
          scrollStateKey,
          instanceId,
        });
        await settleLegendList();
        await settleLegendList();

        expect(getScrollNode().scrollTop).toBe(originalScrollTop);
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

        second.unmount();
      },
    );

    it("F1: a restored free-scrolling position landing near the tail does not flip to following-end", async () => {
      const messages = makeCompletedTranscript(20);
      const anchorId = messages[4]?.id;
      expect(anchorId).toBeTruthy();
      const scrollStateKey = `t5-f1-nearend-${Math.random().toString(36).slice(2)}`;

      // Valid mid-list free restore so LegendList's initialScrollIndex bootstrap
      // actually converges (the old huge-negative near-end offset aborted
      // bootstrap - pin stayed green under the F1 suppress-seed mutation).
      // F1 is the suppressFollowRestoreRef seed for that bootstrap: same class
      // as ticket 3 H3. After bootstrap arms suppression, a subsequent
      // programmatic near-end landing must NOT flip to following-end.
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

      // Programmatic near-end landing (no wheel/pointerdown/touch - not a
      // real gesture, so suppression stays armed). Without F1's seed this
      // report would re-pin following-end.
      act(() => {
        fireScrollToEnd();
      });
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().dataset.scrollMode).not.toBe("following-end");
    });

    it("restores a just-sent turn's semantic anchor and reply reserve after a tab-switch remount", async () => {
      const messages = makeCompletedTranscript(16);
      const sendId = "t5-mid-anchor-send";
      const scrollStateKey = `t5-mid-anchor-${Math.random().toString(36).slice(2)}`;
      const instanceId = `t5-mid-anchor-inst-${Math.random().toString(36).slice(2)}`;
      const composerOverlayHeight = 80;

      tileLiveness.live = true;
      const first = renderChatMessages({
        messages,
        scrollStateKey,
        instanceId,
        localProvenanceMessageIds: new Set([sendId]),
        composerOverlayHeight,
        isChatStreaming: true,
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();

      const afterSend = appendOptimisticUserSend(messages, sendId, 777_000);
      first.rerenderMessages(afterSend);
      await settleLegendList();
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      // `scroll-yank-tab-switch.mov`: switch tabs immediately after the send,
      // while the anchor operation is still allowed to be in flight.
      first.unmount();

      const saved = restoreChatTabState(
        makeDefaultTestIdentity(instanceId),
        afterSend,
      );
      expect(saved.mode).toBe("anchoring-new-turn");
      expect(saved.anchorMessageId).toBe(sendId);

      const second = renderChatMessages({
        messages: afterSend,
        scrollStateKey,
        instanceId,
        composerOverlayHeight,
        isChatStreaming: true,
        // Provenance was already consumed before the switch. Restoration must
        // come from the saved semantic session, not reclassification as a new
        // local send.
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await waitForAnchorEngineSettle();

      const list = legendListRefHolder.current;
      if (list === null) throw new Error("Expected an attached LegendList");
      const sendIndex = afterSend.length - 1;
      const restoredQueryTop =
        list.getState().positionAtIndex(sendIndex) +
        LEGEND_LIST_HEADER_PX -
        getScrollNode().scrollTop;
      expect(
        Math.abs(restoredQueryTop - CHAT_LIST_ANCHOR_OFFSET),
      ).toBeLessThanOrEqual(1);

      // First streamed reply content consumes the already-reserved space. It
      // must not turn the remount into a free-scroll resize/yank.
      const scrollBeforeReply = getScrollNode().scrollTop;
      const withReply = appendStreamingAssistantChunks(afterSend, 2, 778_000);
      second.rerenderMessages(withReply);
      await settleLegendList();
      await waitForRevealPassTick();

      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(getScrollNode().scrollTop).toBe(scrollBeforeReply);

      second.unmount();
    });

    it("preserves a detached streaming viewport and its reply reserve across repeated tab switches", async () => {
      const history = makeCompletedTranscript(12);
      const sendId = "t5-detached-reserve-send";
      const instanceId = `t5-detached-reserve-${Math.random().toString(36).slice(2)}`;
      const afterSend = appendOptimisticUserSend(history, sendId, 780_000);
      const streaming = appendStreamingAssistantChunks(afterSend, 2, 781_000);

      tileLiveness.live = true;
      const first = renderChatMessages({
        messages: history,
        instanceId,
        scrollStateKey: instanceId,
        localProvenanceMessageIds: new Set([sendId]),
        isChatStreaming: true,
      });
      await settleLegendList();

      first.rerenderMessages(afterSend);
      await waitForAnchorEngineSettle();
      first.rerenderMessages(streaming);
      await settleLegendList();

      const anchoredScrollTop = getScrollNode().scrollTop;
      fireEvent.wheel(getScrollNode(), { deltaY: -0.1 });
      await fireScrollTopAndFlush(Math.max(0, anchoredScrollTop - 0.25));
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      const readingScrollTop = getScrollNode().scrollTop;
      first.unmount();

      const saved = restoreChatTabState(
        makeDefaultTestIdentity(instanceId),
        streaming,
      );
      // Scroll ownership and reply-space geometry have independent lifetimes.
      // A detached reader must persist both, rather than clamping the viewport
      // into no-reserve geometry and losing another line on every remount.
      expect(saved).toHaveProperty("replyReserveMessageId", sendId);

      const grownStreaming = appendStreamingAssistantChunks(
        afterSend,
        3,
        781_000,
      );
      const second = renderChatMessages({
        messages: grownStreaming,
        instanceId,
        scrollStateKey: instanceId,
        isChatStreaming: true,
      });
      await settleLegendList();
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().dataset.replyReserveMessageId).toBe(sendId);
      expect(getScrollNode().scrollTop).toBe(readingScrollTop);

      second.unmount();
      const third = renderChatMessages({
        messages: grownStreaming,
        instanceId,
        scrollStateKey: instanceId,
        isChatStreaming: true,
      });
      await settleLegendList();
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().dataset.replyReserveMessageId).toBe(sendId);
      expect(getScrollNode().scrollTop).toBe(readingScrollTop);
      third.unmount();
    });

    it("resumes a saved new-turn anchor when hydration delivers its query after mount", async () => {
      const history = makeCompletedTranscript(12);
      const sendId = "t5-delayed-anchor-send";
      const afterSend = appendOptimisticUserSend(history, sendId, 779_000);
      const scrollStateKey = `t5-delayed-anchor-${Math.random().toString(36).slice(2)}`;
      const identity = makeDefaultTestIdentity(scrollStateKey);

      saveChatTabState({
        identity,
        mode: "anchoring-new-turn",
        anchorMessageId: sendId,
        anchorIndex: afterSend.length - 1,
        offset: 0,
      });

      // The tab can remount from a partial snapshot before the just-sent row
      // is hydrated. Its temporary nearest-neighbor landing must be passive;
      // once the original semantic id arrives, restore the anchor session
      // instead of treating the query as an unrelated append.
      const view = renderChatMessages({
        messages: history,
        scrollStateKey,
        isChatStreaming: true,
      });
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      view.rerenderMessages(afterSend);
      await waitFor(() => {
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      });
      await waitForAnchorEngineSettle();

      const list = legendListRefHolder.current;
      if (list === null) throw new Error("Expected an attached LegendList");
      const queryTop =
        list.getState().positionAtIndex(afterSend.length - 1) +
        LEGEND_LIST_HEADER_PX -
        getScrollNode().scrollTop;
      expect(Math.abs(queryTop - CHAT_LIST_ANCHOR_OFFSET)).toBeLessThanOrEqual(
        1,
      );
    });

    it("recreates a detached reply reserve delivered after a partial hydration mount before replaying the raw viewport", async () => {
      const messages = makeCompletedTranscript(10);
      const partial = messages.slice(0, 4);
      const viewportAnchorId = messages[1]?.id;
      const reserveMessageId = messages[8]?.id;
      expect(viewportAnchorId).toBeTruthy();
      expect(reserveMessageId).toBeTruthy();
      const instanceId = `t5-delayed-detached-reserve-${Math.random().toString(36).slice(2)}`;

      saveChatTabState({
        identity: makeDefaultTestIdentity(instanceId),
        mode: "free-scrolling",
        anchorMessageId: viewportAnchorId,
        anchorIndex: 1,
        offset: -24,
        replyReserveMessageId: reserveMessageId,
      });

      const view = renderChatMessages({
        messages: partial,
        instanceId,
        scrollStateKey: instanceId,
        isChatStreaming: true,
      });
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().dataset.replyReserveMessageId).toBe("");

      view.rerenderMessages(messages);
      await settleLegendList();
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().dataset.replyReserveMessageId).toBe(
        reserveMessageId,
      );
      // position(1)=90, header=40, viewOffset=-24 => scrollTop=154.
      expect(getScrollNode().scrollTop).toBe(154);
      view.unmount();
    });

    it("falls back cleanly when the saved anchor message is gone on remount", async () => {
      const messages = makeCompletedTranscript(12);
      const scrollStateKey = `t5-stale-free-${Math.random().toString(36).slice(2)}`;

      // Legacy save without anchorIndex (pre-ticket-15 shape): when the id is
      // gone AND no index was recorded, still degrade to null-anchor rather
      // than inventing a neighbor. Ticket 15's nearest-neighbor pin covers
      // the anchorIndex path separately.
      saveChatTabState({
        identity: makeDefaultTestIdentity(scrollStateKey),
        mode: "free-scrolling",
        anchorMessageId: "message-removed-while-away",
        anchorIndex: null,
        offset: 64,
      });

      // restoreChatTabState keeps mode, drops the stale anchor.
      expect(
        restoreChatTabState(makeDefaultTestIdentity(scrollStateKey), messages),
      ).toEqual({
        mode: "free-scrolling",
        anchorMessageId: null,
        anchorIndex: null,
        offset: 0,
        replyReserveMessageId: null,
      });

      renderChatMessages({ messages, scrollStateKey });
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      await waitForPillVisible();

      // following-end + stale anchor: mode preserved, no crash.
      const followKey = `t5-stale-follow-${Math.random().toString(36).slice(2)}`;
      saveChatTabState({
        identity: makeDefaultTestIdentity(followKey),
        mode: "following-end",
        anchorMessageId: "also-gone",
        anchorIndex: null,
        offset: 12,
      });
      expect(
        restoreChatTabState(makeDefaultTestIdentity(followKey), messages),
      ).toEqual({
        mode: "following-end",
        anchorMessageId: null,
        anchorIndex: null,
        offset: 0,
        replyReserveMessageId: null,
      });

      cleanup();
      renderChatMessages({ messages, scrollStateKey: followKey });
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      expect(isJumpPillVisible()).toBe(false);
    });

    it("commits the closing position to durable but never resurrects the tab-key entry (ticket 15 review F1)", async () => {
      const messages = makeCompletedTranscript(16);
      // Single key: production tab-key is instanceId; keep them aligned so
      // the canvas-style tab eviction targets the real entry.
      const instanceId = `t5-liveness-inst-${Math.random().toString(36).slice(2)}`;
      const identity = makeDefaultTestIdentity(instanceId);

      tileLiveness.live = true;
      const { unmount } = renderChatMessages({
        messages,
        instanceId,
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();

      // Production order (ticket 15 review F1): the canvas sweep drops the
      // TAB-key entry and flips liveness false SYNCHRONOUSLY, before this
      // component's own unmount cleanup ever runs.
      evictChatTabState([instanceId]);
      tileLiveness.live = false;

      unmount();

      // The non-live unmount commits the CURRENT free-scrolling position to
      // the DURABLE chat-key entry - that is the fix: a genuine close is the
      // only chance this view's final position ever reaches durable at all
      // (a liveness guard that fully skips saving on close was the original
      // bug - it left reopens with either nothing, or a stale earlier
      // durable entry).
      expect(restoreChatTabState(identity, messages).mode).toBe(
        "free-scrolling",
      );

      // What the guard must still prevent: resurrecting the TAB-key entry.
      // Proof: dropping ONLY the durable entry must make the saved state
      // disappear entirely - if the tab-key had been resurrected underneath,
      // `hasSavedChatTabState` would still read true here.
      evictChatTabStateForChat({
        epicId: identity.epicId,
        chatId: identity.chatId,
      });
      expect(hasSavedChatTabState(identity)).toBe(false);
    });

    it("keeps tool, subagent, and activity-group open state across unmount+remount with the same instanceId", async () => {
      const messages = makeCompletedTranscript(8);
      const scrollStateKey = `t5-open-survives-${Math.random().toString(36).slice(2)}`;
      const instanceId = `t5-open-inst-${Math.random().toString(36).slice(2)}`;
      const toolSegmentId = "tool-seg-1";
      const subagentSegmentId = "subagent-seg-1";
      const activityGroupId = "activity-group-1";
      const a2aSentId = "a2a-sent-1";

      tileLiveness.live = true;
      const first = renderChatMessages({
        messages,
        scrollStateKey,
        instanceId,
      });
      await settleLegendList();

      act(() => {
        useToolOpenStore.getState().setOpen(instanceId, toolSegmentId, true);
        useSubagentOpenStore
          .getState()
          .setOpen(instanceId, subagentSegmentId, true);
        getOrCreateActivityGroupOpenStore(makeDefaultTestIdentity(instanceId))
          .getState()
          .setOpen(activityGroupId, true);
        getOrCreateA2AOpenStore(makeDefaultTestIdentity(instanceId))
          .getState()
          .setSentOpen(a2aSentId, true);
      });

      expect(
        useToolOpenStore
          .getState()
          .openIds.has(scopedChatOpenId(instanceId, toolSegmentId)),
      ).toBe(true);
      expect(
        useSubagentOpenStore
          .getState()
          .openIds.has(scopedChatOpenId(instanceId, subagentSegmentId)),
      ).toBe(true);
      expect(
        getOrCreateActivityGroupOpenStore(makeDefaultTestIdentity(instanceId))
          .getState()
          .openIds.has(activityGroupId),
      ).toBe(true);
      expect(
        getOrCreateA2AOpenStore(makeDefaultTestIdentity(instanceId))
          .getState()
          .sentOpenIds.has(a2aSentId),
      ).toBe(true);

      first.unmount();

      // Remount reuses the same instanceId - open state must not reset.
      const second = renderChatMessages({
        messages,
        scrollStateKey,
        instanceId,
      });
      await settleLegendList();

      expect(
        useToolOpenStore
          .getState()
          .openIds.has(scopedChatOpenId(instanceId, toolSegmentId)),
      ).toBe(true);
      expect(
        useSubagentOpenStore
          .getState()
          .openIds.has(scopedChatOpenId(instanceId, subagentSegmentId)),
      ).toBe(true);
      expect(
        getOrCreateActivityGroupOpenStore(makeDefaultTestIdentity(instanceId))
          .getState()
          .openIds.has(activityGroupId),
      ).toBe(true);
      expect(
        getOrCreateA2AOpenStore(makeDefaultTestIdentity(instanceId))
          .getState()
          .sentOpenIds.has(a2aSentId),
      ).toBe(true);
      // Registry identity: remount must reattach the same store instance.
      const activityStoreA = getOrCreateActivityGroupOpenStore(
        makeDefaultTestIdentity(instanceId),
      );
      second.unmount();
      const third = renderChatMessages({
        messages,
        scrollStateKey,
        instanceId,
      });
      expect(
        getOrCreateActivityGroupOpenStore(makeDefaultTestIdentity(instanceId)),
      ).toBe(activityStoreA);
      third.unmount();
    });

    describe("free-scrolling coordinate capture", () => {
      function mockMeasurementSource(
        positionAtIndex: (index: number) => number,
        scroll: number,
        topOffsetAdjustment: number | undefined,
      ) {
        return {
          getState: () => ({
            positionAtIndex,
            scroll,
            ...(topOffsetAdjustment === undefined
              ? {}
              : { topOffsetAdjustment }),
          }),
        };
      }

      it("captures the raw visible offset without rewriting its geometry", () => {
        const list = mockMeasurementSource(() => 500, 2000, undefined);
        expect(captureChatFreeScrollingOffset(list, 3)).toBe(500 - 2000);
      });

      it("folds topOffsetAdjustment into the offset so restore matches LegendList math", () => {
        // position=720, scroll=360, header=40 → viewOffset 400, which
        // round-trips: scroll = position - viewOffset + header = 360.
        const list = mockMeasurementSource(() => 720, 360, 40);
        expect(captureChatFreeScrollingOffset(list, 8)).toBe(720 + 40 - 360);
      });
    });
  });

  describe("ticket 15: dual-key restore + streaming-aware fresh-open", () => {
    afterEach(() => {
      // Dual-key durable entries survive tab-key eviction - clear the epic
      // used by this harness so later suites don't inherit a seed.
      evictChatTabPersistenceForEpic("epic-1");
    });

    it("RESTORE-FIRST: free-scrolling and following-end saved states win over fresh-open policy", async () => {
      const messages = makeCompletedTranscript(16);
      const freeKey = `t15-restore-free-${Math.random().toString(36).slice(2)}`;
      const followKey = `t15-restore-follow-${Math.random().toString(36).slice(2)}`;
      const anchorId = messages[4]?.id ?? null;
      expect(anchorId).toBeTruthy();

      saveChatTabState({
        identity: makeDefaultTestIdentity(freeKey),
        mode: "free-scrolling",
        anchorMessageId: anchorId,
        anchorIndex: 4,
        offset: 24,
      });
      renderChatMessages({ messages, scrollStateKey: freeKey });
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      cleanup();

      saveChatTabState({
        identity: makeDefaultTestIdentity(followKey),
        mode: "following-end",
        anchorMessageId: null,
        anchorIndex: null,
        offset: 0,
      });
      renderChatMessages({ messages, scrollStateKey: followKey });
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      expect(isJumpPillVisible()).toBe(false);
    });

    it("releases both persistence gates when an unreachable saved coordinate exhausts restore retries", () => {
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

    it("streaming fresh-open (no saved state) seeds following-end, not the idle anchor candidate", async () => {
      const messages = makeCompletedTranscript(16);
      const key = `t15-stream-fresh-${Math.random().toString(36).slice(2)}`;
      expect(hasSavedChatTabState(makeDefaultTestIdentity(key))).toBe(false);

      renderChatMessages({
        messages,
        scrollStateKey: key,
        freshOpen: true,
        isChatStreaming: true,
      });
      await settleLegendList();

      // Idle fresh-open would enter anchoring-new-turn on the last user
      // message. Streaming fresh-open skips that scan and stays following-end.
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      expect(getScrollNode().dataset.scrollMode).not.toBe("anchoring-new-turn");
      expect(isJumpPillVisible()).toBe(false);
    });

    it("idle fresh-open still anchors the last user message (ticket-13 path unchanged)", async () => {
      const messages = makeCompletedTranscript(16);
      const key = `t15-idle-fresh-${Math.random().toString(36).slice(2)}`;
      expect(hasSavedChatTabState(makeDefaultTestIdentity(key))).toBe(false);

      renderChatMessages({
        messages,
        scrollStateKey: key,
        freshOpen: true,
        isChatStreaming: false,
      });
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
    });

    it("reopen-after-close restores free-scrolling via the durable chat-key (field symptom)", async () => {
      const messages = makeCompletedTranscript(16);
      const closedInstance = `t15-closed-${Math.random().toString(36).slice(2)}`;
      const reopenedInstance = `t15-reopen-${Math.random().toString(36).slice(2)}`;
      const epicId = "epic-1";
      const taskId = "task-1";
      const closedIdentity = makeTestIdentity(closedInstance, epicId, taskId);
      const reopenedIdentity = makeTestIdentity(
        reopenedInstance,
        epicId,
        taskId,
      );

      tileLiveness.live = true;
      const first = renderChatMessages({
        messages,
        instanceId: closedInstance,
        epicId,
        taskId,
      });
      await settleLegendList();
      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await fireScrollTopAndFlush(360);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // PRODUCTION ORDER (ticket 15 review F1): a real close removes the
      // tile from the canvas and runs the tile-removal sweep (tab-key
      // eviction) SYNCHRONOUSLY, before React ever gets around to unmounting
      // this component - `isEpicCanvasTileInstanceLive` already reads false
      // by the time our own cleanup fires. The earlier version of this pin
      // unmounted BEFORE evicting (the reverse order), which never actually
      // exercised the guard this ticket depends on.
      evictChatTabState([closedInstance]);
      tileLiveness.live = false;
      first.unmount();

      // Same chat, brand-new tileInstanceId - must still restore via durable,
      // which the non-live unmount above just committed (F1's durable-only
      // commit path) - nothing else in this test ever wrote it.
      expect(hasSavedChatTabState(reopenedIdentity)).toBe(true);
      // Ticket 15 review (live pass S5 round 3): a mode-only assertion
      // stayed green through two live failures - a poisoned
      // {anchorMessageId, anchorIndex, offset} triple (a stale anchor row
      // paired with the live scroll offset) still reports `mode:
      // "free-scrolling"`. Assert the full triple is internally coherent -
      // a real, non-null anchor with an index the offset was actually
      // captured relative to.
      const restoredTriple = restoreChatTabState(reopenedIdentity, messages);
      expect(restoredTriple.mode).toBe("free-scrolling");
      expect(restoredTriple.anchorMessageId).not.toBeNull();
      expect(restoredTriple.anchorIndex).not.toBeNull();

      const second = renderChatMessages({
        messages,
        instanceId: reopenedInstance,
        epicId,
        taskId,
      });
      await settleLegendList();
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      // The reopened viewport lands back at the position that was actually
      // on screen when the tab closed - not just "some free-scrolling row".
      expect(getScrollNode().scrollTop).toBe(360);
      second.unmount();

      // Sanity: the closed tab-key alone is not what restored us.
      expect(restoreChatTabState(closedIdentity, messages).mode).toBe(
        "free-scrolling",
      ); // durable still answers for same chat
    });

    // Ticket 15 review (live pass S5 round 3): a small (16-row) transcript
    // and a shallow scroll target let the OLD code's clamping accidentally
    // land "close enough" even with a stale anchor - the poisoned pair
    // only breaks catastrophically once the stale row and the true
    // scrolled row are far apart, matching the live shape (a landmark deep
    // in a long transcript). 100 rows, scrolled to row 50 (far past
    // `enterFreeScrollingAwayFromEnd`'s row-0 park), makes the mismatch
    // large enough to be unmissable.
    const RACE_ROW_COUNT = 100;
    const RACE_TARGET_ROW = 50;
    const RACE_TARGET_SCROLL_TOP =
      RACE_TARGET_ROW * TICKET_13_ROW_HEIGHT_PX + LEGEND_LIST_HEADER_PX;

    it("close races the unserviced rAF viewport mirror: the saved triple still matches the actual scrolled position (live pass S5 round 3, confirmed defect)", async () => {
      const messages = makeCompletedTranscript(RACE_ROW_COUNT);
      const closedInstance = `t15-race-closed-${Math.random().toString(36).slice(2)}`;
      const reopenedInstance = `t15-race-reopen-${Math.random().toString(36).slice(2)}`;
      const epicId = "epic-1";
      const taskId = "task-1";
      const reopenedIdentity = makeTestIdentity(
        reopenedInstance,
        epicId,
        taskId,
      );

      tileLiveness.live = true;
      const first = renderChatMessages({
        messages,
        instanceId: closedInstance,
        epicId,
        taskId,
      });
      await settleLegendList();
      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      // Live evidence: scroll then close BEFORE the pending
      // `scheduleActiveViewportUpdate` rAF ever services
      // `scrolledActiveUserMessageIdRef` - `requestAnimationFrame` never
      // fires for a backgrounded/closing tab, and `useAnimationFrameThrottle`
      // cancels the pending frame on unmount either way. No flush here is
      // the point of this pin.
      fireScrollTopWithoutFlush(RACE_TARGET_SCROLL_TOP);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      evictChatTabState([closedInstance]);
      tileLiveness.live = false;
      first.unmount();

      // The saved triple must be internally coherent with the ACTUAL
      // scrolled position (row 50), not a stale reading-line row paired
      // with the live offset - on the old code this produced an anchor at
      // whatever row `scrolledActiveUserMessageIdRef` last held (row 0,
      // pre-scroll) combined with an offset computed against the live
      // scrollTop, clamping the reopen far from row 50.
      const restoredTriple = restoreChatTabState(reopenedIdentity, messages);
      expect(restoredTriple.mode).toBe("free-scrolling");
      expect(restoredTriple.anchorMessageId).not.toBeNull();
      expect(restoredTriple.anchorIndex).toBeGreaterThan(RACE_TARGET_ROW - 2);
      expect(restoredTriple.anchorIndex).toBeLessThan(RACE_TARGET_ROW + 2);

      const second = renderChatMessages({
        messages,
        instanceId: reopenedInstance,
        epicId,
        taskId,
      });
      await settleLegendList();
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().scrollTop).toBe(RACE_TARGET_SCROLL_TOP);
      second.unmount();
    });

    it("close races the unserviced rAF viewport mirror under StrictMode (dev effect replay must not resurrect the stale row-0 reading)", async () => {
      const messages = makeCompletedTranscript(RACE_ROW_COUNT);
      const closedInstance = `t15-strict-closed-${Math.random().toString(36).slice(2)}`;
      const reopenedInstance = `t15-strict-reopen-${Math.random().toString(36).slice(2)}`;
      const epicId = "epic-1";
      const taskId = "task-1";
      const reopenedIdentity = makeTestIdentity(
        reopenedInstance,
        epicId,
        taskId,
      );

      tileLiveness.live = true;
      const first = render(
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
              instanceId={closedInstance}
              visible
              systemOverlayActive={false}
              isChatStreaming={false}
              scrollRequest={null}
              composerOverlayHeight={80}
            />
          </div>
        </StrictMode>,
      );
      await settleLegendList();
      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      fireScrollTopWithoutFlush(RACE_TARGET_SCROLL_TOP);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      evictChatTabState([closedInstance]);
      tileLiveness.live = false;
      first.unmount();

      const restoredTriple = restoreChatTabState(reopenedIdentity, messages);
      expect(restoredTriple.mode).toBe("free-scrolling");
      expect(restoredTriple.anchorMessageId).not.toBeNull();
      expect(restoredTriple.anchorIndex).toBeGreaterThan(RACE_TARGET_ROW - 2);
      expect(restoredTriple.anchorIndex).toBeLessThan(RACE_TARGET_ROW + 2);

      const second = renderChatMessages({
        messages,
        instanceId: reopenedInstance,
        epicId,
        taskId,
      });
      await settleLegendList();
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().scrollTop).toBe(RACE_TARGET_SCROLL_TOP);
      second.unmount();
    });

    it("hydration catch-up: a saved anchor absent from a still-hydrating mount-time transcript is re-resolved once the full transcript arrives (live pass S5, confirmed defect)", async () => {
      const fullMessages = makeCompletedTranscript(200);
      const anchorIndex = 20;
      const anchorId = fullMessages[anchorIndex]?.id ?? null;
      expect(anchorId).toBeTruthy();
      // Hydration catch-up restores the original sub-row pixel offset, not
      // the fixed minimap/find navigation padding.
      const expectedScrollTop =
        anchorIndex * TICKET_13_ROW_HEIGHT_PX + LEGEND_LIST_HEADER_PX - 24;

      // Repro: reopen races hydration - the FIRST commit only has the tail
      // of the transcript (chat.subscribe's snapshot can still grow after
      // this tile's own snapshotLoaded first flips true; see
      // chat-session-store.ts's reconnect/rehydrate comments) - the saved
      // anchor (idx 20) is not present yet.
      const catchupKey = `t15-hydration-catchup-${Math.random().toString(36).slice(2)}`;
      saveChatTabState({
        identity: makeDefaultTestIdentity(catchupKey),
        mode: "free-scrolling",
        anchorMessageId: anchorId,
        anchorIndex,
        offset: 24,
      });
      const partialMessages = fullMessages.slice(180);
      const { rerenderMessages } = renderChatMessages({
        messages: partialMessages,
        scrollStateKey: catchupKey,
      });
      await settleLegendList();
      // Confirms the gap is real: the mount-time restore could not have
      // found the true anchor in this partial transcript, and the scroll
      // position is nowhere near the true anchor's row.
      expect(screen.queryByTestId(`mock-message-${anchorId}`)).toBeNull();
      expect(getScrollNode().scrollTop).not.toBe(expectedScrollTop);

      // The rest of the transcript arrives (a later onSnapshot/backfill commit).
      rerenderMessages(fullMessages);
      await settleLegendList();

      expect(getScrollNode().scrollTop).toBe(expectedScrollTop);
    });

    it("hydration catch-up survives MANY anchor-absent messages transitions before the anchor arrives (live pass S5 round 2, confirmed defect)", async () => {
      // Live evidence: a reopen can replay dozens of incremental `messages`
      // reference changes (onSnapshot + a burst of backfill/append events)
      // in well under 2 seconds, all before the saved anchor's own commit
      // ever lands. An earlier version of this fix counted every
      // anchor-absent transition as a bounded "attempt" (20) and disarmed
      // itself long before the anchor showed up - this reproduces that
      // exact shape: 25 distinct anchor-absent commits, THEN the anchor.
      const fullMessages = makeCompletedTranscript(200);
      const anchorIndex = 20;
      const anchorId = fullMessages[anchorIndex]?.id ?? null;
      expect(anchorId).toBeTruthy();
      const expectedScrollTop =
        anchorIndex * TICKET_13_ROW_HEIGHT_PX + LEGEND_LIST_HEADER_PX - 24;

      const key = `t15-hydration-many-absent-${Math.random().toString(36).slice(2)}`;
      saveChatTabState({
        identity: makeDefaultTestIdentity(key),
        mode: "free-scrolling",
        anchorMessageId: anchorId,
        anchorIndex,
        offset: 24,
      });
      const { rerenderMessages } = renderChatMessages({
        messages: fullMessages.slice(180, 181),
        scrollStateKey: key,
      });
      await settleLegendList();
      expect(screen.queryByTestId(`mock-message-${anchorId}`)).toBeNull();

      // 25 DISTINCT array references, none containing the anchor (all drawn
      // from the tail, past index 20) - more than the old bounded budget.
      for (let i = 2; i <= 26; i += 1) {
        rerenderMessages(fullMessages.slice(180, 180 + i));
      }
      await settleLegendList();
      expect(screen.queryByTestId(`mock-message-${anchorId}`)).toBeNull();

      // The anchor's own commit finally lands.
      rerenderMessages(fullMessages);
      await settleLegendList();

      expect(getScrollNode().scrollTop).toBe(expectedScrollTop);
    });

    it("preserves the unresolved raw hydration anchor across a normalized rapid remount", async () => {
      const fullMessages = makeCompletedTranscript(200);
      const anchorIndex = 20;
      const anchorId = fullMessages[anchorIndex]?.id ?? null;
      expect(anchorId).toBeTruthy();
      const expectedScrollTop =
        anchorIndex * TICKET_13_ROW_HEIGHT_PX + LEGEND_LIST_HEADER_PX - 24;
      const key = `t15-hydration-remount-${Math.random().toString(36).slice(2)}`;
      const identity = makeDefaultTestIdentity(key);
      // The partial tail is long enough that the substituted local index is
      // measurable away from its own edge, so the normalized fallback can
      // settle and overwrite the ordinary cache before this rapid remount.
      const partialMessages = fullMessages.slice(150);

      saveChatTabState({
        identity,
        mode: "free-scrolling",
        anchorMessageId: anchorId,
        anchorIndex,
        offset: 24,
      });
      tileLiveness.live = true;
      const first = renderChatMessages({
        messages: partialMessages,
        scrollStateKey: key,
      });
      await settleLegendList();
      await settleLegendList();
      first.unmount();

      const normalizedAfterFirstUnmount = peekSavedChatTabState(identity);
      expect(normalizedAfterFirstUnmount?.mode).toBe("free-scrolling");
      expect(normalizedAfterFirstUnmount?.anchorMessageId).not.toBe(anchorId);
      const second = renderChatMessages({
        messages: partialMessages,
        scrollStateKey: key,
      });
      second.rerenderMessages(fullMessages);
      await settleLegendList();

      expect(getScrollNode().scrollTop).toBe(expectedScrollTop);
      second.unmount();
    });

    it("reader intent supersedes the session-retained raw hydration anchor", async () => {
      const fullMessages = makeCompletedTranscript(200);
      const anchorIndex = 20;
      const anchorId = fullMessages[anchorIndex]?.id ?? null;
      expect(anchorId).toBeTruthy();
      const rawAnchorScrollTop =
        anchorIndex * TICKET_13_ROW_HEIGHT_PX + LEGEND_LIST_HEADER_PX - 24;
      const readerRestoredScrollTop = 150 * TICKET_13_ROW_HEIGHT_PX;
      const key = `t15-hydration-reader-${Math.random().toString(36).slice(2)}`;
      const partialMessages = fullMessages.slice(150);

      saveChatTabState({
        identity: makeDefaultTestIdentity(key),
        mode: "free-scrolling",
        anchorMessageId: anchorId,
        anchorIndex,
        offset: 24,
      });
      tileLiveness.live = true;
      const first = renderChatMessages({
        messages: partialMessages,
        scrollStateKey: key,
      });
      await settleLegendList();
      await settleLegendList();
      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      first.unmount();

      const reopened = renderChatMessages({
        messages: fullMessages,
        scrollStateKey: key,
      });
      await settleLegendList();
      expect(getScrollNode().scrollTop).toBe(readerRestoredScrollTop);
      expect(getScrollNode().scrollTop).not.toBe(rawAnchorScrollTop);
      reopened.unmount();
    });

    it("hydration catch-up does not disturb the true-deletion nearest-neighbor fallback (branch-edited anchor, never resolves)", async () => {
      const messages = makeCompletedTranscript(16);
      const key = `t15-hydration-deleted-${Math.random().toString(36).slice(2)}`;

      saveChatTabState({
        identity: makeDefaultTestIdentity(key),
        mode: "free-scrolling",
        anchorMessageId: "gone-branch-deleted",
        anchorIndex: 5,
        offset: 24,
      });
      tileLiveness.live = true;
      const first = renderChatMessages({ messages, scrollStateKey: key });
      await settleLegendList();
      await settleLegendList();

      // The round-1 stale-anchor nearest-neighbor fallback still applies
      // exactly as before this fix. The measured neighboring-row landing is
      // allowed to settle even while the same-mount hydration retry retains
      // the original id, so unmount persists a coherent normalized anchor
      // instead of re-saving the deleted id forever.
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(
        screen.queryByTestId("mock-message-gone-branch-deleted"),
      ).toBeNull();

      first.unmount();
      const normalized = peekSavedChatTabState(makeDefaultTestIdentity(key));
      expect(normalized?.mode).toBe("free-scrolling");
      expect(normalized?.anchorMessageId).not.toBe("gone-branch-deleted");
      expect(
        messages.some((message) => message.id === normalized?.anchorMessageId),
      ).toBe(true);

      const reopened = renderChatMessages({ messages, scrollStateKey: key });
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(
        screen.queryByTestId("mock-message-gone-branch-deleted"),
      ).toBeNull();
      reopened.unmount();
    });

    it("composer-resize alone does not write scroll state (endInset not in save-effect deps)", async () => {
      const messages = makeCompletedTranscript(12);
      const instanceId = `t15-composer-resize-${Math.random().toString(36).slice(2)}`;
      const identity = makeDefaultTestIdentity(instanceId);

      // Truly fresh: no seed, not streaming.
      expect(hasSavedChatTabState(identity)).toBe(false);
      tileLiveness.live = true;
      const { rerenderWith } = renderChatMessages({
        messages,
        instanceId,
        freshOpen: true,
        composerOverlayHeight: 80,
      });
      await settleLegendList();
      expect(hasSavedChatTabState(identity)).toBe(false);

      // Resize the overlaid composer - previously re-ran the unmount-save
      // effect cleanup because endInset was in the dep array, flipping
      // "no saved state" permanently.
      rerenderWith({ composerOverlayHeight: 240 });
      await settleLegendList();

      expect(hasSavedChatTabState(identity)).toBe(false);
    });
  });

  describe("ticket 20: pre-structural-mutation viewport handoff", () => {
    /**
     * Review round 1, finding 3: the same-commit pin below must actually
     * force React to unmount the old fiber and mount the replacement in ONE
     * commit - `unmount()` followed by a separate `render()` call is two
     * commits, and cannot catch a cleanup-clobber. Swapping the wrapping
     * host element's TYPE (div -> section) between rerenders makes React
     * tear down and rebuild the whole subtree - old fiber deletion, new
     * fiber placement, both commit-phase - inside a single `rerender` call,
     * the same one-store-update shape a real drag/split/dissolve/tear-off
     * produces (retained `instanceId`, replaced fiber).
     */
    function KeyedParentChatMessages({
      parentTag,
      instanceId,
      messages,
    }: {
      parentTag: "div" | "section";
      instanceId: string;
      messages: ReadonlyArray<ChatMessageModel>;
    }): ReactElement {
      const Parent = parentTag;
      return (
        <Parent
          data-chat-keyboard-scroll-scope
          data-active="true"
          style={{ height: VIEWPORT_HEIGHT_PX, width: VIEWPORT_WIDTH_PX }}
        >
          <ChatMessages
            taskTitle="Test chat"
            taskId="task-1"
            epicId="epic-1"
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
        </Parent>
      );
    }

    it(
      "same-commit remount reads the pre-move position only when the action " +
        "creator flushes before the replacement mounts (red without the flush)",
      async () => {
        const messages = makeCompletedTranscript(20);
        const instanceId = `t20-same-commit-${Math.random().toString(36).slice(2)}`;
        const identity = makeDefaultTestIdentity(instanceId);

        tileLiveness.live = true;
        const { rerender } = render(
          <KeyedParentChatMessages
            parentTag="div"
            instanceId={instanceId}
            messages={messages}
          />,
        );
        await settleLegendList();

        act(() => {
          enterFreeScrollingAwayFromEnd();
        });
        await fireScrollTopAndFlush(360);
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
        const preMoveScrollTop = getScrollNode().scrollTop;
        expect(preMoveScrollTop).toBe(360);

        // RED-ON-BASELINE: `restoreChatTabState` is exactly what a
        // same-commit replacement's render-time state initializer calls
        // (`ChatMessagesInner`'s `restoredTabState` useState initializer) -
        // React runs it during render, which happens BEFORE ANY commit-phase
        // effect, including the currently-mounted fiber's own unmount
        // cleanup. Nothing has unmounted yet here, so whatever
        // `restoreChatTabState` returns right now is exactly what the
        // type-swap rerender below will read. Without a pre-mutation flush,
        // that is still the harness/cache-miss default following-end seed,
        // not the live 360px position currently on screen - the audit's own
        // `initialize:stale` probe finding, reproduced directly.
        const staleRestore = restoreChatTabState(identity, messages);
        expect(staleRestore.mode).toBe("following-end");

        // The fix: a structural-mutation action creator (drag/split-wrap/
        // dissolve/tear-off) calls this exact primitive, synchronously,
        // BEFORE its own `set()` - simulated here immediately before the
        // type-swap rerender that stands in for that `set()`.
        flushChatTabViewportHandoff([instanceId]);
        const freshRestore = restoreChatTabState(identity, messages);
        expect(freshRestore.mode).toBe("free-scrolling");
        expect(freshRestore.anchorMessageId).not.toBeNull();

        // A REAL same-commit remount: the div -> section type change and the
        // replacement's render-time restore both happen inside this one
        // `rerender` call - React never lets the old fiber's commit-phase
        // cleanup run before this call's render phase (including the new
        // fiber's state initializer) has already completed.
        rerender(
          <KeyedParentChatMessages
            parentTag="section"
            instanceId={instanceId}
            messages={messages}
          />,
        );
        await settleLegendList();
        await settleLegendList();

        // Confirm it actually paints directly at the pre-move position - no
        // stale/default jump.
        expect(getScrollNode().scrollTop).toBe(preMoveScrollTop);
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      },
    );

    it(
      "the pre-mutation flush captures a coherent live-DOM snapshot, not a " +
        "stale rAF-throttled mirror (review round 1, finding 2: rebuilt - " +
        "the prior version raced a scrollRequest, but navigateToMessage " +
        "synchronously freshens the mirror before it scrolls, so that " +
        "construction could never actually desync it)",
      async () => {
        const rowCount = 100;
        const targetRow = 50;
        const targetScrollTop =
          targetRow * TICKET_13_ROW_HEIGHT_PX + LEGEND_LIST_HEADER_PX;
        const messages = makeCompletedTranscript(rowCount);
        const instanceId = `t20-coherent-flush-${Math.random().toString(36).slice(2)}`;
        const identity = makeDefaultTestIdentity(instanceId);

        tileLiveness.live = true;
        const first = renderChatMessages({ messages, instanceId });
        await settleLegendList();
        act(() => {
          enterFreeScrollingAwayFromEnd();
        });
        // Ticket 15 review (live pass S5 round 3)'s exact race, reused here
        // for the still-mounted flush path instead of that pin's non-live
        // unmount path: sets scrollTop and fires the scroll event WITHOUT
        // yielding a frame afterward, so `scheduleActiveViewportUpdate`'s
        // rAF-throttled reading-line mirror (`scrolledActiveUserMessageIdRef`)
        // never catches up to this position. Critically, nothing in this
        // window is a navigation (`navigateToMessage` is not called - no
        // scrollRequest, no minimap/find jump) - only `navigateToMessage`
        // synchronously writes that ref before scrolling, so a
        // navigation-driven jump can never desync the mirror from the DOM in
        // the first place. That is exactly why the prior version of this
        // pin (a scrollRequest-driven jump) was vacuous.
        fireScrollTopWithoutFlush(targetScrollTop);
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

        // Flush with `first` STILL MOUNTED, exactly as a real structural
        // mutation's pre-`set()` flush runs. Reading `restoreChatTabState`
        // BEFORE `first.unmount()` (same ordering proof as the same-commit
        // pin above) is load-bearing: unmounting first would trigger
        // `first`'s OWN unmount-cleanup save too, masking a disabled/broken
        // flush behind the pre-existing unmount path and silently degrading
        // this into an ordinary unmount-capture check that stays green
        // either way.
        flushChatTabViewportHandoff([instanceId]);
        const saved = restoreChatTabState(identity, messages);
        expect(saved.mode).toBe("free-scrolling");
        expect(saved.anchorMessageId).not.toBeNull();
        // The stale mirror (unserviced since before this scroll) points at
        // a different row entirely - a poisoned capture would land well
        // outside this window, not just off by a row or two.
        expect(saved.anchorIndex).toBeGreaterThan(targetRow - 2);
        expect(saved.anchorIndex).toBeLessThan(targetRow + 2);

        first.unmount();

        const replacement = renderChatMessages({ messages, instanceId });
        await settleLegendList();
        await settleLegendList();
        expect(getScrollNode().scrollTop).toBe(targetScrollTop);

        replacement.unmount();
      },
    );

    it("flushing an instanceId with no live/mounted tile is a harmless no-op", () => {
      const instanceId = `t20-no-live-mount-${Math.random().toString(36).slice(2)}`;
      expect(() => flushChatTabViewportHandoff([instanceId])).not.toThrow();
      expect(hasSavedChatTabState(makeDefaultTestIdentity(instanceId))).toBe(
        false,
      );
    });
  });

  describe("ticket 20: restore-driven navigation never visibly traverses", () => {
    /**
     * Records every `scrollTo({behavior, top, left})` LegendList issues
     * against `scrollNode`. Does NOT re-spy `HTMLElement.prototype.scrollTo`
     * by wrapping its CURRENT value as a "call through to prior" fallback -
     * `installLegendListViewportMetrics` already replaced it with a mock
     * once per test, and `vi.spyOn` on an already-spied method returns that
     * SAME mock instance rather than a fresh wrapper, so a captured
     * "prior" reference is actually the mock being reconfigured -
     * `mockImplementation` on it recurses into itself (stack overflow).
     * Reimplements the shim's own minimal numeric/options handling directly
     * against the real `scrollTop`/`scrollLeft` property setters instead.
     */
    function recordScrollToCallsOnNode(scrollNode: HTMLElement): ReadonlyArray<{
      readonly behavior?: ScrollBehavior;
      readonly top?: number;
      readonly left?: number;
    }> {
      const calls: Array<{
        behavior?: ScrollBehavior;
        top?: number;
        left?: number;
      }> = [];
      const scrollTopDescriptor = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        "scrollTop",
      );
      const scrollLeftDescriptor = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        "scrollLeft",
      );
      if (
        scrollTopDescriptor?.set === undefined ||
        scrollLeftDescriptor?.set === undefined
      ) {
        throw new Error("expected scrollTop/scrollLeft setters");
      }
      // The setter is called on a DIFFERENT element each invocation
      // (whichever node `scrollTo` fires on), so it cannot be bound to one
      // fixed `this` up front. Keep the descriptor itself as the stored
      // reference and reach `.set` only immediately before `.call` inside
      // these wrappers - never as a standalone extracted method reference.
      const setScrollTop = (target: HTMLElement, value: number): void => {
        scrollTopDescriptor.set?.call(target, value);
      };
      const setScrollLeft = (target: HTMLElement, value: number): void => {
        scrollLeftDescriptor.set?.call(target, value);
      };
      vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(function (
        this: HTMLElement,
        ...args: Array<number | ScrollToOptions | undefined>
      ): void {
        const first = args[0];
        if (typeof first === "number") {
          const second = args[1];
          setScrollLeft(this, first);
          setScrollTop(this, typeof second === "number" ? second : 0);
          return;
        }
        if (typeof first !== "object") return;
        if (this === scrollNode) {
          calls.push({
            behavior: first.behavior,
            top: first.top,
            left: first.left,
          });
        }
        if (typeof first.left === "number") {
          setScrollLeft(this, first.left);
        }
        if (typeof first.top === "number") {
          setScrollTop(this, first.top);
        }
      });
      return calls;
    }

    it(
      "late-hydration catch-up requests a non-animated (behavior: auto) jump, " +
        "never the animated (behavior: smooth) path minimap/deep-link use " +
        "(find is unrelated - it independently stays non-animated)",
      async () => {
        const fullMessages = makeCompletedTranscript(200);
        const anchorIndex = 20;
        const anchorId = fullMessages[anchorIndex]?.id ?? null;
        expect(anchorId).toBeTruthy();
        const savedViewOffset = 24;
        const estimatedScrollTop =
          anchorIndex * TICKET_13_ROW_HEIGHT_PX +
          LEGEND_LIST_HEADER_PX -
          savedViewOffset;

        const catchupKey = `t20-hydration-single-frame-${Math.random().toString(36).slice(2)}`;
        saveChatTabState({
          identity: makeDefaultTestIdentity(catchupKey),
          mode: "free-scrolling",
          anchorMessageId: anchorId,
          anchorIndex,
          offset: savedViewOffset,
        });
        const partialMessages = fullMessages.slice(180);
        const { rerenderMessages } = renderChatMessages({
          messages: partialMessages,
          scrollStateKey: catchupKey,
        });
        await settleLegendList();
        expect(getScrollNode().scrollTop).not.toBe(estimatedScrollTop);

        const scrollNode = getScrollNode();
        const callsOnScrollNode = recordScrollToCallsOnNode(scrollNode);

        // The rest of the transcript arrives (a later onSnapshot/backfill
        // commit) - triggers the hydration-retry effect's `navigateToMessage`
        // call.
        rerenderMessages(fullMessages);
        await settleLegendList();

        const measuredAnchorTop = legendListRefHolder.current
          ?.getState()
          .positionAtIndex(anchorIndex);
        if (measuredAnchorTop === undefined) {
          throw new Error("Expected hydrated anchor geometry");
        }
        expect(getScrollNode().scrollTop).toBe(
          measuredAnchorTop + LEGEND_LIST_HEADER_PX - savedViewOffset,
        );
        // RED-ON-BASELINE: before threading an explicit `animated` param
        // through `navigateToMessage`, this call hardcoded `animated: true`,
        // which LegendList translates to `behavior: "smooth"` - a reader
        // would see the transcript visibly scroll to the resolved anchor
        // instead of painting there directly. A restore is not a user
        // navigation; every call this retry produced must request
        // `behavior: "auto"` (LegendList's instant/non-animated path).
        expect(callsOnScrollNode.length).toBeGreaterThan(0);
        expect(
          callsOnScrollNode.every((call) => call.behavior === "auto"),
        ).toBe(true);
      },
    );

    it("minimap navigation (a real, user-triggered jump) still requests the animated path, unchanged", async () => {
      const messages = makeTranscript(24);
      renderChatMessages({
        messages,
        scrollStateKey: `t20-minimap-still-animated-${Math.random().toString(36).slice(2)}`,
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();

      const scrollNode = getScrollNode();
      const callsOnScrollNode = recordScrollToCallsOnNode(scrollNode);

      await selectLastChatTurnMinimapItem();

      expect(callsOnScrollNode.length).toBeGreaterThan(0);
      expect(
        callsOnScrollNode.every((call) => call.behavior === "smooth"),
      ).toBe(true);
    });
  });

  // ---------------------------------------------------------------------
  // Ticket 22 (painted-chat lifecycle audit, finding 3): the two-rAF anchor
  // repair (ticket 18's drift re-assert) is keyed to `messages` - a
  // divider/split/join/header/disclosure geometry change under the SAME
  // `messages` array reports through `onItemSizeChanged`/`onLayout` but
  // nothing schedules a repair for it. Row(s) above the anchor moving height
  // shifts the anchored turn's content position with scrollTop unchanged.
  //
  // All four pins settle into an OVERFLOWING anchored turn first (same
  // recipe as ticket 18's pin E) rather than a short, non-overflowing one:
  // `anchoredEndSpace` pins a non-overflowing anchor at the maximum
  // REACHABLE scroll, and LegendList's own internal reserve tracking for
  // that config does not know about a raw `setItemSize` call on a row it
  // isn't watching - it silently re-clamps scrollTop back to its own
  // believed-correct position on the next settle, which would make a
  // perfectly-landed real repair look like a no-op. Once the turn overflows,
  // there is no such natural boundary to fight the repair's write.
  // ---------------------------------------------------------------------
});
