import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { RefObject } from "react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { LegendListRef } from "@legendapp/list/react";
import { ChatTurnMinimap } from "@/components/chat/chat-turn-minimap";
import {
  CHAT_TURN_MINIMAP_END_HIT_PADDING,
  CHAT_TURN_MINIMAP_EXPANDED_HIT_STRIP_WIDTH,
  CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH,
  CHAT_TURN_MINIMAP_KEYBOARD_OWNER_ATTRIBUTE,
} from "@/components/chat/chat-turn-minimap-logic";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import type { ChatTurnMinimapSide } from "@/stores/settings/settings-store";
import type { ChatTabPersistenceIdentity } from "@/stores/chats/chat-tab-persistence-key";
import { isPaneActivationDeferred } from "@/components/epic-canvas/pane-activation";
import {
  evictChatTurnMinimapActiveEntries,
  evictChatTurnMinimapActiveEntryForChat,
  saveChatTurnMinimapActiveEntry,
} from "@/stores/chats/chat-turn-minimap-active-entry-store";
import { makeMessage } from "./chat-message-fixtures";

const DEFAULT_MINIMAP_IDENTITY: ChatTabPersistenceIdentity = {
  tileInstanceId: "minimap-test-tile",
  epicId: "epic-1",
  chatId: "task-1",
};

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  // Ticket 15: active-entry persistence is dual-keyed - clear both halves so
  // a prior test's saved active id does not seed the next mount.
  evictChatTurnMinimapActiveEntries([DEFAULT_MINIMAP_IDENTITY.tileInstanceId]);
  evictChatTurnMinimapActiveEntryForChat(DEFAULT_MINIMAP_IDENTITY);
});

/** Flush the mount-time rAF that measures viewport width / in-view strips. */
async function flushMinimapFrames(frames: number): Promise<void> {
  for (let i = 0; i < frames; i += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    });
  }
}

function makeUser(
  index: number,
  content: string | undefined,
): ChatMessageModel {
  const base = makeMessage(index, "user");
  return content === undefined ? base : { ...base, content };
}

type OnSelectMock = Mock<(messageId: string) => void>;

interface FakeListScrollState {
  readonly scroll: number;
  readonly scrollLength: number;
  readonly positionAtIndex: (index: number) => number | undefined;
  readonly sizeAtIndex: (index: number) => number | undefined;
}

function makeAssistant(index: number, content: string): ChatMessageModel {
  return { ...makeMessage(index, "assistant"), content };
}

function makeA2AUser(index: number, content: string): ChatMessageModel {
  return {
    ...makeMessage(index, "user"),
    content,
    agentSenderInfo: {
      agentId: `agent-${index}`,
      senderTitle: `Agent ${index}`,
      expectReply: false,
      responseId: null,
    },
  };
}

/** Two human user turns with assistant replies. */
function makeTwoTurnTranscript(): ChatMessageModel[] {
  return [
    makeUser(0, "First user turn"),
    makeAssistant(1, "First assistant reply"),
    makeUser(2, "Second user turn"),
    makeAssistant(3, "Second assistant reply"),
  ];
}

/** Three human turns so keyboard End/Home have a clear middle. */
function makeThreeTurnTranscript(): ChatMessageModel[] {
  return [
    makeUser(0, "Turn alpha"),
    makeAssistant(1, "Reply alpha"),
    makeUser(2, "Turn beta"),
    makeAssistant(3, "Reply beta early"),
    makeAssistant(4, "Reply beta final"),
    makeUser(5, "Turn gamma"),
  ];
}

interface FakeListState {
  scroll: number;
  scrollLength: number;
  positions: ReadonlyArray<number>;
  sizes: ReadonlyArray<number>;
}

function createFakeListRef(
  state: FakeListState,
  scrollNode: HTMLElement,
): RefObject<LegendListRef | null> {
  const listState = (): FakeListScrollState => ({
    scroll: state.scroll,
    scrollLength: state.scrollLength,
    positionAtIndex: (index: number) => state.positions[index],
    sizeAtIndex: (index: number) => state.sizes[index],
  });
  const list: Pick<LegendListRef, "getState" | "getScrollableNode"> = {
    getState: () => listState() as never,
    getScrollableNode: () => scrollNode,
  };
  return { current: list as LegendListRef };
}

function mockElementWidth(element: HTMLElement, widthPx: number): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    width: widthPx,
    height: 600,
    top: 0,
    left: 0,
    right: widthPx,
    bottom: 600,
    toJSON: () => ({}),
  });
}

function installControllableResizeObserver(): {
  trigger: () => void;
  restore: () => void;
} {
  let callback: ResizeObserverCallback | null = null;
  const originalResizeObserver = globalThis.ResizeObserver;
  const callbackObserver: ResizeObserver = {
    observe: () => undefined,
    unobserve: () => undefined,
    disconnect: () => undefined,
  };

  class ControllableResizeObserver implements ResizeObserver {
    constructor(nextCallback: ResizeObserverCallback) {
      callback = nextCallback;
    }

    observe(): void {}

    unobserve(): void {}

    disconnect(): void {}
  }

  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: ControllableResizeObserver,
  });
  return {
    restore: () => {
      Object.defineProperty(globalThis, "ResizeObserver", {
        configurable: true,
        writable: true,
        value: originalResizeObserver,
      });
    },
    trigger: () => {
      if (callback === null) {
        throw new Error("ResizeObserver was not installed");
      }
      callback([], callbackObserver);
    },
  };
}

function mockRailGeometry(
  hitStrip: HTMLElement,
  input: { top: number; height: number },
): void {
  vi.spyOn(hitStrip, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: input.top,
    width: 40,
    height: input.height,
    top: input.top,
    left: 0,
    right: 40,
    bottom: input.top + input.height,
    toJSON: () => ({}),
  });
}

