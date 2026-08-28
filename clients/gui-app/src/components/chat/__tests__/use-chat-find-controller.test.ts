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
import { makeMessage } from "./chat-message-fixtures";

const TILE_INSTANCE_ID = "find-controller-tile";
const EMPTY_BACKGROUND_TOOL_BLOCK_IDS: ReadonlySet<string> = new Set<string>();
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
    scrollToLocation = vi.fn();
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

  function renderController(messages: ReadonlyArray<ChatMessageModel>): {
    readonly getAdapter: () => ChatFindAdapter;
    readonly forceStore: StoreApi<ChatFindForceState>;
    readonly getController: () => {
      readonly scheduleMountedHighlightSync: () => void;
    };
    readonly rerenderMessages: (
      messages: ReadonlyArray<ChatMessageModel>,
    ) => void;
  } {
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
      (currentMessages: ReadonlyArray<ChatMessageModel>) => {
        const messagesRef = useRef(currentMessages);
        messagesRef.current = currentMessages;
        const messageIndexByIdRef = useRef(
          new Map(
            currentMessages.map(
              (message, index) => [message.id, index] as const,
            ),
          ),
        );
        messageIndexByIdRef.current = new Map(
          currentMessages.map((message, index) => [message.id, index] as const),
        );
        const backgroundToolBlockIdsRef = useRef<ReadonlySet<string>>(
          EMPTY_BACKGROUND_TOOL_BLOCK_IDS,
        );
        controller = useChatFindController({
          instanceId: TILE_INSTANCE_ID,
          messages: currentMessages,
          messagesRef,
          backgroundToolBlockIds: EMPTY_BACKGROUND_TOOL_BLOCK_IDS,
          backgroundToolBlockIdsRef,
          messageIndexByIdRef,
          getScroller: () => scroller,
          scrollToLocation,
          cancelManualNavigation,
          setScrolledActiveUserMessageIdIfChanged,
        });
        return controller;
      },
      { initialProps: messages, wrapper: Wrapper },
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
      rerenderMessages: (nextMessages) => rendered.rerender(nextMessages),
    };
  }

  it("force-opens the owning chain on a genuine find reveal", () => {
    const messages = makeTranscriptWithSubagentBodyNeedle();
    const { getAdapter, forceStore } = renderController(messages);
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
    const { getAdapter, forceStore } = renderController(messages);
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
    const { getAdapter, getController, forceStore } =
      renderController(messages);
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
    const { getAdapter, forceStore, rerenderMessages } =
      renderController(messages);
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
        title: null,
        description: null,
        questions: [
          {
            questionId: "q1",
            question: "Which detail?",
            header: null,
            options: [],
            multiSelect: false,
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
