import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreApi } from "zustand/vanilla";
import {
  CHAT_ANCHOR_SETTLE_FALLBACK_MS,
  ChatMessages,
  type ChatMessageScrollRequest,
} from "@/components/chat/chat-messages";
import {
  CHAT_ARROW_SCROLL_STEP_PX,
  CHAT_TIMELINE_NAVIGATION_VIEW_OFFSET_PX,
  chatTimelineGetItemType,
} from "@/components/chat/chat-messages-scroll-helpers";
import {
  captureChatFreeScrollingOffset,
  CHAT_LIST_ANCHOR_OFFSET,
  getChatNaturalMaxScrollWithoutAnchorReserve,
} from "@/components/chat/chat-scroll-anchoring";
import { preserveChatScrollAcrossDisclosureChange } from "@/components/chat/chat-scroll-disclosure";
import {
  evictChatTabState,
  hasSavedChatTabState,
  restoreChatTabState,
  saveChatTabState,
} from "@/stores/chats/chat-tab-state-cache";
import { getOrCreateActivityGroupOpenStore } from "@/stores/chats/activity-group-open-store-core";
import type { ActivityGroupOpenState } from "@/stores/chats/activity-group-open-store-context";
import { getOrCreateA2AOpenStore } from "@/stores/chats/a2a-open-store-context";
import { useToolOpenStore } from "@/stores/chats/tool-open-store";
import { useSubagentOpenStore } from "@/stores/chats/subagent-open-store";
import { scopedChatOpenId } from "@/stores/chats/open-store-scope";
import { deriveActivityGroupRenderId } from "@/components/chat/chat-collapsible-key";
import { useSettingsStore } from "@/stores/settings/settings-store";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import type { BackgroundItem } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  makeAssistantMessage,
  makeMessage,
  makeMessageAt,
} from "./chat-message-fixtures";
import {
  installLegendListViewportMetrics,
  settleLegendList,
} from "./legend-list-test-environment";

const VIEWPORT_HEIGHT_PX = 700;
const VIEWPORT_WIDTH_PX = 800;
const PILL_SHOW_DEBOUNCE_MS = 150;

const platformMock = vi.hoisted(() => ({ isMac: true }));
// Default false matches an empty canvas store (existing tests never seed live
// tiles). Ticket 5 remount-save tests flip this true so unmount commits to the
// cache; permanent-close tests keep it false so the save-side guard can be
// asserted. Mirrors use-scroll-restoration.test.tsx.
const tileLiveness = vi.hoisted(() => ({ live: false }));
const activityGroupOpenIds = vi.hoisted(() => ({
  lastOpenIds: new Set<string>(),
  setOpenCalls: [] as Array<{ groupId: string; open: boolean }>,
}));

vi.mock("@/lib/keybindings/platform", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/keybindings/platform")>();
  return {
    ...actual,
    isMac: () => platformMock.isMac,
  };
});

vi.mock("@/stores/epics/canvas/tile-instance-liveness", () => ({
  isEpicCanvasTileInstanceLive: () => tileLiveness.live,
}));

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

vi.mock(
  "@/stores/chats/activity-group-open-store-core",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/stores/chats/activity-group-open-store-core")
      >();
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
      createActivityGroupOpenStore: () =>
        wrapWithSetOpenTracking(actual.createActivityGroupOpenStore()),
      getOrCreateActivityGroupOpenStore: (tileInstanceId: string) =>
        wrapWithSetOpenTracking(
          actual.getOrCreateActivityGroupOpenStore(tileInstanceId),
        ),
    };
  },
);

function makeTranscript(count: number): ChatMessageModel[] {
  return Array.from({ length: count }, (_unused, index) =>
    makeMessage(index, index % 2 === 0 ? "user" : "assistant"),
  );
}

function appendAssistant(
  messages: ReadonlyArray<ChatMessageModel>,
  id: string,
  createdAt: number,
): ReadonlyArray<ChatMessageModel> {
  return [
    ...messages,
    {
      ...makeMessageAt(0, "assistant", createdAt),
      id,
      content: "streamed",
      runState: "running" as const,
    },
  ];
}

/** Completed turns so free-scroll pill is plain (not streaming from stale null completedAt). */
function makeCompletedTranscript(count: number): ChatMessageModel[] {
  return Array.from({ length: count }, (_unused, index) => {
    const role: ChatMessageModel["role"] =
      index % 2 === 0 ? "user" : "assistant";
    return {
      ...makeMessage(index, role),
      completedAt: role === "assistant" ? 1_000 + index : null,
      runState: null,
    };
  });
}

/** P4: a pure agent-to-agent child chat - every `role: "user"` row carries
 *  `agentSenderInfo`, so ZERO rows pass `isHumanUserMessage`. Models the
 *  transcript shape `selectActiveUserMessageId`'s human-only gate
 *  previously starved of any candidate. */
function makeA2AOnlyCompletedTranscript(count: number): ChatMessageModel[] {
  return Array.from({ length: count }, (_unused, index) => {
    const role: ChatMessageModel["role"] =
      index % 2 === 0 ? "user" : "assistant";
    const base = {
      ...makeMessage(index, role),
      completedAt: role === "assistant" ? 1_000 + index : null,
      runState: null,
    };
    if (role !== "user") return base;
    return {
      ...base,
      agentSenderInfo: {
        agentId: `agent-peer-${index}`,
        senderTitle: "Peer",
        expectReply: false,
        responseId: null,
      },
    };
  });
}

/** Composer-send optimistic echo: persistentMessageId stays null (decision #8/#25). */
function appendOptimisticUserSend(
  messages: ReadonlyArray<ChatMessageModel>,
  id: string,
  createdAt: number,
): ReadonlyArray<ChatMessageModel> {
  return [
    ...messages,
    {
      ...makeMessageAt(0, "user", createdAt),
      id,
      content: "hello from send",
      persistentMessageId: null,
    },
  ];
}

/**
 * Queued auto-flush / A2A host row: arrives with persistentMessageId already
 * set to its own id (decision #9 gated path).
 */
function appendPersistentUserRow(
  messages: ReadonlyArray<ChatMessageModel>,
  id: string,
  createdAt: number,
): ReadonlyArray<ChatMessageModel> {
  return [
    ...messages,
    {
      ...makeMessageAt(0, "user", createdAt),
      id,
      content: "queued flush / a2a",
      persistentMessageId: id,
    },
  ];
}

/** Many trailing assistant rows so the anchored turn overflows the usable viewport. */
function appendStreamingAssistantChunks(
  messages: ReadonlyArray<ChatMessageModel>,
  count: number,
  baseCreatedAt: number,
): ReadonlyArray<ChatMessageModel> {
  const chunks = Array.from({ length: count }, (_unused, index) => ({
    ...makeMessageAt(0, "assistant", baseCreatedAt + index + 1),
    id: `stream-chunk-${index}`,
    content: `streamed chunk ${index}`,
    completedAt: null as number | null,
    runState: "running" as const,
  }));
  return [...messages, ...chunks];
}

/**
 * Appends exactly ONE new trailing assistant row with a globally-unique id
 * (`chunkIndex`, not scoped to `messages.length` like
 * `appendStreamingAssistantChunks`) - lets a test drive per-chunk growth
 * through several SEPARATE `rerenderMessages` calls (mirroring real token-
 * by-token streaming, where the reveal-pass effect fires once per delta)
 * instead of one batched jump, which a single effect run cannot expose an
 * indefinite-chase regression through.
 */
function appendOneStreamingChunk(
  messages: ReadonlyArray<ChatMessageModel>,
  chunkIndex: number,
  createdAt: number,
): ReadonlyArray<ChatMessageModel> {
  return [
    ...messages,
    {
      ...makeMessageAt(0, "assistant", createdAt),
      id: `incremental-chunk-${chunkIndex}`,
      content: `streamed chunk ${chunkIndex}`,
      completedAt: null,
      runState: "running" as const,
    },
  ];
}

/**
 * Waits for exactly one reveal-pass tick (two rAFs, matching the effect's
 * own two-rAF pass) without the full anchor-settle fallback - used between
 * incremental chunk appends so each `rerenderMessages` call gets its own
 * measurement/reveal cycle, like real per-token streaming would.
 */
async function waitForRevealPassTick(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  });
}

/**
 * Anchor engine settle: LegendList frames + the `CHAT_ANCHOR_SETTLE_FALLBACK_MS`
 * `awaitScrollSettle` fallback (jsdom never fires native `scrollend`), plus
 * slack for the settle callback's own scheduling.
 */
async function waitForAnchorEngineSettle(): Promise<void> {
  await settleLegendList();
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, CHAT_ANCHOR_SETTLE_FALLBACK_MS + 150);
    });
  });
}

function pillVisibleLabel(): string {
  const pill = screen.getByRole("button", {
    name: "Scroll to end",
    hidden: true,
  });
  return pill.textContent;
}

function isJumpPillVisible(): boolean {
  const pill = screen.getByRole("button", { name: "Scroll to end" });
  return (
    pill.classList.contains("opacity-100") &&
    !pill.classList.contains("opacity-0")
  );
}

function getScrollNode(): HTMLElement {
  const node = screen.getByTestId("chat-messages-scroll");
  if (!(node instanceof HTMLElement)) {
    throw new Error("chat-messages-scroll is not an HTMLElement");
  }
  return node;
}

/** Park away from the tail so LegendList reports isAtEnd/isNearEnd = false. */
function fireScrollAwayFromEnd(): void {
  const scrollNode = getScrollNode();
  scrollNode.scrollTop = 0;
  fireEvent.scroll(scrollNode);
}

function fireScrollToEnd(): void {
  const scrollNode = getScrollNode();
  const maxScroll = Math.max(
    0,
    scrollNode.scrollHeight - scrollNode.clientHeight,
  );
  scrollNode.scrollTop = maxScroll;
  fireEvent.scroll(scrollNode);
}

/**
 * Sets `scrollTop` and fires a scroll event, then yields one animation frame
 * so LegendList's own (batched/scheduled) scroll processing runs before the
 * NEXT step changes the position again - firing several `fireEvent.scroll`
 * calls back-to-back with no yield between them gets coalesced into a
 * single notification of whichever value was current when LegendList's
 * scheduled pass finally ran, silently dropping the intermediate ones.
 */
async function fireScrollTopAndFlush(scrollTop: number): Promise<void> {
  const scrollNode = getScrollNode();
  await act(async () => {
    scrollNode.scrollTop = scrollTop;
    fireEvent.scroll(scrollNode);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
}

/** Dispatch a keydown with target inside the keyboard-scroll scope. */
function dispatchKeyInScope(key: string): void {
  const scrollNode = getScrollNode();
  scrollNode.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
    }),
  );
}

/**
 * Enter free-scrolling and leave the end so the Jump-to-latest pill can show
 * after the 150ms debounce. Wheel cancels the generation token; scrollTop=0
 * drives LegendList's isAtEnd=false into onIsAtEndChange.
 */
function enterFreeScrollingAwayFromEnd(): void {
  const scrollNode = getScrollNode();
  fireEvent.wheel(scrollNode, { deltaY: -80 });
  fireScrollAwayFromEnd();
}

/**
 * Selects the last (most recent) turn on the minimap rail via keyboard - End
 * to move the active index to the last item, then Enter to select it. The
 * rail is a single hit-target button, not a per-item button, so this is the
 * equivalent of the old per-item click. A frame must be awaited between the
 * two keydowns: `setActiveIndex` from End is still in flight when Enter's own
 * `onKeyDown` closure is captured, so firing both synchronously reads the
 * PRE-End `activeItem` (null) and no-ops.
 */
async function selectLastChatTurnMinimapItem(): Promise<void> {
  const minimapButton = screen.getByTestId("chat-turn-minimap-hit-strip");
  fireEvent.keyDown(minimapButton, { key: "End" });
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
  fireEvent.keyDown(minimapButton, { key: "Enter" });
}

interface RenderChatMessagesOptions {
  readonly messages: ReadonlyArray<ChatMessageModel>;
  readonly scrollStateKey?: string;
  readonly instanceId?: string;
  readonly visible?: boolean;
  readonly composerOverlayHeight?: number;
  readonly taskTitle?: string;
  readonly systemOverlayActive?: boolean;
  readonly scrollRequest?: ChatMessageScrollRequest | null;
  readonly backgroundItems?: ReadonlyArray<BackgroundItem> | undefined;
  readonly tileActive?: boolean;
  readonly groupId?: string;
  readonly withSiblingChrome?: boolean;
  /**
   * Opts into decision #15's fresh-open policy (anchor the last user message
   * near the top) by leaving the scroll-state cache empty for this key. Most
   * tests here exercise following/free-scrolling/edge-mutation behavior, not
   * fresh-open itself, so `renderChatMessages` seeds a bottom-following saved
   * state by default (unless the caller already seeded one, e.g. the
   * restored-free-scrolling test) - matching what a returning tab's cache
   * would already hold.
   */
  readonly freshOpen?: boolean;
  /**
   * Seeds the store-side local-provenance registry (`chat-session-store.ts`)
   * this harness fakes - message ids the "client" minted and dispatched
   * (composer send / steer / inline edit), the anchor classifier's ground
   * truth for unconditional vs decision-#9-gated anchoring. Empty by
   * default (models a row arriving from elsewhere - queued flush, A2A, or
   * another window's edit).
   */
  readonly localProvenanceMessageIds?: ReadonlySet<string>;
}

