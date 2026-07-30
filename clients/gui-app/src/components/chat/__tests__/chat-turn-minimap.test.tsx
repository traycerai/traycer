import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createRef, type RefObject } from "react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { LegendListRef } from "@legendapp/list/react";
import { ChatTurnMinimap } from "@/components/chat/chat-turn-minimap";
import {
  CHAT_TURN_MINIMAP_CONTENT_MAX_WIDTH,
  CHAT_TURN_MINIMAP_HIT_STRIP_LEFT,
  CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH,
  CHAT_TURN_MINIMAP_KEYBOARD_OWNER_ATTRIBUTE,
  CHAT_TURN_MINIMAP_PERSISTENT_GUTTER,
} from "@/components/chat/chat-turn-minimap-logic";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import { makeMessage } from "./chat-message-fixtures";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
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

/** Two human user turns (min rail) with assistant replies. */
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

/** Viewport wide enough for a non-zero hit-strip (and persistent gutter). */
const WIDE_VIEWPORT_PX =
  CHAT_TURN_MINIMAP_CONTENT_MAX_WIDTH +
  (CHAT_TURN_MINIMAP_HIT_STRIP_LEFT + CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH) *
    2;
/** 780px pane → 6px side gutter → hitStripWidth 0 (M3b pin). */
const ZERO_BUDGET_VIEWPORT_PX = 780;
/** Side gutter just under the 48px persistent threshold, but > 12 so the strip is live. */
const HOVER_ONLY_VIEWPORT_PX =
  CHAT_TURN_MINIMAP_CONTENT_MAX_WIDTH +
  (CHAT_TURN_MINIMAP_PERSISTENT_GUTTER - 1) * 2;

interface RenderOptions {
  readonly messages: ReadonlyArray<ChatMessageModel>;
  readonly viewportWidth?: number;
  readonly bottomInset?: number;
  readonly listState?: FakeListState;
  readonly onSelect?: (messageId: string) => void;
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
  const topOffsetAdjustmentRef = { current: options.topOffsetAdjustment ?? 0 };

  const tree = (
    <ChatTurnMinimap
      messages={options.messages}
      listRef={listRef}
      topOffsetAdjustmentRef={topOffsetAdjustmentRef}
      viewportRef={viewportRef}
      bottomInset={options.bottomInset ?? 0}
      onSelect={onSelect}
    />
  );
  const result = render(tree);

  return {
    onSelect,
    listState,
    scrollNode,
    viewport,
    rerender: (next: RenderOptions) => {
      mockElementWidth(viewport, next.viewportWidth ?? WIDE_VIEWPORT_PX);
      topOffsetAdjustmentRef.current = next.topOffsetAdjustment ?? 0;
      result.rerender(
        <ChatTurnMinimap
          messages={next.messages}
          listRef={listRef}
          topOffsetAdjustmentRef={topOffsetAdjustmentRef}
          viewportRef={viewportRef}
          bottomInset={next.bottomInset ?? 0}
          onSelect={next.onSelect ?? onSelect}
        />,
      );
    },
  };
}

describe("ChatTurnMinimap item derivation / filtering", () => {
  it("renders nothing with fewer than 2 human user turns", () => {
    const { unmount } = render(
      <ChatTurnMinimap
        messages={[
          makeUser(0, undefined),
          makeAssistant(1, "only one human turn"),
        ]}
        listRef={createRef()}
        topOffsetAdjustmentRef={{ current: 0 }}
        viewportRef={createRef()}
        bottomInset={0}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("chat-turn-minimap")).toBeNull();
    unmount();

    renderMinimap({
      messages: [
        makeUser(0, undefined),
        makeAssistant(1, "a"),
        makeA2AUser(2, "a2a"),
      ],
    });
    // One human user + one A2A user → still below MIN_ITEMS
    expect(screen.queryByTestId("chat-turn-minimap")).toBeNull();
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
    expect(screen.getByText("Final reply for A")).toBeTruthy();
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
      (previewPanel as HTMLElement).querySelectorAll(".text-muted-foreground"),
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
    mockRailGeometry(hitStrip, { top: 0, height: 100 });
    fireEvent.mouseMove(hitStrip, { clientY: 0 });
    expect(await screen.findByText("First user turn")).toBeTruthy();
    fireEvent.mouseLeave(hitStrip);
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();
  });
});