const WIDE_VIEWPORT_PX = 1200;
const CONSTRAINED_VIEWPORT_PX = 420;

interface RenderOptions {
  readonly messages: ReadonlyArray<ChatMessageModel>;
  readonly viewportWidth?: number;
  readonly bottomInset?: number;
  readonly listState?: FakeListState;
  readonly inViewRefreshRef?: RefObject<() => void>;
  readonly onSelect?: (messageId: string) => void;
  readonly side?: ChatTurnMinimapSide;
  /** LegendList's live measured header size (decision #18's
   *  topOffsetAdjustment) - defaults to 0 (no header) unless a scenario
   *  specifically needs to pin header-present behavior. */
  readonly topOffsetAdjustment?: number;
}

function renderMinimap(options: RenderOptions): {
  onSelect: OnSelectMock;
  listState: FakeListState;
  scrollNode: HTMLElement;
  viewport: HTMLElement;
  inViewRefreshRef: RefObject<() => void>;
  rerender: (next: RenderOptions) => void;
} {
  const onSelect: OnSelectMock =
    (options.onSelect as OnSelectMock | undefined) ??
    vi.fn<(messageId: string) => void>();
  const listState: FakeListState = options.listState ?? {
    scroll: 0,
    scrollLength: 500,
    // Default: each message row stacked at 100px intervals, all in view initially
    positions: options.messages.map((_m, i) => i * 100),
    sizes: options.messages.map(() => 80),
  };
  const scrollNode = document.createElement("div");
  document.body.appendChild(scrollNode);
  const listRef = createFakeListRef(listState, scrollNode);

  const viewport = document.createElement("div");
  document.body.appendChild(viewport);
  mockElementWidth(viewport, options.viewportWidth ?? WIDE_VIEWPORT_PX);
  const viewportRef = { current: viewport };
  const inViewRefreshRef: RefObject<() => void> = options.inViewRefreshRef ?? {
    current: () => undefined,
  };
  const topOffsetAdjustmentRef = { current: options.topOffsetAdjustment ?? 0 };

  const tree = (
    <ChatTurnMinimap
      messages={options.messages}
      inViewRefreshRef={inViewRefreshRef}
      listRef={listRef}
      topOffsetAdjustmentRef={topOffsetAdjustmentRef}
      viewportRef={viewportRef}
      bottomInset={options.bottomInset ?? 0}
      onSelect={onSelect}
      identity={DEFAULT_MINIMAP_IDENTITY}
      side={options.side ?? "right"}
    />
  );
  const result = render(tree);

  return {
    onSelect,
    listState,
    scrollNode,
    viewport,
    inViewRefreshRef,
    rerender: (next: RenderOptions) => {
      mockElementWidth(viewport, next.viewportWidth ?? WIDE_VIEWPORT_PX);
      topOffsetAdjustmentRef.current = next.topOffsetAdjustment ?? 0;
      result.rerender(
        <ChatTurnMinimap
          messages={next.messages}
          inViewRefreshRef={inViewRefreshRef}
          listRef={listRef}
          topOffsetAdjustmentRef={topOffsetAdjustmentRef}
          viewportRef={viewportRef}
          bottomInset={next.bottomInset ?? 0}
          onSelect={next.onSelect ?? onSelect}
          identity={DEFAULT_MINIMAP_IDENTITY}
          side={next.side ?? "right"}
        />,
      );
    },
  };
}

describe("ChatTurnMinimap item derivation / filtering", () => {
  it("renders nothing when there are no human user queries", () => {
    renderMinimap({
      messages: [
        makeAssistant(0, "assistant-only transcript"),
        makeA2AUser(1, "agent traffic is not a user query"),
        makeMessage(2, "system"),
      ],
    });
    expect(screen.queryByTestId("chat-turn-minimap")).toBeNull();
  });

  it("renders a usable rail for exactly one human user query", async () => {
    renderMinimap({
      messages: [
        makeUser(0, "Only human query"),
        makeAssistant(1, "Only assistant response"),
        makeA2AUser(2, "Agent traffic must not create another marker"),
      ],
    });
    await flushMinimapFrames(2);

    const rail = screen.getByTestId("chat-turn-minimap");
    const strips = rail.querySelectorAll("[data-chat-turn-minimap-strip]");
    expect(strips).toHaveLength(1);
    expect(strips[0].getAttribute("data-message-id")).toBe("message-0");
    expect(screen.getByTestId("chat-turn-minimap-hit-strip")).not.toBeNull();
  });

  it("only human user rows become strips; A2A, assistant, and system are excluded", async () => {
    const messages: ChatMessageModel[] = [
      makeUser(0, "Human one"),
      makeAssistant(1, "Assistant text"),
      makeA2AUser(2, "A2A traffic must not get a strip"),
      makeMessage(3, "system"),
      makeUser(4, "Human two"),
      makeAssistant(5, "Second reply"),
    ];
    renderMinimap({ messages });
    await flushMinimapFrames(2);

    const rail = screen.getByTestId("chat-turn-minimap");
    const strips = rail.querySelectorAll("[data-chat-turn-minimap-strip]");
    expect(strips).toHaveLength(2);
    expect(strips[0].getAttribute("data-message-id")).toBe("message-0");
    expect(strips[1].getAttribute("data-message-id")).toBe("message-4");
    // A2A row id must not appear
    expect(rail.querySelector('[data-message-id="message-2"]')).toBeNull();
  });
});

