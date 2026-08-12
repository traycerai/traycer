import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RefObject } from "react";
import {
  afterEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
  type Mock,
} from "vitest";
import type { LegendListRef } from "@legendapp/list/react";
import { ChatTurnMinimap } from "@/components/chat/chat-turn-minimap";
import {
  CHAT_TURN_MINIMAP_END_HIT_PADDING,
  CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH,
  CHAT_TURN_MINIMAP_KEYBOARD_OWNER_ATTRIBUTE,
  CHAT_TURN_MINIMAP_MAX_MARKER_WIDTH_REM,
  resolveChatTurnMinimapHitStripWidth,
} from "@/components/chat/chat-turn-minimap-logic";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import {
  DEFAULT_UI_FONT_SIZE,
  useSettingsStore,
  type ChatTurnMinimapSide,
} from "@/stores/settings/settings-store";
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
  // Appearance font size is a global store; restore default so rem-geometry
  // suites never leak into later cases.
  useSettingsStore.setState({ uiFontSize: DEFAULT_UI_FONT_SIZE });
  window.getSelection()?.removeAllRanges();
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

/**
 * Index resolution and passive proximity both read the interaction region's
 * box (not the hit-strip button alone). Wide-path tests historically passed
 * the hit strip; we always resolve the live region element.
 */
function mockRailGeometry(
  fallbackElement: HTMLElement,
  input: {
    top: number;
    height: number;
    left?: number;
    width?: number;
  },
): void {
  const interactionRegion =
    document.querySelector<HTMLElement>(
      "[data-chat-turn-minimap-interaction-region]",
    ) ?? fallbackElement;
  const left = input.left ?? 0;
  const width = input.width ?? 40;
  vi.spyOn(interactionRegion, "getBoundingClientRect").mockReturnValue({
    x: left,
    y: input.top,
    width,
    height: input.height,
    top: input.top,
    left,
    right: left + width,
    bottom: input.top + input.height,
    toJSON: () => ({}),
  });
}

/**
 * Rail geometry for passive proximity: interaction region occupies the safe
 * hit strip ending at `edgeX` (right side) or starting at `edgeX` (left).
 * `hitWidth` 0 is the classic zero-gutter case.
 */
function mockPassiveRailGeometry(input: {
  top: number;
  height: number;
  edgeX: number;
  hitWidth: number;
  side?: ChatTurnMinimapSide;
}): void {
  const interactionRegion = document.querySelector<HTMLElement>(
    "[data-chat-turn-minimap-interaction-region]",
  );
  if (interactionRegion === null) {
    throw new Error("Expected minimap interaction region");
  }
  const side = input.side ?? "right";
  const width = Math.max(0, input.hitWidth);
  const left = side === "left" ? input.edgeX : input.edgeX - width;
  mockRailGeometry(interactionRegion, {
    top: input.top,
    height: input.height,
    left,
    width,
  });
}

/** Zero-width rail geometry used by zero-gutter passive proximity tests. */
function mockZeroWidthRailGeometry(input: {
  top: number;
  height: number;
  edgeX: number;
}): void {
  mockPassiveRailGeometry({
    top: input.top,
    height: input.height,
    edgeX: input.edgeX,
    hitWidth: 0,
    side: "right",
  });
}

function dispatchViewportPointer(
  viewport: HTMLElement,
  type: "pointermove" | "pointerdown" | "pointerleave" | "pointerup",
  init: {
    clientX: number;
    clientY: number;
    buttons?: number;
    /** Override Event.target (jsdom sets it to the dispatch target otherwise). */
    target?: EventTarget;
  },
): PointerEvent {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY,
    buttons: init.buttons ?? 0,
    pointerId: 1,
    pointerType: "mouse",
  });
  if (init.target !== undefined) {
    Object.defineProperty(event, "target", {
      configurable: true,
      get: () => init.target,
    });
  }
  viewport.dispatchEvent(event);
  return event;
}

function dispatchViewportClick(
  viewport: HTMLElement,
  init: {
    clientX: number;
    clientY: number;
    target?: HTMLElement;
  },
): MouseEvent {
  const target = init.target ?? document.createElement("span");
  if (!target.isConnected) viewport.append(target);
  const event = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY,
    button: 0,
  });
  target.dispatchEvent(event);
  return event;
}

/** Synchronous document selectionchange (jsdom's real one is often delayed). */
function dispatchDocumentSelectionChange(): void {
  document.dispatchEvent(new Event("selectionchange"));
}

/**
 * Stub window.getSelection().isCollapsed without mutating the live Selection
 * (so document selectionchange is not auto-fired). Restores on cleanup.
 */
function mockGetSelectionCollapsed(isCollapsed: boolean): () => void {
  const stub = { isCollapsed } as Selection;
  const spy = vi.spyOn(window, "getSelection").mockReturnValue(stub);
  return () => {
    spy.mockRestore();
  };
}

interface HeldAnimationFrames {
  readonly cancelCalls: number[];
  readonly flush: (frameId: number) => void;
  readonly held: Map<number, FrameRequestCallback>;
  readonly restore: () => void;
}

/**
 * Hold requestAnimationFrame callbacks in a map so tests can cancel, replace,
 * and flush frames without racing the browser scheduler. Restores on cleanup.
 */
function installHeldAnimationFrames(): HeldAnimationFrames {
  const held = new Map<number, FrameRequestCallback>();
  const cancelCalls: number[] = [];
  let nextId = 10_000;
  const rafSpy = vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback: FrameRequestCallback) => {
      const id = nextId;
      nextId += 1;
      held.set(id, callback);
      return id;
    });
  const cancelSpy = vi
    .spyOn(window, "cancelAnimationFrame")
    .mockImplementation((frameId: number) => {
      cancelCalls.push(frameId);
      held.delete(frameId);
    });
  return {
    cancelCalls,
    flush: (frameId: number) => {
      const callback = held.get(frameId);
      if (callback === undefined) {
        throw new Error(`No held animation frame ${frameId}`);
      }
      held.delete(frameId);
      callback(0);
    },
    held,
    restore: () => {
      rafSpy.mockRestore();
      cancelSpy.mockRestore();
    },
  };
}

function getInteractionRegion(): HTMLElement {
  const region = document.querySelector<HTMLElement>(
    "[data-chat-turn-minimap-interaction-region]",
  );
  if (region === null) {
    throw new Error("Expected minimap interaction region");
  }
  return region;
}

function expectZeroWidthHitStripInert(): void {
  const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
  expect(hitStrip.hasAttribute("inert")).toBe(true);
  expect(hitStrip.getAttribute("aria-hidden")).toBe("true");
  expect(hitStrip.tabIndex).toBe(-1);
  expect(hitStrip.style.width).toBe("0px");
  expect(hitStrip.classList.contains("pointer-events-none")).toBe(true);
  expect(hitStrip.classList.contains("pointer-events-auto")).toBe(false);
  expect(
    hitStrip.getAttribute("data-chat-turn-minimap-interactive-width"),
  ).toBe("0");
}

/**
 * Partial-positive safe strip: button keeps its exact measured width and
 * keyboard/a11y ownership (not inert), even when passive hover also owns
 * painted marker overflow outside that opening.
 */
function expectPositiveSafeHitStrip(widthPx: number): void {
  const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
  expect(hitStrip.hasAttribute("inert")).toBe(false);
  expect(hitStrip.getAttribute("aria-hidden")).not.toBe("true");
  expect(hitStrip.tabIndex).toBe(0);
  expect(hitStrip.style.width).toBe(`${widthPx}px`);
  expect(hitStrip.classList.contains("pointer-events-auto")).toBe(true);
  expect(hitStrip.classList.contains("pointer-events-none")).toBe(false);
  expect(
    hitStrip.getAttribute("data-chat-turn-minimap-interactive-width"),
  ).toBe(String(widthPx));
  expect(
    hitStrip.hasAttribute(CHAT_TURN_MINIMAP_KEYBOARD_OWNER_ATTRIBUTE),
  ).toBe(true);
  expect(
    screen.queryByRole("button", { name: "Message minimap" }),
  ).not.toBeNull();
  expectMinimapGroupAccessible(true);
}

function expectInteractionRegionHidden(): void {
  const interactionRegion = getInteractionRegion();
  expect(interactionRegion.hasAttribute("inert")).toBe(true);
  expect(interactionRegion.getAttribute("aria-hidden")).toBe("true");
  expect(interactionRegion.classList.contains("pointer-events-none")).toBe(
    true,
  );
  expectMinimapGroupAccessible(false);
}

function expectInteractionRegionExposedForPreview(): void {
  const interactionRegion = getInteractionRegion();
  expect(interactionRegion.hasAttribute("inert")).toBe(false);
  expect(interactionRegion.getAttribute("aria-hidden")).not.toBe("true");
  expect(interactionRegion.classList.contains("pointer-events-auto")).toBe(
    true,
  );
  expect(
    document.querySelector("[data-chat-turn-minimap-preview]"),
  ).not.toBeNull();
  expectMinimapGroupAccessible(true);
}

const WIDE_VIEWPORT_PX = 1200;
const CONSTRAINED_VIEWPORT_PX = 420;
/**
 * Default UI font 15: contentMax=720, sideGutter=(800-720)/2=40,
 * edgeInset=11.25 → hit strip = 28px.
 * 28px > widest marker 1.5rem (22.5px), so passive viewport hover is OFF
 * here — button owns hover. Distinct from the partial-positive cases below.
 */
const PARTIAL_GUTTER_VIEWPORT_PX = 800;
const PARTIAL_GUTTER_HIT_STRIP_WIDTH_DEFAULT_FONT = 28;
/**
 * Independent review P1 partial-positive gutters: safe hit strip is positive
 * but narrower than the widest painted marker, so overflow was dead until
 * passive activation expanded beyond width-zero only.
 */
const PARTIAL_POSITIVE_PASSIVE_CASES = [
  {
    label: "font20/pane1000",
    uiFontSize: 20,
    viewportWidth: 1000,
    hitWidth: 5,
    markerPx: 30,
  },
  {
    label: "font17/pane850",
    uiFontSize: 17,
    viewportWidth: 850,
    hitWidth: 4,
    markerPx: 25.5,
  },
  {
    label: "font15/pane750",
    uiFontSize: 15,
    viewportWidth: 750,
    hitWidth: 3,
    markerPx: 22.5,
  },
] as const;
/**
 * Hit width exactly equals the widest marker's 1.5rem — passive
 * must stay OFF (`resolvedHitStripWidth < widest marker`, not `<=`).
 */
const MARKER_EQUALITY_BOUNDARY_CASES = [
  {
    label: "font20/pane1050",
    uiFontSize: 20,
    viewportWidth: 1050,
    hitWidth: 30,
  },
  {
    label: "font16/pane840",
    uiFontSize: 16,
    viewportWidth: 840,
    hitWidth: 24,
  },
] as const;
/**
 * Card separation from the marker rail is always 2rem of the live UI font
 * (`edgeOffset = uiFontSize * 2`). It is not adaptive to hit-strip width.
 */
const PREVIEW_EDGE_OFFSET_REM = 2;
const PREVIEW_EDGE_OFFSET_DEFAULT_FONT_PX = "30px";
const PREVIEW_EDGE_OFFSET_FONT20_PX = "40px";

function hitStripWidthFor(viewportWidth: number, rootFontSize: number): number {
  return resolveChatTurnMinimapHitStripWidth({
    rootFontSize,
    viewportWidth,
  });
}

/** Production card offset: always 2rem, independent of gutter / hit width. */
function previewEdgeOffsetPx(rootFontSize: number): string {
  return `${rootFontSize * PREVIEW_EDGE_OFFSET_REM}px`;
}

/**
 * Assert compact/expanded card is always 2rem from the rail edge, never uses
 * the old left-8/right-8 utilities, and leaves the opposite side unset.
 * Also asserts the hit strip stays at the measured safe width (no bridge widen).
 */
function expectFixedTwoRemCardSeparation(input: {
  readonly side: ChatTurnMinimapSide;
  readonly uiFontSize: number;
  readonly hitStripWidthPx: number;
}): void {
  const preview = document.querySelector<HTMLElement>(
    "[data-chat-turn-minimap-preview]",
  );
  expect(preview).not.toBeNull();
  const expected = previewEdgeOffsetPx(input.uiFontSize);
  if (input.side === "right") {
    expect(preview?.style.right).toBe(expected);
    expect(preview?.style.left).toBe("");
  } else {
    expect(preview?.style.left).toBe(expected);
    expect(preview?.style.right).toBe("");
  }
  expect(preview?.classList).not.toContain("left-8");
  expect(preview?.classList).not.toContain("right-8");
  // 2rem > widest 1.5rem marker: card cannot cover painted marker spans.
  expect(input.uiFontSize * PREVIEW_EDGE_OFFSET_REM).toBeGreaterThan(
    input.uiFontSize * CHAT_TURN_MINIMAP_MAX_MARKER_WIDTH_REM,
  );
  // Hit strip must stay at the gutter-safe width (never expanded under the card).
  const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
  expect(hitStrip.style.width).toBe(`${input.hitStripWidthPx}px`);
  expect(
    hitStrip.getAttribute("data-chat-turn-minimap-interactive-width"),
  ).toBe(String(input.hitStripWidthPx));
}