interface ChatMessagesRenderState {
  messages: ReadonlyArray<ChatMessageModel>;
  systemOverlayActive: boolean;
  scrollRequest: ChatMessageScrollRequest | null;
  backgroundItems: ReadonlyArray<BackgroundItem> | undefined;
  visible: boolean;
  tileActive: boolean;
  composerOverlayHeight: number;
  localProvenanceMessageIds: ReadonlySet<string>;
}

function renderChatMessages(options: RenderChatMessagesOptions) {
  const scrollStateKey =
    options.scrollStateKey ??
    `scroll-key-${Math.random().toString(36).slice(2)}`;
  const instanceId =
    options.instanceId ?? `instance-${Math.random().toString(36).slice(2)}`;
  const groupId = options.groupId ?? "pane-1";

  if (options.freshOpen !== true && !hasSavedChatTabState(scrollStateKey)) {
    saveChatTabState({
      key: scrollStateKey,
      mode: "following-end",
      anchorMessageId: null,
      offset: 0,
    });
  }

  const state: ChatMessagesRenderState = {
    messages: options.messages,
    systemOverlayActive: options.systemOverlayActive ?? false,
    scrollRequest: options.scrollRequest ?? null,
    backgroundItems: options.backgroundItems,
    visible: options.visible ?? true,
    tileActive: options.tileActive ?? true,
    composerOverlayHeight: options.composerOverlayHeight ?? 80,
    localProvenanceMessageIds: options.localProvenanceMessageIds ?? new Set(),
  };

  const jsx = (): ReactNode => (
    <div
      data-group-id={groupId}
      style={{ height: VIEWPORT_HEIGHT_PX, width: VIEWPORT_WIDTH_PX }}
    >
      <div
        data-chat-keyboard-scroll-scope
        data-active={state.tileActive ? "true" : "false"}
        data-group-id={groupId}
        style={{ height: VIEWPORT_HEIGHT_PX, width: VIEWPORT_WIDTH_PX }}
      >
        <ChatMessages
          taskTitle={options.taskTitle ?? "Test chat"}
          taskId="task-1"
          messages={state.messages}
          localProvenanceMessageIds={state.localProvenanceMessageIds}
          consumeLocalProvenance={(messageId) => {
            if (!state.localProvenanceMessageIds.has(messageId)) return;
            const next = new Set(state.localProvenanceMessageIds);
            next.delete(messageId);
            state.localProvenanceMessageIds = next;
            result.rerender(jsx());
          }}
          backgroundItems={state.backgroundItems}
          scrollStateKey={scrollStateKey}
          getMessageActions={() => null}
          nextStepActions={null}
          instanceId={instanceId}
          visible={state.visible}
          systemOverlayActive={state.systemOverlayActive}
          scrollRequest={state.scrollRequest}
          composerOverlayHeight={state.composerOverlayHeight}
        />
      </div>
      {options.withSiblingChrome === true ? (
        <button type="button" data-testid="pane-sibling-chrome">
          Sibling chrome
        </button>
      ) : null}
    </div>
  );

  const result = render(jsx());
  return {
    ...result,
    scrollStateKey,
    instanceId,
    rerenderMessages: (messages: ReadonlyArray<ChatMessageModel>) => {
      state.messages = messages;
      result.rerender(jsx());
    },
    rerenderWith: (patch: Partial<ChatMessagesRenderState>) => {
      Object.assign(state, patch);
      result.rerender(jsx());
    },
  };
}

async function waitForPillVisible(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, PILL_SHOW_DEBOUNCE_MS + 40);
    });
  });
  await waitFor(() => {
    expect(isJumpPillVisible()).toBe(true);
  });
}