describe("ChatTurnMinimap preview content", () => {
  it("shows user text + the LAST assistant message before the next user row of any kind", async () => {
    // Turn 0's assistants end when A2A user arrives; turn 1 has no assistant yet.
    const messages: ChatMessageModel[] = [
      makeUser(0, "Prompt A"),
      makeAssistant(1, "Draft reply"),
      makeAssistant(2, "Final reply for A"),
      makeA2AUser(3, "A2A ends the turn lookup"),
      makeUser(4, "Prompt B no reply yet"),
    ];
    renderMinimap({ messages });
    await flushMinimapFrames(2);

    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    mockRailGeometry(hitStrip, { top: 0, height: 100 });

    // Hover near the top → first human turn
    fireEvent.mouseMove(hitStrip, { clientY: 0 });
    const preview = await screen.findByText("Prompt A");
    expect(preview).toBeTruthy();
    const assistantPreview = screen.getByText("Final reply for A");
    expect(assistantPreview).toBeTruthy();
    expect(assistantPreview.classList).toContain("line-clamp-3");
    expect(assistantPreview.classList).not.toContain("block");
    expect(screen.queryByText("Draft reply")).toBeNull();

    // Hover near the bottom → second human turn, no assistant line
    fireEvent.mouseMove(hitStrip, { clientY: 100 });
    expect(await screen.findByText("Prompt B no reply yet")).toBeTruthy();
    expect(screen.queryByText("Final reply for A")).toBeNull();
    // Only the user line is present in the preview panel (no muted assistant span)
    const previewPanel = document.querySelector(
      "[data-chat-turn-minimap-preview]",
    );
    expect(previewPanel).not.toBeNull();
    expect(previewPanel?.classList).toContain(
      "w-[min(20rem,calc(100vw-3rem))]",
    );
    expect(previewPanel?.classList).not.toContain("w-80");
    expect(
      (previewPanel as HTMLElement).querySelectorAll(
        "[data-chat-turn-minimap-assistant]",
      ),
    ).toHaveLength(0);
    // Exactly one text line (the user prompt) inside the card
    expect(
      within(previewPanel as HTMLElement).getByText("Prompt B no reply yet"),
    ).toBeTruthy();
  });

  it("closes the preview on mouseleave", async () => {
    renderMinimap({ messages: makeTwoTurnTranscript() });
    await flushMinimapFrames(2);
    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    const interactionRegion = document.querySelector<HTMLElement>(
      "[data-chat-turn-minimap-interaction-region]",
    );
    mockRailGeometry(hitStrip, { top: 0, height: 100 });
    fireEvent.mouseMove(hitStrip, { clientY: 0 });
    expect(await screen.findByText("First user turn")).toBeTruthy();
    expect(interactionRegion).not.toBeNull();
    fireEvent.mouseLeave(interactionRegion as HTMLElement);
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();
  });
});

describe("ChatTurnMinimap always-on rail", () => {
  it("stays visible and interactive in a constrained or tiled pane", async () => {
    const { onSelect } = renderMinimap({
      messages: makeTwoTurnTranscript(),
      viewportWidth: CONSTRAINED_VIEWPORT_PX,
    });
    await flushMinimapFrames(2);

    const rail = screen.getByTestId("chat-turn-minimap");
    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    expect(rail.classList).toContain("opacity-100");
    expect(rail.classList).not.toContain("opacity-0");
    expect(hitStrip.hasAttribute("inert")).toBe(false);
    expect(hitStrip.getAttribute("aria-hidden")).toBeNull();
    expect(hitStrip.classList.contains("pointer-events-auto")).toBe(true);
    expect(hitStrip.tabIndex).toBe(0);
    expect(hitStrip.style.width).toBe(
      `${CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH}px`,
    );
    expect(
      hitStrip.hasAttribute(CHAT_TURN_MINIMAP_KEYBOARD_OWNER_ATTRIBUTE),
    ).toBe(true);
    mockRailGeometry(hitStrip, { top: 0, height: 100 });
    fireEvent.click(hitStrip, { clientY: 100 });
    expect(onSelect).toHaveBeenCalledWith("message-2");
  });

  it("uses the same fixed edge hit target in a wide pane", async () => {
    renderMinimap({
      messages: makeTwoTurnTranscript(),
      viewportWidth: WIDE_VIEWPORT_PX,
    });
    await flushMinimapFrames(2);
    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    expect(hitStrip.style.width).toBe(
      `${CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH}px`,
    );
  });

  it("keeps a restored active entry collapsed until interaction", async () => {
    saveChatTurnMinimapActiveEntry(DEFAULT_MINIMAP_IDENTITY, "message-2");
    renderMinimap({ messages: makeTwoTurnTranscript() });
    await flushMinimapFrames(2);

    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    expect(hitStrip.style.width).toBe(
      `${CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH}px`,
    );
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();

    fireEvent.focus(hitStrip);

    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).not.toBeNull();
    expect(
      hitStrip.getAttribute("data-chat-turn-minimap-interactive-width"),
    ).toBe(CHAT_TURN_MINIMAP_EXPANDED_HIT_STRIP_WIDTH);
  });
});