function expectMinimapGroupAccessible(isAccessible: boolean): void {
  const group = screen.queryByRole("group", {
    name: "Message minimap controls",
  });
  if (isAccessible) {
    expect(group).not.toBeNull();
  } else {
    expect(group).toBeNull();
  }
}

/** Wide-strip contract: named group and keyboard hit target are both exposed. */
function expectMinimapWideStripAccessible(): void {
  expectMinimapGroupAccessible(true);
  expect(
    screen.queryByRole("button", { name: "Message minimap" }),
  ).not.toBeNull();
}

/** Fully closed zero-gutter state: button inert, group hidden, no preview. */
function expectMinimapInertDomState(): void {
  expectZeroWidthHitStripInert();
  expectInteractionRegionHidden();
  expect(document.querySelector("[data-chat-turn-minimap-preview]")).toBeNull();
}

/** Install a non-collapsed window selection; returns a cleanup that clears it. */
function installNonCollapsedSelection(text: string): () => void {
  const selectionHost = document.createElement("div");
  selectionHost.textContent = text;
  document.body.appendChild(selectionHost);
  const range = document.createRange();
  range.selectNodeContents(selectionHost);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  expect(selection?.isCollapsed).toBe(false);
  return () => {
    selection?.removeAllRanges();
    selectionHost.remove();
  };
}

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

  it("bridges the original 2rem card gap, then closes outside it", async () => {
    const { viewport } = renderMinimap({ messages: makeTwoTurnTranscript() });
    await flushMinimapFrames(2);
    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    const interactionRegion = getInteractionRegion();
    // Right-side rail ending at edgeX=140 so 2rem (30px) proximity is exact.
    const edgeX = 140;
    const railTop = 0;
    const railHeight = 100;
    mockRailGeometry(hitStrip, {
      top: railTop,
      height: railHeight,
      left: edgeX - CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH,
      width: CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH,
    });
    fireEvent.mouseMove(hitStrip, { clientY: 0 });
    expect(await screen.findByText("First user turn")).toBeTruthy();
    expectFixedTwoRemCardSeparation({
      side: "right",
      uiFontSize: DEFAULT_UI_FONT_SIZE,
      hitStripWidthPx: CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH,
    });
    // Region mouseleave alone must not dismiss once the open-preview passive
    // observer is active (it bridges the visual gap at 2rem).
    fireEvent.mouseLeave(interactionRegion);
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).not.toBeNull();

    const twoRem = DEFAULT_UI_FONT_SIZE * PREVIEW_EDGE_OFFSET_REM;
    // Exactly 2rem inward of the rail edge retains the open card (same Y so
    // index mapping does not change while proving the horizontal bridge).
    act(() => {
      dispatchViewportPointer(viewport, "pointermove", {
        clientX: edgeX - twoRem,
        clientY: 0,
      });
    });
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).not.toBeNull();
    expect(screen.getByText("First user turn")).toBeTruthy();

    // One pixel beyond the 2rem open-preview proximity closes.
    act(() => {
      dispatchViewportPointer(viewport, "pointermove", {
        clientX: edgeX - twoRem - 1,
        clientY: 0,
      });
    });
    await flushMinimapFrames(1);
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();
  });
});