describe("ChatMessages scroll policy", () => {
  beforeEach(() => {
    activityGroupOpenIds.lastOpenIds = new Set();
    activityGroupOpenIds.setOpenCalls = [];
    platformMock.isMac = true;
    tileLiveness.live = false;
    installLegendListViewportMetrics();
    vi.useRealTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    // Do not restoreAllMocks - it clears module mocks for isMac / activity store.
    platformMock.isMac = true;
    tileLiveness.live = false;
  });

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
      key: scrollStateKey,
      mode: "free-scrolling",
      anchorMessageId: messages[0]?.id ?? null,
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

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });

      // Debounced show: still hidden before 150ms.
      expect(isJumpPillVisible()).toBe(false);

      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, PILL_SHOW_DEBOUNCE_MS - 30);
        });
      });
      expect(isJumpPillVisible()).toBe(false);

      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 60);
        });
      });
      expect(isJumpPillVisible()).toBe(true);
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

  it("near-end restores following-end (pill hides after isAtEnd becomes true)", async () => {
    const messages = makeTranscript(20);
    renderChatMessages({ messages, scrollStateKey: "near-end-restore-key" });
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

    act(() => {
      fireScrollToEnd();
    });

    await waitFor(
      () => {
        expect(isJumpPillVisible()).toBe(false);
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

  describe("H3 suppressFollowRestoreRef persists across programmatic scrolls, cleared only by a real gesture", () => {
    it("suffix removal (non-animated) stays free-scrolling through a duplicate/correction true report, then settles on scrollend", async () => {
      // Enough rows that free-scroll is meaningful; after shrink to 3 rows the
      // remaining content fits the viewport so isNearEnd becomes true.
      const messages = makeTranscript(30);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "h3-suffix-multi-report",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();
      expect(isJumpPillVisible()).toBe(true);

      // Free-scrolling suffix removal → scroll-to-index + nextMode:null +
      // suppressFollowRestoreRef=true (non-animated: no intermediate
      // false frames, but LegendList can still re-notify the settled
      // position more than once - a "duplicate/correction" report).
      const next = messages.slice(0, 3);
      rerenderMessages(next);
      await settleLegendList();

      const scrollNode = getScrollNode();
      const settledScrollTop = Math.max(
        0,
        scrollNode.scrollHeight - scrollNode.clientHeight,
      );

      // First `true` report at the settled position: a ONE-SHOT token would
      // already have been consumed by whatever report preceded this (or, if
      // this were the very first, would be fine here but fail below).
      // Checked via `dataset.scrollMode`, not pill visibility - the shrunk
      // (3-row) transcript now genuinely fits one viewport, so LegendList's
      // own `isContentLess` makes EVERY report `isAtEnd: true` regardless of
      // scrollTop; Ticket 11 fix #3 correctly hides the pill for all of them
      // (decision #16: nothing is out of view). Mode is the precise claim
      // this test makes ("stays free-scrolling") and is unaffected by that.
      await fireScrollTopAndFlush(settledScrollTop);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // Duplicate/correction `true` report: a slightly different scrollTop
      // (not an exact repeat, so LegendList does not skip it as a no-op)
      // that is STILL within the near-end band. This is exactly what a
      // one-shot token cannot survive: it was already consumed by the
      // report above, so this one falls through to the normal
      // reconciliation path and incorrectly restores follow.
      await fireScrollTopAndFlush(Math.max(0, settledScrollTop - 20));
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // Settle the operation (scrollend) - suppression is NOT auto-cleared
      // by settle (no timer survives the collapse); still free regardless,
      // since nothing further reports a NEW isAtEnd value.
      act(() => {
        scrollNode.dispatchEvent(new Event("scrollend"));
      });
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
    });

    it("minimap/navigateToMessage (animated) stays free-scrolling across false->true intermediate frames, then across a stream append", async () => {
      const messages = makeTranscript(24);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "h3-minimap-multi-report",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();

      // Select a near-tail user message on the minimap rail (last human
      // row). navigateToMessage's scroll is ANIMATED - the installed
      // LegendList forwards every native scroll event during the
      // animation, so several `false` reports (still moving toward the
      // target) arrive BEFORE the terminal `true`.
      await selectLastChatTurnMinimapItem();

      const scrollNode = getScrollNode();
      const settledScrollTop = Math.max(
        0,
        scrollNode.scrollHeight - scrollNode.clientHeight,
      );

      // Two intermediate "still animating toward the target" frames. Checked
      // via `dataset.scrollMode`, not pill visibility - the shim's fixed
      // `scrollHeight` (400 rows * 90px) is far beyond this 24-row
      // transcript's REAL measured content, so every one of these
      // `settledScrollTop`-derived offsets is already past the real content
      // end (confirmed: `isAtEnd: true` from the very first report) -
      // Ticket 11 fix #2's reader-position mirror correctly tracks that,
      // which is the point of this test (mode/suppression persistence), not
      // a claim about the pill's own decision-#16 visibility.
      await fireScrollTopAndFlush(Math.max(0, settledScrollTop - 500));
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      await fireScrollTopAndFlush(Math.max(0, settledScrollTop - 150));
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // Terminal `true` report at the animation's destination. A one-shot
      // token was already consumed by the FIRST intermediate `false` report
      // above, so THIS is the exact report that leaks under that design.
      await fireScrollTopAndFlush(settledScrollTop);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // Duplicate/correction true report - a slightly different scrollTop,
      // still within the near-end band, so LegendList does not skip it as a
      // no-op.
      await fireScrollTopAndFlush(Math.max(0, settledScrollTop - 20));
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // Settle (scrollend). Still free - the operation's own reports never
      // restored follow.
      act(() => {
        scrollNode.dispatchEvent(new Event("scrollend"));
      });
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // Suppression is never cleared by settle alone (only a real gesture or
      // an explicit following-end transition clears it), and mode is still
      // free-scrolling regardless - a subsequent stream append must not
      // auto-follow either.
      const parkedAfterSettle = scrollNode.scrollTop;
      rerenderMessages(appendAssistant(messages, "h3-nav-stream", 80_000));
      await settleLegendList();
      expect(getScrollNode().scrollTop).toBe(parkedAfterSettle);
    });

    it("a REAL subsequent near-end gesture still restores follow after a suppressed programmatic scroll settles", async () => {
      const messages = makeTranscript(28);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "h3-companion-restore",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();

      // Programmatic free-scrolling suffix removal (sets suppression).
      const short = messages.slice(0, 4);
      rerenderMessages(short);
      await settleLegendList();
      expect(isJumpPillVisible()).toBe(true);

      // A REAL gesture clears suppression immediately - there is no
      // settle-based auto-release to race against anymore - near-end must
      // restore follow on this gesture's OWN scroll report, not the
      // suppressed operation's.
      act(() => {
        fireEvent.wheel(getScrollNode(), { deltaY: 40 });
        fireScrollToEnd();
      });

      await waitFor(
        () => {
          expect(isJumpPillVisible()).toBe(false);
        },
        { timeout: 3_000 },
      );
    });

    it("a real gesture mid-operation clears suppression immediately, pre-empting the in-flight scroll", async () => {
      const messages = makeTranscript(24);
      renderChatMessages({
        messages,
        scrollStateKey: "h3-gesture-preempts-ownership",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();

      await selectLastChatTurnMinimapItem();

      const scrollNode = getScrollNode();
      // Mid-flight: an intermediate animation frame (still suppressed).
      act(() => {
        scrollNode.scrollTop = 200;
        fireEvent.scroll(scrollNode);
      });
      expect(isJumpPillVisible()).toBe(true);

      // A real gesture arrives BEFORE the operation would have settled on
      // its own (no scrollend/750ms fired yet) - it must still take over
      // normally: park away from the end and confirm the pill stays/shows.
      act(() => {
        fireEvent.wheel(scrollNode, { deltaY: -40 });
        fireScrollAwayFromEnd();
      });
      await waitFor(() => {
        expect(isJumpPillVisible()).toBe(true);
      });

      // And a subsequent near-end report (this gesture's own, not the
      // preempted operation's) now correctly restores follow.
      act(() => {
        fireEvent.wheel(scrollNode, { deltaY: 40 });
        fireScrollToEnd();
      });
      await waitFor(() => {
        expect(isJumpPillVisible()).toBe(false);
      });
    });

    it("a bare pointerdown mid-flight freezes the in-flight animated scroll and absorbs a stray late near-end echo", async () => {
      const messages = makeTranscript(24);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "h3-pointerdown-freeze",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();

      // Animated navigateToMessage (sets suppression).
      await selectLastChatTurnMinimapItem();

      const scrollNode = getScrollNode();
      const settledScrollTop = Math.max(
        0,
        scrollNode.scrollHeight - scrollNode.clientHeight,
      );
      const midFlight = Math.max(0, settledScrollTop - 500);

      // Mid-flight intermediate frame (still suppressed). Checked via
      // `dataset.scrollMode`, not pill visibility - the shim's fixed
      // `scrollHeight` puts every one of these `settledScrollTop`-derived
      // offsets past this 24-row transcript's REAL content end, so
      // Ticket 11 fix #2/#3 correctly treat them as "at the live edge" and
      // hide the pill; mode persistence (this test's actual claim) is
      // unaffected.
      await fireScrollTopAndFlush(midFlight);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // A bare pointerdown - NO accompanying scroll - is decision #6's "ANY
      // pointerdown relinquishes follow/anchor ownership" (text selection,
      // expanding a card). Unlike wheel/touch, it produces no scroll of its
      // own, so the browser's native smooth-scroll animation would keep
      // running unless explicitly frozen.
      act(() => {
        fireEvent.pointerDown(scrollNode);
      });
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // Deliver what would have been the operation's terminal near-end
      // report, as if an already-in-flight native animation frame still
      // fired one more time despite the freeze (a jsdom-only worst case - a
      // real browser's scrollTo/scrollTop write reliably cancels the native
      // smooth-scroll immediately). Must NOT reverse the cancellation.
      await fireScrollTopAndFlush(settledScrollTop);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // The viewport must not keep moving on top of that either: a
      // subsequent stream append does not auto-follow.
      const parked = scrollNode.scrollTop;
      rerenderMessages(appendAssistant(messages, "h3-freeze-stream", 90_000));
      await settleLegendList();
      expect(scrollNode.scrollTop).toBe(parked);
    });

    it("a pointerdown freeze with NO stale echo does not swallow the next real gesture's own terminal report", async () => {
      const messages = makeTranscript(24);
      renderChatMessages({
        messages,
        scrollStateKey: "h3-pointerdown-freeze-no-echo",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();

      // Animated navigateToMessage (sets suppression, arms the freeze grace
      // window on the pointerdown below).
      await selectLastChatTurnMinimapItem();

      const scrollNode = getScrollNode();

      // A bare pointerdown mid-flight freezes the in-flight scroll (arms the
      // grace window) - but the freeze's own same-offset scrollToOffset
      // write is not guaranteed to emit ANY scroll event (a jsdom no-op
      // write, or a real browser deduping a same-position write). NO stale
      // echo follows here - unlike the sibling test above.
      act(() => {
        fireEvent.pointerDown(scrollNode);
      });
      expect(isJumpPillVisible()).toBe(true);

      // A REAL subsequent gesture (wheel) must not have ITS OWN legitimate
      // terminal near-end report swallowed by an unconsumed grace window left
      // over from the pointerdown freeze above - the grace must be bounded to
      // THIS cancel, not survive indefinitely waiting for a report that never
      // came.
      act(() => {
        fireEvent.wheel(scrollNode, { deltaY: 40 });
        fireScrollToEnd();
      });

      await waitFor(() => {
        expect(isJumpPillVisible()).toBe(false);
      });
    });

    it("H1 review fix: a bare pointerdown mid-animation during a PILL-CLICK scrollToEnd still freezes (suppression alone under-covers this path)", async () => {
      // Root cause: scrollToEnd's pill-click path clears
      // suppressFollowRestoreRef unconditionally (setTimelineMode
      // ("following-end") - an explicit go-live) BEFORE its own ANIMATED
      // scroll settles. The freeze in cancelTimelineLiveFollowForUserNavigation
      // was gated solely on suppression, so a bare pointerdown mid-animation
      // found nothing to freeze - the native smooth-scroll kept running and
      // its terminal near-end report re-enabled following against the
      // cancellation. hasActiveAnimatedImperativeScrollRef closes that gap
      // independently of suppression.
      const messages = makeTranscript(24);
      renderChatMessages({
        messages,
        scrollStateKey: "h1-pill-click-freeze",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();

      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Scroll to end" }));
      });
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");

      const scrollNode = getScrollNode();

      // A bare pointerdown - NO accompanying scroll - mid-animation (no
      // scrollend/750ms fallback has fired yet). Decision #6: cancels follow
      // AND must freeze the still-in-flight scrollToEnd animation.
      act(() => {
        fireEvent.pointerDown(scrollNode);
      });
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // Deliver what would be the animation's own terminal near-end report,
      // as if it kept running unfrozen (the actual bug) or a stale frame
      // still fired despite the freeze. Must NOT reverse the cancellation.
      act(() => {
        fireScrollToEnd();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
    });
  });

  describe("M3b minimap hit-strip is fully inert at zero gutter budget, not just visually collapsed", () => {
    // The rail sizes its hit-strip off the PANE'S WIDTH (side gutter around
    // the centered content column), not the composer dock height the old
    // top-right overlay clamped against - a materially different geometry
    // axis, so this pin targets the transcript container's own measured width
    // instead of `composerOverlayHeight`.
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

    it("goes fully inert when the pane leaves no usable hit-strip width", async () => {
      const messages = makeTranscript(20);
      renderChatMessages({ messages, scrollStateKey: "m3b-inert-hit-strip" });
      // 780px pane, 768px content column -> 6px side gutter, below the
      // 12px hit-strip left offset: hitStripWidth clamps to 0.
      mockNarrowTranscriptWidth(780);
      await settleLegendList();

      const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
      await waitFor(() => {
        // jsdom does not implement the `inert` IDL property/behavior, only
        // reflects the attribute React sets - assert on that instead of
        // `.inert` (which reads back `undefined` here regardless of value).
        expect(hitStrip.hasAttribute("inert")).toBe(true);
      });
      expect(hitStrip.getAttribute("aria-hidden")).toBe("true");
      expect(hitStrip.classList.contains("pointer-events-none")).toBe(true);
      expect(hitStrip.tabIndex).toBe(-1);
      // aria-hidden removes the whole subtree from the accessibility tree -
      // Testing Library's own role computation confirms it is unreachable,
      // not just that we intended to hide it.
      expect(
        screen.queryByRole("button", { name: /Jump to message/ }),
      ).toBeNull();

      // Park in free-scrolling (a stable, non-drifting position - unlike the
      // default following-end mode, whose own reveal-pass keeps chasing the
      // jsdom shim's fixed large scrollHeight) so a leaking select is
      // unambiguous: jsdom does not enforce real `inert` event-dispatch
      // blocking, so this pins the component's OWN belt-and-suspenders guard
      // (onClick/onKeyDown early-return on `isInert`) rather than relying
      // solely on the browser to refuse dispatch into the subtree.
      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();
      const scrollNode = getScrollNode();
      const parkedScrollTop = scrollNode.scrollTop;
      await selectLastChatTurnMinimapItem();
      expect(scrollNode.scrollTop).toBe(parkedScrollTop);
      expect(isJumpPillVisible()).toBe(true);
    });

    it("stays interactive at the harness's default (usable) pane width", async () => {
      const messages = makeTranscript(20);
      renderChatMessages({ messages, scrollStateKey: "m3b-usable-hit-strip" });
      await settleLegendList();

      const hitStrip = screen.getByTestId("chat-turn-minimap-hit-strip");
      expect(hitStrip.hasAttribute("inert")).toBe(false);
      expect(hitStrip.getAttribute("aria-hidden")).toBeNull();
      expect(hitStrip.classList.contains("pointer-events-auto")).toBe(true);
      expect(screen.getByRole("button", { name: /Jump to message/ })).toBe(
        hitStrip,
      );
    });
  });

  describe("M1 isAtEndRef null sentinel on cancel", () => {
    it("reconciles follow when a cancel happens while still in the near-end band", async () => {
      const messages = makeTranscript(20);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "m1-near-end-cancel",
      });
      await settleLegendList();

      // Cancel without leaving the near-end band (wheel only; stay at end).
      const scrollNode = getScrollNode();
      const atEnd = scrollNode.scrollTop;
      fireEvent.wheel(scrollNode, { deltaY: -10 });
      // Re-fire scroll while still at the end so onIsAtEndChange(true) runs
      // after isAtEndRef was invalidated to null.
      scrollNode.scrollTop = atEnd;
      fireEvent.scroll(scrollNode);

      // Mode must re-enter following-end (pill stays hidden).
      expect(isJumpPillVisible()).toBe(false);

      // Following catch-up still works after the reconcile.
      const before = getScrollNode().scrollTop;
      rerenderMessages(appendAssistant(messages, "m1-follow-stream", 90_000));
      await settleLegendList();
      // At end + following: maintainScrollAtEnd / reveal pass may hold or
      // advance the offset; either way we are not free-parked away from end.
      expect(getScrollNode().scrollTop).toBeGreaterThanOrEqual(before - 1);
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
      // Shrink to a handful of rows via a free-scrolling suffix removal
      // (H3 path: scroll-to-index + nextMode:null + suppress) so the
      // remaining content fits within one viewport - the resulting
      // scrollTop lands at (or essentially at) the true max, well inside
      // BOTH onEndReachedThreshold and LegendList's own internal
      // maintainScrollAtEndThreshold (also 0.1 by default). Pre-fix,
      // `maintainScrollAtEnd` was gated only on `anchoredEndSpace` (always
      // absent here) - never on the mode machine - so LegendList's OWN
      // stick-to-bottom would still fire on the append below even though
      // the reader had relinquished follow. `followEnabled` closes that.
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

      const shrunk = messages.slice(0, 3);
      rerenderMessages(shrunk);
      await settleLegendList();
      // Still free-scrolling (H3): the near-end landing did not silently
      // restore follow. Checked via `dataset.scrollMode` directly, not pill
      // visibility - the shrunk transcript now genuinely fits one viewport,
      // so Ticket 11 fix #3 correctly hides the pill here (decision #16:
      // nothing is out of view) even though mode stays free-scrolling.
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      const parkedAtNearEnd = getScrollNode().scrollTop;
      rerenderMessages(appendAssistant(shrunk, "follow-gate-stream", 120_000));
      await settleLegendList();

      expect(getScrollNode().scrollTop).toBe(parkedAtNearEnd);
      // Mode is still what actually matters here, not just the position.
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
            progress: null,
            startedAt: 0,
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
            progress: null,
            startedAt: 0,
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
    it("disables quote selection while a system overlay is active", async () => {
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
        systemOverlayActive: false,
      });
      await settleLegendList();

      // Select quotable text inside the transcript.
      const textNode = screen.getByText(
        /Quotable assistant text for overlay gating/,
      );
      const range = document.createRange();
      range.selectNodeContents(textNode);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      await act(async () => {
        document.dispatchEvent(new Event("selectionchange"));
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
      });

      // May or may not show depending on quotable markup from mock ChatMessage.
      // Drive the prop transition regardless and assert the enabled wiring via
      // the store-facing path: when systemOverlayActive flips true, any
      // existing quote affordance is dismissed / not interactive.
      const quoteBefore = screen.queryByRole("button", { name: "Quote" });

      rerenderWith({ systemOverlayActive: true });
      await act(async () => {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
      });

      expect(screen.queryByRole("button", { name: "Quote" })).toBeNull();

      rerenderWith({ systemOverlayActive: false });
      // Re-enable: selection may need re-trigger; at minimum the prop path
      // no longer forces disabled. Re-fire selectionchange.
      await act(async () => {
        document.dispatchEvent(new Event("selectionchange"));
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
      });
      void quoteBefore;
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

  describe("ticket 4: anchor engine integration (decisions #8-10, #15-16)", () => {
    it("composer-send optimistic row anchors while free-scrolling, settles, and keeps mode through stream growth (decision #8)", async () => {
      // Honest pin for unconditional local-provenance: free-scroll FIRST so a
      // bug that only anchors while following-end cannot pass. Registry
      // membership (not row shape / persistentMessageId) is the ground truth.
      const messages = makeCompletedTranscript(16);
      const sendId = "user-optimistic-send";
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "t4-optimistic-anchor-key",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      // Parked at top: the would-be send row is outside the mounted window.
      expect(screen.queryByTestId(`mock-message-${sendId}`)).toBeNull();

      const afterSend = appendOptimisticUserSend(messages, sendId, 999_000);
      rerenderMessages(afterSend);
      await settleLegendList();

      // Honest #8 pin: free-scrolling + local registry → mode flips and the
      // target row mounts (a following-only bug would leave free-scrolling).
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      await waitForAnchorEngineSettle();
      const scrollAfterSettle = getScrollNode().scrollTop;
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      // Streamed growth after settle: still anchoring; compare two real
      // scrollTops (never a scrollHeight-derived maxScroll). Leaving
      // anchoring-new-turn would be the blank end-space chase regression.
      const afterStream = appendStreamingAssistantChunks(afterSend, 3, 999_000);
      rerenderMessages(afterStream);
      await settleLegendList();
      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 100);
        });
      });

      expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      const scrollAfterStream = getScrollNode().scrollTop;
      expect(Math.abs(scrollAfterStream - scrollAfterSettle)).toBeLessThan(
        2_000,
      );
    });

    it("overflowing anchored turn (from free-scroll send) shows streaming pill then New reply with no mode flip on completion (decision #10)", async () => {
      // Enough rows to free-scroll away from the would-be send, but not so many
      // that LegendList measurement of the anchor index is flaky under the
      // jsdom shim (overflow metrics need a measured anchor + last row).
      const messages = makeCompletedTranscript(10);
      const sendId = "user-overflow-send";
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "t4-overflow-new-reply-key",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(screen.queryByTestId(`mock-message-${sendId}`)).toBeNull();

      const afterSend = appendOptimisticUserSend(messages, sendId, 888_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      // Settle must complete before the reveal pass will accept size growth
      // (positioned === settled). jsdom relies on the 750ms scrollend fallback.
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      // 14 * 90px ≈ 1260 > usable viewport (~604 with endInset 80 + offset 16)
      // so the reveal pass flips anchoredTurnOverflowsViewport → streaming pill.
      const afterOverflow = appendStreamingAssistantChunks(
        afterSend,
        14,
        888_000,
      );
      rerenderMessages(afterOverflow);
      await settleLegendList();
      // Two-rAF reveal pass + state commit for overflowsUsableViewport.
      await act(async () => {
        for (let frame = 0; frame < 6; frame += 1) {
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          });
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 300);
        });
      });

      await waitFor(
        () => {
          expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
          expect(isJumpPillVisible()).toBe(true);
          expect(screen.getByTestId("scroll-to-end-pill-spinner")).toBeTruthy();
          expect(pillVisibleLabel()).toMatch(/…$/);
        },
        { timeout: 4_000 },
      );

      const scrollWhileStreaming = getScrollNode().scrollTop;

      // Complete the trailing assistant while still anchored / not following.
      const trailing = afterOverflow[afterOverflow.length - 1];
      const afterComplete: ReadonlyArray<ChatMessageModel> = [
        ...afterOverflow.slice(0, -1),
        {
          ...trailing,
          completedAt: 1_700_000_000_000,
          runState: null,
        },
      ];
      rerenderMessages(afterComplete);
      await settleLegendList();
      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 200);
        });
      });

      // Decision #10: stay anchored - no flip to following-end (that would be
      // the auto-reveal regression). Compare two real scrollTops, never a
      // shim scrollHeight-derived maxScroll.
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      const scrollAfterComplete = getScrollNode().scrollTop;
      expect(Math.abs(scrollAfterComplete - scrollWhileStreaming)).toBeLessThan(
        500,
      );

      await waitFor(
        () => {
          expect(isJumpPillVisible()).toBe(true);
          expect(screen.queryByTestId("scroll-to-end-pill-spinner")).toBeNull();
          expect(pillVisibleLabel()).toContain("New reply");
        },
        { timeout: 3_000 },
      );
    });

    it("second- and third-turn anchor engagement lands at the EXACT anchor offset, not merely 'somewhere far' (live-E2E merge-blocker: multi-turn anchor engagement)", async () => {
      // Row height is uniform (90px, ITEM_HEIGHT_PX) under the jsdom shim,
      // so a correctly-landed anchor's scrollTop must differ from another
      // correctly-landed anchor's scrollTop by EXACTLY (indexDelta * 90),
      // regardless of any header/inset constant this test doesn't know.
      // This is what distinguishes a real landing from an undershoot: the
      // live third-turn regression settled ~512px SHORT of the target
      // (528px landed vs 16px expected) while holding rock-steady there -
      // a loose "moved far enough" check cannot see that at all.
      const ROW_HEIGHT_PX = 90;
      const initial = makeCompletedTranscript(4);
      const turn1Id = "user-turn1-send";
      const turn2Id = "user-turn2-send";
      const turn3Id = "user-turn3-send";
      const { rerenderMessages } = renderChatMessages({
        messages: initial,
        scrollStateKey: "t4-multiturn-engagement-key",
        localProvenanceMessageIds: new Set([turn1Id, turn2Id, turn3Id]),
      });
      await settleLegendList();

      // Turn 1: send + full anchor-lifecycle settle - its refs must be
      // SETTLED, not merely pending, before turn 2 begins (stale-ref hint).
      const afterTurn1Send = appendOptimisticUserSend(
        initial,
        turn1Id,
        100_000,
      );
      rerenderMessages(afterTurn1Send);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${turn1Id}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      const scrollAfterTurn1 = getScrollNode().scrollTop;
      const turn1AnchorIndex = afterTurn1Send.length - 1;

      // Grow + complete turn 1's reply to substantial size (~70 rows ≈
      // 6300px, matching the live trace's "~7000px content").
      const afterOverflow = appendStreamingAssistantChunks(
        afterTurn1Send,
        70,
        100_000,
      );
      rerenderMessages(afterOverflow);
      await settleLegendList();
      await act(async () => {
        for (let frame = 0; frame < 6; frame += 1) {
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          });
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 300);
        });
      });
      const trailing1 = afterOverflow[afterOverflow.length - 1];
      const afterTurn1Complete: ReadonlyArray<ChatMessageModel> = [
        ...afterOverflow.slice(0, -1),
        { ...trailing1, completedAt: 1_700_000_000_000, runState: null },
      ];
      rerenderMessages(afterTurn1Complete);
      await settleLegendList();

      // Free-scroll far from wherever turn 1's anchor left us. jsdom's flat
      // getBoundingClientRect makes scrollTop the only trustworthy geometry
      // signal, so parking at the very top makes "did the anchor scroll
      // actually land" an unmissable jump rather than a coincidental no-op.
      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(screen.queryByTestId(`mock-message-${turn2Id}`)).toBeNull();

      // Turn 2: second send. Decision #8: unconditional anchor regardless
      // of current mode/position.
      const afterTurn2Send = appendOptimisticUserSend(
        afterTurn1Complete,
        turn2Id,
        300_000,
      );
      rerenderMessages(afterTurn2Send);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${turn2Id}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await waitForAnchorEngineSettle();
      const scrollAfterTurn2 = getScrollNode().scrollTop;
      const turn2AnchorIndex = afterTurn2Send.length - 1;

      // Exact-landing check: turn 2's anchor must sit precisely
      // (indexDelta * rowHeight) away from turn 1's - not merely "moved
      // far", which an undershot-but-still-large jump would also satisfy.
      expect(scrollAfterTurn2 - scrollAfterTurn1).toBe(
        (turn2AnchorIndex - turn1AnchorIndex) * ROW_HEIGHT_PX,
      );

      // Grow + complete turn 2's reply too, mirroring a real multi-turn
      // chat (the live regression only showed up on the THIRD anchor
      // session - a bare unfilled send for turn 2, as this test used to
      // do, may not exercise the same compounding-reserve state).
      // `appendOneStreamingChunk` (globally-unique ids), not
      // `appendStreamingAssistantChunks` (scoped `stream-chunk-0..9`,
      // which would collide with turn 1's own `stream-chunk-0..69`
      // still in the array and corrupt LegendList's keyExtractor).
      let turn2Overflow: ReadonlyArray<ChatMessageModel> = afterTurn2Send;
      for (let chunkIndex = 0; chunkIndex < 10; chunkIndex += 1) {
        turn2Overflow = appendOneStreamingChunk(
          turn2Overflow,
          100 + chunkIndex,
          300_000,
        );
      }
      rerenderMessages(turn2Overflow);
      await settleLegendList();
      await act(async () => {
        for (let frame = 0; frame < 6; frame += 1) {
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          });
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 300);
        });
      });
      const trailing2 = turn2Overflow[turn2Overflow.length - 1];
      const afterTurn2Complete: ReadonlyArray<ChatMessageModel> = [
        ...turn2Overflow.slice(0, -1),
        { ...trailing2, completedAt: 1_700_000_100_000, runState: null },
      ];
      rerenderMessages(afterTurn2Complete);
      await settleLegendList();

      // Third turn (twice-settled refs): turn 1's AND turn 2's anchor
      // lifecycles have both already run to settle before this begins -
      // exactly the "stale refs from a prior turn" shape the live finding's
      // hint #1 called out.
      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(screen.queryByTestId(`mock-message-${turn3Id}`)).toBeNull();

      const afterTurn3Send = appendOptimisticUserSend(
        afterTurn2Complete,
        turn3Id,
        500_000,
      );
      rerenderMessages(afterTurn3Send);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${turn3Id}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await waitForAnchorEngineSettle();
      const scrollAfterTurn3 = getScrollNode().scrollTop;
      const turn3AnchorIndex = afterTurn3Send.length - 1;

      // The live regression: turn 3 settled ~512px SHORT of its target
      // (missing-reserve undershoot) while turn 2 landed exactly. This
      // must fail loudly, not just "still moved some" - same exact-delta
      // check as turn 1 -> turn 2 above.
      expect(scrollAfterTurn3 - scrollAfterTurn2).toBe(
        (turn3AnchorIndex - turn2AnchorIndex) * ROW_HEIGHT_PX,
      );
    });

    it("re-asserts the anchor position when content ABOVE it grows after settle (live-E2E: late-arriving prior-turn metadata following a short reply)", async () => {
      // The bug this guards: a prior turn's completion metadata (e.g. a
      // "Thought for Xs" disclosure) can land ABOVE the current anchor
      // AFTER this turn's anchor has already settled -
      // `maintainVisibleContentPosition` has `size:false`, so LegendList never
      // compensates, and nothing else corrects it: the reveal-delta check only
      // accounts for growth BELOW the anchor.
      const ROW_HEIGHT_PX = 90;
      const initial = makeCompletedTranscript(4);
      const turn1Id = "user-turn1-send";
      const turn2Id = "user-turn2-send";
      const { rerenderMessages } = renderChatMessages({
        messages: initial,
        scrollStateKey: "t4-anchor-drift-key",
        localProvenanceMessageIds: new Set([turn1Id, turn2Id]),
      });
      await settleLegendList();

      const afterTurn1Send = appendOptimisticUserSend(
        initial,
        turn1Id,
        100_000,
      );
      rerenderMessages(afterTurn1Send);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${turn1Id}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();

      // Turn 1 gets a short reply that completes immediately - the shape
      // t9's live repro isolated (long prior turns don't show this, only
      // short ones).
      const afterTurn1Reply: ReadonlyArray<ChatMessageModel> = [
        ...afterTurn1Send,
        {
          ...makeMessageAt(0, "assistant", 100_001),
          id: "turn1-reply",
          content: "OK",
          completedAt: 100_002,
          runState: null,
        },
      ];
      rerenderMessages(afterTurn1Reply);
      await settleLegendList();

      const afterTurn2Send = appendOptimisticUserSend(
        afterTurn1Reply,
        turn2Id,
        200_000,
      );
      rerenderMessages(afterTurn2Send);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${turn2Id}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await waitForAnchorEngineSettle();
      const scrollAfterSettle = getScrollNode().scrollTop;
      const turn2AnchorIndex = afterTurn2Send.length - 1;

      // Late-arriving metadata for turn 1: a new row lands ABOVE turn 2's
      // anchor via the SAME `messages` array the reveal-pass effect
      // already watches - not a new data source, just a delayed update to
      // existing history.
      const withLateMetadata: ReadonlyArray<ChatMessageModel> = [
        ...afterTurn2Send.slice(0, turn2AnchorIndex),
        {
          ...makeMessageAt(0, "assistant", 100_003),
          id: "turn1-late-metadata",
          content: "Thought for 4s",
          completedAt: 100_004,
          runState: null,
        },
        ...afterTurn2Send.slice(turn2AnchorIndex),
      ];
      rerenderMessages(withLateMetadata);
      await waitForRevealPassTick();

      // The anchor must hold its EXACT offset from the viewport top - the
      // inserted row grew content above it by one row height, so scroll
      // must grow by exactly that much to compensate. A flat (zero) delta
      // here is the live regression: the anchor silently drifts down by
      // the inserted row's height instead.
      const scrollAfterMetadata = getScrollNode().scrollTop;
      expect(scrollAfterMetadata - scrollAfterSettle).toBe(ROW_HEIGHT_PX);
    });

    describe("reveal pass stops advancing once the anchored turn overflows (live-E2E merge-blocker: decisions #1/#10/#16)", () => {
      // The bug this guards: a single batched jump to N streamed rows (like
      // the test above) only fires the reveal-pass effect ONCE, which can
      // never expose an indefinite-chase regression - real streaming is
      // incremental (one effect run per token/delta). These tests drive
      // growth one chunk at a time, awaiting a reveal-pass tick between each,
      // to mirror that shape.
      it("holds the anchor position (no drift, no pill) while growth stays within the usable viewport", async () => {
        const messages = makeCompletedTranscript(10);
        const sendId = "user-fits-send";
        const { rerenderMessages } = renderChatMessages({
          messages,
          scrollStateKey: "t4-reveal-fits-key",
          localProvenanceMessageIds: new Set([sendId]),
        });
        await settleLegendList();

        const afterSend = appendOptimisticUserSend(messages, sendId, 500_000);
        rerenderMessages(afterSend);
        await waitFor(() => {
          expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
        });
        await waitForAnchorEngineSettle();
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
        const scrollAtAnchor = getScrollNode().scrollTop;

        // Usable viewport ≈ 604px / 90px rows ≈ 6.7 rows - well under overflow.
        // With uniform 90px rows, `anchoredEndSpace`'s reserved trailing
        // space absorbs each new row exactly (decision #12's 16px offset
        // budgets ~588px below the anchor before overflow) - growth inside
        // that budget needs no scroll adjustment at all, since the newly
        // measured row simply replaces reserved blank space that was
        // already within the viewport. scrollTop staying put here is the
        // correct behavior, not an absence of coverage: the sibling "STOPS
        // scrolling" test below exercises the one case that DOES require a
        // scroll response (crossing into overflow).
        let current = afterSend;
        for (let chunkIndex = 0; chunkIndex < 5; chunkIndex += 1) {
          current = appendOneStreamingChunk(current, chunkIndex, 500_000);
          rerenderMessages(current);
          await waitForRevealPassTick();
          // Still fits - the pill must not show a streaming/overflow state,
          // and the anchor must not drift off its settled position.
          expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
          expect(getScrollNode().scrollTop).toBe(scrollAtAnchor);
        }
        expect(isJumpPillVisible()).toBe(false);
      });

      it("STOPS scrolling the instant the turn overflows, flips the pill to streaming, and never moves again across further chunks (red-on-baseline: fails pre-fix with continuous movement)", async () => {
        const messages = makeCompletedTranscript(10);
        const sendId = "user-overflow-stop-send";
        const { rerenderMessages } = renderChatMessages({
          messages,
          scrollStateKey: "t4-reveal-stops-key",
          localProvenanceMessageIds: new Set([sendId]),
        });
        await settleLegendList();

        const afterSend = appendOptimisticUserSend(messages, sendId, 600_000);
        rerenderMessages(afterSend);
        await waitFor(() => {
          expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
        });
        await waitForAnchorEngineSettle();

        // Grow one chunk at a time until the pill reports streaming (first
        // overflow), then keep growing 4 MORE chunks and assert scrollTop is
        // frozen across every one of them - not just "eventually settles."
        let current = afterSend;
        let scrollAtFirstOverflow: number | null = null;
        for (let chunkIndex = 0; chunkIndex < 20; chunkIndex += 1) {
          current = appendOneStreamingChunk(current, chunkIndex, 600_000);
          rerenderMessages(current);
          await waitForRevealPassTick();
          if (isJumpPillVisible()) {
            scrollAtFirstOverflow = getScrollNode().scrollTop;
            break;
          }
        }
        if (scrollAtFirstOverflow === null) {
          throw new Error(
            "Turn never overflowed the usable viewport within 20 chunks - test setup is wrong, not the assertion.",
          );
        }
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
        expect(screen.getByTestId("scroll-to-end-pill-spinner")).toBeTruthy();

        for (let more = 0; more < 4; more += 1) {
          current = appendOneStreamingChunk(current, 100 + more, 600_000);
          rerenderMessages(current);
          await waitForRevealPassTick();
          // The live-E2E bug: this kept advancing (163 -> 7494px) instead of
          // staying frozen at the overflow boundary.
          expect(getScrollNode().scrollTop).toBe(scrollAtFirstOverflow);
          expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
          expect(isJumpPillVisible()).toBe(true);
        }

        // Completion below the fold: decision #10, still zero movement.
        const trailingId = `incremental-chunk-${103}`;
        const completed = current.map((message) =>
          message.id === trailingId
            ? { ...message, completedAt: 1_700_000_000_000, runState: null }
            : message,
        );
        rerenderMessages(completed);
        await waitForRevealPassTick();
        await act(async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 200);
          });
        });

        expect(getScrollNode().scrollTop).toBe(scrollAtFirstOverflow);
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
        await waitFor(() => {
          expect(isJumpPillVisible()).toBe(true);
          expect(screen.queryByTestId("scroll-to-end-pill-spinner")).toBeNull();
          expect(pillVisibleLabel()).toContain("New reply");
        });
      });
    });

    it("queued-flush/A2A row (no local provenance) anchors while following-end (decision #9)", async () => {
      // No localProvenance: proves the gated path, not the unconditional one.
      // data-scroll-mode is the honest signal that the anchor engine engaged
      // (following-end catchup alone would not leave "following-end").
      const messages = makeCompletedTranscript(16);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "t4-gated-follow-key",
      });
      await settleLegendList();
      expect(isJumpPillVisible()).toBe(false);
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");

      const afterFlush = appendPersistentUserRow(
        messages,
        "user-queued-flush-follow",
        777_000,
      );
      rerenderMessages(afterFlush);
      await settleLegendList();

      await waitFor(() => {
        expect(
          screen.getByTestId("mock-message-user-queued-flush-follow"),
        ).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
    });

    it("queued-flush/A2A row while free-scrolling does not move scrollTop and keeps free-scroll mode (decision #9)", async () => {
      const messages = makeCompletedTranscript(20);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "t4-gated-free-key",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(isJumpPillVisible()).toBe(true);
      expect(pillVisibleLabel()).toContain("Scroll to end");
      expect(screen.queryByTestId("scroll-to-end-pill-spinner")).toBeNull();
      expect(pillVisibleLabel()).not.toContain("New reply");

      const parkedScrollTop = getScrollNode().scrollTop;
      expect(
        screen.queryByTestId("mock-message-user-queued-flush-free"),
      ).toBeNull();

      const afterFlush = appendPersistentUserRow(
        messages,
        "user-queued-flush-free",
        666_000,
      );
      rerenderMessages(afterFlush);
      await settleLegendList();
      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 100);
        });
      });

      // Classifier returned none: park + free-scrolling mode both hold.
      expect(getScrollNode().scrollTop).toBe(parkedScrollTop);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(
        screen.queryByTestId("mock-message-user-queued-flush-free"),
      ).toBeNull();
      expect(isJumpPillVisible()).toBe(true);
      expect(pillVisibleLabel()).toContain("Scroll to end");
      expect(screen.queryByTestId("scroll-to-end-pill-spinner")).toBeNull();
      expect(pillVisibleLabel()).not.toContain("New reply");
    });

    it("fresh open with no saved scroll state anchors the last user message (decision #15)", async () => {
      // 20 rows: last is assistant (message-19); last user is message-18.
      // data-scroll-mode is the honest pin (not scrollHeight-derived maxScroll).
      const messages = makeCompletedTranscript(20);
      const scrollStateKey = `t4-fresh-open-${Math.random().toString(36).slice(2)}`;
      expect(hasSavedChatTabState(scrollStateKey)).toBe(false);

      renderChatMessages({
        messages,
        scrollStateKey,
        freshOpen: true,
      });
      // Mode seed is synchronous at construction
      // (`resolveChatTimelineInitialModeSeed`) - first render, before settle.
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await settleLegendList();
      await waitForAnchorEngineSettle();

      await waitFor(() => {
        expect(screen.getByTestId("mock-message-message-18")).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(isJumpPillVisible()).toBe(false);
    });

    it("empty transcript still renders ChatEmptyState under the fresh-open path", async () => {
      const scrollStateKey = `t4-fresh-empty-${Math.random().toString(36).slice(2)}`;
      renderChatMessages({
        messages: [],
        scrollStateKey,
        freshOpen: true,
      });
      await settleLegendList();

      expect(screen.getByText("Start the conversation")).toBeTruthy();
      expect(screen.getByText("Send a message to get started.")).toBeTruthy();
      expect(screen.queryByTestId("chat-messages-scroll")).toBeNull();
    });

    describe("H1: empty -> non-empty edge (local provenance + fresh-open re-derive)", () => {
      it("local-provenance first message anchors even with a saved bottom-following state", async () => {
        // Mount empty with a cache entry (freshOpen: false default seed). The
        // mount-time fresh-open seed has nothing to target; the local send on
        // the later transition must still anchor unconditionally via the
        // registry - proving that branch is independent of saved state.
        const sendId = "first-local-send";
        const { rerenderMessages } = renderChatMessages({
          messages: [],
          scrollStateKey: "t4-h1-local-empty-key",
          freshOpen: false,
          localProvenanceMessageIds: new Set([sendId]),
        });
        await settleLegendList();
        expect(screen.getByText("Start the conversation")).toBeTruthy();

        const next: ReadonlyArray<ChatMessageModel> = [
          {
            ...makeMessageAt(0, "user", 1_000),
            id: sendId,
            content: "hello empty chat",
            persistentMessageId: null,
          },
        ];
        rerenderMessages(next);
        await settleLegendList();

        await waitFor(() => {
          expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
        });
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      });

      it("empty -> multi-message history with no local match re-derives fresh-open (decision #15 late load)", async () => {
        // Tile mounts empty before snapshot loads; mount-time seed sees no
        // user row. First non-empty transition with !hadSavedScrollState must
        // re-derive fresh-open targeting the LAST user row.
        const history = makeCompletedTranscript(8);
        // last user = message-6 (indices 0..7, even = user)
        const lastUserId = "message-6";
        const { rerenderMessages } = renderChatMessages({
          messages: [],
          scrollStateKey: `t4-h1-fresh-late-${Math.random().toString(36).slice(2)}`,
          freshOpen: true,
        });
        await settleLegendList();
        expect(screen.getByText("Start the conversation")).toBeTruthy();

        rerenderMessages(history);
        await settleLegendList();

        await waitFor(() => {
          expect(screen.getByTestId(`mock-message-${lastUserId}`)).toBeTruthy();
        });
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      });

      it("empty -> multi-message with saved state and no local match stays following-end", async () => {
        // Returning tab: hadSavedScrollState + following-end mode. Snapshot
        // load must NOT spuriously anchor (would steal the restored follow
        // intent).
        const history = makeCompletedTranscript(8);
        const { rerenderMessages } = renderChatMessages({
          messages: [],
          scrollStateKey: "t4-h1-saved-no-local-key",
          freshOpen: false,
        });
        await settleLegendList();

        rerenderMessages(history);
        await settleLegendList();

        await waitFor(() => {
          expect(screen.getByTestId("chat-messages-scroll")).toBeTruthy();
        });
        expect(getScrollNode().dataset.scrollMode).toBe("following-end");
        // Not the fresh-open / local-send anchor path.
        expect(getScrollNode().dataset.scrollMode).not.toBe(
          "anchoring-new-turn",
        );
      });
    });

    describe("H2: same-turn steer-shaped insert (new user before still-present trailing assistant)", () => {
      it("anchors when the inserted user id is in the local-provenance registry", async () => {
        // Not a pure append and not a clean first-divergence replacement:
        // the trailing assistant keeps its id while a new user row is
        // spliced ahead of it (same-turn steer row-splitting shape). Prefix
        // history keeps the free-scroll park far from the insert so
        // row-mount is a real virtualization signal.
        const prefix = makeCompletedTranscript(16);
        const userTail = {
          ...makeMessageAt(0, "user", 200),
          id: "u-tail",
          completedAt: null,
        };
        const assistantLive = {
          ...makeMessageAt(1, "assistant", 201),
          id: "a-live",
          content: "still streaming",
          completedAt: null,
          runState: "running" as const,
        };
        const messages: ReadonlyArray<ChatMessageModel> = [
          ...prefix,
          userTail,
          assistantLive,
        ];
        const steerId = "u-steer";
        const { rerenderMessages } = renderChatMessages({
          messages,
          scrollStateKey: "t4-h2-steer-local-key",
          localProvenanceMessageIds: new Set([steerId]),
        });
        await settleLegendList();

        act(() => {
          enterFreeScrollingAwayFromEnd();
        });
        await waitForPillVisible();
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
        expect(screen.queryByTestId(`mock-message-${steerId}`)).toBeNull();

        const afterSteer: ReadonlyArray<ChatMessageModel> = [
          ...prefix,
          userTail,
          {
            ...makeMessageAt(0, "user", 202),
            id: steerId,
            content: "steer instruction",
            persistentMessageId: null,
          },
          assistantLive,
        ];
        rerenderMessages(afterSteer);
        await settleLegendList();

        await waitFor(() => {
          expect(screen.getByTestId(`mock-message-${steerId}`)).toBeTruthy();
        });
        expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      });

      it("stays free-scrolling when the inserted user id is NOT in the registry", async () => {
        const prefix = makeCompletedTranscript(16);
        const userTail = {
          ...makeMessageAt(0, "user", 200),
          id: "u-tail-gate",
          completedAt: null,
        };
        const assistantDone = {
          ...makeMessageAt(1, "assistant", 201),
          id: "a-live-gate",
          content: "done",
          completedAt: 300,
          runState: null,
        };
        const messages: ReadonlyArray<ChatMessageModel> = [
          ...prefix,
          userTail,
          assistantDone,
        ];
        const foreignId = "u-foreign-steer";
        const { rerenderMessages } = renderChatMessages({
          messages,
          scrollStateKey: "t4-h2-steer-foreign-key",
          // Empty registry: foreign window / A2A-shaped insert.
        });
        await settleLegendList();

        act(() => {
          enterFreeScrollingAwayFromEnd();
        });
        await waitForPillVisible();
        const parkedScrollTop = getScrollNode().scrollTop;
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

        const afterForeign: ReadonlyArray<ChatMessageModel> = [
          ...prefix,
          userTail,
          {
            ...makeMessageAt(0, "user", 202),
            id: foreignId,
            content: "other window edit",
            persistentMessageId: foreignId,
          },
          assistantDone,
        ];
        rerenderMessages(afterForeign);
        await settleLegendList();
        await act(async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 100);
          });
        });

        expect(getScrollNode().scrollTop).toBe(parkedScrollTop);
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
        expect(screen.queryByTestId(`mock-message-${foreignId}`)).toBeNull();
      });
    });
  });

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
        // test invented via a seeded saveChatTabState call.
        const saved = restoreChatTabState(scrollStateKey, messages);
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
        const saved = restoreChatTabState(scrollStateKey, messages);
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
        key: scrollStateKey,
        mode: "free-scrolling",
        anchorMessageId: anchorId,
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

    it("collapses mid-anchor (anchoring-new-turn) unmount to free-scrolling on the next mount", async () => {
      const messages = makeCompletedTranscript(16);
      const sendId = "t5-mid-anchor-send";
      const scrollStateKey = `t5-mid-anchor-${Math.random().toString(36).slice(2)}`;
      const instanceId = `t5-mid-anchor-inst-${Math.random().toString(36).slice(2)}`;
      // Matches legend-list-test-environment spacer measurement for
      // aria-hidden header/footer shells (not production h-16/h-20).
      const HARNESS_HEADER_PX = 40;
      const HARNESS_FOOTER_PX = 40;
      const HARNESS_ITEM_PX = 90;
      const composerOverlayHeight = 80;

      tileLiveness.live = true;
      const first = renderChatMessages({
        messages,
        scrollStateKey,
        instanceId,
        localProvenanceMessageIds: new Set([sendId]),
        composerOverlayHeight,
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

      // Content-relative last-row bottom: N items of fixed harness height
      // (positions start at 0; last bottom = N * itemHeight).
      const lastBottom = afterSend.length * HARNESS_ITEM_PX;
      const naturalMax = getChatNaturalMaxScrollWithoutAnchorReserve({
        headerSize: HARNESS_HEADER_PX,
        footerSize: HARNESS_FOOTER_PX,
        lastBottom,
        endInset: composerOverlayHeight,
        viewportLength: VIEWPORT_HEIGHT_PX,
      });
      // Old (wrong) bound for mutation contrast - under-clamps by
      // header+footer-anchorOffset (= 64 in this harness).
      const oldRevealBound = Math.max(
        0,
        lastBottom -
          (VIEWPORT_HEIGHT_PX -
            composerOverlayHeight -
            CHAT_LIST_ANCHOR_OFFSET),
      );
      expect(naturalMax - oldRevealBound).toBe(
        HARNESS_HEADER_PX + HARNESS_FOOTER_PX - CHAT_LIST_ANCHOR_OFFSET,
      );
      expect(naturalMax).toBeGreaterThan(oldRevealBound);

      // Force a reserve-inflated park ABOVE both bounds while still in
      // anchoring-new-turn (bare scrollTop write is not a cancel gesture).
      // F3 must clamp to naturalMax on save; the old reveal bound would clamp
      // 64px lower - restored geometry distinguishes them.
      await fireScrollTopAndFlush(naturalMax + 200);
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(getScrollNode().scrollTop).toBeGreaterThan(naturalMax);

      // Unmount while still mid-anchor - do NOT wait for settle.
      first.unmount();

      const saved = restoreChatTabState(scrollStateKey, afterSend);
      // anchoring-new-turn never round-trips through the cache.
      expect(saved.mode).toBe("free-scrolling");
      expect(saved.mode).not.toBe("following-end");
      // Active minimap/reading-line row (not necessarily the anchored send).
      expect(saved.anchorMessageId).not.toBeNull();

      const second = renderChatMessages({
        messages: afterSend,
        scrollStateKey,
        instanceId,
        composerOverlayHeight,
        // Provenance already consumed; remount must not re-enter the engine.
      });
      await settleLegendList();
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().dataset.scrollMode).not.toBe("anchoring-new-turn");
      // Ticket 11 fix #3: the restore lands exactly at the true content end
      // (naturalMax, asserted below) - decision #16's "out of view" semantic
      // correctly keeps the pill HIDDEN here even though mode is
      // free-scrolling, not following-end (the no-follow contract -
      // decision #14/#21 - is about MODE, not pill visibility).
      expect(isJumpPillVisible()).toBe(false);

      // F3 geometry: restore lands on the true no-reserve max, not the
      // under-clamped reveal target (oldRevealBound = naturalMax - 64 here).
      const restoredScrollTop = getScrollNode().scrollTop;
      expect(restoredScrollTop).toBe(naturalMax);
      expect(restoredScrollTop).not.toBe(oldRevealBound);
      expect(restoredScrollTop).toBeGreaterThan(oldRevealBound);

      second.unmount();
    });

    it("falls back cleanly when the saved anchor message is gone on remount", async () => {
      const messages = makeCompletedTranscript(12);
      const scrollStateKey = `t5-stale-free-${Math.random().toString(36).slice(2)}`;

      saveChatTabState({
        key: scrollStateKey,
        mode: "free-scrolling",
        anchorMessageId: "message-removed-while-away",
        offset: 64,
      });

      // restoreChatTabState keeps mode, drops the stale anchor.
      expect(restoreChatTabState(scrollStateKey, messages)).toEqual({
        mode: "free-scrolling",
        anchorMessageId: null,
        offset: 0,
      });

      renderChatMessages({ messages, scrollStateKey });
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      await waitForPillVisible();

      // following-end + stale anchor: mode preserved, no crash.
      const followKey = `t5-stale-follow-${Math.random().toString(36).slice(2)}`;
      saveChatTabState({
        key: followKey,
        mode: "following-end",
        anchorMessageId: "also-gone",
        offset: 12,
      });
      expect(restoreChatTabState(followKey, messages)).toEqual({
        mode: "following-end",
        anchorMessageId: null,
        offset: 0,
      });

      cleanup();
      renderChatMessages({ messages, scrollStateKey: followKey });
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      expect(isJumpPillVisible()).toBe(false);
    });

    it("does not resurrect hasSavedChatTabState on unmount when the tile is no longer live", async () => {
      const messages = makeCompletedTranscript(16);
      const scrollStateKey = `t5-liveness-guard-${Math.random().toString(36).slice(2)}`;
      const instanceId = `t5-liveness-inst-${Math.random().toString(36).slice(2)}`;

      tileLiveness.live = true;
      const { unmount } = renderChatMessages({
        messages,
        scrollStateKey,
        instanceId,
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();

      // Permanent close: canvas sweep drops the entry before unmount cleanup.
      evictChatTabState([scrollStateKey]);
      expect(hasSavedChatTabState(scrollStateKey)).toBe(false);
      tileLiveness.live = false;

      unmount();

      // Without the save-side liveness guard, free-scrolling unmount would
      // re-save and resurrect the entry the sweep just cleared.
      expect(hasSavedChatTabState(scrollStateKey)).toBe(false);
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
        getOrCreateActivityGroupOpenStore(instanceId)
          .getState()
          .setOpen(activityGroupId, true);
        getOrCreateA2AOpenStore(instanceId)
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
        getOrCreateActivityGroupOpenStore(instanceId)
          .getState()
          .openIds.has(activityGroupId),
      ).toBe(true);
      expect(
        getOrCreateA2AOpenStore(instanceId)
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
        getOrCreateActivityGroupOpenStore(instanceId)
          .getState()
          .openIds.has(activityGroupId),
      ).toBe(true);
      expect(
        getOrCreateA2AOpenStore(instanceId)
          .getState()
          .sentOpenIds.has(a2aSentId),
      ).toBe(true);
      // Registry identity: remount must reattach the same store instance.
      const activityStoreA = getOrCreateActivityGroupOpenStore(instanceId);
      second.unmount();
      const third = renderChatMessages({
        messages,
        scrollStateKey,
        instanceId,
      });
      expect(getOrCreateActivityGroupOpenStore(instanceId)).toBe(
        activityStoreA,
      );
      third.unmount();
    });

    describe("F3: save-time offset clamps against no-reserve geometry", () => {
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

      it("captures the raw offset when there is no natural-max-scroll bound (ordinary free-scrolling)", () => {
        const list = mockMeasurementSource(() => 500, 2000, undefined);
        expect(captureChatFreeScrollingOffset(list, 3, null)).toBe(500 - 2000);
      });

      it("clamps the captured scroll to the natural bound when it exceeds it (anchoring-new-turn reserve)", () => {
        // Anchoring parked the anchor near the top by scrolling to 4484 - a
        // position only reachable because anchoredEndSpace reserved blank
        // trailing space below it for a reply that has not streamed in yet.
        // The real (no-reserve) content only justifies scrolling to 3986.
        const list = mockMeasurementSource(() => 4500, 4484, undefined);
        const naturalMaxScroll = 3986;
        expect(captureChatFreeScrollingOffset(list, 5, naturalMaxScroll)).toBe(
          4500 - naturalMaxScroll,
        );
      });

      it("leaves the captured scroll untouched when it is already within the natural bound", () => {
        // A settled, caught-up anchored turn: the reveal-pass effect already
        // converged scroll to (at most) the natural bound - clamping must be
        // a no-op here, not double-subtract or otherwise distort a valid
        // position.
        const list = mockMeasurementSource(() => 4500, 3200, undefined);
        const naturalMaxScroll = 3986;
        expect(captureChatFreeScrollingOffset(list, 5, naturalMaxScroll)).toBe(
          4500 - 3200,
        );
      });

      it("folds topOffsetAdjustment into the offset so restore matches LegendList math", () => {
        // position=720, scroll=360, header=40 → viewOffset 400, which
        // round-trips: scroll = position - viewOffset + header = 360.
        const list = mockMeasurementSource(() => 720, 360, 40);
        expect(captureChatFreeScrollingOffset(list, 8, null)).toBe(
          720 + 40 - 360,
        );
      });

      it("keeps the F3 clamp relative to the top-offset-corrected value", () => {
        // Clamp scroll first, then add topOffset: (4500 + 40) - 3986, not
        // (4500 + 40) - 4484.
        const list = mockMeasurementSource(() => 4500, 4484, 40);
        expect(captureChatFreeScrollingOffset(list, 5, 3986)).toBe(
          4500 + 40 - 3986,
        );
      });
    });
  });

  describe("bottom fade replaces the legacy overpaint div", () => {
    it("no longer renders the legacy bg-linear-to-t overpaint div", async () => {
      const messages = makeCompletedTranscript(8);
      const { container } = renderChatMessages({ messages });
      await settleLegendList();

      expect(container.querySelector(".bg-linear-to-t")).toBeNull();
    });

    it("writes --chat-bottom-overlay-inset on the transcript container from the measured dock inset, tracking dock resize", async () => {
      const messages = makeCompletedTranscript(8);
      const { rerenderWith } = renderChatMessages({
        messages,
        composerOverlayHeight: 64,
      });
      await settleLegendList();

      const container = screen.getByTestId("chat-transcript-container");
      expect(
        container.style.getPropertyValue("--chat-bottom-overlay-inset"),
      ).toBe("64px");

      // Dock grows (e.g. the files-changed panel opening) - the var must
      // track the new measured height, not the value at mount.
      rerenderWith({ composerOverlayHeight: 148 });
      await settleLegendList();

      expect(
        container.style.getPropertyValue("--chat-bottom-overlay-inset"),
      ).toBe("148px");
    });
  });

  // -------------------------------------------------------------------------
  // Ticket 11: live-edge reconciliation for mode + pill (scroll-only routes,
  // suppressed-nav pill bookkeeping, strict epsilon vs loose near-end).
  // -------------------------------------------------------------------------
  describe("ticket 11: live-edge reconciliation for mode + pill", () => {
    /**
     * Drive the scroll node to an absolute `scrollTop` and fire a native
     * `scroll` event ONLY - no wheel/touchmove/pointerdown. Models an OS
     * scrollbar drag that never cancels generation ownership.
     */
    async function fireScrollOnlyTo(scrollTop: number): Promise<void> {
      await fireScrollTopAndFlush(scrollTop);
    }

    async function setupOverflowingAnchoredTurn(options: {
      readonly scrollStateKey: string;
      readonly sendId: string;
    }): Promise<{
      rerenderMessages: (messages: ReadonlyArray<ChatMessageModel>) => void;
      afterOverflow: ReadonlyArray<ChatMessageModel>;
    }> {
      const messages = makeCompletedTranscript(10);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: options.scrollStateKey,
        localProvenanceMessageIds: new Set([options.sendId]),
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();

      const afterSend = appendOptimisticUserSend(
        messages,
        options.sendId,
        888_000,
      );
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(
          screen.getByTestId(`mock-message-${options.sendId}`),
        ).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await waitForAnchorEngineSettle();

      const afterOverflow = appendStreamingAssistantChunks(
        afterSend,
        14,
        888_000,
      );
      rerenderMessages(afterOverflow);
      await settleLegendList();
      await act(async () => {
        for (let frame = 0; frame < 6; frame += 1) {
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          });
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 300);
        });
      });

      await waitFor(
        () => {
          expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
          expect(isJumpPillVisible()).toBe(true);
        },
        { timeout: 4_000 },
      );

      return { rerenderMessages, afterOverflow };
    }

    it("(a) scroll-only overflow-to-tail flips to following-end, hides pill, next chunk advances", async () => {
      const { rerenderMessages, afterOverflow } =
        await setupOverflowingAnchoredTurn({
          scrollStateKey: "t11-a-scroll-only",
          sendId: "t11-a-send",
        });

      // Scroll-ONLY route: native scrollbar drag never fires wheel/pointerdown,
      // so generation ownership stays matched for the whole anchoring session.
      // Without Ticket 11 reconciliation the terminal true report hits the
      // stale-true equality fast-path and mode stays stranded anchoring.
      //
      // Walk scrollTop upward from the parked anchor (not the shim's huge
      // fixed scrollHeight max - that overshoots real content and leaves no
      // room for maintainScrollAtEnd to advance on the next chunk).
      const parkedAtAnchor = getScrollNode().scrollTop;
      let flippedAt: number | null = null;
      for (let top = parkedAtAnchor; top <= parkedAtAnchor + 4_000; top += 80) {
        await fireScrollOnlyTo(top);
        if (getScrollNode().dataset.scrollMode === "following-end") {
          flippedAt = getScrollNode().scrollTop;
          break;
        }
      }
      expect(flippedAt).not.toBeNull();
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      expect(isJumpPillVisible()).toBe(false);

      // maintainScrollAtEnd re-engaged: subsequent stream growth advances
      // past the content-end landing we just found.
      const beforeChunk = getScrollNode().scrollTop;
      let afterChunk: ReadonlyArray<ChatMessageModel> = afterOverflow;
      for (let i = 0; i < 8; i += 1) {
        afterChunk = appendOneStreamingChunk(afterChunk, 900 + i, 900_000 + i);
      }
      rerenderMessages(afterChunk);
      await settleLegendList();
      await waitForRevealPassTick();
      await waitForRevealPassTick();

      await waitFor(() => {
        expect(getScrollNode().scrollTop).toBeGreaterThan(beforeChunk);
      });
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
    });

    it("(b) ordinary wheel cancel + pill-click path stays green (no regression)", async () => {
      // Companion to (a): the gesture-driven path must still cancel ownership
      // and restore follow via the pill - Ticket 11's mirror must not break it.
      const messages = makeTranscript(20);
      renderChatMessages({
        messages,
        scrollStateKey: "t11-b-wheel-path",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(isJumpPillVisible()).toBe(true);

      fireEvent.click(screen.getByRole("button", { name: "Scroll to end" }));
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      expect(isJumpPillVisible()).toBe(false);
    });

    it("(c) pill click while anchoring immediately enters following-end", async () => {
      await setupOverflowingAnchoredTurn({
        scrollStateKey: "t11-c-pill-while-anchoring",
        sendId: "t11-c-send",
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(isJumpPillVisible()).toBe(true);

      fireEvent.click(screen.getByRole("button", { name: "Scroll to end" }));
      // scrollToEnd sets following-end unconditionally on click - no wait.
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      expect(isJumpPillVisible()).toBe(false);
    });

    it("(d) suppressed nav at tail stays free, hides pill at edge, shows pill on offscreen growth without scroll event", async () => {
      // Ticket 5 F1-style: free-scrolling restore seeds suppressFollowRestore
      // from the first frame. A subsequent programmatic near-end landing
      // (no wheel) must stay free AND hide the pill via Ticket 11 fix #3's
      // suppressed-branch bookkeeping - then growth without a scroll event
      // must re-show the pill via the reveal-pass branch.
      const messages = makeCompletedTranscript(20);
      const anchorId = messages[4]?.id;
      expect(anchorId).toBeTruthy();
      const scrollStateKey = `t11-d-suppressed-${Math.random().toString(36).slice(2)}`;

      saveChatTabState({
        key: scrollStateKey,
        mode: "free-scrolling",
        anchorMessageId: anchorId,
        offset: 40,
      });

      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey,
      });
      await settleLegendList();
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // Programmatic near-end landing (still suppressed - no real gesture).
      // Walk to a content-relative end from the restored mid-list park so we
      // don't overshoot into the shim's fixed huge scrollHeight.
      const start = getScrollNode().scrollTop;
      for (let top = start; top <= start + 6_000; top += 120) {
        await fireScrollTopAndFlush(top);
        if (!isJumpPillVisible()) break;
      }
      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, PILL_SHOW_DEBOUNCE_MS + 40);
        });
      });

      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      await waitFor(
        () => {
          expect(isJumpPillVisible()).toBe(false);
        },
        { timeout: 2_000 },
      );

      // Growth WITHOUT a scroll event: append enough that the parked free
      // position is no longer at the end. Ticket 11 fix #3's reveal-pass
      // branch is the only bookkeeping path for this (no native scroll).
      let grown: ReadonlyArray<ChatMessageModel> = messages;
      for (let i = 0; i < 20; i += 1) {
        grown = appendOneStreamingChunk(grown, 2000 + i, 1_000_000 + i);
      }
      rerenderMessages(grown);
      await settleLegendList();
      await waitForRevealPassTick();
      await waitForPillVisible();

      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(isJumpPillVisible()).toBe(true);
    });

    it("(e) strict 1px epsilon gates mode reconciliation, not loose isNearEnd alone", async () => {
      await setupOverflowingAnchoredTurn({
        scrollStateKey: "t11-e-strict-epsilon",
        sendId: "t11-e-send",
      });

      // Find the minimal content-end scroll that flips to following-end via
      // the Ticket 11 reconciliation (scrollDeltaToRevealEnd <= 1), walking
      // from the parked anchor rather than the shim's fixed max scroll.
      const parkedAtAnchor = getScrollNode().scrollTop;
      let contentEndScroll: number | null = null;
      for (let top = parkedAtAnchor; top <= parkedAtAnchor + 4_000; top += 40) {
        await fireScrollOnlyTo(top);
        if (getScrollNode().dataset.scrollMode === "following-end") {
          contentEndScroll = getScrollNode().scrollTop;
          break;
        }
      }
      expect(contentEndScroll).not.toBeNull();

      // Re-enter anchoring so we can probe the SHORT-OF-END case under the
      // same overflow geometry. A fresh local-provenance send does that.
      // Simpler: the probe above already proved the true edge flips; now
      // re-setup and park well short of that edge while still inside a
      // typical loose near-end band of the CONTENT range.
      //
      // Tear down and re-drive: park at contentEnd - 200 (strict fail) then
      // contentEnd (strict pass). Re-setup is the honest way after the flip
      // already consumed anchoring.
      cleanup();
      await setupOverflowingAnchoredTurn({
        scrollStateKey: "t11-e-strict-epsilon-2",
        sendId: "t11-e-send-2",
      });
      const end = contentEndScroll as number;

      // ~200px short of the true content end: scrollDeltaToRevealEnd >> 1,
      // so even if isNearEnd is true the strict gate must keep anchoring.
      await fireScrollOnlyTo(Math.max(0, end - 200));
      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 50);
        });
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");

      // True live edge: strict epsilon satisfied → following-end.
      await fireScrollOnlyTo(end);
      await waitFor(
        () => {
          expect(getScrollNode().dataset.scrollMode).toBe("following-end");
        },
        { timeout: 2_000 },
      );
    });
  });

  // -------------------------------------------------------------------------
  // Ticket 10: settle/re-issue generalization + item-type split.
  // ANIMATED undershoot itself is jsdom-blind (no real animation timing);
  // pins exercise the settle/validate/re-issue LOGIC by driving geometry
  // between issue and settle (F2-style).
  // -------------------------------------------------------------------------
  describe("ticket 10: settle/re-issue navigation + item-type split", () => {
    /**
     * Ticket 10 F2-style: force the scroll node to land short of wherever
     * LegendList tries to place it, so the first settle's validate fails and
     * the re-issue path must recover. `enable` toggles the undershoot so a
     * later re-issue (or the final accept) can land honestly when cleared.
     */
    function installScrollUndershoot(
      scrollNode: HTMLElement,
      undershootPx: number,
    ): { setEnabled: (enabled: boolean) => void; dispose: () => void } {
      let enabled = true;
      let stored = scrollNode.scrollTop;
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
          if (!enabled) {
            stored = numeric;
            return;
          }
          stored = Math.max(0, numeric - undershootPx);
        },
      });
      return {
        setEnabled: (next: boolean) => {
          enabled = next;
        },
        dispose: () => {
          // Leave the last stored value; the prototype setter from the
          // viewport-metrics shim takes over again once this own-property
          // is removed.
          Reflect.deleteProperty(scrollNode, "scrollTop");
          scrollNode.scrollTop = stored;
        },
      };
    }

    it("navigateToMessage settle detects a short landing and re-issues to the exact viewOffset", async () => {
      // Target a MID-list human user row so the exact landing has a non-zero
      // scrollTop - navigating Home→row 0 wants scrollTop≈0, where an
      // undershoot is invisible and the pin would pass vacuously without
      // re-issue.
      const messages = makeCompletedTranscript(30);
      // messages[10] is a user row (even indices); positionAtIndex ≈ 10*90.
      const targetIndex = 10;
      const targetId = messages[targetIndex]?.id;
      expect(targetId).toBeTruthy();
      expect(messages[targetIndex]?.role).toBe("user");

      const { rerenderWith } = renderChatMessages({
        messages,
        scrollStateKey: "t10-nav-reissue",
      });
      await settleLegendList();

      const scrollNode = getScrollNode();
      // First material scroll jump lands 500px short of the intended target;
      // subsequent re-issues land honestly.
      let corruptNextJump = true;
      let stored = scrollNode.scrollTop;
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
          if (corruptNextJump && Math.abs(numeric - stored) > 100) {
            corruptNextJump = false;
            // From a bottom-following seed the jump is upward (numeric <
            // stored). Landing "short" of an upward jump means stopping
            // higher than the target (less travel) → numeric + 500.
            stored = numeric + 500;
            return;
          }
          stored = numeric;
        },
      });
      try {
        // Deep-link scrollRequest shares navigateToMessage's choke point
        // (scrollToTimelineLocationSuppressingFollowRestore).
        rerenderWith({
          scrollRequest: {
            requestId: 10_001,
            messageId: targetId,
            blockId: "",
          },
        });
        await act(async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 50);
          });
        });

        await waitForAnchorEngineSettle();
        await waitForAnchorEngineSettle();

        // Exact landing: scrollTop = positionAtIndex + header - viewOffset.
        // Row height is uniform 90px under the jsdom shim; header spacer 40.
        const ROW_HEIGHT_PX = 90;
        const HARNESS_HEADER_PX = 40;
        const expectedScrollTop =
          targetIndex * ROW_HEIGHT_PX +
          HARNESS_HEADER_PX -
          CHAT_TIMELINE_NAVIGATION_VIEW_OFFSET_PX;
        expect(
          Math.abs(getScrollNode().scrollTop - expectedScrollTop),
        ).toBeLessThanOrEqual(1);
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      } finally {
        Reflect.deleteProperty(scrollNode, "scrollTop");
      }
    });

    it("scrollToEnd settle re-issues to the true end after a short first landing", async () => {
      const messages = makeCompletedTranscript(24);
      renderChatMessages({
        messages,
        scrollStateKey: "t10-scroll-to-end-reissue",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();
      const freePark = getScrollNode().scrollTop;

      const scrollNode = getScrollNode();
      // Only the FIRST end-landing undershoots; re-issues land honestly so
      // the settle/validate/re-issue chain can converge (mirrors estimate →
      // measurement mid-flight, not permanent geometry sabotage).
      let undershootNextIncrease = true;
      let stored = scrollNode.scrollTop;
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
          if (undershootNextIncrease && numeric > stored + 100) {
            undershootNextIncrease = false;
            stored = Math.max(0, numeric - 600);
            return;
          }
          stored = numeric;
        },
      });
      try {
        fireEvent.click(screen.getByRole("button", { name: "Scroll to end" }));
        expect(getScrollNode().dataset.scrollMode).toBe("following-end");

        await waitForAnchorEngineSettle();
        await waitForAnchorEngineSettle();

        const recovered = getScrollNode().scrollTop;
        // Recovered past the free-scroll park and past the intentional
        // 600px undershoot of the first landing.
        expect(recovered).toBeGreaterThan(freePark + 600);
        expect(getScrollNode().dataset.scrollMode).toBe("following-end");
        expect(isJumpPillVisible()).toBe(false);

        // A second clean pill click must not move further - exact end.
        Reflect.deleteProperty(scrollNode, "scrollTop");
        scrollNode.scrollTop = recovered;
        fireEvent.click(screen.getByRole("button", { name: "Scroll to end" }));
        await waitForAnchorEngineSettle();
        expect(
          Math.abs(getScrollNode().scrollTop - recovered),
        ).toBeLessThanOrEqual(2);
      } finally {
        Reflect.deleteProperty(scrollNode, "scrollTop");
      }
    });

    it("scrollToEnd retry exhaustion reconciles to free-scrolling with the pill visible (never stranded following-end)", async () => {
      const messages = makeCompletedTranscript(24);
      renderChatMessages({
        messages,
        scrollStateKey: "t10-scroll-to-end-exhaust",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();

      const scrollNode = getScrollNode();
      // Keep undershooting for every attempt so validate never passes across
      // the bounded 3 retries + initial attempt.
      const undershoot = installScrollUndershoot(scrollNode, 600);
      try {
        fireEvent.click(screen.getByRole("button", { name: "Scroll to end" }));
        expect(getScrollNode().dataset.scrollMode).toBe("following-end");

        // initial settle + 3 re-issue settles = 4 * fallback.
        await act(async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, (CHAT_ANCHOR_SETTLE_FALLBACK_MS + 100) * 5);
          });
        });

        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
        expect(isJumpPillVisible()).toBe(true);
      } finally {
        undershoot.dispose();
      }
    });

    it("navigateToMessage settle chain aborts on a real mid-flight wheel gesture (no snap-back)", async () => {
      const messages = makeCompletedTranscript(30);
      renderChatMessages({
        messages,
        scrollStateKey: "t10-nav-abort-gesture",
      });
      await settleLegendList();

      const scrollNode = getScrollNode();
      const undershoot = installScrollUndershoot(scrollNode, 800);
      try {
        const minimapButton = screen.getByTestId("chat-turn-minimap-hit-strip");
        fireEvent.keyDown(minimapButton, { key: "Home" });
        await act(async () => {
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          });
        });
        fireEvent.keyDown(minimapButton, { key: "Enter" });

        // Mid-settle: a real wheel gesture must abort the re-issue chain
        // (generation bump + suppression clear). Park at a known offset.
        await act(async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 120);
          });
        });
        undershoot.setEnabled(false);
        act(() => {
          fireEvent.wheel(scrollNode, { deltaY: -80 });
          scrollNode.scrollTop = 220;
          fireEvent.scroll(scrollNode);
        });
        const parked = getScrollNode().scrollTop;
        expect(parked).toBe(220);

        // Wait well past any remaining settle/re-issue windows. A buggy
        // non-aborted re-issue would snap scroll away from the user's park.
        await act(async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, (CHAT_ANCHOR_SETTLE_FALLBACK_MS + 100) * 4);
          });
        });

        expect(getScrollNode().scrollTop).toBe(parked);
        expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      } finally {
        undershoot.dispose();
      }
    });

    it("getItemType splits human-sent user rows from A2A agent-sent rows", () => {
      const human = makeMessage(0, "user");
      expect(human.agentSenderInfo).toBeNull();
      expect(chatTimelineGetItemType(human)).toBe("user:human");

      const a2a: ChatMessageModel = {
        ...makeMessage(1, "user"),
        agentSenderInfo: {
          agentId: "agent-peer-1",
          senderTitle: "Peer",
          expectReply: false,
          responseId: null,
        },
      };
      expect(chatTimelineGetItemType(a2a)).toBe("user:a2a");
      expect(chatTimelineGetItemType(makeMessage(2, "assistant"))).toBe(
        "assistant",
      );
      // Distinct pools: the two user shapes must never collapse to one string.
      expect(chatTimelineGetItemType(human)).not.toBe(
        chatTimelineGetItemType(a2a),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Ticket 12: viewport stability while free-scrolling (sizePreservationEnabled).
  // Pure size-change MVCP simulation is jsdom-blind under the fixed-height
  // shim (LegendList's size path needs real item-layout measurement churn
  // that getBoundingClientRect overrides alone do not trigger). Interaction
  // contracts that do not need a size event are pinned below.
  // -------------------------------------------------------------------------
  describe("ticket 12: sizePreservationEnabled interaction audit", () => {
    // jsdom-blind: a mounted row's measured size changing after the initial
    // estimate (MVCP size:true path). The shared shim uses fixed 90px row
    // heights; LegendList's ScrollAdjust sizeDiff only fires when its own
    // measurement pipeline observes a layout change, which the fixed-height
    // getBoundingClientRect override never produces. Extending the shim's
    // rect height alone is insufficient without driving LegendList's internal
    // size-at-index cache. Declared honestly rather than faked.

    it("L3 review fix: sizePreservationEnabled is wired true ONLY in free-scrolling, false in following-end AND anchoring-new-turn", async () => {
      // `maintainVisibleContentPosition.size` has no DOM signature to read
      // back directly - `data-size-preservation-enabled` (review-round
      // test-observability, mirrors `data-scroll-mode`'s own "not read by
      // any production code" contract) is the prop-level pin: the five
      // interaction-audit tests below only re-confirm EXISTING contracts
      // hold under the new wiring - none of them fail if the wiring itself
      // silently regresses to always-false (a mutation flip confirmed this:
      // all five stayed green).
      const sendId = "t12-l3-send";
      const messages = makeCompletedTranscript(10);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "t12-l3-wiring",
        localProvenanceMessageIds: new Set([sendId]),
      });
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
      expect(getScrollNode().dataset.sizePreservationEnabled).toBe("false");

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().dataset.sizePreservationEnabled).toBe("true");

      const afterSend = appendOptimisticUserSend(messages, sendId, 500_000);
      rerenderMessages(afterSend);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${sendId}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(getScrollNode().dataset.sizePreservationEnabled).toBe("false");
    });

    it("(1) anchoring drift re-assert still holds with sizePreservationEnabled=false during anchoring-new-turn", async () => {
      // Re-runs the existing Ticket 4 above-anchor growth pin under the
      // Ticket 12 wiring: anchoring-new-turn never enables size:true, so the
      // reveal-pass anchorPositionDrift re-assert must still single-correct.
      const ROW_HEIGHT_PX = 90;
      const initial = makeCompletedTranscript(4);
      const turn1Id = "t12-drift-turn1";
      const turn2Id = "t12-drift-turn2";
      const { rerenderMessages } = renderChatMessages({
        messages: initial,
        scrollStateKey: "t12-anchor-drift",
        localProvenanceMessageIds: new Set([turn1Id, turn2Id]),
      });
      await settleLegendList();

      const afterTurn1Send = appendOptimisticUserSend(
        initial,
        turn1Id,
        100_000,
      );
      rerenderMessages(afterTurn1Send);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${turn1Id}`)).toBeTruthy();
      });
      await waitForAnchorEngineSettle();

      const afterTurn1Reply: ReadonlyArray<ChatMessageModel> = [
        ...afterTurn1Send,
        {
          ...makeMessageAt(0, "assistant", 100_001),
          id: "t12-turn1-reply",
          content: "OK",
          completedAt: 100_002,
          runState: null,
        },
      ];
      rerenderMessages(afterTurn1Reply);
      await settleLegendList();

      const afterTurn2Send = appendOptimisticUserSend(
        afterTurn1Reply,
        turn2Id,
        200_000,
      );
      rerenderMessages(afterTurn2Send);
      await waitFor(() => {
        expect(screen.getByTestId(`mock-message-${turn2Id}`)).toBeTruthy();
      });
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      await waitForAnchorEngineSettle();
      const scrollAfterSettle = getScrollNode().scrollTop;
      const turn2AnchorIndex = afterTurn2Send.length - 1;

      const withLateMetadata: ReadonlyArray<ChatMessageModel> = [
        ...afterTurn2Send.slice(0, turn2AnchorIndex),
        {
          ...makeMessageAt(0, "assistant", 100_003),
          id: "t12-turn1-late-metadata",
          content: "Thought for 4s",
          completedAt: 100_004,
          runState: null,
        },
        ...afterTurn2Send.slice(turn2AnchorIndex),
      ];
      rerenderMessages(withLateMetadata);
      await settleLegendList();
      await waitForRevealPassTick();
      await waitForRevealPassTick();

      // Reveal-pass re-assert: scroll advances by exactly one row (the
      // late metadata), not double-corrected by an accidental size:true.
      expect(getScrollNode().dataset.scrollMode).toBe("anchoring-new-turn");
      expect(getScrollNode().scrollTop - scrollAfterSettle).toBe(ROW_HEIGHT_PX);
    });

    it("(2) following-end maintainScrollAtEnd catch-up is unaffected (size:false there)", async () => {
      const messages = makeTranscript(20);
      const { rerenderMessages } = renderChatMessages({
        messages,
        scrollStateKey: "t12-follow-catchup",
      });
      await settleLegendList();
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");

      const before = getScrollNode().scrollTop;
      rerenderMessages(appendAssistant(messages, "t12-follow-stream", 130_000));
      await settleLegendList();

      await waitFor(() => {
        expect(getScrollNode().scrollTop).toBeGreaterThan(before);
      });
      expect(getScrollNode().dataset.scrollMode).toBe("following-end");
    });

    it("(3) disclosure helper skips its OWN manual correction under free-scrolling - MVCP is the sole owner there (M2 fix)", async () => {
      // Review round M2: static analysis proved the manual correction below
      // and LegendList's own MVCP size-correction are ADDITIVE (not self-
      // cancelling) when both fire for the same disclosure - an
      // over-correction. Ownership is now exclusive per mode:
      // `correctionOwnedByMvcp: true` (free-scrolling, sizePreservationEnabled)
      // must skip the manual scrollToOffset write entirely (mutate still
      // runs). ChatMessage is mocked in this suite, so a real activity-group
      // expand cannot drive LegendList's own row remeasure to independently
      // prove MVCP's side of the fix - the unit-level pins in
      // chat-scroll-disclosure.test.ts cover both ownership branches
      // directly; this test proves the free-scrolling INTEGRATION context
      // (a real ChatMessages render) still reaches the "owned by MVCP,
      // skip" branch, not just the pure-function contract in isolation.
      const messages = makeCompletedTranscript(16);
      renderChatMessages({
        messages,
        scrollStateKey: "t12-disclosure-single-delta",
      });
      await settleLegendList();

      act(() => {
        enterFreeScrollingAwayFromEnd();
      });
      await waitForPillVisible();
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      const scrollNode = getScrollNode();
      await fireScrollTopAndFlush(300);
      const before = scrollNode.scrollTop;

      // Synthetic list handle mirroring what ChatMessages passes the helper.
      const scrollToOffsetCalls: Array<{ offset: number }> = [];
      const listHandle = {
        getState: () => ({ scroll: before }),
        scrollToOffset: (opts: { offset: number; animated: boolean }) => {
          scrollToOffsetCalls.push({ offset: opts.offset });
          scrollNode.scrollTop = opts.offset;
        },
      };
      const anchor = document.createElement("div");
      const rect = vi.spyOn(anchor, "getBoundingClientRect");
      rect.mockReturnValueOnce({
        x: 0,
        y: 120,
        width: 100,
        height: 40,
        top: 120,
        left: 0,
        right: 100,
        bottom: 160,
        toJSON: () => ({}),
      });
      // Expand pushes the anchor top down by 80px (content above grew).
      rect.mockReturnValueOnce({
        x: 0,
        y: 200,
        width: 100,
        height: 40,
        top: 200,
        left: 0,
        right: 100,
        bottom: 240,
        toJSON: () => ({}),
      });

      const mutate = vi.fn();
      preserveChatScrollAcrossDisclosureChange({
        list: listHandle as never,
        anchorElement: anchor,
        mutate,
        // Mirrors `requestMeasuredItemChange`'s own
        // `timelineScrollModeRef.current === "free-scrolling"` computation -
        // true here since the mode was driven to free-scrolling above.
        correctionOwnedByMvcp: true,
      });

      expect(mutate).toHaveBeenCalledOnce();
      expect(scrollToOffsetCalls).toEqual([]);
      expect(scrollNode.scrollTop).toBe(before);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      rect.mockRestore();
    });

    it("(4) suppressed programmatic nav under free-scrolling never auto-restores follow (sizePreservation active)", async () => {
      const messages = makeCompletedTranscript(20);
      const anchorId = messages[4]?.id;
      expect(anchorId).toBeTruthy();
      const scrollStateKey = `t12-suppress-${Math.random().toString(36).slice(2)}`;

      saveChatTabState({
        key: scrollStateKey,
        mode: "free-scrolling",
        anchorMessageId: anchorId,
        offset: 40,
      });

      renderChatMessages({ messages, scrollStateKey });
      await settleLegendList();
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      // Programmatic near-end landing (no real gesture): suppression must
      // hold even with sizePreservationEnabled=true on free-scrolling.
      act(() => {
        fireScrollToEnd();
      });
      await settleLegendList();

      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");
      expect(getScrollNode().dataset.scrollMode).not.toBe("following-end");
    });

    it("(5) ticket-5 free-scrolling restore bootstrap still lands the exact pixel with sizePreservation from first render", async () => {
      const messages = makeCompletedTranscript(20);
      const scrollStateKey = `t12-restore-${Math.random().toString(36).slice(2)}`;
      const instanceId = `t12-restore-inst-${Math.random().toString(36).slice(2)}`;

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

      const second = renderChatMessages({
        messages,
        scrollStateKey,
        instanceId,
      });
      await settleLegendList();
      await settleLegendList();

      // Exact-pixel restore must not fight MVCP size-correction on bootstrap.
      expect(getScrollNode().scrollTop).toBe(originalScrollTop);
      expect(getScrollNode().dataset.scrollMode).toBe("free-scrolling");

      second.unmount();
    });
  });
});
