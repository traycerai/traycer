import { act, cleanup, renderHook } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
  type Mock,
} from "vitest";
import type { ReactNode } from "react";
import type { StoreApi } from "zustand/vanilla";
import { createElement, useRef } from "react";
import type { ChatFindAdapter } from "@/components/chat/chat-find";
import { FULLY_LOADED_TRANSCRIPT } from "@/components/chat/chat-find-index";
import type { TileFindAdapter } from "@/stores/tile-find";
import { TileFindContext } from "@/components/epic-canvas/tile-find/tile-find-adapter-context";
import { useChatFindController } from "@/components/chat/use-chat-find-controller";
import {
  ChatFindForceStoreContext,
  ChatFindForceTileInstanceIdContext,
  type ChatFindForceState,
  createChatFindForceStore,
} from "@/stores/chats/chat-find-force-store-context";
import {
  createChatCollapsibleKey,
  derivePromotedSubagentRenderId,
  serializeChatCollapsibleKey,
} from "@/components/chat/chat-collapsible-key";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import { chatFindSegmentUnitId } from "@/components/chat/chat-find-projection";
import { makeMessage } from "./chat-message-fixtures";

const TILE_INSTANCE_ID = "find-controller-tile";
const EMPTY_BACKGROUND_TOOL_BLOCK_IDS: ReadonlySet<string> = new Set<string>();
// Stable across renders, as ChatMessages passes it: a new identity re-creates
// the adapter and drops its query.
const NO_COVERAGE_MESSAGE = (): string | null => null;
const SUBAGENT_ID = "subagent-find-ctrl";
const UNIQUE_NEEDLE = "find-ctrl-unique-needle-xyz";