describe("ChatTurnMinimap keyboard navigation", () => {
  it("ArrowDown/ArrowUp move the active index (clamped), Home/End jump ends", async () => {
    renderMinimap({ messages: makeThreeTurnTranscript() });
    await flushMinimapFrames(2);
    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");

    fireEvent.focus(hitStrip);
    // Focus seeds activeIndex to 0 when null
    expect(await screen.findByText("Turn alpha")).toBeTruthy();

    fireEvent.keyDown(hitStrip, { key: "ArrowDown" });
    expect(await screen.findByText("Turn beta")).toBeTruthy();

    fireEvent.keyDown(hitStrip, { key: "ArrowDown" });
    expect(await screen.findByText("Turn gamma")).toBeTruthy();

    // Clamped at last
    fireEvent.keyDown(hitStrip, { key: "ArrowDown" });
    expect(screen.getByText("Turn gamma")).toBeTruthy();

    fireEvent.keyDown(hitStrip, { key: "ArrowUp" });
    expect(await screen.findByText("Turn beta")).toBeTruthy();

    fireEvent.keyDown(hitStrip, { key: "Home" });
    expect(await screen.findByText("Turn alpha")).toBeTruthy();

    // Clamped at first
    fireEvent.keyDown(hitStrip, { key: "ArrowUp" });
    expect(screen.getByText("Turn alpha")).toBeTruthy();

    fireEvent.keyDown(hitStrip, { key: "End" });
    expect(await screen.findByText("Turn gamma")).toBeTruthy();
  });

  it("Enter and Space select the active item; Enter with no active item is a no-op", async () => {
    const { onSelect } = renderMinimap({
      messages: makeThreeTurnTranscript(),
    });
    await flushMinimapFrames(2);
    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");

    // No focus / no active → Enter no-ops
    fireEvent.keyDown(hitStrip, { key: "Enter" });
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.focus(hitStrip);
    expect(await screen.findByText("Turn alpha")).toBeTruthy();
    fireEvent.keyDown(hitStrip, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("message-0");
    onSelect.mockClear();

    fireEvent.keyDown(hitStrip, { key: "ArrowDown" });
    expect(await screen.findByText("Turn beta")).toBeTruthy();
    fireEvent.keyDown(hitStrip, { key: " " });
    expect(onSelect).toHaveBeenCalledWith("message-2");
  });

  it("End then Enter selects the last item's message id (frame between keys)", async () => {
    const { onSelect } = renderMinimap({
      messages: makeThreeTurnTranscript(),
    });
    await flushMinimapFrames(2);
    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");

    fireEvent.keyDown(hitStrip, { key: "End" });
    await flushMinimapFrames(1);
    fireEvent.keyDown(hitStrip, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("message-5");
  });
});

describe("ChatTurnMinimap mouse interaction", () => {
  it("adds invisible pointer room beyond the first and last visible strips", async () => {
    renderMinimap({ messages: makeThreeTurnTranscript() });
    await flushMinimapFrames(2);

    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    const interactionRegion = document.querySelector<HTMLElement>(
      "[data-chat-turn-minimap-interaction-region]",
    );
    const firstStrip = document.querySelector<HTMLElement>(
      '[data-chat-turn-minimap-strip][data-message-id="message-0"]',
    );
    const lastStrip = document.querySelector<HTMLElement>(
      '[data-chat-turn-minimap-strip][data-message-id="message-5"]',
    );

    expect(firstStrip?.style.top).toBe(
      `calc(0% + ${CHAT_TURN_MINIMAP_END_HIT_PADDING}px)`,
    );
    expect(lastStrip?.style.top).toBe(
      `calc(100% - ${CHAT_TURN_MINIMAP_END_HIT_PADDING}px)`,
    );
    expect(hitStrip.parentElement).toBe(interactionRegion);
    expect(hitStrip.classList).toContain("h-full");
    expect(hitStrip.style.height).toBe("");

    mockRailGeometry(hitStrip, { top: 0, height: 40 });
    fireEvent.mouseMove(hitStrip, { clientY: 15 });
    expect(await screen.findByText("Turn alpha")).toBeTruthy();
    fireEvent.mouseMove(hitStrip, { clientY: 25 });
    expect(await screen.findByText("Turn gamma")).toBeTruthy();
  });

  it("mousemove maps pointer Y to nearest index and opens the preview", async () => {
    renderMinimap({ messages: makeThreeTurnTranscript() });
    await flushMinimapFrames(2);
    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    mockRailGeometry(hitStrip, { top: 100, height: 200 });

    fireEvent.mouseMove(hitStrip, { clientY: 100 }); // first
    expect(await screen.findByText("Turn alpha")).toBeTruthy();

    fireEvent.mouseMove(hitStrip, { clientY: 200 }); // middle
    expect(await screen.findByText("Turn beta")).toBeTruthy();

    fireEvent.mouseMove(hitStrip, { clientY: 300 }); // last
    expect(await screen.findByText("Turn gamma")).toBeTruthy();
  });

  it("click resolves nearest index and calls onSelect with that message id, then blurs", async () => {
    const { onSelect } = renderMinimap({
      messages: makeThreeTurnTranscript(),
    });
    await flushMinimapFrames(2);
    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    mockRailGeometry(hitStrip, { top: 100, height: 200 });
    const blurSpy = vi.spyOn(hitStrip, "blur");

    fireEvent.click(hitStrip, { clientY: 200 });
    expect(onSelect).toHaveBeenCalledWith("message-2");
    expect(blurSpy).toHaveBeenCalled();
  });

  it("clicking the preview card selects its message", async () => {
    const { onSelect } = renderMinimap({
      messages: makeTwoTurnTranscript(),
    });
    await flushMinimapFrames(2);
    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    mockRailGeometry(hitStrip, { top: 0, height: 100 });
    fireEvent.mouseMove(hitStrip, { clientY: 0 });

    await screen.findByText("First user turn");
    const previewCard = document.querySelector("[data-chat-turn-minimap-card]");
    expect(previewCard).not.toBeNull();
    fireEvent.click(previewCard as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith("message-0");
  });

  it("explains both expand and collapse controls in keyboard-accessible tooltips", async () => {
    renderMinimap({ messages: makeThreeTurnTranscript() });
    await flushMinimapFrames(2);
    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    mockRailGeometry(hitStrip, { top: 0, height: 100 });
    fireEvent.mouseMove(hitStrip, { clientY: 50 });

    const expandButton = await screen.findByRole("button", {
      name: "Expand all messages",
    });
    fireEvent.focus(expandButton);
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Expand all messages",
    );
    fireEvent.blur(expandButton, { relatedTarget: hitStrip });
    fireEvent.click(expandButton);

    const collapseButton = screen.getByRole("button", {
      name: "Collapse message list",
    });
    fireEvent.focus(collapseButton);
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Collapse message list",
    );
  });

  it("finishes minimap actions before an inactive canvas pane activates on the same click", async () => {
    const order: string[] = [];
    const onSelect = vi.fn<(messageId: string) => void>((messageId) => {
      order.push(`select:${messageId}`);
    });
    renderMinimap({
      messages: makeThreeTurnTranscript(),
      onSelect,
    });
    await flushMinimapFrames(2);
    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    mockRailGeometry(hitStrip, { top: 0, height: 100 });
    fireEvent.mouseMove(hitStrip, { clientY: 50 });
    const expandButton = await screen.findByRole("button", {
      name: "Expand all messages",
    });
    expect(isPaneActivationDeferred(expandButton)).toBe(true);

    const activatePaneAfterClick = (): void => {
      order.push("activate");
    };
    document.addEventListener("click", activatePaneAfterClick);
    try {
      fireEvent.pointerDown(expandButton);
      fireEvent.click(expandButton);
      expect(order).toEqual(["activate"]);
      expect(
        screen.getByRole("button", { name: "Collapse message list" }),
      ).toBeTruthy();

      const lastMessage = screen.getByRole("button", {
        name: "Jump to message: Turn gamma",
      });
      expect(isPaneActivationDeferred(lastMessage)).toBe(true);
      order.length = 0;
      fireEvent.pointerDown(lastMessage);
      fireEvent.click(lastMessage);
      expect(order).toEqual(["select:message-5", "activate"]);
      expect(onSelect).toHaveBeenCalledWith("message-5");
    } finally {
      document.removeEventListener("click", activatePaneAfterClick);
    }
  });

  it("expands in place to a scrollable serial list and keeps every card selectable", async () => {
    const { onSelect } = renderMinimap({
      messages: makeThreeTurnTranscript(),
    });
    await flushMinimapFrames(2);
    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    mockRailGeometry(hitStrip, { top: 0, height: 100 });
    fireEvent.mouseMove(hitStrip, { clientY: 50 });

    fireEvent.click(
      await screen.findByRole("button", { name: "Expand all messages" }),
    );

    const collapseButton = screen.getByRole("button", {
      name: "Collapse message list",
    });
    expect(collapseButton.getAttribute("data-variant")).toBe("ghost");
    expect(
      hitStrip.getAttribute("data-chat-turn-minimap-interactive-width"),
    ).toBe(CHAT_TURN_MINIMAP_EXPANDED_HIT_STRIP_WIDTH);
    expect(
      collapseButton.querySelector(".lucide-fold-vertical"),
    ).not.toBeNull();
    const messageCards = document.querySelectorAll(
      "[data-chat-turn-minimap-list-item]",
    );
    expect(messageCards).toHaveLength(3);
    expect(screen.queryByText("User messages · 3")).toBeNull();
    expect(screen.queryByText("Message 1")).toBeNull();
    expect(screen.getByText("Turn alpha")).toBeTruthy();
    expect(screen.getByText("Turn beta")).toBeTruthy();
    expect(screen.getByText("Turn gamma")).toBeTruthy();
    expect(messageCards[0].textContent).toBe("Turn alpha");
    expect(messageCards[1].textContent).toBe("Turn beta");
    expect(messageCards[2].textContent).toBe("Turn gamma");
    expect(messageCards[0].classList).toContain("hover:bg-foreground/[0.08]");
    expect(messageCards[1].getAttribute("data-active")).toBe("true");
    expect(messageCards[1].getAttribute("aria-current")).toBe("true");
    expect(messageCards[1].classList).toContain("bg-foreground/[0.13]");
    expect(messageCards[0].getAttribute("data-active")).toBe("false");
    expect(screen.queryByText("Reply alpha")).toBeNull();
    expect(screen.queryByText("Reply beta final")).toBeNull();
    const expandedPanel = document.querySelector<HTMLElement>(
      "[data-chat-turn-minimap-preview] > div",
    );
    const listScroller = document.querySelector<HTMLElement>(
      "[data-chat-turn-minimap-list-scroll]",
    );
    expect(expandedPanel?.classList).toContain(
      "max-h-[min(60vh,calc(100cqh_-_1rem))]",
    );
    expect(expandedPanel?.classList).toContain("overflow-hidden");
    expect(listScroller?.classList).toContain("overflow-y-auto");

    fireEvent.click(messageCards[2]);
    expect(onSelect).toHaveBeenCalledWith("message-5");
    expect(messageCards[2].getAttribute("data-active")).toBe("true");
    expect(messageCards[1].getAttribute("data-active")).toBe("false");
    expect(
      screen.getByRole("button", { name: "Collapse message list" }),
    ).toBeTruthy();
  });

  it("shows expanded user queries for up to three intrinsic lines", async () => {
    const longQuery =
      "Explain how the inactive pane activation contract should preserve a newly opened portalled control while route synchronization catches up";
    renderMinimap({
      messages: [
        makeUser(0, longQuery),
        makeAssistant(1, "Long query reply"),
        makeUser(2, "Short query"),
      ],
    });
    await flushMinimapFrames(2);
    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    mockRailGeometry(hitStrip, { top: 0, height: 100 });
    fireEvent.mouseMove(hitStrip, { clientY: 0 });
    fireEvent.click(
      await screen.findByRole("button", { name: "Expand all messages" }),
    );

    const longText = screen
      .getByRole("button", { name: `Jump to message: ${longQuery}` })
      .querySelector<HTMLElement>("[data-chat-turn-minimap-user-text]");
    const shortText = screen
      .getByRole("button", { name: "Jump to message: Short query" })
      .querySelector<HTMLElement>("[data-chat-turn-minimap-user-text]");

    expect(longText?.classList).toContain("line-clamp-3");
    expect(longText?.classList).toContain("whitespace-normal");
    expect(longText?.classList).toContain("break-words");
    expect(longText?.classList).not.toContain("whitespace-nowrap");
    expect(shortText?.classList).toContain("line-clamp-3");
    expect(shortText?.classList).not.toContain("min-h-[3.75rem]");
  });

  it("dismisses the expanded list when the pointer leaves the whole interaction region", async () => {
    renderMinimap({ messages: makeThreeTurnTranscript() });
    await flushMinimapFrames(2);
    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    const interactionRegion = document.querySelector<HTMLElement>(
      "[data-chat-turn-minimap-interaction-region]",
    );
    mockRailGeometry(hitStrip, { top: 0, height: 100 });
    fireEvent.mouseMove(hitStrip, { clientY: 50 });
    const expandButton = await screen.findByRole("button", {
      name: "Expand all messages",
    });
    expect(expandButton.getAttribute("data-variant")).toBe("ghost");
    expect(
      expandButton.querySelector(".lucide-unfold-vertical"),
    ).not.toBeNull();
    fireEvent.click(expandButton);

    expect(interactionRegion).not.toBeNull();
    fireEvent.mouseLeave(interactionRegion as HTMLElement);

    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();
    fireEvent.mouseMove(hitStrip, { clientY: 50 });
    expect(
      await screen.findByRole("button", { name: "Expand all messages" }),
    ).toBeTruthy();
  });

  it("keeps the panel open while focus moves within it, then closes when focus leaves", async () => {
    renderMinimap({ messages: makeThreeTurnTranscript() });
    await flushMinimapFrames(2);
    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    const outsideButton = document.createElement("button");
    document.body.appendChild(outsideButton);

    fireEvent.focus(hitStrip);
    const expandButton = await screen.findByRole("button", {
      name: "Expand all messages",
    });
    fireEvent.blur(hitStrip, { relatedTarget: expandButton });
    fireEvent.focus(expandButton);
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).not.toBeNull();

    fireEvent.click(expandButton);
    const activeMessage = screen.getByRole("button", {
      name: "Jump to message: Turn alpha",
    });
    fireEvent.focus(activeMessage);
    fireEvent.blur(activeMessage, { relatedTarget: outsideButton });

    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();
  });

  it("lets Escape collapse from any expanded-list item and dismiss the compact preview", async () => {
    renderMinimap({ messages: makeThreeTurnTranscript() });
    await flushMinimapFrames(2);
    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    mockRailGeometry(hitStrip, { top: 0, height: 100 });
    fireEvent.mouseMove(hitStrip, { clientY: 50 });
    fireEvent.click(
      await screen.findByRole("button", { name: "Expand all messages" }),
    );
    const activeMessage = screen.getByRole("button", {
      name: "Jump to message: Turn beta",
    });

    fireEvent.keyDown(activeMessage, { key: "Escape" });
    expect(
      screen.getByRole("button", { name: "Expand all messages" }),
    ).toBeTruthy();
    expect(document.activeElement).toBe(hitStrip);

    fireEvent.keyDown(hitStrip, { key: "Escape" });
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();
  });
});

