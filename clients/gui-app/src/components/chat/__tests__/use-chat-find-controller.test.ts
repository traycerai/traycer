import "../../../../__tests__/test-browser-apis";

import { act, cleanup, renderHook } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { ReactNode } from "react";
import { createElement, useRef } from "react";
import type { ChatFindAdapter } from "@/components/chat/chat-find";
import type { TileFindAdapter } from "@/stores/tile-find";
import { TileFindContext } from "@/components/epic-canvas/tile-find/tile-find-adapter-context";
import { useChatFindController } from "@/components/chat/use-chat-find-controller";
import {
  createChatCollapsibleKey,
  derivePromotedSubagentRenderId,
  serializeChatCollapsibleKey,
} from "@/components/chat/chat-collapsible-key";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import type { ChatCollapsibleKey } from "@/components/chat/chat-collapsible-key";
import { makeMessage } from "./chat-message-fixtures";

const TILE_INSTANCE_ID = "find-controller-tile";
const EMPTY_BACKGROUND_TOOL_BLOCK_IDS: ReadonlySet<string> = new Set<string>();
const SUBAGENT_ID = "subagent-find-ctrl";
const UNIQUE_NEEDLE = "find-ctrl-unique-needle-xyz";

const setFindForcedOpen = vi.hoisted(() =>
  vi.fn<(key: ChatCollapsibleKey, open: boolean) => void>(),
);

vi.mock(
  "@/stores/chats/chat-find-force-store-context",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/stores/chats/chat-find-force-store-context")
      >();
    return {
      ...actual,
      useSetChatFindForcedOpen: () => setFindForcedOpen,
    };
  },
);

describe("useChatFindController - chain-open on reveal", () => {
  let registeredAdapter: ChatFindAdapter | null;
  let scroller: HTMLElement;
  let scrollToLocation: Mock;
  let cancelManualNavigation: Mock;
  let setScrolledActiveUserMessageIdIfChanged: Mock;
  let restoreFrames: (() => void) | null;

  beforeEach(() => {
    registeredAdapter = null;
    setFindForcedOpen.mockReset();
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
  } {
    const messageIndexById = new Map(
      messages.map((message, index) => [message.id, index] as const),
    );

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

    function Wrapper(props: { readonly children: ReactNode }) {
      return createElement(
        TileFindContext.Provider,
        { value: tileFindContext },
        props.children,
      );
    }

    renderHook(
      () => {
        const messagesRef = useRef(messages);
        messagesRef.current = messages;
        const messageIndexByIdRef = useRef(messageIndexById);
        messageIndexByIdRef.current = messageIndexById;
        const backgroundToolBlockIdsRef = useRef<ReadonlySet<string>>(
          EMPTY_BACKGROUND_TOOL_BLOCK_IDS,
        );
        return useChatFindController({
          instanceId: TILE_INSTANCE_ID,
          messages,
          messagesRef,
          backgroundToolBlockIds: EMPTY_BACKGROUND_TOOL_BLOCK_IDS,
          backgroundToolBlockIdsRef,
          messageIndexByIdRef,
          getScroller: () => scroller,
          scrollToLocation,
          cancelManualNavigation,
          setScrolledActiveUserMessageIdIfChanged,
        });
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
    };
  }

  it("force-opens the owning chain on a genuine find reveal", () => {
    const messages = makeTranscriptWithSubagentBodyNeedle();
    const { getAdapter } = renderController(messages);
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
      setFindForcedOpen.mock.calls.some(
        ([key, open]) =>
          open &&
          serializeChatCollapsibleKey(key) ===
            serializeChatCollapsibleKey(expectedKey),
      ),
    ).toBe(true);
  });

  it("does not re-force-open on a passive reconcile of the same target", () => {
    const messages = makeTranscriptWithSubagentBodyNeedle();
    const { getAdapter } = renderController(messages);
    const adapter = getAdapter();

    act(() => {
      void adapter.search({
        requestId: 2,
        query: UNIQUE_NEEDLE,
        matchCase: false,
      });
    });
    expect(setFindForcedOpen.mock.calls.length).toBeGreaterThan(0);
    setFindForcedOpen.mockClear();

    // Streaming resync of the same active target (navigate: false path).
    act(() => {
      adapter.notifyRowsChanged();
    });

    expect(setFindForcedOpen).not.toHaveBeenCalled();
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
  return () => {
    request.mockRestore();
    cancel.mockRestore();
  };
}