describe("useChatFindController - chain-open on reveal", () => {
  let registeredAdapter: ChatFindAdapter | null;
  let scroller: HTMLElement;
  let scrollToLocation: Mock;
  let cancelManualNavigation: Mock;
  let setScrolledActiveUserMessageIdIfChanged: Mock;
  let restoreFrames: (() => void) | null;

  beforeEach(() => {
    registeredAdapter = null;
    // Matches `issueFreeTimelineNavigation`'s real contract: `afterSettle`
    // fires once row landing is done and the reader has not taken over. A
    // test that needs to hold the reveal pending, or to simulate the reader
    // cancelling, overrides this with its own captured callback.
    scrollToLocation = vi.fn(
      (
        _location: unknown,
        afterSettle: () => void,
        _onCancelled: () => void,
      ) => {
        afterSettle();
      },
    );
    cancelManualNavigation = vi.fn();
    setScrolledActiveUserMessageIdIfChanged = vi.fn();

    scroller = document.createElement("div");
    const anchorRow = document.createElement("div");
    anchorRow.dataset.messageId = "msg-user";
    const targetRow = document.createElement("div");
    targetRow.dataset.messageId = "msg-assistant";
    scroller.append(anchorRow, targetRow);
    document.body.append(scroller);

    restoreFrames = installFrameQueue();
  });

  afterEach(() => {
    restoreFrames?.();
    restoreFrames = null;
    cleanup();
    scroller.remove();
    registeredAdapter = null;
    vi.restoreAllMocks();
  });

  interface ControllerScope {
    readonly openSubagentId: string | null;
    readonly getSubagentViewRoot: () => HTMLElement | null;
  }

  const TRANSCRIPT_SCOPE: ControllerScope = {
    openSubagentId: null,
    getSubagentViewRoot: () => null,
  };

  function renderController(
    messages: ReadonlyArray<ChatMessageModel>,
    initialScope: ControllerScope,
  ): {
    readonly getAdapter: () => ChatFindAdapter;
    readonly forceStore: StoreApi<ChatFindForceState>;
    readonly getController: () => {
      readonly scheduleMountedHighlightSync: () => void;
    };
    readonly rerenderMessages: (
      messages: ReadonlyArray<ChatMessageModel>,
    ) => void;
    readonly rerenderScope: (scope: ControllerScope) => void;
  } {
    const getScroller = (): HTMLElement => scroller;
    let currentScope = initialScope;
    let currentMessages = messages;
    const tileFindContext = {
      tileInstanceId: TILE_INSTANCE_ID,
      registerAdapter: (adapter: TileFindAdapter) => {
        // The controller only ever registers its own ChatFindAdapter here -
        // safe to narrow for test-only access to notifyRowsChanged (not
        // part of the base TileFindAdapter interface).
        registeredAdapter = adapter as ChatFindAdapter;
        return () => {
          if (registeredAdapter === adapter) {
            registeredAdapter = null;
          }
        };
      },
    };

    const forceStore = createChatFindForceStore();
    let controller: {
      readonly scheduleMountedHighlightSync: () => void;
    } | null = null;

    function Wrapper(props: { readonly children: ReactNode }) {
      return createElement(
        ChatFindForceTileInstanceIdContext.Provider,
        { value: TILE_INSTANCE_ID },
        createElement(
          ChatFindForceStoreContext.Provider,
          { value: forceStore },
          createElement(
            TileFindContext.Provider,
            { value: tileFindContext },
            props.children,
          ),
        ),
      );
    }

    const rendered = renderHook(
      (props: {
        readonly messages: ReadonlyArray<ChatMessageModel>;
        readonly scope: ControllerScope;
      }) => {
        const currentMessages = props.messages;
        const messagesRef = useRef(currentMessages);
        messagesRef.current = currentMessages;
        const rowIndexByKeyRef = useRef(
          new Map(
            currentMessages.map(
              (message, index) => [message.id, index] as const,
            ),
          ),
        );
        rowIndexByKeyRef.current = new Map(
          currentMessages.map((message, index) => [message.id, index] as const),
        );
        const backgroundToolBlockIdsRef = useRef<ReadonlySet<string>>(
          EMPTY_BACKGROUND_TOOL_BLOCK_IDS,
        );
        controller = useChatFindController({
          splitLongTurns: true,
          instanceId: TILE_INSTANCE_ID,
          messages: currentMessages,
          messagesRef,
          backgroundToolBlockIds: EMPTY_BACKGROUND_TOOL_BLOCK_IDS,
          backgroundToolBlockIdsRef,
          // This suite drives the legacy line, where the transcript is fully
          // materialized and find has nothing to disclose.
          getFindCoverageMessage: NO_COVERAGE_MESSAGE,
          getFindPlacement: () => FULLY_LOADED_TRANSCRIPT,
          requestIndexJump: () => undefined,
          requestIndexRead: () => undefined,
          rowIndexByKeyRef,
          getScroller,
          scrollToLocation,
          cancelManualNavigation,
          getNavigationGeneration: () => 0,
          setScrolledActiveUserMessageIdIfChanged,
          openSubagentId: props.scope.openSubagentId,
          getSubagentViewRoot: props.scope.getSubagentViewRoot,
        });
        return controller;
      },
      {
        initialProps: { messages, scope: initialScope },
        wrapper: Wrapper,
      },
    );

    return {
      getAdapter: () => {
        if (registeredAdapter === null) {
          throw new Error("chat find adapter did not register");
        }
        return registeredAdapter;
      },
      forceStore,
      getController: () => {
        if (controller === null) throw new Error("controller did not mount");
        return controller;
      },
      rerenderMessages: (nextMessages) => {
        currentMessages = nextMessages;
        rendered.rerender({ messages: currentMessages, scope: currentScope });
      },
      rerenderScope: (scope) => {
        currentScope = scope;
        rendered.rerender({ messages: currentMessages, scope });
      },
    };
  }

  it("force-opens the owning chain on a genuine find reveal", () => {
    const messages = makeTranscriptWithSubagentBodyNeedle();
    const { getAdapter, forceStore } = renderController(
      messages,
      TRANSCRIPT_SCOPE,
    );
    const adapter = getAdapter();

    act(() => {
      void adapter.search({
        requestId: 1,
        query: UNIQUE_NEEDLE,
        matchCase: false,
      });
    });

    const expectedKey = createChatCollapsibleKey(
      TILE_INSTANCE_ID,
      "subagent",
      derivePromotedSubagentRenderId(SUBAGENT_ID),
    );
    expect(
      forceStore
        .getState()
        .forcedKeyIds.has(serializeChatCollapsibleKey(expectedKey)),
    ).toBe(true);
  });

  it("does not re-force-open on a passive reconcile of the same target", () => {
    const messages = makeTranscriptWithSubagentBodyNeedle();
    const { getAdapter, forceStore } = renderController(
      messages,
      TRANSCRIPT_SCOPE,
    );
    const adapter = getAdapter();

    act(() => {
      void adapter.search({
        requestId: 2,
        query: UNIQUE_NEEDLE,
        matchCase: false,
      });
    });
    const forcedKeysAfterSearch = forceStore.getState().forcedKeyIds;

    // Streaming resync of the same active target (navigate: false path).
    act(() => {
      adapter.notifyRowsChanged();
    });

    expect(forceStore.getState().forcedKeyIds).toBe(forcedKeysAfterSearch);
  });

  it("resumes an offscreen interview detail reveal when virtualization mounts the unit", () => {
    onTestFinished(installMockHighlights());
    const messages = makeTranscriptWithInterviewDetailNeedle();
    const { getAdapter, getController, forceStore } = renderController(
      messages,
      TRANSCRIPT_SCOPE,
    );
    const adapter = getAdapter();

    act(() => {
      void adapter.search({
        requestId: 3,
        query: "offscreen interview detail",
        matchCase: false,
      });
    });

    // The message row exists, but virtualization has not mounted its detail
    // anchor yet. The first reveal frame therefore remains pending.
    flushOneFrame();
    expect(adapter.getSnapshot()).toMatchObject({
      activeUnitId: "interview:interview-find:question:0:answer:value:0",
      exactHighlight: "pending",
    });

    const targetRow = document.createElement("div");
    targetRow.dataset.messageId = "msg-interview";
    scroller.append(targetRow);
    const detail = document.createElement("span");
    detail.dataset.chatFindUnit =
      "interview:interview-find:question:0:answer:value:0";
    detail.textContent = "offscreen interview detail";
    targetRow.append(detail);

    // This is the same measured-row mount signal ChatMessages wires to the
    // controller; no message reference or unrelated activity changes.
    act(() => getController().scheduleMountedHighlightSync());
    flushFrames();

    expect(adapter.getSnapshot()).toMatchObject({
      query: "offscreen interview detail",
      activeUnitId: "interview:interview-find:question:0:answer:value:0",
      exactHighlight: "painted",
    });
    expect(forceStore.getState().activeTarget).toMatchObject({
      unitId: "interview:interview-find:question:0:answer:value:0",
      key: { kind: "interview", id: "interview-find" },
    });
  });

  it("clears an interview target when passive reconciliation moves to an ordinary unit", () => {
    const messages = makeTranscriptWithInterviewDetailNeedle();
    const { getAdapter, forceStore, rerenderMessages } = renderController(
      messages,
      TRANSCRIPT_SCOPE,
    );
    const adapter = getAdapter();

    act(() => {
      void adapter.search({
        requestId: 4,
        query: "offscreen interview detail",
        matchCase: false,
      });
    });
    expect(forceStore.getState().activeTarget?.key.kind).toBe("interview");

    const ordinaryMessages = makeTranscriptWithOrdinaryFallbackNeedle();
    // Re-render only the transcript projection. The active query remains open,
    // so the controller's messages layout effect performs passive reconciliation.
    act(() => rerenderMessages(ordinaryMessages));
    expect(forceStore.getState().activeTarget).toBeNull();
  });

  describe("with an open subagent conversation", () => {
    const CARD_ID = "card-open";

    function viewRoot(): HTMLElement {
      const root = document.createElement("div");
      const unit = document.createElement("span");
      unit.dataset.chatFindUnit = "segment:card-text";
      unit.textContent = "needle card";
      root.append(unit);
      document.body.append(root);
      onTestFinished(() => root.remove());
      return root;
    }

    function transcriptWithCard(): ReadonlyArray<ChatMessageModel> {
      const user: ChatMessageModel = {
        ...makeMessage(0, "user"),
        id: "msg-user",
        content: "needle user",
      };
      const assistant: ChatMessageModel = {
        ...makeMessage(1, "assistant"),
        id: "msg-assistant",
        segments: [
          {
            id: CARD_ID,
            kind: "subagent",
            name: "Opener",
            agentType: null,
            task: "Investigate",
            progressUpdates: [],
            result: null,
            isStreaming: false,
            endState: null,
            stopped: false,
            startedAt: 1,
            durationMs: 100,
            spawnToolCallId: null,
            parentId: null,
            workflowMeta: null,
            toolImageResults: [],
            children: [
              {
                id: "card-text",
                kind: "text",
                markdown: "needle card",
                isStreaming: false,
                parentId: CARD_ID,
              },
            ],
          },
        ],
      };
      return [user, assistant];
    }

    it("counts only the card's matches and reveals without scrolling the timeline", () => {
      const root = viewRoot();
      const { getAdapter } = renderController(transcriptWithCard(), {
        openSubagentId: CARD_ID,
        getSubagentViewRoot: () => root,
      });
      const adapter = getAdapter();

      act(() => {
        void adapter.search({
          requestId: 1,
          query: "needle",
          matchCase: false,
        });
      });
      flushFrames();

      expect(adapter.getSnapshot().total).toBe(1);
      expect(adapter.getSnapshot().coverageMessage).toBeNull();
      expect(scrollToLocation).not.toHaveBeenCalled();
      expect(cancelManualNavigation).not.toHaveBeenCalled();
    });

    it("re-runs an active query when the open card changes", () => {
      const root = viewRoot();
      // One stable getter across scopes, as ChatMessages passes: a new
      // identity would re-create the adapter and drop its query.
      const getSubagentViewRoot = (): HTMLElement => root;
      const { getAdapter, rerenderScope } = renderController(
        transcriptWithCard(),
        { openSubagentId: null, getSubagentViewRoot },
      );
      const adapter = getAdapter();

      act(() => {
        void adapter.search({
          requestId: 1,
          query: "needle",
          matchCase: false,
        });
      });
      expect(adapter.getSnapshot().total).toBe(2);

      act(() =>
        rerenderScope({ openSubagentId: CARD_ID, getSubagentViewRoot }),
      );
      expect(getAdapter().getSnapshot().total).toBe(1);

      act(() => rerenderScope({ openSubagentId: null, getSubagentViewRoot }));
      expect(getAdapter().getSnapshot().total).toBe(2);
    });
  });
});