describe("ChatTurnMinimap gutter gating", () => {
  it("is fully inert at zero hit-strip budget (attribute + a11y + handlers no-op)", async () => {
    const { onSelect } = renderMinimap({
      messages: makeTwoTurnTranscript(),
      viewportWidth: ZERO_BUDGET_VIEWPORT_PX,
    });
    await flushMinimapFrames(2);

    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    await waitFor(() => {
      expect(hitStrip.hasAttribute("inert")).toBe(true);
    });
    expect(hitStrip.getAttribute("aria-hidden")).toBe("true");
    expect(hitStrip.classList.contains("pointer-events-none")).toBe(true);
    expect(hitStrip.tabIndex).toBe(-1);
    // jsdom does not enforce real inert dispatch blocking - pin the
    // component's own isInert early-return on click/keydown.
    fireEvent.click(hitStrip);
    fireEvent.keyDown(hitStrip, { key: "Enter" });
    fireEvent.keyDown(hitStrip, { key: "ArrowDown" });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("is interactive (un-inert) above zero budget", async () => {
    renderMinimap({
      messages: makeTwoTurnTranscript(),
      viewportWidth: WIDE_VIEWPORT_PX,
    });
    await flushMinimapFrames(2);

    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    await waitFor(() => {
      expect(hitStrip.hasAttribute("inert")).toBe(false);
    });
    expect(hitStrip.getAttribute("aria-hidden")).toBeNull();
    expect(hitStrip.classList.contains("pointer-events-auto")).toBe(true);
    expect(hitStrip.tabIndex).toBe(0);
    expect(
      hitStrip.hasAttribute(CHAT_TURN_MINIMAP_KEYBOARD_OWNER_ATTRIBUTE),
    ).toBe(true);
  });

  it("marks persistent gutter above the 48px side-gutter threshold and hover-reveal below it", async () => {
    const { viewport, rerender } = renderMinimap({
      messages: makeTwoTurnTranscript(),
      viewportWidth: WIDE_VIEWPORT_PX,
    });
    await flushMinimapFrames(2);
    const rail = screen.getByTestId("chat-turn-minimap");
    await waitFor(() => {
      expect(rail.getAttribute("data-persistent-gutter")).toBe("true");
    });
    expect(rail.className).toContain("opacity-100");

    // Re-measure at a hover-only width by swapping the rect and forcing a
    // remount of the measure effect via a prop that still keeps 2+ items.
    mockElementWidth(viewport, HOVER_ONLY_VIEWPORT_PX);
    // Trigger ResizeObserver? Mock is a no-op. Re-render alone won't re-run
    // the effect (viewportRef identity is stable). Force a remount.
    cleanup();
    renderMinimap({
      messages: makeTwoTurnTranscript(),
      viewportWidth: HOVER_ONLY_VIEWPORT_PX,
    });
    await flushMinimapFrames(2);
    const hoverRail = screen.getByTestId("chat-turn-minimap");
    await waitFor(() => {
      expect(hoverRail.getAttribute("data-persistent-gutter")).toBe("false");
    });
    expect(hoverRail.className).toContain("opacity-0");
    expect(hoverRail.className).toContain("hover:opacity-100");
    // Still interactive (non-zero strip) even without persistent gutter
    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    expect(hitStrip.hasAttribute("inert")).toBe(false);
    // silence unused rerender (kept for call-site symmetry)
    void rerender;
  });

  it("sizes the collapsed hit-strip width to the gutter-clamped budget", async () => {
    // sideGutter = 52 → hit = min(40, 52-12) = 40
    renderMinimap({
      messages: makeTwoTurnTranscript(),
      viewportWidth: WIDE_VIEWPORT_PX,
    });
    await flushMinimapFrames(2);
    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    await waitFor(() => {
      expect(hitStrip.style.width).toBe(
        `${CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH}px`,
      );
    });
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

  it("clicking inside the preview panel does NOT trigger selection", async () => {
    const { onSelect } = renderMinimap({
      messages: makeTwoTurnTranscript(),
    });
    await flushMinimapFrames(2);
    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    mockRailGeometry(hitStrip, { top: 0, height: 100 });
    fireEvent.mouseMove(hitStrip, { clientY: 0 });

    const preview = await screen.findByText("First user turn");
    const previewRoot = preview.closest("[data-chat-turn-minimap-preview]");
    expect(previewRoot).not.toBeNull();
    fireEvent.click(previewRoot as HTMLElement);
    expect(onSelect).not.toHaveBeenCalled();
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

  it("updates data-in-view when the list scroll node fires a scroll event", async () => {
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

    // Scroll the band over the second user row
    listState.scroll = 200;
    listState.scrollLength = 300;
    fireEvent.scroll(scrollNode);

    await waitFor(() => {
      expect(strip0?.getAttribute("data-in-view")).toBe("false");
      expect(strip2?.getAttribute("data-in-view")).toBe("true");
    });
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