describe("ChatTurnMinimap hit strip geometry", () => {
  it("keeps the zero-width button inert in a constrained pane (markers still paint)", async () => {
    const { onSelect } = renderMinimap({
      messages: makeTwoTurnTranscript(),
      viewportWidth: CONSTRAINED_VIEWPORT_PX,
    });
    await flushMinimapFrames(2);

    expect(
      hitStripWidthFor(CONSTRAINED_VIEWPORT_PX, DEFAULT_UI_FONT_SIZE),
    ).toBe(0);

    const rail = screen.getByTestId("chat-turn-minimap");
    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    const interactionRegion = getInteractionRegion();
    expect(rail.classList).toContain("opacity-100");
    expect(rail.classList).not.toContain("opacity-0");
    // Visible markers still paint on the zero-width rail.
    expect(
      rail.querySelectorAll("[data-chat-turn-minimap-strip]"),
    ).toHaveLength(2);
    expect(
      hitStrip.hasAttribute(CHAT_TURN_MINIMAP_KEYBOARD_OWNER_ATTRIBUTE),
    ).toBe(true);
    // Button stays inert; group stays hidden until a passive preview opens.
    expectMinimapInertDomState();
    expect(interactionRegion.getAttribute("role")).toBe("group");
    expect(interactionRegion.getAttribute("aria-label")).toBe(
      "Message minimap controls",
    );

    // Direct button pointer/keyboard remains a no-op (passive path is separate).
    mockZeroWidthRailGeometry({ top: 0, height: 100, edgeX: 400 });
    fireEvent.mouseMove(hitStrip, { clientY: 50 });
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();
    fireEvent.click(hitStrip, { clientY: 100 });
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.focus(hitStrip);
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();
    fireEvent.keyDown(hitStrip, { key: "ArrowDown" });
    fireEvent.keyDown(hitStrip, { key: "Enter" });
    expect(onSelect).not.toHaveBeenCalled();
    expectZeroWidthHitStripInert();
  });

  it("caps the edge hit target at the max width in a wide pane", async () => {
    const { onSelect } = renderMinimap({
      messages: makeTwoTurnTranscript(),
      viewportWidth: WIDE_VIEWPORT_PX,
    });
    await flushMinimapFrames(2);
    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    expect(hitStripWidthFor(WIDE_VIEWPORT_PX, DEFAULT_UI_FONT_SIZE)).toBe(
      CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH,
    );
    expect(hitStrip.style.width).toBe(
      `${CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH}px`,
    );
    expect(hitStrip.hasAttribute("inert")).toBe(false);
    expect(hitStrip.getAttribute("aria-hidden")).toBeNull();
    expect(hitStrip.classList.contains("pointer-events-auto")).toBe(true);
    expect(hitStrip.tabIndex).toBe(0);
    expect(
      hitStrip.getAttribute("data-chat-turn-minimap-interactive-width"),
    ).toBe(String(CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH));
    // Named group + keyboard hit target are exposed when the gutter is non-zero.
    expectMinimapWideStripAccessible();
    const interactionRegion = document.querySelector<HTMLElement>(
      "[data-chat-turn-minimap-interaction-region]",
    );
    expect(interactionRegion?.hasAttribute("inert")).toBe(false);
    // React keeps aria-hidden={false} as the literal "false" string.
    expect(interactionRegion?.getAttribute("aria-hidden")).not.toBe("true");
    mockRailGeometry(hitStrip, { top: 0, height: 100 });
    fireEvent.click(hitStrip, { clientY: 100 });
    expect(onSelect).toHaveBeenCalledWith("message-2");
  });

  it("keeps the original 2rem preview separation at a partial gutter on the right", async () => {
    expect(
      hitStripWidthFor(PARTIAL_GUTTER_VIEWPORT_PX, DEFAULT_UI_FONT_SIZE),
    ).toBe(PARTIAL_GUTTER_HIT_STRIP_WIDTH_DEFAULT_FONT);
    expect(previewEdgeOffsetPx(DEFAULT_UI_FONT_SIZE)).toBe(
      PREVIEW_EDGE_OFFSET_DEFAULT_FONT_PX,
    );

    renderMinimap({
      messages: makeTwoTurnTranscript(),
      viewportWidth: PARTIAL_GUTTER_VIEWPORT_PX,
    });
    await flushMinimapFrames(2);

    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    expectPositiveSafeHitStrip(PARTIAL_GUTTER_HIT_STRIP_WIDTH_DEFAULT_FONT);

    mockRailGeometry(hitStrip, { top: 0, height: 100 });
    fireEvent.mouseMove(hitStrip, { clientY: 0 });
    expectFixedTwoRemCardSeparation({
      side: "right",
      uiFontSize: DEFAULT_UI_FONT_SIZE,
      hitStripWidthPx: PARTIAL_GUTTER_HIT_STRIP_WIDTH_DEFAULT_FONT,
    });
  });

  it("keeps the original 2rem preview separation at a partial gutter on the left", async () => {
    renderMinimap({
      messages: makeTwoTurnTranscript(),
      viewportWidth: PARTIAL_GUTTER_VIEWPORT_PX,
      side: "left",
    });
    await flushMinimapFrames(2);

    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    expectPositiveSafeHitStrip(PARTIAL_GUTTER_HIT_STRIP_WIDTH_DEFAULT_FONT);

    mockRailGeometry(hitStrip, { top: 0, height: 100 });
    fireEvent.mouseMove(hitStrip, { clientY: 0 });
    expectFixedTwoRemCardSeparation({
      side: "left",
      uiFontSize: DEFAULT_UI_FONT_SIZE,
      hitStripWidthPx: PARTIAL_GUTTER_HIT_STRIP_WIDTH_DEFAULT_FONT,
    });
  });

  it("uses fixed 2rem preview edge offset on a wide pane (font15 → 30px)", async () => {
    renderMinimap({
      messages: makeTwoTurnTranscript(),
      viewportWidth: WIDE_VIEWPORT_PX,
    });
    await flushMinimapFrames(2);
    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    mockRailGeometry(hitStrip, { top: 0, height: 100 });
    fireEvent.mouseMove(hitStrip, { clientY: 0 });
    // Always uiFontSize*2 (30px at default font), never adaptive to the 40px strip.
    expect(previewEdgeOffsetPx(DEFAULT_UI_FONT_SIZE)).toBe(
      PREVIEW_EDGE_OFFSET_DEFAULT_FONT_PX,
    );
    expectFixedTwoRemCardSeparation({
      side: "right",
      uiFontSize: DEFAULT_UI_FONT_SIZE,
      hitStripWidthPx: CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH,
    });
  });

  it("keeps the original 2rem preview separation at font20 / 1000px (partial-positive)", async () => {
    useSettingsStore.setState({ uiFontSize: 20 });
    expect(hitStripWidthFor(1000, 20)).toBe(5);
    expect(previewEdgeOffsetPx(20)).toBe(PREVIEW_EDGE_OFFSET_FONT20_PX);

    renderMinimap({
      messages: makeTwoTurnTranscript(),
      viewportWidth: 1000,
    });
    await flushMinimapFrames(2);

    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    expectPositiveSafeHitStrip(5);
    mockRailGeometry(hitStrip, { top: 0, height: 100 });
    fireEvent.mouseMove(hitStrip, { clientY: 0 });
    // Hit strip is only 5px; card still sits at full 2rem (40px), not min(2rem, hit-1).
    expectFixedTwoRemCardSeparation({
      side: "right",
      uiFontSize: 20,
      hitStripWidthPx: 5,
    });
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
    // Preview open must not widen the hit strip (mouseleave stays prompt).
    expect(hitStrip.style.width).toBe(
      `${CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH}px`,
    );
    expect(
      hitStrip.getAttribute("data-chat-turn-minimap-interactive-width"),
    ).toBe(String(CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH));
  });

  it("dismisses open/expanded interaction on resize-to-zero; resizing alone does not revive", async () => {
    const resizeObserver = installControllableResizeObserver();
    try {
      const { viewport } = renderMinimap({
        messages: makeTwoTurnTranscript(),
        viewportWidth: WIDE_VIEWPORT_PX,
      });
      await flushMinimapFrames(2);

      const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
      expect(hitStrip.style.width).toBe(
        `${CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH}px`,
      );
      expectMinimapWideStripAccessible();

      mockRailGeometry(hitStrip, { top: 0, height: 100 });
      fireEvent.mouseMove(hitStrip, { clientY: 0 });
      expect(await screen.findByText("First user turn")).toBeTruthy();
      fireEvent.click(
        await screen.findByRole("button", { name: "Expand all messages" }),
      );
      expect(
        screen.getByRole("button", { name: "Collapse message list" }),
      ).toBeTruthy();
      hitStrip.focus();
      expect(document.activeElement).toBe(hitStrip);

      mockElementWidth(viewport, CONSTRAINED_VIEWPORT_PX);
      act(() => resizeObserver.trigger());
      await flushMinimapFrames(1);

      expectMinimapInertDomState();
      expect(document.activeElement).not.toBe(hitStrip);
      expect(
        screen.queryByRole("button", { name: "Collapse message list" }),
      ).toBeNull();

      // Another measure at the same zero-gutter width still does not revive.
      act(() => resizeObserver.trigger());
      await flushMinimapFrames(1);
      expectMinimapInertDomState();

      // First fresh passive movement near the zero-width rail may reopen.
      mockZeroWidthRailGeometry({ top: 0, height: 100, edgeX: 400 });
      act(() => {
        dispatchViewportPointer(viewport, "pointermove", {
          clientX: 400,
          clientY: 0,
        });
      });
      expect(await screen.findByText("First user turn")).toBeTruthy();
      expectZeroWidthHitStripInert();
      expectInteractionRegionExposedForPreview();

      // Clear via pointerleave, then widen: control returns without auto-revive.
      act(() => {
        dispatchViewportPointer(viewport, "pointerleave", {
          clientX: 0,
          clientY: 0,
        });
      });
      expect(
        document.querySelector("[data-chat-turn-minimap-preview]"),
      ).toBeNull();

      mockElementWidth(viewport, WIDE_VIEWPORT_PX);
      act(() => resizeObserver.trigger());
      await flushMinimapFrames(1);

      const restoredHitStrip = screen.getByTestId(
        "chat-turn-minimap-hit-strip",
      );
      expect(restoredHitStrip.style.width).toBe(
        `${CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH}px`,
      );
      expect(restoredHitStrip.hasAttribute("inert")).toBe(false);
      expectMinimapWideStripAccessible();
      expect(
        document.querySelector("[data-chat-turn-minimap-preview]"),
      ).toBeNull();

      mockRailGeometry(restoredHitStrip, { top: 0, height: 100 });
      fireEvent.mouseMove(restoredHitStrip, { clientY: 0 });
      expect(await screen.findByText("First user turn")).toBeTruthy();
    } finally {
      resizeObserver.restore();
    }
  });

  it("dismisses open/expanded interaction on live UI font-size change; no auto-revive until fresh input", async () => {
    // 900px is interactive at default 15 (strip 40) but zero at font 20.
    expect(hitStripWidthFor(900, 15)).toBe(
      CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH,
    );
    expect(hitStripWidthFor(900, 20)).toBe(0);

    const { viewport } = renderMinimap({
      messages: makeTwoTurnTranscript(),
      viewportWidth: 900,
    });
    await flushMinimapFrames(2);

    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    expect(hitStrip.style.width).toBe(
      `${CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH}px`,
    );
    mockRailGeometry(hitStrip, { top: 0, height: 100 });
    fireEvent.mouseMove(hitStrip, { clientY: 0 });
    expect(await screen.findByText("First user turn")).toBeTruthy();
    fireEvent.click(
      await screen.findByRole("button", { name: "Expand all messages" }),
    );
    expect(
      screen.getByRole("button", { name: "Collapse message list" }),
    ).toBeTruthy();
    hitStrip.focus();
    expect(document.activeElement).toBe(hitStrip);

    act(() => {
      useSettingsStore.setState({ uiFontSize: 20 });
    });
    // Font change re-runs the measure effect via rAF; viewport box is unchanged.
    expect(viewport.getBoundingClientRect().width).toBe(900);
    await flushMinimapFrames(2);

    expectMinimapInertDomState();
    expect(document.activeElement).not.toBe(hitStrip);
    expect(
      screen.queryByRole("button", { name: "Collapse message list" }),
    ).toBeNull();

    // Resizing/remeasuring alone (font still 20 / zero gutter) stays closed.
    await flushMinimapFrames(1);
    expectMinimapInertDomState();

    // Fresh passive movement at font20 proximity (1rem = 20px) reopens.
    mockZeroWidthRailGeometry({ top: 0, height: 100, edgeX: 900 });
    act(() => {
      dispatchViewportPointer(viewport, "pointermove", {
        clientX: 900 - 20,
        clientY: 0,
      });
    });
    expect(await screen.findByText("First user turn")).toBeTruthy();
    expectZeroWidthHitStripInert();
    expectInteractionRegionExposedForPreview();

    act(() => {
      dispatchViewportPointer(viewport, "pointerleave", {
        clientX: 0,
        clientY: 0,
      });
    });

    act(() => {
      useSettingsStore.setState({ uiFontSize: 15 });
    });
    await flushMinimapFrames(2);

    const restoredHitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    expect(restoredHitStrip.style.width).toBe(
      `${CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH}px`,
    );
    expect(restoredHitStrip.hasAttribute("inert")).toBe(false);
    expectMinimapWideStripAccessible();
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();

    mockRailGeometry(restoredHitStrip, { top: 0, height: 100 });
    fireEvent.mouseMove(restoredHitStrip, { clientY: 0 });
    expect(await screen.findByText("First user turn")).toBeTruthy();
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

  it("does not open the preview while a non-collapsed window selection is active", async () => {
    renderMinimap({ messages: makeThreeTurnTranscript() });
    await flushMinimapFrames(2);
    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    mockRailGeometry(hitStrip, { top: 100, height: 200 });

    const clearSelection = installNonCollapsedSelection(
      "selected transcript text",
    );
    onTestFinished(clearSelection);

    fireEvent.mouseMove(hitStrip, { clientY: 200 });
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();

    clearSelection();
    fireEvent.mouseMove(hitStrip, { clientY: 200 });
    expect(await screen.findByText("Turn beta")).toBeTruthy();
  });

  it("does not call onSelect on click while a non-collapsed selection is active", async () => {
    const { onSelect } = renderMinimap({
      messages: makeThreeTurnTranscript(),
    });
    await flushMinimapFrames(2);
    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    mockRailGeometry(hitStrip, { top: 100, height: 200 });
    const clearSelection = installNonCollapsedSelection(
      "selected transcript text",
    );
    onTestFinished(clearSelection);

    fireEvent.mouseDown(hitStrip, { clientY: 200 });
    fireEvent.click(hitStrip, { clientY: 200 });

    expect(onSelect).not.toHaveBeenCalled();
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();

    clearSelection();
  });

  it("does not open preview or select on focus/Enter while a non-collapsed selection is active", async () => {
    const { onSelect } = renderMinimap({
      messages: makeThreeTurnTranscript(),
    });
    await flushMinimapFrames(2);
    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    const clearSelection = installNonCollapsedSelection(
      "selected transcript text",
    );
    onTestFinished(clearSelection);

    fireEvent.focus(hitStrip);
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();

    fireEvent.keyDown(hitStrip, { key: "Enter" });
    fireEvent.keyDown(hitStrip, { key: " " });
    fireEvent.keyDown(hitStrip, { key: "ArrowDown" });

    expect(onSelect).not.toHaveBeenCalled();
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();

    clearSelection();
  });

  it("resumes click and focus selection after the window selection is cleared", async () => {
    const { onSelect } = renderMinimap({
      messages: makeThreeTurnTranscript(),
    });
    await flushMinimapFrames(2);
    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    mockRailGeometry(hitStrip, { top: 100, height: 200 });
    const clearSelection = installNonCollapsedSelection(
      "selected transcript text",
    );
    onTestFinished(clearSelection);

    fireEvent.click(hitStrip, { clientY: 200 });
    fireEvent.focus(hitStrip);
    expect(onSelect).not.toHaveBeenCalled();
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();

    clearSelection();

    fireEvent.focus(hitStrip);
    expect(await screen.findByText("Turn alpha")).toBeTruthy();
    fireEvent.keyDown(hitStrip, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("message-0");
    onSelect.mockClear();

    fireEvent.click(hitStrip, { clientY: 200 });
    expect(onSelect).toHaveBeenCalledWith("message-2");
  });

  it("does not open the preview during a pointer drag, then resumes normal hover", async () => {
    renderMinimap({ messages: makeThreeTurnTranscript() });
    await flushMinimapFrames(2);
    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    mockRailGeometry(hitStrip, { top: 100, height: 200 });

    // buttons !== 0 means a button is held (drag / text selection gesture).
    fireEvent.mouseMove(hitStrip, { clientY: 200, buttons: 1 });
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();

    fireEvent.mouseMove(hitStrip, { clientY: 200, buttons: 0 });
    expect(await screen.findByText("Turn beta")).toBeTruthy();
  });

  it("closes an open preview if the pointer keeps moving during a drag", async () => {
    renderMinimap({ messages: makeThreeTurnTranscript() });
    await flushMinimapFrames(2);
    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    mockRailGeometry(hitStrip, { top: 100, height: 200 });

    fireEvent.mouseMove(hitStrip, { clientY: 200, buttons: 0 });
    expect(await screen.findByText("Turn beta")).toBeTruthy();

    fireEvent.mouseMove(hitStrip, { clientY: 220, buttons: 1 });
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();
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
    // Expanded preview must keep the hit strip at its collapsed gutter width
    // so leaving the interaction region still ends the hover promptly.
    expect(hitStrip.style.width).toBe(
      `${CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH}px`,
    );
    expect(
      hitStrip.getAttribute("data-chat-turn-minimap-interactive-width"),
    ).toBe(String(CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH));
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

  it("keeps the active row visible while rail hover advances through an overflowing expanded list", async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
    onTestFinished(() => scrollIntoView.mockRestore());
    const messages = Array.from({ length: 8 }, (_, index) =>
      makeUser(index, `Turn ${index + 1}`),
    );
    const { viewport } = renderMinimap({ messages });
    await flushMinimapFrames(2);

    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    mockRailGeometry(hitStrip, { top: 0, height: 100 });
    fireEvent.mouseMove(hitStrip, { clientY: 0 });
    fireEvent.click(
      await screen.findByRole("button", { name: "Expand all messages" }),
    );
    scrollIntoView.mockClear();
    const listScroller = document.querySelector<HTMLElement>(
      "[data-chat-turn-minimap-list-scroll]",
    );
    if (listScroller === null) {
      throw new Error("Expected expanded minimap list scroller");
    }
    vi.spyOn(listScroller, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 300,
      height: 100,
      top: 0,
      left: 0,
      right: 300,
      bottom: 100,
      toJSON: () => ({}),
    });
    const lastCard = screen.getByRole("button", {
      name: "Jump to message: Turn 8",
    });
    const firstCard = screen.getByRole("button", {
      name: "Jump to message: Turn 1",
    });
    vi.spyOn(lastCard, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 160,
      width: 300,
      height: 40,
      top: 160,
      left: 0,
      right: 300,
      bottom: 200,
      toJSON: () => ({}),
    });
    vi.spyOn(firstCard, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: -100,
      width: 300,
      height: 40,
      top: -100,
      left: 0,
      right: 300,
      bottom: -60,
      toJSON: () => ({}),
    });

    for (const clientY of [30, 60, 100]) {
      act(() => {
        dispatchViewportPointer(viewport, "pointermove", {
          buttons: 0,
          clientX: 40,
          clientY,
        });
      });
      await flushMinimapFrames(1);
    }

    expect(lastCard.getAttribute("data-active")).toBe("true");
    expect(listScroller.scrollTop).toBe(100);
    expect(scrollIntoView).not.toHaveBeenCalled();

    act(() => {
      dispatchViewportPointer(viewport, "pointermove", {
        buttons: 0,
        clientX: 40,
        clientY: 0,
      });
    });
    await flushMinimapFrames(1);

    expect(firstCard.getAttribute("data-active")).toBe("true");
    expect(listScroller.scrollTop).toBe(0);
    expect(scrollIntoView).not.toHaveBeenCalled();
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
    const { viewport } = renderMinimap({ messages: makeThreeTurnTranscript() });
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
    act(() => {
      dispatchViewportPointer(viewport, "pointermove", {
        clientX: -1,
        clientY: 50,
      });
    });
    await flushMinimapFrames(1);

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

  /**
   * Electron regression: compact vs expanded used to render *different*
   * expand/collapse buttons. Clicking a focused Expand control unmounted it
   * (focusout relatedTarget=null) and interaction blur closed the preview
   * before expand could stick. Production keeps one Tooltip/Button outside
   * the compact/expanded branch so DOM identity + focus persist.
   */
  it("keeps one persistent expand/collapse control focused across toggles", async () => {
    const user = userEvent.setup();
    renderMinimap({ messages: makeThreeTurnTranscript() });
    await flushMinimapFrames(2);
    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    mockRailGeometry(hitStrip, { top: 0, height: 100 });
    fireEvent.mouseMove(hitStrip, { clientY: 50 });

    const toggleButton = await screen.findByRole("button", {
      name: "Expand all messages",
    });
    expect(
      toggleButton.querySelector(".lucide-unfold-vertical"),
    ).not.toBeNull();
    expect(toggleButton.querySelector(".lucide-fold-vertical")).toBeNull();
    // Exactly one expand/collapse control in the preview (not one per branch).
    expect(
      screen.getAllByRole("button", {
        name: /Expand all messages|Collapse message list/,
      }),
    ).toHaveLength(1);

    // Focused expand: same DOM node identity, focus retained, labels/icons swap.
    // Prefer the element focus API over fireEvent.focus so activeElement is real.
    act(() => {
      toggleButton.focus();
    });
    expect(document.activeElement).toBe(toggleButton);
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Expand all messages",
    );
    // Click while focused - the historical bug closed the preview on focusout.
    await user.click(toggleButton);

    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).not.toBeNull();
    expect(
      document.querySelectorAll("[data-chat-turn-minimap-list-item]"),
    ).toHaveLength(3);
    expect(document.querySelector("[data-chat-turn-minimap-card]")).toBeNull();
    expect(document.activeElement).toBe(toggleButton);
    expect(screen.getByRole("button", { name: "Collapse message list" })).toBe(
      toggleButton,
    );
    expect(toggleButton.getAttribute("aria-label")).toBe(
      "Collapse message list",
    );
    expect(toggleButton.querySelector(".lucide-fold-vertical")).not.toBeNull();
    expect(toggleButton.querySelector(".lucide-unfold-vertical")).toBeNull();
    expect(
      screen.getAllByRole("button", {
        name: /Expand all messages|Collapse message list/,
      }),
    ).toHaveLength(1);
    // Tooltip content tracks the live expanded state on the same control.
    // user-event click may leave the Radix tooltip closed; re-open via focus.
    fireEvent.focus(toggleButton);
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Collapse message list",
    );

    // Focused collapse: returns compact preview, stays open, same node + focus.
    act(() => {
      toggleButton.focus();
    });
    expect(document.activeElement).toBe(toggleButton);
    await user.click(toggleButton);
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).not.toBeNull();
    expect(
      document.querySelector("[data-chat-turn-minimap-card]"),
    ).not.toBeNull();
    expect(
      document.querySelector("[data-chat-turn-minimap-list-item]"),
    ).toBeNull();
    expect(document.activeElement).toBe(toggleButton);
    expect(screen.getByRole("button", { name: "Expand all messages" })).toBe(
      toggleButton,
    );
    expect(toggleButton.getAttribute("aria-label")).toBe("Expand all messages");
    expect(
      toggleButton.querySelector(".lucide-unfold-vertical"),
    ).not.toBeNull();
    expect(toggleButton.querySelector(".lucide-fold-vertical")).toBeNull();
    expect(
      screen.getAllByRole("button", {
        name: /Expand all messages|Collapse message list/,
      }),
    ).toHaveLength(1);

    // Outside blur still closes (interaction focusout contract unchanged).
    const outsideButton = document.createElement("button");
    document.body.appendChild(outsideButton);
    act(() => {
      outsideButton.focus();
    });
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();

    // Pointer click still expands after reopening the compact preview.
    fireEvent.mouseMove(hitStrip, { clientY: 50 });
    const expandAgain = await screen.findByRole("button", {
      name: "Expand all messages",
    });
    // fireEvent path (no user-event focus choreography) must still expand.
    fireEvent.click(expandAgain);
    expect(
      document.querySelectorAll("[data-chat-turn-minimap-list-item]"),
    ).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Collapse message list" })).toBe(
      expandAgain,
    );
    // And a second focused click collapses without dismissing the preview.
    act(() => {
      expandAgain.focus();
    });
    expect(document.activeElement).toBe(expandAgain);
    await user.click(expandAgain);
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).not.toBeNull();
    expect(
      document.querySelector("[data-chat-turn-minimap-card]"),
    ).not.toBeNull();
    expect(document.activeElement).toBe(expandAgain);
    expect(screen.getByRole("button", { name: "Expand all messages" })).toBe(
      expandAgain,
    );

    // Escape still collapses to compact then dismisses (unchanged contract).
    await user.click(expandAgain);
    const listItem = screen.getByRole("button", {
      name: "Jump to message: Turn beta",
    });
    fireEvent.keyDown(listItem, { key: "Escape" });
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
    expect(hitStrip.style.width).toBe(
      `${CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH}px`,
    );
    mockRailGeometry(hitStrip, { top: 0, height: 100 });
    fireEvent.mouseMove(hitStrip, { clientY: 0 });
    // Fixed 2rem card offset on the configured side (not left-8, not strip-adaptive).
    expectFixedTwoRemCardSeparation({
      side: "left",
      uiFontSize: DEFAULT_UI_FONT_SIZE,
      hitStripWidthPx: CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH,
    });
  });

  it("places the rail and inward-opening preview on the default right side", async () => {
    renderMinimap({ messages: makeTwoTurnTranscript() });
    await flushMinimapFrames(2);
    const rail = screen.getByTestId("chat-turn-minimap");
    expect(rail.dataset.side).toBe("right");
    expect(rail.classList).toContain("right-0");

    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    expect(hitStrip.parentElement?.classList).toContain("right-3");
    expect(hitStrip.style.width).toBe(
      `${CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH}px`,
    );
    mockRailGeometry(hitStrip, { top: 0, height: 100 });
    fireEvent.mouseMove(hitStrip, { clientY: 0 });
    // Fixed 2rem (font15 → 30px) on the configured inward edge.
    expectFixedTwoRemCardSeparation({
      side: "right",
      uiFontSize: DEFAULT_UI_FONT_SIZE,
      hitStripWidthPx: CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH,
    });
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

/**
 * Fixed 2rem card separation matrix + open-preview 2rem gap bridge.
 * Before a card opens, marker-overflow passive proximity stays 1rem; once
 * previewVisible, passive observation uses 2rem so the pointer can cross the
 * visual gap without widening the hit strip.
 */
describe("ChatTurnMinimap fixed 2rem card separation and open-preview gap", () => {
  const RAIL_TOP = 100;
  const RAIL_HEIGHT = 200;
  const RIGHT_EDGE_X = 580;
  const LEFT_EDGE_X = 12;

  const FIXED_OFFSET_CASES = [
    {
      label: "zero gutter font15 right",
      uiFontSize: DEFAULT_UI_FONT_SIZE,
      viewportWidth: CONSTRAINED_VIEWPORT_PX,
      hitWidth: 0,
      side: "right" as const,
      edgeX: RIGHT_EDGE_X,
      openVia: "passive" as const,
    },
    {
      label: "zero gutter font15 left",
      uiFontSize: DEFAULT_UI_FONT_SIZE,
      viewportWidth: CONSTRAINED_VIEWPORT_PX,
      hitWidth: 0,
      side: "left" as const,
      edgeX: LEFT_EDGE_X,
      openVia: "passive" as const,
    },
    {
      label: "zero gutter font20 right",
      uiFontSize: 20,
      viewportWidth: 593,
      hitWidth: 0,
      side: "right" as const,
      edgeX: RIGHT_EDGE_X,
      openVia: "passive" as const,
    },
    {
      label: "partial gutter font15 right",
      uiFontSize: DEFAULT_UI_FONT_SIZE,
      viewportWidth: PARTIAL_GUTTER_VIEWPORT_PX,
      hitWidth: PARTIAL_GUTTER_HIT_STRIP_WIDTH_DEFAULT_FONT,
      side: "right" as const,
      edgeX: RIGHT_EDGE_X,
      openVia: "button" as const,
    },
    {
      label: "partial gutter font15 left",
      uiFontSize: DEFAULT_UI_FONT_SIZE,
      viewportWidth: PARTIAL_GUTTER_VIEWPORT_PX,
      hitWidth: PARTIAL_GUTTER_HIT_STRIP_WIDTH_DEFAULT_FONT,
      side: "left" as const,
      edgeX: LEFT_EDGE_X,
      openVia: "button" as const,
    },
    {
      label: "partial-positive font20/1000 right",
      uiFontSize: 20,
      viewportWidth: 1000,
      hitWidth: 5,
      side: "right" as const,
      edgeX: RIGHT_EDGE_X,
      openVia: "button" as const,
    },
    {
      label: "wide max strip font15 right",
      uiFontSize: DEFAULT_UI_FONT_SIZE,
      viewportWidth: WIDE_VIEWPORT_PX,
      hitWidth: CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH,
      side: "right" as const,
      edgeX: RIGHT_EDGE_X,
      openVia: "button" as const,
    },
    {
      label: "wide max strip font15 left",
      uiFontSize: DEFAULT_UI_FONT_SIZE,
      viewportWidth: WIDE_VIEWPORT_PX,
      hitWidth: CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH,
      side: "left" as const,
      edgeX: LEFT_EDGE_X,
      openVia: "button" as const,
    },
  ] as const;

  it.each(FIXED_OFFSET_CASES)(
    "card is exactly 2rem from the rail ($label); strip width stays safe",
    async (offsetCase) => {
      useSettingsStore.setState({ uiFontSize: offsetCase.uiFontSize });
      expect(
        hitStripWidthFor(offsetCase.viewportWidth, offsetCase.uiFontSize),
      ).toBe(offsetCase.hitWidth);

      const { viewport } = renderMinimap({
        messages: makeThreeTurnTranscript(),
        viewportWidth: offsetCase.viewportWidth,
        side: offsetCase.side,
      });
      await flushMinimapFrames(2);

      mockPassiveRailGeometry({
        top: RAIL_TOP,
        height: RAIL_HEIGHT,
        edgeX: offsetCase.edgeX,
        hitWidth: offsetCase.hitWidth,
        side: offsetCase.side,
      });

      if (offsetCase.openVia === "passive") {
        act(() => {
          dispatchViewportPointer(viewport, "pointermove", {
            clientX: offsetCase.edgeX,
            clientY: RAIL_TOP + RAIL_HEIGHT / 2,
            buttons: 0,
          });
        });
      } else {
        const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
        fireEvent.mouseMove(hitStrip, {
          clientY: RAIL_TOP + RAIL_HEIGHT / 2,
          buttons: 0,
        });
      }

      expect(await screen.findByText("Turn beta")).toBeTruthy();
      expectFixedTwoRemCardSeparation({
        side: offsetCase.side,
        uiFontSize: offsetCase.uiFontSize,
        hitStripWidthPx: offsetCase.hitWidth,
      });
      if (offsetCase.hitWidth === 0) {
        expectZeroWidthHitStripInert();
      } else {
        expectPositiveSafeHitStrip(offsetCase.hitWidth);
      }
    },
  );

  it("open-preview proximity is 2rem (retain at boundary, close beyond) on left and right", async () => {
    // Wide pane: passive is off until the card opens; then 2rem gap bridge.
    const { viewport } = renderMinimap({
      messages: makeThreeTurnTranscript(),
      viewportWidth: WIDE_VIEWPORT_PX,
      side: "right",
    });
    await flushMinimapFrames(2);
    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    mockPassiveRailGeometry({
      top: RAIL_TOP,
      height: RAIL_HEIGHT,
      edgeX: RIGHT_EDGE_X,
      hitWidth: CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH,
      side: "right",
    });
    fireEvent.mouseMove(hitStrip, {
      clientY: RAIL_TOP + RAIL_HEIGHT / 2,
      buttons: 0,
    });
    expect(await screen.findByText("Turn beta")).toBeTruthy();
    fireEvent.mouseLeave(getInteractionRegion());

    const twoRem = DEFAULT_UI_FONT_SIZE * PREVIEW_EDGE_OFFSET_REM;
    act(() => {
      dispatchViewportPointer(viewport, "pointermove", {
        clientX: RIGHT_EDGE_X - twoRem,
        clientY: RAIL_TOP + RAIL_HEIGHT / 2,
      });
    });
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).not.toBeNull();

    // Pointer into the card retains regardless of coordinates.
    const preview = document.querySelector("[data-chat-turn-minimap-preview]");
    act(() => {
      dispatchViewportPointer(viewport, "pointermove", {
        clientX: 50,
        clientY: 20,
        target: preview as EventTarget,
      });
    });
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).not.toBeNull();

    act(() => {
      dispatchViewportPointer(viewport, "pointermove", {
        clientX: RIGHT_EDGE_X - twoRem - 1,
        clientY: RAIL_TOP + RAIL_HEIGHT / 2,
      });
    });
    await flushMinimapFrames(1);
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();

    // Left side same contract after re-open.
    cleanup();
    useSettingsStore.setState({ uiFontSize: DEFAULT_UI_FONT_SIZE });
    const left = renderMinimap({
      messages: makeThreeTurnTranscript(),
      viewportWidth: WIDE_VIEWPORT_PX,
      side: "left",
    });
    await flushMinimapFrames(2);
    const leftHit = screen.getByTestId("chat-turn-minimap-hit-strip");
    mockPassiveRailGeometry({
      top: RAIL_TOP,
      height: RAIL_HEIGHT,
      edgeX: LEFT_EDGE_X,
      hitWidth: CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH,
      side: "left",
    });
    fireEvent.mouseMove(leftHit, {
      clientY: RAIL_TOP + RAIL_HEIGHT / 2,
      buttons: 0,
    });
    expect(await screen.findByText("Turn beta")).toBeTruthy();
    fireEvent.mouseLeave(getInteractionRegion());
    act(() => {
      dispatchViewportPointer(left.viewport, "pointermove", {
        clientX: LEFT_EDGE_X + twoRem,
        clientY: RAIL_TOP + RAIL_HEIGHT / 2,
      });
    });
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).not.toBeNull();
    act(() => {
      dispatchViewportPointer(left.viewport, "pointermove", {
        clientX: LEFT_EDGE_X + twoRem + 1,
        clientY: RAIL_TOP + RAIL_HEIGHT / 2,
      });
    });
    await flushMinimapFrames(1);
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();
  });

  it("expanded list keeps fixed 2rem offset, gap retain, and closes beyond gap / viewport leave", async () => {
    const { viewport } = renderMinimap({
      messages: makeThreeTurnTranscript(),
      viewportWidth: WIDE_VIEWPORT_PX,
    });
    await flushMinimapFrames(2);
    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    mockPassiveRailGeometry({
      top: RAIL_TOP,
      height: RAIL_HEIGHT,
      edgeX: RIGHT_EDGE_X,
      hitWidth: CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH,
      side: "right",
    });
    fireEvent.mouseMove(hitStrip, {
      clientY: RAIL_TOP + RAIL_HEIGHT / 2,
      buttons: 0,
    });
    expect(await screen.findByText("Turn beta")).toBeTruthy();
    fireEvent.click(
      await screen.findByRole("button", { name: "Expand all messages" }),
    );
    expect(
      screen.getByRole("button", { name: "Collapse message list" }),
    ).toBeTruthy();
    expectFixedTwoRemCardSeparation({
      side: "right",
      uiFontSize: DEFAULT_UI_FONT_SIZE,
      hitStripWidthPx: CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH,
    });
    // Expanded list still shows all turns (no stale single-card content).
    expect(screen.getByText("Turn alpha")).toBeTruthy();
    expect(screen.getByText("Turn gamma")).toBeTruthy();

    fireEvent.mouseLeave(getInteractionRegion());
    const twoRem = DEFAULT_UI_FONT_SIZE * PREVIEW_EDGE_OFFSET_REM;
    act(() => {
      dispatchViewportPointer(viewport, "pointermove", {
        clientX: RIGHT_EDGE_X - twoRem,
        clientY: RAIL_TOP + RAIL_HEIGHT / 2,
      });
    });
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Collapse message list" }),
    ).toBeTruthy();

    act(() => {
      dispatchViewportPointer(viewport, "pointerleave", {
        clientX: 0,
        clientY: 0,
      });
    });
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();
    // No stale expanded card after viewport leave.
    expect(
      screen.queryByRole("button", { name: "Collapse message list" }),
    ).toBeNull();
  });

  it("zero-gutter open card uses 2rem gap proximity (not the 1rem pre-open band)", async () => {
    useSettingsStore.setState({ uiFontSize: DEFAULT_UI_FONT_SIZE });
    const { viewport } = renderMinimap({
      messages: makeThreeTurnTranscript(),
      viewportWidth: CONSTRAINED_VIEWPORT_PX,
    });
    await flushMinimapFrames(2);
    expectZeroWidthHitStripInert();
    mockZeroWidthRailGeometry({
      top: RAIL_TOP,
      height: RAIL_HEIGHT,
      edgeX: RIGHT_EDGE_X,
    });
    act(() => {
      dispatchViewportPointer(viewport, "pointermove", {
        clientX: RIGHT_EDGE_X,
        clientY: RAIL_TOP + RAIL_HEIGHT / 2,
        buttons: 0,
      });
    });
    expect(await screen.findByText("Turn beta")).toBeTruthy();
    expectFixedTwoRemCardSeparation({
      side: "right",
      uiFontSize: DEFAULT_UI_FONT_SIZE,
      hitStripWidthPx: 0,
    });

    const oneRem = DEFAULT_UI_FONT_SIZE;
    const twoRem = DEFAULT_UI_FONT_SIZE * PREVIEW_EDGE_OFFSET_REM;
    // Between 1rem and 2rem: only valid once the card is open.
    act(() => {
      dispatchViewportPointer(viewport, "pointermove", {
        clientX: RIGHT_EDGE_X - oneRem - 1,
        clientY: RAIL_TOP + RAIL_HEIGHT / 2,
      });
    });
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).not.toBeNull();
    act(() => {
      dispatchViewportPointer(viewport, "pointermove", {
        clientX: RIGHT_EDGE_X - twoRem,
        clientY: RAIL_TOP + RAIL_HEIGHT / 2,
      });
    });
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).not.toBeNull();
    act(() => {
      dispatchViewportPointer(viewport, "pointermove", {
        clientX: RIGHT_EDGE_X - twoRem - 1,
        clientY: RAIL_TOP + RAIL_HEIGHT / 2,
      });
    });
    await flushMinimapFrames(1);
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();
    expectMinimapInertDomState();
  });
});