describe("useChatFindController - deferred settle gates reveal", () => {
  // The race this suite guards: `requestFindReveal`/`scheduleFindRevealStep`
  // must not paint or re-center a unit before the row navigation they
  // started has told them, via `afterSettle`, that it can no longer correct
  // the scroll - and must retire cleanly, never stuck pending forever, when
  // that navigation instead reports `onCancelled` (the reader took over).
  // `chat-messages.tsx`'s `issueFreeTimelineNavigation` is the real caller of
  // both; here `scrollToLocation` stands in for it and a test holds the
  // callbacks itself to simulate navigation still in flight or cancelled.
  let registeredAdapter: ChatFindAdapter | null;
  let scroller: HTMLElement;
  let scrollToLocation: Mock;
  let cancelManualNavigation: Mock;
  let setScrolledActiveUserMessageIdIfChanged: Mock;
  let restoreFrames: (() => void) | null;
  let restoreHighlights: (() => void) | null;

  beforeEach(() => {
    registeredAdapter = null;
    scrollToLocation = vi.fn(
      (
        _location: unknown,
        afterSettle: () => void,
        _onCancelled: () => void,
      ) => {
        afterSettle();
      },
    );
    cancelManualNavigation = vi.fn();
    setScrolledActiveUserMessageIdIfChanged = vi.fn();

    scroller = document.createElement("div");
    document.body.append(scroller);

    restoreFrames = installFrameQueue();
    restoreHighlights = installMockHighlights();
  });

  afterEach(() => {
    restoreFrames?.();
    restoreFrames = null;
    restoreHighlights?.();
    restoreHighlights = null;
    cleanup();
    scroller.remove();
    registeredAdapter = null;
    vi.restoreAllMocks();
  });

  function renderController(messages: ReadonlyArray<ChatMessageModel>): {
    readonly getAdapter: () => ChatFindAdapter;
    readonly getController: () => {
      readonly scheduleMountedHighlightSync: () => void;
      readonly onRenderedDataChange: () => void;
    };
  } {
    const getScroller = (): HTMLElement => scroller;
    const tileFindContext = {
      tileInstanceId: TILE_INSTANCE_ID,
      registerAdapter: (adapter: TileFindAdapter) => {
        registeredAdapter = adapter as ChatFindAdapter;
        return () => {
          if (registeredAdapter === adapter) {
            registeredAdapter = null;
          }
        };
      },
    };
    const forceStore = createChatFindForceStore();
    let controller: {
      readonly scheduleMountedHighlightSync: () => void;
      readonly onRenderedDataChange: () => void;
    } | null = null;

    function Wrapper(props: { readonly children: ReactNode }) {
      return createElement(
        ChatFindForceTileInstanceIdContext.Provider,
        { value: TILE_INSTANCE_ID },
        createElement(
          ChatFindForceStoreContext.Provider,
          { value: forceStore },
          createElement(
            TileFindContext.Provider,
            { value: tileFindContext },
            props.children,
          ),
        ),
      );
    }

    renderHook(
      () => {
        const messagesRef = useRef(messages);
        messagesRef.current = messages;
        const rowIndexByKeyRef = useRef(
          new Map(
            messages.map((message, index) => [message.id, index] as const),
          ),
        );
        const backgroundToolBlockIdsRef = useRef<ReadonlySet<string>>(
          EMPTY_BACKGROUND_TOOL_BLOCK_IDS,
        );
        controller = useChatFindController({
          splitLongTurns: true,
          instanceId: TILE_INSTANCE_ID,
          messages,
          messagesRef,
          backgroundToolBlockIds: EMPTY_BACKGROUND_TOOL_BLOCK_IDS,
          backgroundToolBlockIdsRef,
          getFindCoverageMessage: NO_COVERAGE_MESSAGE,
          getFindPlacement: () => FULLY_LOADED_TRANSCRIPT,
          requestIndexJump: () => undefined,
          requestIndexRead: () => undefined,
          rowIndexByKeyRef,
          getScroller,
          scrollToLocation,
          cancelManualNavigation,
          getNavigationGeneration: () => 0,
          setScrolledActiveUserMessageIdIfChanged,
          openSubagentId: null,
          getSubagentViewRoot: () => null,
        });
        return controller;
      },
      { wrapper: Wrapper },
    );

    return {
      getAdapter: () => {
        if (registeredAdapter === null) {
          throw new Error("chat find adapter did not register");
        }
        return registeredAdapter;
      },
      getController: () => {
        if (controller === null) throw new Error("controller did not mount");
        return controller;
      },
    };
  }

  /** Mounts `messageId`'s row (empty of any find unit) in the scroller. */
  function mountRow(messageId: string): HTMLElement {
    const row = document.createElement("div");
    row.dataset.messageId = messageId;
    scroller.append(row);
    return row;
  }

  /** Mounts a find unit for `unitId` inside an already-mounted row. */
  function mountUnit(row: HTMLElement, unitId: string, text: string): void {
    const unit = document.createElement("span");
    unit.dataset.chatFindUnit = unitId;
    unit.textContent = text;
    row.append(unit);
  }

  const NEEDLE = "deferred-settle-needle";

  function transcriptWithOffscreenText(
    messageId: string,
    markdown: string,
  ): ReadonlyArray<ChatMessageModel> {
    return [
      {
        ...makeMessage(0, "assistant"),
        id: messageId,
        segments: [
          {
            id: `${messageId}-seg`,
            kind: "text",
            markdown,
            isStreaming: false,
          },
        ],
      },
    ];
  }

  it("holds the reveal pending through a rendered-data change and a mounted-highlight sync, then paints once settle fires", () => {
    const messages = transcriptWithOffscreenText("msg-deferred", NEEDLE);
    const capturedAfterSettles: Array<() => void> = [];
    scrollToLocation.mockImplementation(
      (
        _location: unknown,
        afterSettle: () => void,
        _onCancelled: () => void,
      ) => {
        capturedAfterSettles.push(afterSettle);
      },
    );
    const { getAdapter, getController } = renderController(messages);
    const adapter = getAdapter();

    act(() => {
      void adapter.search({ requestId: 1, query: NEEDLE, matchCase: false });
    });
    flushOneFrame();

    expect(scrollToLocation).toHaveBeenCalledTimes(1);
    expect(adapter.getSnapshot().exactHighlight).toBe("pending");
    const capturedAfterSettle = capturedAfterSettles[0];

    // The row lands and mounts while the navigation this reveal started is
    // still outstanding - the exact sequence a LegendList mount signal races
    // against a slow scroll settle.
    const row = mountRow("msg-deferred");
    mountUnit(row, chatFindSegmentUnitId("msg-deferred-seg"), NEEDLE);

    // Both signals `chat-messages.tsx` would fire on that mount must be
    // no-ops while the row navigation they did not start is still pending.
    act(() => getController().onRenderedDataChange());
    act(() => getController().scheduleMountedHighlightSync());
    flushFrames();

    expect(scrollToLocation).toHaveBeenCalledTimes(1);
    expect(adapter.getSnapshot().exactHighlight).toBe("pending");

    // The navigation settles: only now may the reveal proceed.
    act(() => capturedAfterSettle());
    flushFrames();

    expect(adapter.getSnapshot().exactHighlight).toBe("painted");
  });

  it("ignores a stale settle completion after a newer search superseded it", () => {
    const firstMessages = transcriptWithOffscreenText(
      "msg-stale-one",
      "stale-needle-one",
    );
    const capturedAfterSettles: Array<() => void> = [];
    scrollToLocation.mockImplementation(
      (
        _location: unknown,
        afterSettle: () => void,
        _onCancelled: () => void,
      ) => {
        capturedAfterSettles.push(afterSettle);
      },
    );
    const { getAdapter } = renderController(firstMessages);
    const adapter = getAdapter();

    act(() => {
      void adapter.search({
        requestId: 1,
        query: "stale-needle-one",
        matchCase: false,
      });
    });
    flushOneFrame();
    expect(scrollToLocation).toHaveBeenCalledTimes(1);
    expect(adapter.getSnapshot().exactHighlight).toBe("pending");
    const staleAfterSettle = capturedAfterSettles[0];

    // A newer request for the same query takes over before the first
    // navigation settles; the changed requestId bumps the generation.
    act(() => {
      void adapter.search({
        requestId: 2,
        query: "stale-needle-one",
        matchCase: false,
      });
    });
    flushOneFrame();
    expect(scrollToLocation).toHaveBeenCalledTimes(2);

    // The stale settle from the superseded navigation arrives late. It must
    // not advance or corrupt the current (second) navigation's pending gate.
    act(() => staleAfterSettle());
    flushFrames();
    expect(adapter.getSnapshot().exactHighlight).toBe("pending");
    expect(scrollToLocation).toHaveBeenCalledTimes(2);

    // The current navigation's own settle still completes the reveal.
    const row = mountRow("msg-stale-one");
    mountUnit(
      row,
      chatFindSegmentUnitId("msg-stale-one-seg"),
      "stale-needle-one",
    );
    const currentAfterSettle = capturedAfterSettles[1];
    act(() => currentAfterSettle());
    flushFrames();
    expect(adapter.getSnapshot().exactHighlight).toBe("painted");
  });

  it("still waits for row navigation on a same-unit hop requested while the first reveal's navigation is pending", () => {
    const messages = transcriptWithOffscreenText(
      "msg-same-unit",
      "same-unit-needle and again same-unit-needle",
    );
    const capturedAfterSettles: Array<() => void> = [];
    scrollToLocation.mockImplementation(
      (
        _location: unknown,
        afterSettle: () => void,
        _onCancelled: () => void,
      ) => {
        capturedAfterSettles.push(afterSettle);
      },
    );
    const { getAdapter } = renderController(messages);
    const adapter = getAdapter();

    act(() => {
      void adapter.search({
        requestId: 1,
        query: "same-unit-needle",
        matchCase: false,
      });
    });
    flushOneFrame();
    expect(scrollToLocation).toHaveBeenCalledTimes(1);
    expect(adapter.getSnapshot().exactHighlight).toBe("pending");

    // The second occurrence lives in the SAME unit as the first. Reached
    // while the first reveal's row navigation is still outstanding, it must
    // not be mistaken for an already-open in-place hop: nothing has mounted
    // or positioned that unit yet.
    act(() => {
      void adapter.next();
    });
    flushOneFrame();

    expect(scrollToLocation).toHaveBeenCalledTimes(2);
    expect(adapter.getSnapshot().exactHighlight).toBe("pending");

    const row = mountRow("msg-same-unit");
    mountUnit(
      row,
      chatFindSegmentUnitId("msg-same-unit-seg"),
      "same-unit-needle and again same-unit-needle",
    );
    const secondAfterSettle = capturedAfterSettles[1];
    act(() => secondAfterSettle());
    flushFrames();

    expect(adapter.getSnapshot().exactHighlight).toBe("painted");
  });

  it("retires the pending reveal without painting when the row navigation reports cancellation, leaves a later mount to a passive repaint only, and still fully navigates the next same-unit hop", () => {
    const messages = transcriptWithOffscreenText(
      "msg-cancelled",
      "cancelled-needle and again cancelled-needle",
    );
    const capturedAfterSettles: Array<() => void> = [];
    const capturedOnCancelleds: Array<() => void> = [];
    scrollToLocation.mockImplementation(
      (
        _location: unknown,
        afterSettle: () => void,
        onCancelled: () => void,
      ) => {
        capturedAfterSettles.push(afterSettle);
        capturedOnCancelleds.push(onCancelled);
      },
    );
    const { getAdapter, getController } = renderController(messages);
    const adapter = getAdapter();

    act(() => {
      void adapter.search({
        requestId: 1,
        query: "cancelled-needle",
        matchCase: false,
      });
    });
    flushOneFrame();
    expect(scrollToLocation).toHaveBeenCalledTimes(1);
    expect(adapter.getSnapshot().exactHighlight).toBe("pending");

    // The reader takes the viewport back before the navigation ever settled.
    act(() => capturedOnCancelleds[0]());
    flushFrames();

    // Retiring the reveal is not painting it: the match stays "pending" (the
    // active match is retained for a future passive paint) but nothing was
    // scrolled or highlighted on the reader's behalf, and no second
    // navigation was issued. A LATE call of the first navigation's own
    // `afterSettle` (a straggler racing the cancellation) must not resurrect
    // the retired reveal either.
    expect(scrollToLocation).toHaveBeenCalledTimes(1);
    expect(adapter.getSnapshot().exactHighlight).toBe("pending");
    act(() => capturedAfterSettles[0]?.());
    flushFrames();
    expect(scrollToLocation).toHaveBeenCalledTimes(1);
    expect(adapter.getSnapshot().exactHighlight).toBe("pending");

    // The row mounts afterwards. With the reveal retired this can only be a
    // passive repaint (no further navigation, no second `scrollToLocation`
    // call) - never a resumed reveal fighting the reader's own scroll.
    const row = mountRow("msg-cancelled");
    mountUnit(
      row,
      chatFindSegmentUnitId("msg-cancelled-seg"),
      "cancelled-needle and again cancelled-needle",
    );
    act(() => getController().scheduleMountedHighlightSync());
    flushFrames();

    expect(scrollToLocation).toHaveBeenCalledTimes(1);
    expect(adapter.getSnapshot().exactHighlight).toBe("painted");

    // A passive rescan (the same signal a streaming message edit fires)
    // reconciles the open chain against the now-mounted unit. It must not
    // resurrect the completed-reveal bookkeeping the cancellation retired:
    // only an actual completed navigation+paint may mark a unit "already
    // revealed" for the in-place-hop shortcut below.
    act(() => {
      adapter.notifyRowsChanged();
    });
    flushFrames();
    expect(scrollToLocation).toHaveBeenCalledTimes(1);

    // The cancelled reveal must not count as an already-opened unit: the
    // next hop into the SAME unit has to navigate fully again, not take the
    // same-unit in-place-hop shortcut over a reader-owned scroll position.
    act(() => {
      void adapter.next();
    });
    flushOneFrame();

    expect(scrollToLocation).toHaveBeenCalledTimes(2);
    expect(adapter.getSnapshot().exactHighlight).toBe("pending");

    const secondAfterSettle = capturedAfterSettles[1];
    act(() => secondAfterSettle());
    flushFrames();
    expect(adapter.getSnapshot().exactHighlight).toBe("painted");
  });
});

