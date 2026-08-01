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
import type { RequestChatMeasuredItemChange } from "@/components/chat/chat-measured-item-change-context";
import type { ChatViewportAnchorListState } from "@/components/chat/chat-messages-scroll-helpers";
import { makeMessage } from "./chat-message-fixtures";

const TILE_INSTANCE_ID = "find-controller-tile";
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

describe("useChatFindController - measured chain-open on reveal", () => {
  let registeredAdapter: ChatFindAdapter | null;
  let scroller: HTMLElement;
  let anchorRow: HTMLElement;
  let requestMeasuredItemChange: Mock<RequestChatMeasuredItemChange>;
  let getViewportAnchorListState: Mock<
    () => ChatViewportAnchorListState | null
  >;
  let scrollToLocation: Mock;
  let cancelManualNavigation: Mock;
  let setScrolledActiveUserMessageIdIfChanged: Mock;
  let restoreFrames: (() => void) | null;

  beforeEach(() => {
    registeredAdapter = null;
    setFindForcedOpen.mockReset();
    requestMeasuredItemChange = vi.fn((_anchor, mutate) => {
      mutate();
    });
    scrollToLocation = vi.fn();
    cancelManualNavigation = vi.fn();
    setScrolledActiveUserMessageIdIfChanged = vi.fn();

    scroller = document.createElement("div");
    anchorRow = document.createElement("div");
    anchorRow.dataset.messageId = "msg-user";
    const targetRow = document.createElement("div");
    targetRow.dataset.messageId = "msg-assistant";
    scroller.append(anchorRow, targetRow);
    document.body.append(scroller);

    // Row 0 sits at the viewport top (scroll=0, tops at 0 and 100).
    getViewportAnchorListState = vi.fn(() => ({
      scroll: 0,
      positionAtIndex: (index: number) => index * 100,
    }));

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
        return useChatFindController({
          instanceId: TILE_INSTANCE_ID,
          messages,
          messagesRef,
          messageIndexByIdRef,
          getScroller: () => scroller,
          getViewportAnchorListState,
          scrollToLocation,
          cancelManualNavigation,
          setScrolledActiveUserMessageIdIfChanged,
          requestMeasuredItemChange,
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

  it("routes a genuine find reveal's chain-open through requestMeasuredItemChange with the viewport-top anchor", () => {
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

    expect(requestMeasuredItemChange).toHaveBeenCalledTimes(1);
    const [anchorElement, mutate] =
      requestMeasuredItemChange.mock.calls[0] ?? [];
    expect(anchorElement).toBe(anchorRow);
    expect(typeof mutate).toBe("function");

    // Mock already invoked mutate: force-open runs for the subagent body chain.
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

  it("resolves the viewport-top anchor correctly when a header offset is present (decision #18)", () => {
    // Row 0 ("msg-user") is short (content-relative position 0), row 1
    // ("msg-assistant") starts right after it at position 10 - both fall
    // within an 80px header. scroll=80 means the viewport's own top edge
    // sits at content-relative position 0 (row 0's own top) - an unadjusted
    // comparison against raw scroll would spuriously anchor on row 1
    // instead, measuring a row whose position moves with row 0's own growth
    // and reintroducing the self-growth yank the viewport-top anchor exists
    // to prevent.
    getViewportAnchorListState.mockReturnValue({
      scroll: 80,
      positionAtIndex: (index: number) => [0, 10][index],
      topOffsetAdjustment: 80,
    });
    const messages = makeTranscriptWithSubagentBodyNeedle();
    const { getAdapter } = renderController(messages);
    const adapter = getAdapter();

    act(() => {
      void adapter.search({
        requestId: 3,
        query: UNIQUE_NEEDLE,
        matchCase: false,
      });
    });

    expect(requestMeasuredItemChange).toHaveBeenCalledTimes(1);
    const [anchorElement] = requestMeasuredItemChange.mock.calls[0] ?? [];
    expect(anchorElement).toBe(anchorRow);
  });

  it("does not route a passive reconcile through requestMeasuredItemChange", () => {
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
    expect(requestMeasuredItemChange).toHaveBeenCalledTimes(1);
    requestMeasuredItemChange.mockClear();
    setFindForcedOpen.mockClear();

    // Streaming resync of the same active target (navigate: false path).
    act(() => {
      adapter.notifyRowsChanged();
    });

    expect(requestMeasuredItemChange).not.toHaveBeenCalled();
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