/**
 * Passive viewport hover activates whenever the safe hit strip is strictly
 * narrower than the widest 1.5rem marker (zero-gutter and partial-positive
 * gutters), and also while a preview is open (2rem gap bridge). Button-owned
 * hover covers max-width and hit >= the widest marker until a card opens.
 */
describe("ChatTurnMinimap passive hover (hit narrower than widest marker)", () => {
  const RAIL_TOP = 100;
  const RAIL_HEIGHT = 200;
  const RIGHT_EDGE_X = 580;
  const LEFT_EDGE_X = 12;

  async function renderZeroGutterPassive(options: {
    readonly side?: ChatTurnMinimapSide;
    readonly messages?: ReadonlyArray<ChatMessageModel>;
    readonly onSelect?: (messageId: string) => void;
    readonly viewportWidth?: number;
  }): Promise<{
    viewport: HTMLElement;
    onSelect: OnSelectMock;
  }> {
    const rendered = renderMinimap({
      messages: options.messages ?? makeThreeTurnTranscript(),
      viewportWidth: options.viewportWidth ?? CONSTRAINED_VIEWPORT_PX,
      side: options.side ?? "right",
      onSelect: options.onSelect,
    });
    await flushMinimapFrames(2);
    expectZeroWidthHitStripInert();
    expectInteractionRegionHidden();
    return { viewport: rendered.viewport, onSelect: rendered.onSelect };
  }

  async function renderPartialPositivePassive(input: {
    readonly uiFontSize: number;
    readonly viewportWidth: number;
    readonly hitWidth: number;
    readonly side?: ChatTurnMinimapSide;
    readonly messages?: ReadonlyArray<ChatMessageModel>;
    readonly onSelect?: (messageId: string) => void;
  }): Promise<{
    viewport: HTMLElement;
    onSelect: OnSelectMock;
    hitWidth: number;
  }> {
    useSettingsStore.setState({ uiFontSize: input.uiFontSize });
    expect(hitStripWidthFor(input.viewportWidth, input.uiFontSize)).toBe(
      input.hitWidth,
    );
    expect(input.hitWidth).toBeGreaterThan(0);
    expect(input.hitWidth).toBeLessThan(
      input.uiFontSize * CHAT_TURN_MINIMAP_MAX_MARKER_WIDTH_REM,
    );

    const rendered = renderMinimap({
      messages: input.messages ?? makeThreeTurnTranscript(),
      viewportWidth: input.viewportWidth,
      side: input.side ?? "right",
      onSelect: input.onSelect,
    });
    await flushMinimapFrames(2);
    expectPositiveSafeHitStrip(input.hitWidth);
    return {
      viewport: rendered.viewport,
      onSelect: rendered.onSelect,
      hitWidth: input.hitWidth,
    };
  }

  function openPassiveAtY(
    viewport: HTMLElement,
    input: {
      clientY: number;
      edgeX: number;
      clientX?: number;
      uiFontSize?: number;
      hitWidth?: number;
      side?: ChatTurnMinimapSide;
    },
  ): void {
    const hitWidth = input.hitWidth ?? 0;
    const side = input.side ?? "right";
    mockPassiveRailGeometry({
      top: RAIL_TOP,
      height: RAIL_HEIGHT,
      edgeX: input.edgeX,
      hitWidth,
      side,
    });
    const proximity = input.uiFontSize ?? DEFAULT_UI_FONT_SIZE;
    act(() => {
      dispatchViewportPointer(viewport, "pointermove", {
        clientX: input.clientX ?? input.edgeX,
        clientY: input.clientY,
        buttons: 0,
      });
    });
    // Sanity: the move was inside the 1rem horizontal band.
    expect(
      Math.abs((input.clientX ?? input.edgeX) - input.edgeX),
    ).toBeLessThanOrEqual(proximity);
  }

  /**
   * Pointer on painted marker overflow just outside the live button opening
   * (still within 1rem of the edge) — the dead zone independent review P1
   * called out for partial-positive gutters.
   */
  function overflowClientXOutsideButton(input: {
    edgeX: number;
    hitWidth: number;
    side: ChatTurnMinimapSide;
  }): number {
    return input.side === "left"
      ? input.edgeX + input.hitWidth + 1
      : input.edgeX - input.hitWidth - 1;
  }

  it("opens and changes compact cards from viewport pointermove near each marker (right, font15)", async () => {
    const { viewport } = await renderZeroGutterPassive({});
    // Three turns: first / middle / last map to rail Y at top / mid / bottom.
    openPassiveAtY(viewport, { clientY: RAIL_TOP, edgeX: RIGHT_EDGE_X });
    expect(await screen.findByText("Turn alpha")).toBeTruthy();
    expectZeroWidthHitStripInert();
    expectInteractionRegionExposedForPreview();

    openPassiveAtY(viewport, {
      clientY: RAIL_TOP + RAIL_HEIGHT / 2,
      edgeX: RIGHT_EDGE_X,
      clientX: RIGHT_EDGE_X - DEFAULT_UI_FONT_SIZE,
    });
    expect(await screen.findByText("Turn beta")).toBeTruthy();

    openPassiveAtY(viewport, {
      clientY: RAIL_TOP + RAIL_HEIGHT,
      edgeX: RIGHT_EDGE_X,
    });
    expect(await screen.findByText("Turn gamma")).toBeTruthy();
    expectZeroWidthHitStripInert();
  });

  it("opens compact cards from left-edge coordinates (font15 proximity)", async () => {
    const { viewport } = await renderZeroGutterPassive({ side: "left" });
    openPassiveAtY(viewport, {
      clientY: RAIL_TOP + RAIL_HEIGHT / 2,
      edgeX: LEFT_EDGE_X,
      clientX: LEFT_EDGE_X + DEFAULT_UI_FONT_SIZE,
    });
    expect(await screen.findByText("Turn beta")).toBeTruthy();
    expectZeroWidthHitStripInert();
    expectInteractionRegionExposedForPreview();
  });

  it("uses font20 1rem proximity on left and right edges", async () => {
    useSettingsStore.setState({ uiFontSize: 20 });
    const { viewport } = await renderZeroGutterPassive({
      // 593-class constrained pane stays zero at font 20.
      viewportWidth: 593,
    });

    openPassiveAtY(viewport, {
      clientY: RAIL_TOP,
      edgeX: RIGHT_EDGE_X,
      clientX: RIGHT_EDGE_X - 20,
      uiFontSize: 20,
    });
    expect(await screen.findByText("Turn alpha")).toBeTruthy();

    act(() => {
      dispatchViewportPointer(viewport, "pointerleave", {
        clientX: 0,
        clientY: 0,
      });
    });
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();

    // Remount is unnecessary: switch side via rerender through a second render.
    cleanup();
    const left = await renderZeroGutterPassive({
      side: "left",
      viewportWidth: 593,
    });
    openPassiveAtY(left.viewport, {
      clientY: RAIL_TOP + RAIL_HEIGHT,
      edgeX: LEFT_EDGE_X,
      clientX: LEFT_EDGE_X + 20,
      uiFontSize: 20,
    });
    expect(await screen.findByText("Turn gamma")).toBeTruthy();
  });

  it("does not open when pointer is outside horizontal or vertical proximity", async () => {
    const { viewport } = await renderZeroGutterPassive({});
    mockZeroWidthRailGeometry({
      top: RAIL_TOP,
      height: RAIL_HEIGHT,
      edgeX: RIGHT_EDGE_X,
    });

    // Outside horizontal band (beyond 1rem from right edge).
    act(() => {
      dispatchViewportPointer(viewport, "pointermove", {
        clientX: RIGHT_EDGE_X - DEFAULT_UI_FONT_SIZE - 1,
        clientY: RAIL_TOP + RAIL_HEIGHT / 2,
      });
    });
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();

    // Inside horizontal band but outside vertical rail.
    act(() => {
      dispatchViewportPointer(viewport, "pointermove", {
        clientX: RIGHT_EDGE_X,
        clientY: RAIL_TOP - 1,
      });
    });
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();

    act(() => {
      dispatchViewportPointer(viewport, "pointermove", {
        clientX: RIGHT_EDGE_X,
        clientY: RAIL_TOP + RAIL_HEIGHT + 1,
      });
    });
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();
    expectInteractionRegionHidden();
  });

  it("coalesces pointer moves into one layout read using the latest point", async () => {
    const { viewport } = await renderZeroGutterPassive({});
    const interactionRegion = getInteractionRegion();
    const rectSpy = vi
      .spyOn(interactionRegion, "getBoundingClientRect")
      .mockReturnValue({
        x: RIGHT_EDGE_X,
        y: RAIL_TOP,
        width: 0,
        height: RAIL_HEIGHT,
        top: RAIL_TOP,
        left: RIGHT_EDGE_X,
        right: RIGHT_EDGE_X,
        bottom: RAIL_TOP + RAIL_HEIGHT,
        toJSON: () => ({}),
      });
    const frames = installHeldAnimationFrames();
    try {
      act(() => {
        dispatchViewportPointer(viewport, "pointermove", {
          clientX: RIGHT_EDGE_X,
          clientY: RAIL_TOP,
        });
        dispatchViewportPointer(viewport, "pointermove", {
          clientX: RIGHT_EDGE_X,
          clientY: RAIL_TOP + RAIL_HEIGHT,
        });
      });

      expect(frames.held.size).toBe(1);
      expect(rectSpy).not.toHaveBeenCalled();
      const frameId = [...frames.held.keys()][0];
      act(() => {
        frames.flush(frameId);
      });

      expect(rectSpy).toHaveBeenCalledTimes(1);
      expect(await screen.findByText("Turn gamma")).toBeTruthy();

      act(() => {
        dispatchViewportPointer(viewport, "pointermove", {
          clientX: RIGHT_EDGE_X,
          clientY: RAIL_TOP,
        });
      });
      expect(frames.held.size).toBe(1);
      const pendingFrameId = [...frames.held.keys()][0];
      act(() => {
        dispatchViewportPointer(viewport, "pointerleave", {
          clientX: 0,
          clientY: 0,
        });
      });
      expect(frames.cancelCalls).toContain(pendingFrameId);
      expect(frames.held.size).toBe(0);
    } finally {
      frames.restore();
    }
  });

  it("retains the preview while the pointer moves into the preview target", async () => {
    const { viewport } = await renderZeroGutterPassive({});
    openPassiveAtY(viewport, {
      clientY: RAIL_TOP + RAIL_HEIGHT / 2,
      edgeX: RIGHT_EDGE_X,
    });
    expect(await screen.findByText("Turn beta")).toBeTruthy();
    const preview = document.querySelector("[data-chat-turn-minimap-preview]");
    expect(preview).not.toBeNull();

    // Even with coordinates outside the rail zone, a preview-targeted move
    // must not dismiss (retain path).
    act(() => {
      dispatchViewportPointer(viewport, "pointermove", {
        clientX: 100,
        clientY: 50,
        target: preview as EventTarget,
      });
    });
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).not.toBeNull();
    expect(screen.getByText("Turn beta")).toBeTruthy();
  });

  it("dismisses when the pointer moves into the transcript outside the zone", async () => {
    const { viewport } = await renderZeroGutterPassive({});
    openPassiveAtY(viewport, {
      clientY: RAIL_TOP,
      edgeX: RIGHT_EDGE_X,
    });
    expect(await screen.findByText("Turn alpha")).toBeTruthy();

    act(() => {
      dispatchViewportPointer(viewport, "pointermove", {
        clientX: 40,
        clientY: RAIL_TOP + 10,
      });
    });
    await flushMinimapFrames(1);
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();
    expectMinimapInertDomState();
  });

  it("dismisses on viewport pointerleave but not on region mouseleave", async () => {
    const { viewport } = await renderZeroGutterPassive({});
    openPassiveAtY(viewport, {
      clientY: RAIL_TOP + RAIL_HEIGHT / 2,
      edgeX: RIGHT_EDGE_X,
    });
    expect(await screen.findByText("Turn beta")).toBeTruthy();

    // Region mouseleave must not close passive previews (only wide-strip path).
    fireEvent.mouseLeave(getInteractionRegion());
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).not.toBeNull();

    act(() => {
      dispatchViewportPointer(viewport, "pointerleave", {
        clientX: RIGHT_EDGE_X,
        clientY: RAIL_TOP,
      });
    });
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();
    expectMinimapInertDomState();
  });

  it("clicking the compact card calls onSelect while the zero button stays inert", async () => {
    const { viewport, onSelect } = await renderZeroGutterPassive({});
    openPassiveAtY(viewport, { clientY: RAIL_TOP, edgeX: RIGHT_EDGE_X });
    expect(await screen.findByText("Turn alpha")).toBeTruthy();
    expectInteractionRegionExposedForPreview();

    const previewCard = document.querySelector("[data-chat-turn-minimap-card]");
    expect(previewCard).not.toBeNull();
    fireEvent.click(previewCard as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith("message-0");
    expectZeroWidthHitStripInert();
  });

  it("navigates from a clean click on painted zero-gutter markers", async () => {
    const { viewport, onSelect } = await renderZeroGutterPassive({});
    openPassiveAtY(viewport, {
      clientY: RAIL_TOP + RAIL_HEIGHT / 2,
      edgeX: RIGHT_EDGE_X,
    });
    expect(await screen.findByText("Turn beta")).toBeTruthy();

    let event: MouseEvent | undefined;
    act(() => {
      event = dispatchViewportClick(viewport, {
        clientX:
          RIGHT_EDGE_X -
          DEFAULT_UI_FONT_SIZE * CHAT_TURN_MINIMAP_MAX_MARKER_WIDTH_REM,
        clientY: RAIL_TOP + RAIL_HEIGHT / 2,
      });
    });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("message-2");
    expect(event?.defaultPrevented).toBe(true);
    expectZeroWidthHitStripInert();
  });

  it("leaves a zero-gutter click with the transcript when text is selected", async () => {
    const { viewport, onSelect } = await renderZeroGutterPassive({});
    mockZeroWidthRailGeometry({
      top: RAIL_TOP,
      height: RAIL_HEIGHT,
      edgeX: RIGHT_EDGE_X,
    });
    const clearSelection = installNonCollapsedSelection(
      "selected transcript text",
    );
    onTestFinished(clearSelection);

    let event: MouseEvent | undefined;
    act(() => {
      event = dispatchViewportClick(viewport, {
        clientX: RIGHT_EDGE_X - 1,
        clientY: RAIL_TOP + RAIL_HEIGHT / 2,
      });
    });

    expect(onSelect).not.toHaveBeenCalled();
    expect(event?.defaultPrevented).toBe(false);
  });

  it("does not claim clicks outside the painted zero-gutter marker width", async () => {
    const { viewport, onSelect } = await renderZeroGutterPassive({});
    mockZeroWidthRailGeometry({
      top: RAIL_TOP,
      height: RAIL_HEIGHT,
      edgeX: RIGHT_EDGE_X,
    });

    let event: MouseEvent | undefined;
    act(() => {
      event = dispatchViewportClick(viewport, {
        clientX:
          RIGHT_EDGE_X -
          DEFAULT_UI_FONT_SIZE * CHAT_TURN_MINIMAP_MAX_MARKER_WIDTH_REM -
          1,
        clientY: RAIL_TOP + RAIL_HEIGHT / 2,
      });
    });

    expect(onSelect).not.toHaveBeenCalled();
    expect(event?.defaultPrevented).toBe(false);
  });

  it("supports expand and collapse in passive mode", async () => {
    const { viewport, onSelect } = await renderZeroGutterPassive({});
    openPassiveAtY(viewport, {
      clientY: RAIL_TOP + RAIL_HEIGHT / 2,
      edgeX: RIGHT_EDGE_X,
    });
    expect(await screen.findByText("Turn beta")).toBeTruthy();

    fireEvent.click(
      await screen.findByRole("button", { name: "Expand all messages" }),
    );
    expect(
      screen.getByRole("button", { name: "Collapse message list" }),
    ).toBeTruthy();
    expect(screen.getByText("Turn alpha")).toBeTruthy();
    expect(screen.getByText("Turn gamma")).toBeTruthy();
    expectZeroWidthHitStripInert();
    // Group remains exposed while preview is visible so expanded controls work.
    expectInteractionRegionExposedForPreview();

    fireEvent.click(
      screen.getByRole("button", { name: "Jump to message: Turn gamma" }),
    );
    expect(onSelect).toHaveBeenCalledWith("message-5");

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse message list" }),
    );
    expect(
      screen.getByRole("button", { name: "Expand all messages" }),
    ).toBeTruthy();
  });

  it("pointerdown outside the preview closes without preventing default", async () => {
    const { viewport } = await renderZeroGutterPassive({});
    openPassiveAtY(viewport, {
      clientY: RAIL_TOP + RAIL_HEIGHT / 2,
      edgeX: RIGHT_EDGE_X,
    });
    expect(await screen.findByText("Turn beta")).toBeTruthy();

    let event: PointerEvent | undefined;
    act(() => {
      event = dispatchViewportPointer(viewport, "pointerdown", {
        clientX: 80,
        clientY: 120,
      });
    });
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();
    expect(event?.defaultPrevented).toBe(false);
    expectMinimapInertDomState();
  });

  it("pointerdown on the preview target does not close", async () => {
    const { viewport } = await renderZeroGutterPassive({});
    openPassiveAtY(viewport, {
      clientY: RAIL_TOP + RAIL_HEIGHT / 2,
      edgeX: RIGHT_EDGE_X,
    });
    expect(await screen.findByText("Turn beta")).toBeTruthy();
    const preview = document.querySelector("[data-chat-turn-minimap-preview]");
    expect(preview).not.toBeNull();

    act(() => {
      dispatchViewportPointer(viewport, "pointerdown", {
        clientX: 200,
        clientY: 150,
        target: preview as EventTarget,
      });
    });
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).not.toBeNull();
  });

  it("buttons-held move and non-collapsed selection suppress/close without cancelling the event", async () => {
    const { viewport } = await renderZeroGutterPassive({});
    openPassiveAtY(viewport, {
      clientY: RAIL_TOP + RAIL_HEIGHT / 2,
      edgeX: RIGHT_EDGE_X,
    });
    expect(await screen.findByText("Turn beta")).toBeTruthy();

    let dragEvent: PointerEvent | undefined;
    act(() => {
      dragEvent = dispatchViewportPointer(viewport, "pointermove", {
        clientX: RIGHT_EDGE_X,
        clientY: RAIL_TOP + RAIL_HEIGHT / 2 + 4,
        buttons: 1,
      });
    });
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();
    expect(dragEvent?.defaultPrevented).toBe(false);

    // Clean hover resumes after release.
    openPassiveAtY(viewport, {
      clientY: RAIL_TOP + RAIL_HEIGHT / 2,
      edgeX: RIGHT_EDGE_X,
    });
    expect(await screen.findByText("Turn beta")).toBeTruthy();

    const clearSelection = installNonCollapsedSelection(
      "selected transcript text",
    );
    onTestFinished(clearSelection);
    let selectionEvent: PointerEvent | undefined;
    act(() => {
      selectionEvent = dispatchViewportPointer(viewport, "pointermove", {
        clientX: RIGHT_EDGE_X,
        clientY: RAIL_TOP + 10,
        buttons: 0,
      });
    });
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();
    expect(selectionEvent?.defaultPrevented).toBe(false);
    clearSelection();

    openPassiveAtY(viewport, {
      clientY: RAIL_TOP,
      edgeX: RIGHT_EDGE_X,
    });
    expect(await screen.findByText("Turn alpha")).toBeTruthy();
    expectZeroWidthHitStripInert();
  });

  it("group a11y is hidden before/after preview and exposed only while shown", async () => {
    const { viewport } = await renderZeroGutterPassive({});
    expectInteractionRegionHidden();
    expectMinimapGroupAccessible(false);

    openPassiveAtY(viewport, {
      clientY: RAIL_TOP,
      edgeX: RIGHT_EDGE_X,
    });
    expect(await screen.findByText("Turn alpha")).toBeTruthy();
    expectInteractionRegionExposedForPreview();
    expectMinimapGroupAccessible(true);
    // Named hit-strip button remains out of the a11y tree while zero-width.
    expect(
      screen.queryByRole("button", { name: "Message minimap" }),
    ).toBeNull();
    expectZeroWidthHitStripInert();

    act(() => {
      dispatchViewportPointer(viewport, "pointerleave", {
        clientX: 0,
        clientY: 0,
      });
    });
    expectInteractionRegionHidden();
    expectMinimapGroupAccessible(false);
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();
  });

  it("does not activate passive hover on a max-width (40px) hit strip — button owns hover", async () => {
    const { viewport } = renderMinimap({
      messages: makeThreeTurnTranscript(),
      viewportWidth: WIDE_VIEWPORT_PX,
    });
    await flushMinimapFrames(2);
    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    expect(hitStrip.style.width).toBe(
      `${CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH}px`,
    );
    expect(CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH).toBeGreaterThan(
      DEFAULT_UI_FONT_SIZE * CHAT_TURN_MINIMAP_MAX_MARKER_WIDTH_REM,
    );
    mockRailGeometry(hitStrip, {
      top: RAIL_TOP,
      height: RAIL_HEIGHT,
      left: RIGHT_EDGE_X - 40,
      width: 40,
    });

    // Viewport pointermove must not open when the button-owned path owns hover.
    act(() => {
      dispatchViewportPointer(viewport, "pointermove", {
        clientX: RIGHT_EDGE_X,
        clientY: RAIL_TOP + RAIL_HEIGHT / 2,
      });
    });
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();

    fireEvent.mouseMove(hitStrip, {
      clientY: RAIL_TOP + RAIL_HEIGHT / 2,
    });
    expect(await screen.findByText("Turn beta")).toBeTruthy();
  });

  it.each(PARTIAL_POSITIVE_PASSIVE_CASES)(
    "partial-positive $label: geometry pins safe width and activates passive (hit $hitWidth < marker $markerPx)",
    async (partialCase) => {
      expect(
        hitStripWidthFor(partialCase.viewportWidth, partialCase.uiFontSize),
      ).toBe(partialCase.hitWidth);
      expect(
        partialCase.uiFontSize * CHAT_TURN_MINIMAP_MAX_MARKER_WIDTH_REM,
      ).toBe(partialCase.markerPx);

      await renderPartialPositivePassive({
        uiFontSize: partialCase.uiFontSize,
        viewportWidth: partialCase.viewportWidth,
        hitWidth: partialCase.hitWidth,
      });
      expectPositiveSafeHitStrip(partialCase.hitWidth);
    },
  );

  it("partial-positive font20/1000 right: viewport overflow outside button opens/changes cards; width and a11y held", async () => {
    const partialCase = PARTIAL_POSITIVE_PASSIVE_CASES[0];
    const { viewport, hitWidth } = await renderPartialPositivePassive({
      uiFontSize: partialCase.uiFontSize,
      viewportWidth: partialCase.viewportWidth,
      hitWidth: partialCase.hitWidth,
      side: "right",
    });

    const overflowX = overflowClientXOutsideButton({
      edgeX: RIGHT_EDGE_X,
      hitWidth,
      side: "right",
    });
    expect(Math.abs(overflowX - RIGHT_EDGE_X)).toBe(hitWidth + 1);
    expect(hitWidth + 1).toBeLessThanOrEqual(partialCase.uiFontSize);

    openPassiveAtY(viewport, {
      clientY: RAIL_TOP,
      edgeX: RIGHT_EDGE_X,
      clientX: overflowX,
      uiFontSize: partialCase.uiFontSize,
      hitWidth,
      side: "right",
    });
    expect(await screen.findByText("Turn alpha")).toBeTruthy();
    expectPositiveSafeHitStrip(hitWidth);
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).not.toBeNull();

    openPassiveAtY(viewport, {
      clientY: RAIL_TOP + RAIL_HEIGHT / 2,
      edgeX: RIGHT_EDGE_X,
      clientX: overflowX,
      uiFontSize: partialCase.uiFontSize,
      hitWidth,
      side: "right",
    });
    expect(await screen.findByText("Turn beta")).toBeTruthy();

    openPassiveAtY(viewport, {
      clientY: RAIL_TOP + RAIL_HEIGHT,
      edgeX: RIGHT_EDGE_X,
      clientX: overflowX,
      uiFontSize: partialCase.uiFontSize,
      hitWidth,
      side: "right",
    });
    expect(await screen.findByText("Turn gamma")).toBeTruthy();
    expectPositiveSafeHitStrip(hitWidth);
  });

  it("partial-positive font17/850 left: viewport overflow outside button opens cards", async () => {
    const partialCase = PARTIAL_POSITIVE_PASSIVE_CASES[1];
    const { viewport, hitWidth } = await renderPartialPositivePassive({
      uiFontSize: partialCase.uiFontSize,
      viewportWidth: partialCase.viewportWidth,
      hitWidth: partialCase.hitWidth,
      side: "left",
    });

    const overflowX = overflowClientXOutsideButton({
      edgeX: LEFT_EDGE_X,
      hitWidth,
      side: "left",
    });
    openPassiveAtY(viewport, {
      clientY: RAIL_TOP + RAIL_HEIGHT / 2,
      edgeX: LEFT_EDGE_X,
      clientX: overflowX,
      uiFontSize: partialCase.uiFontSize,
      hitWidth,
      side: "left",
    });
    expect(await screen.findByText("Turn beta")).toBeTruthy();
    expectPositiveSafeHitStrip(hitWidth);
  });

  it.each([
    { caseIndex: 0, edgeX: RIGHT_EDGE_X, side: "right" as const },
    { caseIndex: 1, edgeX: LEFT_EDGE_X, side: "left" as const },
  ])(
    "partial-positive $side: a clean click on painted overflow outside the button navigates",
    async ({ caseIndex, edgeX, side }) => {
      const partialCase = PARTIAL_POSITIVE_PASSIVE_CASES[caseIndex];
      const { viewport, onSelect, hitWidth } =
        await renderPartialPositivePassive({
          uiFontSize: partialCase.uiFontSize,
          viewportWidth: partialCase.viewportWidth,
          hitWidth: partialCase.hitWidth,
          side,
        });
      const overflowX = overflowClientXOutsideButton({
        edgeX,
        hitWidth,
        side,
      });
      openPassiveAtY(viewport, {
        clientY: RAIL_TOP + RAIL_HEIGHT / 2,
        edgeX,
        clientX: overflowX,
        uiFontSize: partialCase.uiFontSize,
        hitWidth,
        side,
      });
      expect(await screen.findByText("Turn beta")).toBeTruthy();

      let event: MouseEvent | undefined;
      act(() => {
        event = dispatchViewportClick(viewport, {
          clientX: overflowX,
          clientY: RAIL_TOP + RAIL_HEIGHT / 2,
        });
      });

      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledWith("message-2");
      expect(event?.defaultPrevented).toBe(true);
      expectPositiveSafeHitStrip(hitWidth);
    },
  );

  it("partial-positive font15/750 right: retain, dismiss, card click; button stays positive", async () => {
    const partialCase = PARTIAL_POSITIVE_PASSIVE_CASES[2];
    const { viewport, onSelect, hitWidth } = await renderPartialPositivePassive(
      {
        uiFontSize: partialCase.uiFontSize,
        viewportWidth: partialCase.viewportWidth,
        hitWidth: partialCase.hitWidth,
        side: "right",
      },
    );

    const overflowX = overflowClientXOutsideButton({
      edgeX: RIGHT_EDGE_X,
      hitWidth,
      side: "right",
    });
    openPassiveAtY(viewport, {
      clientY: RAIL_TOP,
      edgeX: RIGHT_EDGE_X,
      clientX: overflowX,
      uiFontSize: partialCase.uiFontSize,
      hitWidth,
      side: "right",
    });
    expect(await screen.findByText("Turn alpha")).toBeTruthy();
    const preview = document.querySelector("[data-chat-turn-minimap-preview]");
    expect(preview).not.toBeNull();

    // Retain while pointer is over the preview card.
    act(() => {
      dispatchViewportPointer(viewport, "pointermove", {
        clientX: 100,
        clientY: 50,
        target: preview as EventTarget,
      });
    });
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).not.toBeNull();
    expect(screen.getByText("Turn alpha")).toBeTruthy();
    expectPositiveSafeHitStrip(hitWidth);

    // Card click navigates while the safe strip stays positive.
    const previewCard = document.querySelector("[data-chat-turn-minimap-card]");
    expect(previewCard).not.toBeNull();
    fireEvent.click(previewCard as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith("message-0");
    expectPositiveSafeHitStrip(hitWidth);

    // Re-open then dismiss into transcript outside the proximity zone.
    openPassiveAtY(viewport, {
      clientY: RAIL_TOP + RAIL_HEIGHT / 2,
      edgeX: RIGHT_EDGE_X,
      clientX: overflowX,
      uiFontSize: partialCase.uiFontSize,
      hitWidth,
      side: "right",
    });
    expect(await screen.findByText("Turn beta")).toBeTruthy();
    act(() => {
      dispatchViewportPointer(viewport, "pointermove", {
        clientX: 40,
        clientY: RAIL_TOP + 10,
      });
    });
    await flushMinimapFrames(1);
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();
    expectPositiveSafeHitStrip(hitWidth);
  });

  it("partial-positive: drag and non-collapsed selection suppress passive without cancelling events", async () => {
    const partialCase = PARTIAL_POSITIVE_PASSIVE_CASES[0];
    const { viewport, hitWidth } = await renderPartialPositivePassive({
      uiFontSize: partialCase.uiFontSize,
      viewportWidth: partialCase.viewportWidth,
      hitWidth: partialCase.hitWidth,
    });
    const overflowX = overflowClientXOutsideButton({
      edgeX: RIGHT_EDGE_X,
      hitWidth,
      side: "right",
    });
    openPassiveAtY(viewport, {
      clientY: RAIL_TOP + RAIL_HEIGHT / 2,
      edgeX: RIGHT_EDGE_X,
      clientX: overflowX,
      uiFontSize: partialCase.uiFontSize,
      hitWidth,
      side: "right",
    });
    expect(await screen.findByText("Turn beta")).toBeTruthy();

    let dragEvent: PointerEvent | undefined;
    act(() => {
      dragEvent = dispatchViewportPointer(viewport, "pointermove", {
        clientX: overflowX,
        clientY: RAIL_TOP + RAIL_HEIGHT / 2 + 4,
        buttons: 1,
      });
    });
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();
    expect(dragEvent?.defaultPrevented).toBe(false);
    expectPositiveSafeHitStrip(hitWidth);

    openPassiveAtY(viewport, {
      clientY: RAIL_TOP + RAIL_HEIGHT / 2,
      edgeX: RIGHT_EDGE_X,
      clientX: overflowX,
      uiFontSize: partialCase.uiFontSize,
      hitWidth,
      side: "right",
    });
    expect(await screen.findByText("Turn beta")).toBeTruthy();

    const clearSelection = installNonCollapsedSelection(
      "selected partial-positive text",
    );
    onTestFinished(clearSelection);
    let selectionEvent: PointerEvent | undefined;
    act(() => {
      selectionEvent = dispatchViewportPointer(viewport, "pointermove", {
        clientX: overflowX,
        clientY: RAIL_TOP + 10,
        buttons: 0,
      });
    });
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();
    expect(selectionEvent?.defaultPrevented).toBe(false);
    clearSelection();
    expectPositiveSafeHitStrip(hitWidth);

    openPassiveAtY(viewport, {
      clientY: RAIL_TOP,
      edgeX: RIGHT_EDGE_X,
      clientX: overflowX,
      uiFontSize: partialCase.uiFontSize,
      hitWidth,
      side: "right",
    });
    expect(await screen.findByText("Turn alpha")).toBeTruthy();
    expectPositiveSafeHitStrip(hitWidth);
  });

  it("partial-positive: button mouse path still works and keyboard ownership stays on the strip", async () => {
    const partialCase = PARTIAL_POSITIVE_PASSIVE_CASES[0];
    const { onSelect, hitWidth } = await renderPartialPositivePassive({
      uiFontSize: partialCase.uiFontSize,
      viewportWidth: partialCase.viewportWidth,
      hitWidth: partialCase.hitWidth,
    });
    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    mockPassiveRailGeometry({
      top: RAIL_TOP,
      height: RAIL_HEIGHT,
      edgeX: RIGHT_EDGE_X,
      hitWidth,
      side: "right",
    });

    fireEvent.mouseMove(hitStrip, {
      clientY: RAIL_TOP + RAIL_HEIGHT / 2,
      buttons: 0,
    });
    expect(await screen.findByText("Turn beta")).toBeTruthy();
    expectPositiveSafeHitStrip(hitWidth);

    fireEvent.focus(hitStrip);
    fireEvent.keyDown(hitStrip, { key: "ArrowDown" });
    expect(await screen.findByText("Turn gamma")).toBeTruthy();
    fireEvent.keyDown(hitStrip, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("message-5");
    expectPositiveSafeHitStrip(hitWidth);
  });

  it.each(MARKER_EQUALITY_BOUNDARY_CASES)(
    "passive off when hit equals widest marker 1.5rem ($label: hit $hitWidth)",
    async (boundaryCase) => {
      useSettingsStore.setState({ uiFontSize: boundaryCase.uiFontSize });
      expect(
        hitStripWidthFor(boundaryCase.viewportWidth, boundaryCase.uiFontSize),
      ).toBe(boundaryCase.hitWidth);
      expect(boundaryCase.hitWidth).toBe(
        boundaryCase.uiFontSize * CHAT_TURN_MINIMAP_MAX_MARKER_WIDTH_REM,
      );

      const { viewport } = renderMinimap({
        messages: makeThreeTurnTranscript(),
        viewportWidth: boundaryCase.viewportWidth,
      });
      await flushMinimapFrames(2);
      expectPositiveSafeHitStrip(boundaryCase.hitWidth);

      mockPassiveRailGeometry({
        top: RAIL_TOP,
        height: RAIL_HEIGHT,
        edgeX: RIGHT_EDGE_X,
        hitWidth: boundaryCase.hitWidth,
        side: "right",
      });
      const overflowX = overflowClientXOutsideButton({
        edgeX: RIGHT_EDGE_X,
        hitWidth: boundaryCase.hitWidth,
        side: "right",
      });

      act(() => {
        dispatchViewportPointer(viewport, "pointermove", {
          clientX: overflowX,
          clientY: RAIL_TOP + RAIL_HEIGHT / 2,
        });
      });
      expect(
        document.querySelector("[data-chat-turn-minimap-preview]"),
      ).toBeNull();

      act(() => {
        dispatchViewportPointer(viewport, "pointermove", {
          clientX: RIGHT_EDGE_X,
          clientY: RAIL_TOP + RAIL_HEIGHT / 2,
        });
      });
      expect(
        document.querySelector("[data-chat-turn-minimap-preview]"),
      ).toBeNull();

      // Button-owned path still works at the equality boundary.
      const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
      fireEvent.mouseMove(hitStrip, {
        clientY: RAIL_TOP + RAIL_HEIGHT / 2,
        buttons: 0,
      });
      expect(await screen.findByText("Turn beta")).toBeTruthy();
      expectPositiveSafeHitStrip(boundaryCase.hitWidth);
    },
  );
});