function makeTranscriptWithSubagentBodyNeedle(): ReadonlyArray<ChatMessageModel> {
  const user: ChatMessageModel = {
    ...makeMessage(0, "user"),
    id: "msg-user",
    content: "plain user text",
  };
  const assistant: ChatMessageModel = {
    ...makeMessage(1, "assistant"),
    id: "msg-assistant",
    segments: [
      {
        id: SUBAGENT_ID,
        kind: "subagent",
        name: "Researcher",
        agentType: "analysis",
        task: "Investigate the flake",
        progressUpdates: ["Scanning"],
        result: `Done: ${UNIQUE_NEEDLE}`,
        isStreaming: false,
        endState: null,
        stopped: false,
        startedAt: 1,
        durationMs: 100,
        spawnToolCallId: null,
        parentId: null,
        workflowMeta: null,
        toolImageResults: [],
        children: [],
      },
    ],
  };
  return [user, assistant];
}

function makeTranscriptWithInterviewDetailNeedle(): ReadonlyArray<ChatMessageModel> {
  const user: ChatMessageModel = {
    ...makeMessage(0, "user"),
    id: "msg-user",
    content: "plain user text",
  };
  const assistant: ChatMessageModel = {
    ...makeMessage(1, "assistant"),
    id: "msg-interview",
    segments: [
      {
        id: "interview-find",
        kind: "interview",
        status: "completed",
        toolName: "AskUserQuestion",
        questions: [
          {
            questionId: "q1",
            question: "Which detail?",
            header: null,
            options: [],
            multiSelect: false,
            allowsCustomAnswer: null,
          },
        ],
        answers: [
          {
            questionId: "q1",
            question: "Which detail?",
            values: ["offscreen interview detail"],
            notes: null,
            selection: null,
          },
        ],
        draftAnswers: [],
        outcome: "answered",
        settlement: null,
        error: null,
        delivery: null,
        forkedWithoutAnswer: false,
      },
    ],
  };
  return [user, assistant];
}