describe("ChatTurnMinimap side placement", () => {
  it("places the rail and inward-opening preview on the configured side", async () => {
    renderMinimap({ messages: makeTwoTurnTranscript(), side: "left" });
    await flushMinimapFrames(2);
    const rail = screen.getByTestId("chat-turn-minimap");
    expect(rail.dataset.side).toBe("left");
    expect(rail.classList).toContain("left-0");

    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    expect(hitStrip.parentElement?.classList).toContain("left-3");
    mockRailGeometry(hitStrip, { top: 0, height: 100 });
    fireEvent.mouseMove(hitStrip, { clientY: 0 });
    const preview = document.querySelector("[data-chat-turn-minimap-preview]");
    expect(preview?.classList).toContain("left-8");
  });

  it("places the rail on the right when configured with the default side", async () => {
    renderMinimap({ messages: makeTwoTurnTranscript() });
    await flushMinimapFrames(2);
    const rail = screen.getByTestId("chat-turn-minimap");
    expect(rail.dataset.side).toBe("right");
    expect(rail.classList).toContain("right-0");
  });
});

describe("ChatTurnMinimap in-view highlighting", () => {
  it("marks strips whose list rows intersect the scrolled viewport band", async () => {
    // Two human turns at message indices 0 and 2.
    const messages = makeTwoTurnTranscript();
    // Row 0 fully above the band; row 2 (second user at list index 2) in view.
    const listState: FakeListState = {
      scroll: 200,
      scrollLength: 300, // band [200, 500)
      positions: [0, 80, 250, 330],
      sizes: [60, 60, 60, 60],
    };
    renderMinimap({ messages, listState });
    await flushMinimapFrames(3);

    const strip0 = document.querySelector(
      '[data-chat-turn-minimap-strip][data-message-id="message-0"]',
    );
    const strip2 = document.querySelector(
      '[data-chat-turn-minimap-strip][data-message-id="message-2"]',
    );
    expect(strip0).not.toBeNull();
    expect(strip2).not.toBeNull();
    await waitFor(() => {
      expect(strip0?.getAttribute("data-in-view")).toBe("false");
      expect(strip2?.getAttribute("data-in-view")).toBe("true");
    });
  });

  it("lights the nearest user-message strip when no query is in view", async () => {
    const messages = makeTwoTurnTranscript();
    const listState: FakeListState = {
      scroll: 150,
      scrollLength: 50, // gap [150, 200): first user ends at 60, second starts at 250
      positions: [0, 80, 250, 330],
      sizes: [60, 60, 60, 60],
    };
    const { inViewRefreshRef } = renderMinimap({ messages, listState });
    await flushMinimapFrames(3);

    const firstStrip = document.querySelector(
      '[data-chat-turn-minimap-strip][data-message-id="message-0"]',
    );
    const secondStrip = document.querySelector(
      '[data-chat-turn-minimap-strip][data-message-id="message-2"]',
    );
    await waitFor(() => {
      expect(firstStrip?.getAttribute("data-in-view")).toBe("false");
      expect(secondStrip?.getAttribute("data-in-view")).toBe("false");
      expect(firstStrip?.getAttribute("data-proximity")).toBe("false");
      expect(secondStrip?.getAttribute("data-proximity")).toBe("true");
    });

    listState.scroll = 70;
    act(() => inViewRefreshRef.current());

    expect(firstStrip?.getAttribute("data-proximity")).toBe("true");
    expect(secondStrip?.getAttribute("data-proximity")).toBe("false");

    // Equal distance above and below: keep the earlier marker stable rather
    // than flickering between neighbors at the exact midpoint.
    listState.scroll = 155;
    listState.scrollLength = 0;
    act(() => inViewRefreshRef.current());
    expect(firstStrip?.getAttribute("data-proximity")).toBe("true");
    expect(secondStrip?.getAttribute("data-proximity")).toBe("false");

    // Far beyond the transcript: the final real query remains the anchor.
    listState.scroll = 1_000;
    listState.scrollLength = 50;
    act(() => inViewRefreshRef.current());
    expect(firstStrip?.getAttribute("data-proximity")).toBe("false");
    expect(secondStrip?.getAttribute("data-proximity")).toBe("true");
  });

  it("does not add a proximity highlight while real query rows are visible", async () => {
    const messages = makeTwoTurnTranscript();
    const listState: FakeListState = {
      scroll: 0,
      scrollLength: 300,
      positions: [0, 80, 250, 330],
      sizes: [60, 60, 60, 60],
    };
    renderMinimap({ messages, listState });
    await flushMinimapFrames(3);

    const strips = document.querySelectorAll("[data-chat-turn-minimap-strip]");
    await waitFor(() => {
      expect(
        [...strips].filter(
          (strip) => strip.getAttribute("data-in-view") === "true",
        ),
      ).toHaveLength(2);
      expect(
        [...strips].filter(
          (strip) => strip.getAttribute("data-proximity") === "true",
        ),
      ).toHaveLength(0);
    });
  });

  it("keeps a deterministic real marker lit while row measurements are temporarily unavailable", async () => {
    const messages = makeTwoTurnTranscript();
    renderMinimap({
      messages,
      listState: {
        scroll: 0,
        scrollLength: 300,
        positions: [],
        sizes: [],
      },
    });
    await flushMinimapFrames(3);

    const firstStrip = document.querySelector(
      '[data-chat-turn-minimap-strip][data-message-id="message-0"]',
    );
    const secondStrip = document.querySelector(
      '[data-chat-turn-minimap-strip][data-message-id="message-2"]',
    );
    await waitFor(() => {
      expect(firstStrip?.getAttribute("data-proximity")).toBe("true");
      expect(secondStrip?.getAttribute("data-proximity")).toBe("false");
    });
  });

  it("does not rewrite marker attributes when repeated scroll refreshes resolve the same state", async () => {
    const messages = makeTwoTurnTranscript();
    const { inViewRefreshRef } = renderMinimap({
      messages,
      listState: {
        scroll: 150,
        scrollLength: 50,
        positions: [0, 80, 250, 330],
        sizes: [60, 60, 60, 60],
      },
    });
    await flushMinimapFrames(3);

    const rail = screen.getByTestId("chat-turn-minimap");
    const observer = new MutationObserver(() => undefined);
    observer.observe(rail, {
      attributes: true,
      attributeFilter: ["data-in-view", "data-proximity"],
      subtree: true,
    });

    act(() => inViewRefreshRef.current());

    expect(observer.takeRecords()).toHaveLength(0);
    observer.disconnect();
  });

  it("excludes rows hidden behind the bottom overlay inset", async () => {
    const messages = makeTwoTurnTranscript();
    const listState: FakeListState = {
      scroll: 0,
      scrollLength: 300,
      positions: [0, 80, 250, 330],
      sizes: [60, 60, 60, 60],
    };
    renderMinimap({ messages, listState, bottomInset: 100 });
    await flushMinimapFrames(3);

    const firstStrip = document.querySelector(
      '[data-chat-turn-minimap-strip][data-message-id="message-0"]',
    );
    const coveredStrip = document.querySelector(
      '[data-chat-turn-minimap-strip][data-message-id="message-2"]',
    );
    await waitFor(() => {
      expect(firstStrip?.getAttribute("data-in-view")).toBe("true");
      expect(coveredStrip?.getAttribute("data-in-view")).toBe("false");
    });
  });

  // O2 (ticket 16 listener consolidation): the minimap no longer attaches its own scroll
  // listener to the list's scrollable node - production now drives this via
  // `inViewRefreshRef`, invoked from ChatTimeline's own `onScroll` callback
  // (chat-messages.tsx's `handleScroll`). This pin exercises the same
  // scroll-position-changed scenario the old native-listener test covered,
  // through the new caller-driven contract instead of a raw DOM event.
  it("updates data-in-view when the caller notifies a scroll position change", async () => {
    const messages = makeTwoTurnTranscript();
    const listState: FakeListState = {
      scroll: 0,
      scrollLength: 100, // band [0, 100) - only row 0 intersects
      positions: [0, 80, 250, 330],
      sizes: [60, 60, 60, 60],
    };
    const { inViewRefreshRef } = renderMinimap({ messages, listState });
    await flushMinimapFrames(3);

    const strip0 = document.querySelector(
      '[data-chat-turn-minimap-strip][data-message-id="message-0"]',
    );
    const strip2 = document.querySelector(
      '[data-chat-turn-minimap-strip][data-message-id="message-2"]',
    );
    await waitFor(() => {
      expect(strip0?.getAttribute("data-in-view")).toBe("true");
      expect(strip2?.getAttribute("data-in-view")).toBe("false");
    });

    // Scroll the band over the second user row
    listState.scroll = 200;
    listState.scrollLength = 300;
    act(() => {
      inViewRefreshRef.current();
    });

    expect(strip0?.getAttribute("data-in-view")).toBe("false");
    expect(strip2?.getAttribute("data-in-view")).toBe("true");
  });

  it("does not update data-in-view on a raw scroll DOM event with no caller-driven refresh (no second listener)", async () => {
    const messages = makeTwoTurnTranscript();
    const listState: FakeListState = {
      scroll: 0,
      scrollLength: 100, // band [0, 100) - only row 0 intersects
      positions: [0, 80, 250, 330],
      sizes: [60, 60, 60, 60],
    };
    const { scrollNode } = renderMinimap({ messages, listState });
    await flushMinimapFrames(3);

    const strip0 = document.querySelector(
      '[data-chat-turn-minimap-strip][data-message-id="message-0"]',
    );
    const strip2 = document.querySelector(
      '[data-chat-turn-minimap-strip][data-message-id="message-2"]',
    );
    await waitFor(() => {
      expect(strip0?.getAttribute("data-in-view")).toBe("true");
      expect(strip2?.getAttribute("data-in-view")).toBe("false");
    });

    listState.scroll = 200;
    listState.scrollLength = 300;
    fireEvent.scroll(scrollNode);
    // No inViewRefreshRef call follows - the strips must NOT have moved,
    // since the component owns no listener of its own on this node anymore.
    expect(strip0?.getAttribute("data-in-view")).toBe("true");
    expect(strip2?.getAttribute("data-in-view")).toBe("false");
  });

  it("updates data-in-view when LegendList reports a row remeasurement", async () => {
    const messages = makeTwoTurnTranscript();
    const listState: FakeListState = {
      scroll: 0,
      scrollLength: 300,
      positions: [0, 80, 180, 260],
      sizes: [60, 60, 60, 60],
    };
    const { inViewRefreshRef } = renderMinimap({ messages, listState });
    await flushMinimapFrames(3);

    const secondStrip = document.querySelector(
      '[data-chat-turn-minimap-strip][data-message-id="message-2"]',
    );
    expect(secondStrip?.getAttribute("data-in-view")).toBe("true");

    // An expanded row above the second user message moves it below the band
    // without changing messages or scrollTop.
    listState.positions = [0, 80, 380, 460];
    act(() => {
      inViewRefreshRef.current();
    });

    expect(secondStrip?.getAttribute("data-in-view")).toBe("false");
  });

  it("updates data-in-view when a pane resize changes the list viewport", async () => {
    const resizeObserver = installControllableResizeObserver();
    try {
      const messages = makeTwoTurnTranscript();
      const listState: FakeListState = {
        scroll: 0,
        scrollLength: 300,
        positions: [0, 80, 250, 330],
        sizes: [60, 60, 60, 60],
      };
      renderMinimap({ messages, listState });
      await flushMinimapFrames(3);

      const secondStrip = document.querySelector(
        '[data-chat-turn-minimap-strip][data-message-id="message-2"]',
      );
      expect(secondStrip?.getAttribute("data-in-view")).toBe("true");

      listState.scrollLength = 200;
      act(() => resizeObserver.trigger());

      expect(secondStrip?.getAttribute("data-in-view")).toBe("false");
    } finally {
      resizeObserver.restore();
    }
  });
});