/**
 * Native Computer Use found a release-order race: physical drag ends near the
 * zero-gutter marker, the final buttons=0 move opens a passive card while
 * selection is still collapsed, then the browser finalizes a non-collapsed
 * selection without a further move. Production closes via (a) document
 * selectionchange and (b) passive pointerup → rAF selection check.
 */
describe("ChatTurnMinimap selection finalization races", () => {
  const RAIL_TOP = 100;
  const RAIL_HEIGHT = 200;
  const RIGHT_EDGE_X = 580;

  async function renderConstrainedPassive(): Promise<{
    viewport: HTMLElement;
  }> {
    const rendered = renderMinimap({
      messages: makeThreeTurnTranscript(),
      viewportWidth: CONSTRAINED_VIEWPORT_PX,
      side: "right",
    });
    await flushMinimapFrames(2);
    expectZeroWidthHitStripInert();
    return { viewport: rendered.viewport };
  }

  function openPassivePreview(viewport: HTMLElement): void {
    mockZeroWidthRailGeometry({
      top: RAIL_TOP,
      height: RAIL_HEIGHT,
      edgeX: RIGHT_EDGE_X,
    });
    act(() => {
      dispatchViewportPointer(viewport, "pointermove", {
        clientX: RIGHT_EDGE_X,
        clientY: RAIL_TOP + RAIL_HEIGHT / 2,
        buttons: 0,
      });
    });
  }

  async function openWidePreview(input: {
    readonly expanded: boolean;
  }): Promise<void> {
    renderMinimap({
      messages: makeThreeTurnTranscript(),
      viewportWidth: WIDE_VIEWPORT_PX,
    });
    await flushMinimapFrames(2);
    const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
    mockRailGeometry(hitStrip, { top: RAIL_TOP, height: RAIL_HEIGHT });
    fireEvent.mouseMove(hitStrip, {
      clientY: RAIL_TOP + RAIL_HEIGHT / 2,
      buttons: 0,
    });
    expect(await screen.findByText("Turn beta")).toBeTruthy();
    if (input.expanded) {
      fireEvent.click(
        await screen.findByRole("button", { name: "Expand all messages" }),
      );
      expect(
        screen.getByRole("button", { name: "Collapse message list" }),
      ).toBeTruthy();
    }
  }

  it("pointerup then non-collapsed selection before rAF closes passive preview after the frame", async () => {
    const { viewport } = await renderConstrainedPassive();
    // Final buttons=0 move opens immediately before selection finalization.
    openPassivePreview(viewport);
    expect(await screen.findByText("Turn beta")).toBeTruthy();
    expectInteractionRegionExposedForPreview();

    // pointerup while selection is still collapsed — only schedules the check.
    act(() => {
      dispatchViewportPointer(viewport, "pointerup", {
        clientX: RIGHT_EDGE_X,
        clientY: RAIL_TOP + RAIL_HEIGHT / 2,
        buttons: 0,
      });
    });
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).not.toBeNull();

    // Selection finalizes before the scheduled frame (no further pointermove).
    const restoreSelection = mockGetSelectionCollapsed(false);
    onTestFinished(restoreSelection);
    await flushMinimapFrames(1);

    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();
    expectMinimapInertDomState();
    restoreSelection();
  });

  it("pointerup keeps the passive preview when selection stays collapsed through the frame", async () => {
    const { viewport } = await renderConstrainedPassive();
    openPassivePreview(viewport);
    expect(await screen.findByText("Turn beta")).toBeTruthy();

    act(() => {
      dispatchViewportPointer(viewport, "pointerup", {
        clientX: RIGHT_EDGE_X,
        clientY: RAIL_TOP + RAIL_HEIGHT / 2,
      });
    });
    await flushMinimapFrames(1);

    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).not.toBeNull();
    expect(screen.getByText("Turn beta")).toBeTruthy();
  });

  it("repeated pointerup cancels the earlier scheduled frame", async () => {
    const { viewport } = await renderConstrainedPassive();
    openPassivePreview(viewport);
    expect(await screen.findByText("Turn beta")).toBeTruthy();

    const frames = installHeldAnimationFrames();
    try {
      act(() => {
        dispatchViewportPointer(viewport, "pointerup", {
          clientX: RIGHT_EDGE_X,
          clientY: RAIL_TOP,
        });
      });
      expect(frames.held.size).toBe(1);
      const firstId = [...frames.held.keys()][0];

      act(() => {
        dispatchViewportPointer(viewport, "pointerup", {
          clientX: RIGHT_EDGE_X,
          clientY: RAIL_TOP,
        });
      });
      expect(frames.cancelCalls).toContain(firstId);
      expect(frames.held.has(firstId)).toBe(false);
      expect(frames.held.size).toBe(1);
      const secondId = [...frames.held.keys()][0];
      expect(secondId).not.toBe(firstId);

      // Only the latest frame runs: collapsed at first schedule, non-collapsed
      // for the replacement frame — first frame must not have closed early.
      const restoreSelection = mockGetSelectionCollapsed(false);
      onTestFinished(restoreSelection);
      act(() => {
        frames.flush(secondId);
      });
      expect(
        document.querySelector("[data-chat-turn-minimap-preview]"),
      ).toBeNull();
      expectMinimapInertDomState();
      restoreSelection();
    } finally {
      frames.restore();
    }
  });

  it("unmount cancels a pending pointerup frame and leaves no minimap effects", async () => {
    const { viewport } = await renderConstrainedPassive();
    openPassivePreview(viewport);
    expect(await screen.findByText("Turn beta")).toBeTruthy();

    const frames = installHeldAnimationFrames();
    try {
      act(() => {
        dispatchViewportPointer(viewport, "pointerup", {
          clientX: RIGHT_EDGE_X,
          clientY: RAIL_TOP,
        });
      });
      expect(frames.held.size).toBe(1);
      const pendingId = [...frames.held.keys()][0];

      cleanup();

      expect(frames.cancelCalls).toContain(pendingId);
      expect(frames.held.has(pendingId)).toBe(false);
      expect(screen.queryByTestId("chat-turn-minimap")).toBeNull();
      expect(
        document.querySelector("[data-chat-turn-minimap-preview]"),
      ).toBeNull();
    } finally {
      frames.restore();
    }
  });

  it("selectionchange closes passive compact and expanded previews immediately", async () => {
    const { viewport } = await renderConstrainedPassive();
    openPassivePreview(viewport);
    expect(await screen.findByText("Turn beta")).toBeTruthy();

    const clearSelection = installNonCollapsedSelection("quote this text");
    onTestFinished(clearSelection);
    act(() => {
      dispatchDocumentSelectionChange();
    });
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();
    expectMinimapInertDomState();
    clearSelection();

    openPassivePreview(viewport);
    expect(await screen.findByText("Turn beta")).toBeTruthy();
    fireEvent.click(
      await screen.findByRole("button", { name: "Expand all messages" }),
    );
    expect(
      screen.getByRole("button", { name: "Collapse message list" }),
    ).toBeTruthy();
    expect(screen.getByText("Turn alpha")).toBeTruthy();

    const clearExpandedSelection =
      installNonCollapsedSelection("expanded quote");
    onTestFinished(clearExpandedSelection);
    act(() => {
      dispatchDocumentSelectionChange();
    });
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();
    expectMinimapInertDomState();
    clearExpandedSelection();
  });

  it("selectionchange closes wide compact and expanded previews immediately", async () => {
    await openWidePreview({ expanded: false });
    const clearCompact = installNonCollapsedSelection("wide compact quote");
    onTestFinished(clearCompact);
    act(() => {
      dispatchDocumentSelectionChange();
    });
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();
    clearCompact();

    cleanup();
    await openWidePreview({ expanded: true });
    const clearExpanded = installNonCollapsedSelection("wide expanded quote");
    onTestFinished(clearExpanded);
    act(() => {
      dispatchDocumentSelectionChange();
    });
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();
    clearExpanded();
  });

  it("collapsed selectionchange does not close an open preview", async () => {
    const { viewport } = await renderConstrainedPassive();
    openPassivePreview(viewport);
    expect(await screen.findByText("Turn beta")).toBeTruthy();

    expect(window.getSelection()?.isCollapsed).not.toBe(false);
    act(() => {
      dispatchDocumentSelectionChange();
    });
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).not.toBeNull();
    expect(screen.getByText("Turn beta")).toBeTruthy();
  });

  it("clearing selection does not auto-reopen; fresh clean hover resumes", async () => {
    const { viewport } = await renderConstrainedPassive();
    openPassivePreview(viewport);
    expect(await screen.findByText("Turn beta")).toBeTruthy();

    const clearSelection = installNonCollapsedSelection("temporary quote");
    onTestFinished(clearSelection);
    act(() => {
      dispatchDocumentSelectionChange();
    });
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();
    expectMinimapInertDomState();

    clearSelection();
    act(() => {
      dispatchDocumentSelectionChange();
    });
    // Clearing alone must not revive the card.
    expect(
      document.querySelector("[data-chat-turn-minimap-preview]"),
    ).toBeNull();
    expectMinimapInertDomState();

    openPassivePreview(viewport);
    expect(await screen.findByText("Turn beta")).toBeTruthy();
    expectInteractionRegionExposedForPreview();
    expectZeroWidthHitStripInert();
  });

  it("removes the document selectionchange listener on unmount", async () => {
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");

    renderMinimap({
      messages: makeThreeTurnTranscript(),
      viewportWidth: CONSTRAINED_VIEWPORT_PX,
    });
    await flushMinimapFrames(2);

    const selectionRegistration = addSpy.mock.calls.find(
      (call) => call[0] === "selectionchange",
    );
    expect(selectionRegistration).toBeDefined();
    const handler = selectionRegistration?.[1];
    expect(typeof handler).toBe("function");

    cleanup();

    expect(removeSpy).toHaveBeenCalledWith("selectionchange", handler);

    // Listener must not remain: a post-unmount selectionchange is a no-op.
    expect(() => {
      document.dispatchEvent(new Event("selectionchange"));
    }).not.toThrow();
    expect(screen.queryByTestId("chat-turn-minimap")).toBeNull();

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});