function makeTranscriptWithOrdinaryFallbackNeedle(): ReadonlyArray<ChatMessageModel> {
  return [
    {
      ...makeMessage(1, "assistant"),
      id: "msg-interview",
      segments: [
        {
          id: "ordinary-text",
          kind: "text",
          markdown: "offscreen interview detail",
          isStreaming: false,
        },
      ],
    },
  ];
}

class TestHighlight {
  constructor(..._ranges: ReadonlyArray<Range>) {}
}

function installMockHighlights(): () => void {
  const previousCss = globalThis.CSS;
  const previousHighlight = globalThis.Highlight;
  Object.defineProperty(globalThis, "Highlight", {
    configurable: true,
    writable: true,
    value: TestHighlight,
  });
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    writable: true,
    value: {
      highlights: {
        set: () => undefined,
        delete: () => undefined,
      },
    },
  });
  return () => {
    Object.defineProperty(globalThis, "CSS", {
      configurable: true,
      writable: true,
      value: previousCss,
    });
    Object.defineProperty(globalThis, "Highlight", {
      configurable: true,
      writable: true,
      value: previousHighlight,
    });
  };
}

function installFrameQueue(): () => void {
  const frames: FrameRequestCallback[] = [];
  const request = vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
  const cancel = vi
    .spyOn(window, "cancelAnimationFrame")
    .mockImplementation((id) => {
      const index = id - 1;
      frames[index] = () => undefined;
    });
  flushOneFrame = () => {
    const pending = frames.splice(0, 1);
    pending.forEach((callback) => callback(performance.now()));
  };
  flushFrames = () => {
    while (frames.length > 0) {
      const pending = frames.splice(0, frames.length);
      pending.forEach((callback) => callback(performance.now()));
    }
  };
  return () => {
    request.mockRestore();
    cancel.mockRestore();
    flushOneFrame = () => undefined;
    flushFrames = () => undefined;
  };
}

let flushOneFrame: () => void = () => undefined;
let flushFrames: () => void = () => undefined;