describe("ChatTurnMinimap selection → onSelect contract", () => {
  it("keyboard End+Enter delivers the last human turn's message id", async () => {
    const { onSelect } = renderMinimap({
      messages: makeThreeTurnTranscript(),
    });
    await flushMinimapFrames(2);
    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    fireEvent.keyDown(hitStrip, { key: "End" });
    await flushMinimapFrames(1);
    fireEvent.keyDown(hitStrip, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("message-5");
  });

  it("mouse click at a given Y delivers the nearest item's message id", async () => {
    const { onSelect } = renderMinimap({
      messages: makeThreeTurnTranscript(),
    });
    await flushMinimapFrames(2);
    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    mockRailGeometry(hitStrip, { top: 0, height: 100 });
    // progress ~1 → last item
    fireEvent.click(hitStrip, { clientY: 100 });
    expect(onSelect).toHaveBeenCalledWith("message-5");
  });
});

describe("ChatTurnMinimap bottomInset", () => {
  it("applies a non-negative bottom style from bottomInset", async () => {
    renderMinimap({
      messages: makeTwoTurnTranscript(),
      bottomInset: 84.2,
    });
    await flushMinimapFrames(2);
    const rail = screen.getByTestId("chat-turn-minimap");
    expect(rail.style.bottom).toBe("85px"); // ceil
  });
});
