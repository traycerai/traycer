import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  createRef,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LegendListRef } from "@legendapp/list/react";
import type {
  ChatMessageActions,
  ChatMessageUserActions,
} from "@/components/chat/chat-message";
import { ChatTimeline } from "@/components/chat/chat-timeline";
import { PANEL_RESIZE_VISIBLE_ROW_ATTRIBUTE } from "@/components/chat/chat-timeline-panel-resize-snapshot";
import type { NextStepActionHandler } from "@/components/chat/segments/next-steps-action-group";
import { beginPanelResizeInteraction } from "@/lib/layout/panel-resizing-class";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import { makeMessage, makeMessages } from "./chat-message-fixtures";
import {
  advanceLegendListFrames,
  installLegendListTestClock,
  installLegendListViewportMetrics,
  restoreLegendListTestClock,
  settleLegendList,
} from "./legend-list-test-environment";

const MESSAGE_ROW_SELECTOR = "[data-message-id]";
const LARGE_MESSAGE_COUNT = 400;

/**
 * Review round 1, finding 2: counts ROW-BOUNDARY renders - i.e. how many
 * times `ChatTimelineRow` re-entered this child boundary - NOT executions of
 * the real memoized `ChatMessageImpl` body. This wrapper is intentionally
 * un-memoized, so it always re-runs (and increments the counter) whenever
 * its parent `ChatTimelineRow` re-renders; the wrapped `actual.ChatMessage`
 * (still the real `memo(ChatMessageImpl)`) could in principle still bail
 * internally even when this wrapper re-runs. That's the right granularity
 * for pinning the context-propagation/external-store fanout bug (a
 * `ChatTimelineRow`-level defect), but it does NOT prove anything about
 * `ChatMessageImpl`'s own render cost - see the `getMessageActions`-based
 * assertions elsewhere in this file for independent row-boundary evidence.
 */
const renderCounts = new Map<string, number>();

vi.mock("@/components/chat/chat-message", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/chat/chat-message")>();

  function ChatMessageWithRenderProbe(
    props: Parameters<typeof actual.ChatMessage>[0],
  ): ReactElement {
    useEffect(() => {
      const id = props.message.id;
      renderCounts.set(id, (renderCounts.get(id) ?? 0) + 1);
    });
    return <actual.ChatMessage {...props} />;
  }

  return {
    ...actual,
    ChatMessage: ChatMessageWithRenderProbe,
  };
});

const VIEWPORT_HEIGHT_PX = 700;

/** Captures the static LegendList scroll-policy props ChatTimeline must pin. */
const legendListPolicyProps = vi.hoisted(() => ({
  last: null as null | {
    maintainScrollAtEnd: unknown;
    maintainScrollAtEndThreshold: unknown;
    maintainVisibleContentPosition: unknown;
  },
}));

vi.mock("@legendapp/list/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@legendapp/list/react")>();
  const CapturingLegendList: typeof actual.LegendList = (props) => {
    legendListPolicyProps.last = {
      maintainScrollAtEnd: props.maintainScrollAtEnd,
      maintainScrollAtEndThreshold: props.maintainScrollAtEndThreshold,
      maintainVisibleContentPosition: props.maintainVisibleContentPosition,
    };
    return <actual.LegendList {...props} />;
  };
  return { ...actual, LegendList: CapturingLegendList };
});

const VIEWPORT_WIDTH_PX = 800;

function mountedMessageRows(container: HTMLElement): NodeListOf<Element> {
  return container.querySelectorAll(MESSAGE_ROW_SELECTOR);
}

/** Ticket 23 panel-resize tests: a distinct-position rect, overriding the
 *  shared `installLegendListViewportMetrics()` shim's uniform (0,0)-origin
 *  stub on a specific element so visible vs. off-screen rows are
 *  distinguishable (see `chat-timeline-panel-resize-snapshot.test.ts` for
 *  the same rationale on the pure module). */
function rectOf(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: VIEWPORT_WIDTH_PX,
    width: VIEWPORT_WIDTH_PX,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

function rowIds(container: HTMLElement): ReadonlyArray<string> {
  return Array.from(mountedMessageRows(container)).map(
    (row) => row.getAttribute("data-message-id") ?? "",
  );
}

function makeUserActions(): ChatMessageUserActions {
  return {
    type: "user",
    enabled: true,
    confirmingDelete: false,
    editing: null,
    onEdit: () => undefined,
    onDeleteRequest: () => undefined,
    onDeleteConfirm: () => undefined,
    onDeleteCancel: () => undefined,
  };
}

interface RenderTimelineOptions {
  readonly messages: ReadonlyArray<ChatMessageModel>;
  readonly taskTitle?: string;
  readonly backgroundToolBlockIds?: ReadonlySet<string>;
  readonly getMessageActions?: (
    message: ChatMessageModel,
  ) => ChatMessageActions | null;
  readonly nextStepActions?: NextStepActionHandler | null;
  readonly listRef?: RefObject<LegendListRef | null>;
  readonly className?: string;
  readonly "data-testid"?: string;
  readonly onItemSizeChanged?: () => void;
  readonly navigationHighlightedMessageId?: string | null;
}

function renderTimeline(options: RenderTimelineOptions) {
  const listRef = options.listRef ?? createRef<LegendListRef | null>();
  const getMessageActions =
    options.getMessageActions ?? ((_message: ChatMessageModel) => null);
  const nextStepActions = options.nextStepActions ?? null;
  const backgroundToolBlockIds =
    options.backgroundToolBlockIds ?? new Set<string>();

  const jsx = (
    messages: ReadonlyArray<ChatMessageModel>,
    navigationHighlightedMessageId: string | null | undefined,
  ): ReactNode => (
    <div
      style={{
        height: VIEWPORT_HEIGHT_PX,
        width: VIEWPORT_WIDTH_PX,
      }}
    >
      <ChatTimeline
        messages={messages}
        taskTitle={options.taskTitle ?? "Test transcript"}
        backgroundToolBlockIds={backgroundToolBlockIds}
        getMessageActions={getMessageActions}
        nextStepActions={nextStepActions}
        listRef={listRef}
        className={options.className ?? "h-full"}
        data-testid={options["data-testid"]}
        onItemSizeChanged={options.onItemSizeChanged}
        navigationHighlightedMessageId={navigationHighlightedMessageId}
      />
    </div>
  );

  const result = render(
    jsx(options.messages, options.navigationHighlightedMessageId),
  );
  return {
    ...result,
    listRef,
    rerenderMessages: (
      messages: ReadonlyArray<ChatMessageModel>,
      navigationHighlightedMessageId: string | null | undefined,
    ) => {
      result.rerender(jsx(messages, navigationHighlightedMessageId));
    },
  };
}

/** Render counts (from the `ChatMessage` probe above) for every id in
 *  `messages`, snapshotted as a plain map so two snapshots can be diffed by
 *  value without aliasing the live `renderCounts` map. */
function snapshotRenderCounts(
  messages: ReadonlyArray<ChatMessageModel>,
): Map<string, number> {
  return new Map(messages.map((m) => [m.id, renderCounts.get(m.id) ?? 0]));
}

/** Message ids whose render count changed between two snapshots. */
function renderedSince(
  messages: ReadonlyArray<ChatMessageModel>,
  before: Map<string, number>,
): ReadonlyArray<string> {
  return messages
    .map((m) => m.id)
    .filter((id) => (renderCounts.get(id) ?? 0) !== (before.get(id) ?? 0));
}

async function flushFrame(): Promise<void> {
  await advanceLegendListFrames(1);
}

describe("ChatTimeline", () => {
  beforeEach(() => {
    renderCounts.clear();
    installLegendListViewportMetrics();
    installLegendListTestClock();
  });

  afterEach(() => {
    cleanup();
    restoreLegendListTestClock();
    vi.restoreAllMocks();
  });

  it("virtualizes a large transcript so mounted DOM rows stay bounded", async () => {
    const messages = makeMessages(LARGE_MESSAGE_COUNT);
    const { container } = renderTimeline({ messages });

    await settleLegendList();
    await waitFor(
      () => {
        expect(mountedMessageRows(container).length).toBeGreaterThan(0);
      },
      { timeout: 5_000 },
    );

    const mountedCount = mountedMessageRows(container).length;
    // Viewport (~700px) + draw distance + pool still has to be far below a
    // 1:1 mount of 400 messages. A loose but meaningful bound:
    expect(mountedCount).toBeGreaterThan(0);
    expect(mountedCount).toBeLessThan(LARGE_MESSAGE_COUNT / 4);
    expect(mountedCount).toBeLessThan(80);

    // Keep the concrete numbers in the assertion message for the report.
    expect(
      mountedCount,
      `virtualization evidence: ${LARGE_MESSAGE_COUNT} messages -> ${mountedCount} mounted DOM rows`,
    ).toBeLessThan(LARGE_MESSAGE_COUNT);
  });

  it("keeps earlier row DOM nodes stable when only the streaming tail content changes", async () => {
    // Keep the set small enough that every row fits the mocked viewport so
    // virtualization does not recycle early nodes out of the DOM.
    const baseMessages: ChatMessageModel[] = [
      makeMessage(0, "user"),
      makeMessage(1, "assistant"),
      makeMessage(2, "user"),
      {
        ...makeMessage(3, "assistant"),
        content: "partial",
        runState: "running",
      },
    ];

    const { container, rerenderMessages } = renderTimeline({
      messages: baseMessages,
    });

    await settleLegendList();
    await waitFor(
      () => {
        expect(mountedMessageRows(container).length).toBe(baseMessages.length);
      },
      { timeout: 5_000 },
    );

    const earlyRowBefore = container.querySelector(
      '[data-message-id="message-0"]',
    );
    const midRowBefore = container.querySelector(
      '[data-message-id="message-1"]',
    );
    const userRowBefore = container.querySelector(
      '[data-message-id="message-2"]',
    );
    expect(earlyRowBefore).not.toBeNull();
    expect(midRowBefore).not.toBeNull();
    expect(userRowBefore).not.toBeNull();

    const earlyRenderCountBefore = renderCounts.get("message-0") ?? 0;
    const midRenderCountBefore = renderCounts.get("message-1") ?? 0;
    const userRenderCountBefore = renderCounts.get("message-2") ?? 0;
    const streamingRenderCountBefore = renderCounts.get("message-3") ?? 0;

    // Simulate a store rebuild: new array, new objects; only the streaming
    // message's content differs. Structural sharing + memo should keep
    // earlier rows from remounting / re-rendering.
    const nextMessages: ReadonlyArray<ChatMessageModel> = [
      { ...baseMessages[0] },
      { ...baseMessages[1] },
      { ...baseMessages[2] },
      {
        ...baseMessages[3],
        content: "partial reply token",
      },
    ];

    rerenderMessages(nextMessages, undefined);

    await advanceLegendListFrames(1);

    const earlyRowAfter = container.querySelector(
      '[data-message-id="message-0"]',
    );
    const midRowAfter = container.querySelector(
      '[data-message-id="message-1"]',
    );
    const userRowAfter = container.querySelector(
      '[data-message-id="message-2"]',
    );

    // Same DOM node instances → React did not tear down / remount them.
    expect(earlyRowAfter).toBe(earlyRowBefore);
    expect(midRowAfter).toBe(midRowBefore);
    expect(userRowAfter).toBe(userRowBefore);

    // Render-count probe: unrelated rows should not re-render.
    expect(renderCounts.get("message-0") ?? 0).toBe(earlyRenderCountBefore);
    expect(renderCounts.get("message-1") ?? 0).toBe(midRenderCountBefore);
    expect(renderCounts.get("message-2") ?? 0).toBe(userRenderCountBefore);
    // Streaming row may re-render once for the content update.
    expect(renderCounts.get("message-3") ?? 0).toBeGreaterThanOrEqual(
      streamingRenderCountBefore,
    );
  });

  it("renders ChatEmptyState for an empty message list and does not mount LegendList rows", () => {
    const { container } = renderTimeline({
      messages: [],
      "data-testid": "chat-timeline",
    });

    expect(screen.getByText("Start the conversation")).not.toBeNull();
    expect(screen.getByText("Send a message to get started.")).not.toBeNull();
    expect(mountedMessageRows(container).length).toBe(0);
    // data-testid is spread onto LegendList only when messages exist.
    expect(screen.queryByTestId("chat-timeline")).toBeNull();
  });

  it("sets data-message-id and role-specific contain-intrinsic-size classes on row wrappers", async () => {
    const messages: ReadonlyArray<ChatMessageModel> = [
      makeMessage(0, "user"),
      makeMessage(1, "assistant"),
    ];
    const { container } = renderTimeline({ messages });

    await settleLegendList();
    await waitFor(
      () => {
        expect(rowIds(container)).toEqual(
          expect.arrayContaining(["message-0", "message-1"]),
        );
      },
      { timeout: 5_000 },
    );

    const userRow = container.querySelector('[data-message-id="message-0"]');
    const assistantRow = container.querySelector(
      '[data-message-id="message-1"]',
    );
    expect(userRow).not.toBeNull();
    expect(assistantRow).not.toBeNull();

    const userClass = userRow?.getAttribute("class") ?? "";
    const assistantClass = assistantRow?.getAttribute("class") ?? "";

    expect(userClass).toContain("[contain:layout_paint_style]");
    expect(assistantClass).toContain("[contain:layout_paint_style]");
    expect(userClass).toContain("[contain-intrinsic-size:auto_8rem]");
    expect(assistantClass).toContain("[contain-intrinsic-size:auto_14rem]");
    expect(userClass).not.toContain("[contain-intrinsic-size:auto_14rem]");
    expect(assistantClass).not.toContain("[contain-intrinsic-size:auto_8rem]");
  });

  it("forwards getMessageActions, backgroundToolBlockIds, and nextStepActions into ChatMessage", async () => {
    const user = makeMessage(0, "user");
    const assistant = makeMessage(1, "assistant");
    const userActions = makeUserActions();
    const getMessageActions = vi.fn(
      (message: ChatMessageModel): ChatMessageActions | null => {
        if (message.role === "user") return userActions;
        return null;
      },
    );
    const nextStepActions: NextStepActionHandler = {
      canSend: true,
      onSend: () => true,
    };
    const backgroundToolBlockIds = new Set(["tool-block-1"]);

    const { container } = renderTimeline({
      messages: [user, assistant],
      getMessageActions,
      nextStepActions,
      backgroundToolBlockIds,
    });

    await settleLegendList();
    await waitFor(
      () => {
        expect(mountedMessageRows(container).length).toBeGreaterThan(0);
      },
      { timeout: 5_000 },
    );

    expect(getMessageActions).toHaveBeenCalled();
    const calledWithIds = getMessageActions.mock.calls.map(
      (call) => call[0].id,
    );
    expect(calledWithIds).toEqual(
      expect.arrayContaining(["message-0", "message-1"]),
    );

    // Action bar only mounts when getMessageActions returned user actions.
    expect(screen.getByLabelText("Edit message")).not.toBeNull();
  });

  // Ticket 17 (chat-messages.tsx review round 2, finding 2 residual):
  // establishes the LIBRARY-LEVEL contract the fix depends on - a row's
  // real measured size CAN change under the SAME `data` array with NO
  // scroll event at all (an activity-group disclosure collapsing/expanding
  // is exactly this shape: that open/closed state lives outside `messages`,
  // so LegendList sees no data change and jsdom's `MockResizeObserver` never
  // fires on its own). `setItemSize` is the ref-exposed imperative path
  // production would only reach via a real ResizeObserver (a no-op in this
  // test environment) - calling it directly here still runs through
  // LegendList's own `applyItemSize`/`onItemSizeChanged` pipeline for real,
  // which is the part `chat-messages.tsx`'s `onTimelineItemSizeChanged` (not
  // exercised by this file - `ChatMessages` does not expose `chatTimelineRef`
  // to tests) depends on being reachable at all.
  it("onItemSizeChanged fires for a real size delta on an already-measured row, with no scroll and no data change", async () => {
    const messages: ChatMessageModel[] = [
      makeMessage(0, "user"),
      makeMessage(1, "assistant"),
      makeMessage(2, "user"),
    ];
    const onItemSizeChanged = vi.fn();
    const { listRef } = renderTimeline({ messages, onItemSizeChanged });

    await settleLegendList();
    await waitFor(() => {
      expect(listRef.current).not.toBeNull();
    });

    onItemSizeChanged.mockClear();
    act(() => {
      listRef.current?.setItemSize("message-0", { height: 40, width: 800 });
    });

    expect(onItemSizeChanged).toHaveBeenCalled();
  });

  it("keeps Legend List as the sole scroll owner on the app-wide compact scrollbar theme", () => {
    // Chat previously set data-native-scrollbar to opt out of index.css's
    // 4px transparent-track theme. That left the OS gutter overlapping the
    // absolute lower composer; the transcript now uses the global theme.
    const messages: ChatMessageModel[] = [makeMessage(0, "user")];
    const { getByTestId } = renderTimeline({
      messages,
      "data-testid": "chat-timeline",
    });

    const listElement = getByTestId("chat-timeline");
    expect(listElement.hasAttribute("data-native-scrollbar")).toBe(false);
    expect(listElement.className).toContain("overflow-y-auto");
    expect(listElement.className).toContain("overflow-x-hidden");
    expect(listElement.className).toContain("overscroll-y-contain");
    expect(listElement.className).not.toContain("scrollbar-gutter");
    expect(listElement.className).not.toContain("scrollbar-native-thin");
    // showsVerticalScrollIndicator stays on; LegendList only adds this class
    // when the indicator is suppressed.
    expect(listElement.className).not.toContain(
      "legend-list-scrollbar-y-hidden",
    );
  });

  // M4 (ticket 16 spacer alignment): header/footer 40px -> 12/16px, fade
  // header 64/80px -> 40/48px.
  it("uses the approved compact spacer sizes instead of the old 40/64/80px drift", () => {
    const messages: ChatMessageModel[] = [makeMessage(0, "user")];

    function spacerClasses(container: HTMLElement): ReadonlyArray<string> {
      // Only the header/footer/fade-header spacer divs - not the row action
      // buttons' lucide icon SVGs, which also carry aria-hidden.
      return Array.from(
        container.querySelectorAll('div[aria-hidden="true"]'),
      ).map((node) => node.getAttribute("class") ?? "");
    }

    const { container } = renderTimeline({ messages });
    expect(spacerClasses(container)).toEqual(["h-3 sm:h-4", "h-3 sm:h-4"]);
  });

  // Ticket 24 (painted-chat lifecycle audit, finding 5): the shared row
  // context previously carried `navigationHighlightedMessageId` directly, so
  // React's context propagation re-rendered EVERY mounted row - bypassing
  // each row's own `memo` bailout entirely (see the render-count probe's own
  // doc comment above for exactly what "renders" measures here: row-
  // boundary commits, not `ChatMessageImpl` body executions specifically).
  // Pin: moving the highlight renders only the old and new highlighted
  // rows; clearing it renders only the previously highlighted row.
  it("isolates navigation-highlight changes to only the affected rows", async () => {
    const messageCount = 8;
    const messages = makeMessages(messageCount);

    const { container, rerenderMessages } = renderTimeline({
      messages,
      navigationHighlightedMessageId: null,
    });

    await settleLegendList();
    await waitFor(() => {
      expect(mountedMessageRows(container).length).toBe(messageCount);
    });

    const baseline = snapshotRenderCounts(messages);

    // Move the highlight onto message-3: only that row should render.
    rerenderMessages(messages, "message-3");
    await flushFrame();
    expect(renderedSince(messages, baseline)).toEqual(["message-3"]);

    const afterFirstMove = snapshotRenderCounts(messages);

    // Move the highlight from message-3 to message-5: exactly the old and
    // new highlighted rows should render - not the other 6 mounted rows.
    rerenderMessages(messages, "message-5");
    await flushFrame();
    expect(new Set(renderedSince(messages, afterFirstMove))).toEqual(
      new Set(["message-3", "message-5"]),
    );

    const afterSecondMove = snapshotRenderCounts(messages);

    // Clear the highlight: only the previously highlighted row should render.
    rerenderMessages(messages, null);
    await flushFrame();
    expect(renderedSince(messages, afterSecondMove)).toEqual(["message-5"]);
  });

  const NAVIGATION_HIGHLIGHT_RING_CLASS =
    "bg-primary/15 ring-2 ring-inset ring-primary/80 motion-safe:animate-pulse";

  function highlightedRowIds(container: HTMLElement): ReadonlyArray<string> {
    return Array.from(
      container.querySelectorAll('[data-navigation-highlighted="true"]'),
    ).map((row) => row.getAttribute("data-message-id") ?? "");
  }

  function rowHasHighlightRing(row: Element | null): boolean {
    if (row === null) return false;
    const className = row.getAttribute("class") ?? "";
    return NAVIGATION_HIGHLIGHT_RING_CLASS.split(" ").every((token) =>
      className.includes(token),
    );
  }

  /**
   * Review round 1, finding 1: owns messages/highlight as REAL React state
   * (mirroring how chat-messages.tsx drives `ChatTimeline`) and exposes the
   * raw setters, so timing-sensitive tests can trigger updates WITHOUT going
   * through Testing Library's `rerender` - `rerender`'s internal `act()`
   * (confirmed empirically, including with `IS_REACT_ACT_ENVIRONMENT`
   * disabled and with `flushSync`) fully settles BOTH `useLayoutEffect` AND
   * `useEffect` synchronously in this React version, which hides the exact
   * regression finding 1 covers. Calling the exposed setters directly, with
   * the act-environment flag OFF (see `withActEnvironmentDisabled`), lets a
   * PLAIN state update go through React's ordinary (non-test) scheduling,
   * where a passive effect's flush is a real, separately-scheduled task
   * instead of something `act()` eagerly drains for you.
   */
  function HighlightTimingHarness({
    initialMessages,
    initialHighlight,
    onExposeSetters,
  }: {
    readonly initialMessages: ReadonlyArray<ChatMessageModel>;
    readonly initialHighlight: string | null;
    readonly onExposeSetters: (setters: {
      readonly setMessages: (messages: ReadonlyArray<ChatMessageModel>) => void;
      readonly setHighlight: (id: string | null) => void;
    }) => void;
  }): ReactElement {
    const [messages, setMessages] = useState(initialMessages);
    const [highlight, setHighlight] = useState(initialHighlight);
    const [listRef] = useState(() => createRef<LegendListRef | null>());

    useEffect(() => {
      onExposeSetters({ setMessages, setHighlight });
      // Setter identities from useState never change - registering once is
      // enough, and re-running on every render would re-expose (harmlessly)
      // identical functions anyway.
    }, [onExposeSetters]);

    return (
      <div style={{ height: VIEWPORT_HEIGHT_PX, width: VIEWPORT_WIDTH_PX }}>
        <ChatTimeline
          messages={messages}
          taskTitle="Test transcript"
          backgroundToolBlockIds={new Set<string>()}
          getMessageActions={() => null}
          nextStepActions={null}
          listRef={listRef}
          className="h-full"
          navigationHighlightedMessageId={highlight}
        />
      </div>
    );
  }

  interface HighlightTimingSetters {
    readonly setMessages: (messages: ReadonlyArray<ChatMessageModel>) => void;
    readonly setHighlight: (id: string | null) => void;
  }

  /** Runs `fn` with React's act-environment detection OFF, so a plain state
   *  update inside `fn` is scheduled the way it would be in production, not
   *  the eagerly-flushed way `act()` schedules it for test determinism. */
  async function withActEnvironmentDisabled(
    fn: () => Promise<void>,
  ): Promise<void> {
    const globalWithActFlag = globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    };
    const previous = globalWithActFlag.IS_REACT_ACT_ENVIRONMENT;
    globalWithActFlag.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      await fn();
    } finally {
      globalWithActFlag.IS_REACT_ACT_ENVIRONMENT = previous;
    }
  }

  /** One virtual browser turn - the queued macrotask plus the following
   *  animation frame. This is the exact window where a
   *  `useLayoutEffect`-published store settles (verified against a toy
   *  two-component external-store harness) but a `useEffect`-published one
   *  has not yet, when act-environment is off. Keep this outside `act`: the
   *  finding deliberately exercises React's normal asynchronous scheduling. */
  async function tickOneMacrotask(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(16);
  }

  // Finding 1's "row mounting in the stale window" sub-case was investigated
  // specifically for a row that mounts because `messages` GROWS (a new
  // message arrives) in the same update as a highlight change. Empirically
  // (verified with fine-grained per-tick polling, both against this fix and
  // against a reverted `useEffect` mutation), LegendList's OWN settling work
  // for a newly-added data item takes at least one macrotask regardless of
  // which effect type publishes the highlight - by the time the new row's
  // component renders for the first time, the store has already settled
  // either way, so that specific construction cannot discriminate the two
  // implementations in this component. The setter-direction pin below
  // exercises the same underlying mechanism (a real, non-`rerender`-routed
  // update publishing a NEW highlight id) on already-mounted rows, which the
  // clear-direction pin right after it confirms DOES discriminate.
  it("(finding 1) setting a highlight via a real update settles within one macrotask - no stale un-highlighted paint", async () => {
    const messages = makeMessages(3);
    let setters: HighlightTimingSetters | null = null;

    const { container } = render(
      <HighlightTimingHarness
        initialMessages={messages}
        initialHighlight={null}
        onExposeSetters={(s) => {
          setters = s;
        }}
      />,
    );

    await settleLegendList();
    await waitFor(() => {
      expect(mountedMessageRows(container).length).toBe(3);
    });
    expect(highlightedRowIds(container)).toEqual([]);

    await withActEnvironmentDisabled(async () => {
      // Mirrors the external-jump activation shape: a plain setState call,
      // not a Testing-Library `rerender`.
      setters?.setHighlight("message-1");
      await tickOneMacrotask();
    });

    expect(highlightedRowIds(container)).toEqual(["message-1"]);
    const highlightedRow = container.querySelector(
      '[data-message-id="message-1"]',
    );
    expect(rowHasHighlightRing(highlightedRow)).toBe(true);
  });

  it("(finding 1) clearing the highlight via a real update settles within one macrotask - no stale painted ring", async () => {
    const messages = makeMessages(3);
    let setters: HighlightTimingSetters | null = null;

    const { container } = render(
      <HighlightTimingHarness
        initialMessages={messages}
        initialHighlight="message-1"
        onExposeSetters={(s) => {
          setters = s;
        }}
      />,
    );

    await settleLegendList();
    await waitFor(() => {
      expect(mountedMessageRows(container).length).toBe(3);
    });
    expect(highlightedRowIds(container)).toEqual(["message-1"]);

    await withActEnvironmentDisabled(async () => {
      // Mirrors the 3s-timeout / real-gesture clear shape: a plain setState
      // call, not a Testing-Library `rerender`.
      setters?.setHighlight(null);
      await tickOneMacrotask();
    });

    expect(highlightedRowIds(container)).toEqual([]);
    const previouslyHighlighted = container.querySelector(
      '[data-message-id="message-1"]',
    );
    expect(rowHasHighlightRing(previouslyHighlighted)).toBe(false);
  });

  it("sets data-navigation-highlighted and the ring className only on the highlighted row", async () => {
    const messageCount = 6;
    const messages = makeMessages(messageCount);

    const { container, rerenderMessages } = renderTimeline({
      messages,
      navigationHighlightedMessageId: null,
    });

    await settleLegendList();
    await waitFor(() => {
      expect(mountedMessageRows(container).length).toBe(messageCount);
    });

    // No highlight: attribute absent on every mounted row, ring classes absent.
    expect(highlightedRowIds(container)).toEqual([]);
    for (const id of messages.map((m) => m.id)) {
      const row = container.querySelector(`[data-message-id="${id}"]`);
      expect(row).not.toBeNull();
      expect(row?.getAttribute("data-navigation-highlighted")).toBeNull();
      expect(rowHasHighlightRing(row)).toBe(false);
    }

    rerenderMessages(messages, "message-2");
    await flushFrame();

    expect(highlightedRowIds(container)).toEqual(["message-2"]);
    const highlighted = container.querySelector(
      '[data-message-id="message-2"]',
    );
    expect(highlighted?.getAttribute("data-navigation-highlighted")).toBe(
      "true",
    );
    expect(rowHasHighlightRing(highlighted)).toBe(true);

    for (const id of messages
      .map((m) => m.id)
      .filter((id) => id !== "message-2")) {
      const row = container.querySelector(`[data-message-id="${id}"]`);
      expect(row?.getAttribute("data-navigation-highlighted")).toBeNull();
      expect(rowHasHighlightRing(row)).toBe(false);
    }

    // Move highlight: previous loses attribute + ring; new gains both.
    rerenderMessages(messages, "message-4");
    await flushFrame();

    expect(highlightedRowIds(container)).toEqual(["message-4"]);
    expect(
      container
        .querySelector('[data-message-id="message-2"]')
        ?.getAttribute("data-navigation-highlighted"),
    ).toBeNull();
    expect(
      rowHasHighlightRing(
        container.querySelector('[data-message-id="message-2"]'),
      ),
    ).toBe(false);
    expect(
      container
        .querySelector('[data-message-id="message-4"]')
        ?.getAttribute("data-navigation-highlighted"),
    ).toBe("true");
    expect(
      rowHasHighlightRing(
        container.querySelector('[data-message-id="message-4"]'),
      ),
    ).toBe(true);
  });

  it("does not throw or highlight any row when navigationHighlightedMessageId is a stale/missing id", async () => {
    const messageCount = 5;
    const messages = makeMessages(messageCount);

    const { container, rerenderMessages } = renderTimeline({
      messages,
      navigationHighlightedMessageId: null,
    });

    await settleLegendList();
    await waitFor(() => {
      expect(mountedMessageRows(container).length).toBe(messageCount);
    });

    expect(() => {
      rerenderMessages(messages, "message-not-in-list");
    }).not.toThrow();
    await flushFrame();

    expect(highlightedRowIds(container)).toEqual([]);
    for (const id of messages.map((m) => m.id)) {
      const row = container.querySelector(`[data-message-id="${id}"]`);
      expect(row?.getAttribute("data-navigation-highlighted")).toBeNull();
      expect(rowHasHighlightRing(row)).toBe(false);
    }

    // Still healthy after a real highlight: stale id must clear any prior ring.
    rerenderMessages(messages, "message-1");
    await flushFrame();
    expect(highlightedRowIds(container)).toEqual(["message-1"]);

    expect(() => {
      rerenderMessages(messages, "message-removed-earlier");
    }).not.toThrow();
    await flushFrame();
    expect(highlightedRowIds(container)).toEqual([]);
  });

  it("scopes navigation-highlight state per ChatTimeline mount, not module-wide", async () => {
    const messagesA = makeMessages(4);
    const messagesB = makeMessages(4).map((m, index) => ({
      ...m,
      // Distinct ids so the two lists do not collide in the shared render probe.
      id: `b-message-${index}`,
      content: `B user message ${index}`,
    }));

    const timelineA = renderTimeline({
      messages: messagesA,
      navigationHighlightedMessageId: null,
      "data-testid": "timeline-a",
    });
    const timelineB = renderTimeline({
      messages: messagesB,
      navigationHighlightedMessageId: null,
      "data-testid": "timeline-b",
    });

    await settleLegendList();
    await waitFor(() => {
      expect(mountedMessageRows(timelineA.container).length).toBe(4);
      expect(mountedMessageRows(timelineB.container).length).toBe(4);
    });

    // Highlight only A: B must stay completely unhighlighted and not throw.
    expect(() => {
      timelineA.rerenderMessages(messagesA, "message-1");
    }).not.toThrow();
    await flushFrame();

    expect(highlightedRowIds(timelineA.container)).toEqual(["message-1"]);
    expect(highlightedRowIds(timelineB.container)).toEqual([]);
    expect(
      rowHasHighlightRing(
        timelineB.container.querySelector('[data-message-id="b-message-1"]'),
      ),
    ).toBe(false);

    // Highlight only B to a different row: A keeps its own highlight.
    expect(() => {
      timelineB.rerenderMessages(messagesB, "b-message-2");
    }).not.toThrow();
    await flushFrame();

    expect(highlightedRowIds(timelineA.container)).toEqual(["message-1"]);
    expect(highlightedRowIds(timelineB.container)).toEqual(["b-message-2"]);

    // Clear A: B's highlight is untouched.
    timelineA.rerenderMessages(messagesA, null);
    await flushFrame();
    expect(highlightedRowIds(timelineA.container)).toEqual([]);
    expect(highlightedRowIds(timelineB.container)).toEqual(["b-message-2"]);
  });

  it("rapid sequential highlight moves still re-render only the previous and next rows each step", async () => {
    const messageCount = 8;
    const messages = makeMessages(messageCount);
    const sequence = [
      "message-0",
      "message-2",
      "message-5",
      "message-7",
      "message-1",
    ] as const;

    const { container, rerenderMessages } = renderTimeline({
      messages,
      navigationHighlightedMessageId: null,
    });

    await settleLegendList();
    await waitFor(() => {
      expect(mountedMessageRows(container).length).toBe(messageCount);
    });

    let previousHighlight: string | null = null;
    for (const nextId of sequence) {
      const before = snapshotRenderCounts(messages);
      rerenderMessages(messages, nextId);
      await flushFrame();

      const expected =
        previousHighlight === null ? [nextId] : [previousHighlight, nextId];
      expect(new Set(renderedSince(messages, before))).toEqual(
        new Set(expected),
      );
      expect(highlightedRowIds(container)).toEqual([nextId]);
      previousHighlight = nextId;
    }
  });

  it("does not re-invoke getMessageActions for unrelated rows when only the highlight changes", async () => {
    const messageCount = 6;
    const messages = makeMessages(messageCount);
    const getMessageActions = vi.fn(
      (_message: ChatMessageModel): ChatMessageActions | null => null,
    );

    const { container, rerenderMessages } = renderTimeline({
      messages,
      getMessageActions,
      navigationHighlightedMessageId: null,
    });

    await settleLegendList();
    await waitFor(() => {
      expect(mountedMessageRows(container).length).toBe(messageCount);
    });

    function callCountByMessageId(): Map<string, number> {
      const counts = new Map<string, number>();
      for (const call of getMessageActions.mock.calls) {
        const id = call[0].id;
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      return counts;
    }

    // Mount settled: every row has been rendered at least once through the
    // shared-context path (getMessageActions is invoked from ChatTimelineRow
    // during render). Snapshot those counts before the highlight-only prop
    // change so we can prove unrelated rows do not re-enter that path.
    const baselineCalls = callCountByMessageId();
    for (const message of messages) {
      expect(baselineCalls.get(message.id) ?? 0).toBeGreaterThan(0);
    }
    getMessageActions.mockClear();

    // Same messages array reference; only the highlight prop changes. The
    // ChatTimelineRowCtx object must stay identity-stable (store is
    // useState-stable), so non-highlighted rows must not re-render and
    // therefore must not re-invoke getMessageActions.
    rerenderMessages(messages, "message-3");
    await flushFrame();

    const afterFirstMove = callCountByMessageId();
    expect(afterFirstMove.get("message-3") ?? 0).toBeGreaterThan(0);
    for (const message of messages) {
      if (message.id === "message-3") continue;
      expect(afterFirstMove.get(message.id) ?? 0).toBe(0);
    }

    getMessageActions.mockClear();
    rerenderMessages(messages, "message-0");
    await flushFrame();

    const afterSecondMove = callCountByMessageId();
    // Old + new highlighted rows re-render; everyone else stays quiet.
    expect(afterSecondMove.get("message-3") ?? 0).toBeGreaterThan(0);
    expect(afterSecondMove.get("message-0") ?? 0).toBeGreaterThan(0);
    for (const message of messages) {
      if (message.id === "message-3" || message.id === "message-0") continue;
      expect(afterSecondMove.get(message.id) ?? 0).toBe(0);
    }
  });

  it("unmounts cleanly while a navigation highlight is active", async () => {
    const messages = makeMessages(4);
    const { container, unmount, rerenderMessages } = renderTimeline({
      messages,
      navigationHighlightedMessageId: null,
    });

    await settleLegendList();
    await waitFor(() => {
      expect(mountedMessageRows(container).length).toBe(4);
    });

    rerenderMessages(messages, "message-2");
    await flushFrame();
    expect(highlightedRowIds(container)).toEqual(["message-2"]);

    // Defensive: unmount with an active store subscription must not throw,
    // and post-unmount work must remain safe (no listener fire crash).
    expect(() => {
      unmount();
    }).not.toThrow();

    expect(mountedMessageRows(container).length).toBe(0);
    expect(() => {
      // After unmount the store is unreachable from React; this only asserts
      // the unmount itself left the test environment intact for subsequent
      // mounts (covered by later tests / afterEach cleanup).
      renderTimeline({
        messages,
        navigationHighlightedMessageId: "message-0",
      });
    }).not.toThrow();
  });

  describe("panel-resize freeze (ticket 23 D20 port)", () => {
    const PANEL_RESIZING_CLASS = "traycer-panel-resizing";

    afterEach(() => {
      // Defensive: a test that throws before its own stop() must not leak
      // the class/markers into a later test.
      document.documentElement.classList.remove(PANEL_RESIZING_CLASS);
    });

    it("every row carries the marker-scoped freeze selector targeting only unmarked rows", async () => {
      const messages = [makeMessage(0, "user")];
      const { container } = renderTimeline({ messages });
      await settleLegendList();
      await waitFor(() => {
        expect(mountedMessageRows(container).length).toBe(1);
      });

      const row = container.querySelector<HTMLElement>(
        '[data-message-id="message-0"]',
      );
      expect(row?.className).toContain(
        "[.traycer-panel-resizing_&:not([data-panel-resize-visible])]:[content-visibility:hidden]",
      );
    });

    it("marks exactly the geometrically visible rows at drag start and clears every marker at drag end", async () => {
      const messages = [
        makeMessage(0, "user"),
        makeMessage(1, "assistant"),
        makeMessage(2, "user"),
      ];
      const { container, listRef } = renderTimeline({ messages });
      await settleLegendList();
      await waitFor(() => {
        expect(mountedMessageRows(container).length).toBe(messages.length);
      });

      const scrollNode = listRef.current?.getScrollableNode();
      if (!scrollNode) throw new Error("scroll node not mounted");
      // Viewport 0..300; row 0 fully inside, row 1 straddles the bottom
      // edge (counts as visible), row 2 fully below.
      scrollNode.getBoundingClientRect = () => rectOf(0, 300);
      const row0 = container.querySelector<HTMLElement>(
        '[data-message-id="message-0"]',
      );
      const row1 = container.querySelector<HTMLElement>(
        '[data-message-id="message-1"]',
      );
      const row2 = container.querySelector<HTMLElement>(
        '[data-message-id="message-2"]',
      );
      if (!row0 || !row1 || !row2) throw new Error("rows not found");
      row0.getBoundingClientRect = () => rectOf(0, 100);
      row1.getBoundingClientRect = () => rectOf(250, 100);
      row2.getBoundingClientRect = () => rectOf(1000, 100);

      const stop = beginPanelResizeInteraction(1, () => undefined);

      expect(
        document.documentElement.classList.contains(PANEL_RESIZING_CLASS),
      ).toBe(true);
      expect(row0.getAttribute(PANEL_RESIZE_VISIBLE_ROW_ATTRIBUTE)).toBe(
        "true",
      );
      expect(row1.getAttribute(PANEL_RESIZE_VISIBLE_ROW_ATTRIBUTE)).toBe(
        "true",
      );
      expect(row2.hasAttribute(PANEL_RESIZE_VISIBLE_ROW_ATTRIBUTE)).toBe(false);

      stop();

      expect(
        document.documentElement.classList.contains(PANEL_RESIZING_CLASS),
      ).toBe(false);
      expect(row0.hasAttribute(PANEL_RESIZE_VISIBLE_ROW_ATTRIBUTE)).toBe(false);
      expect(row1.hasAttribute(PANEL_RESIZE_VISIBLE_ROW_ATTRIBUTE)).toBe(false);
      expect(row2.hasAttribute(PANEL_RESIZE_VISIBLE_ROW_ATTRIBUTE)).toBe(false);
    });

    it("clears this timeline's own markers on unmount, even mid-drag", async () => {
      const messages = [makeMessage(0, "user"), makeMessage(1, "assistant")];
      const { container, listRef, unmount } = renderTimeline({ messages });
      await settleLegendList();
      await waitFor(() => {
        expect(mountedMessageRows(container).length).toBe(messages.length);
      });

      const scrollNode = listRef.current?.getScrollableNode();
      if (!scrollNode) throw new Error("scroll node not mounted");
      scrollNode.getBoundingClientRect = () => rectOf(0, 300);
      const row = container.querySelector<HTMLElement>(
        '[data-message-id="message-0"]',
      );
      if (!row) throw new Error("row not found");
      row.getBoundingClientRect = () => rectOf(0, 100);

      const stop = beginPanelResizeInteraction(1, () => undefined);
      expect(row.getAttribute(PANEL_RESIZE_VISIBLE_ROW_ATTRIBUTE)).toBe("true");

      expect(() => {
        unmount();
      }).not.toThrow();

      expect(row.hasAttribute(PANEL_RESIZE_VISIBLE_ROW_ATTRIBUTE)).toBe(false);

      // The now-unregistered participant must not be invoked (and must not
      // throw) when the drag ends afterward.
      expect(() => {
        stop();
      }).not.toThrow();
    });

    it("registers a fresh timeline as a NEW participant across remounts (no stale registration)", async () => {
      const messages = [makeMessage(0, "user")];
      const first = renderTimeline({ messages });
      await settleLegendList();
      await waitFor(() => {
        expect(mountedMessageRows(first.container).length).toBe(1);
      });
      first.unmount();

      const second = renderTimeline({ messages });
      await settleLegendList();
      await waitFor(() => {
        expect(mountedMessageRows(second.container).length).toBe(1);
      });

      const scrollNode = second.listRef.current?.getScrollableNode();
      if (!scrollNode) throw new Error("scroll node not mounted");
      scrollNode.getBoundingClientRect = () => rectOf(0, 300);
      const row = second.container.querySelector<HTMLElement>(
        '[data-message-id="message-0"]',
      );
      if (!row) throw new Error("row not found");
      row.getBoundingClientRect = () => rectOf(0, 100);

      const stop = beginPanelResizeInteraction(1, () => undefined);
      // Only ONE capture ran for the currently-mounted timeline - the first
      // (unmounted) instance's participant was unregistered, not left
      // dangling to double-mark or throw against detached DOM.
      expect(row.getAttribute(PANEL_RESIZE_VISIBLE_ROW_ATTRIBUTE)).toBe("true");
      stop();
    });
  });
});

describe("ChatTimeline LegendList strict-edge policy config", () => {
  beforeEach(() => {
    legendListPolicyProps.last = null;
    installLegendListViewportMetrics();
  });

  afterEach(() => {
    cleanup();
  });

  it("pins maintainScrollAtEndThreshold=0, MVCP maintenance, and the library's own maintainScrollAtEnd permanently disabled", async () => {
    // Fixup (callback-synchronous-follow): the library's own
    // `maintainScrollAtEnd` is NEVER passed at all anymore - not even
    // conditionally - since every one of its call sites (data/item/footer/
    // layout) already no-ops when this prop is falsy. Bottom-follow is
    // reimplemented in `chat-timeline-follow-latch.ts` and driven
    // imperatively; see that module's own real-LegendList integration
    // coverage for the actual follow/detach behavior this enables.
    renderTimeline({ messages: makeMessages(6) });
    await settleLegendList();
    expect(legendListPolicyProps.last).not.toBeNull();
    expect(legendListPolicyProps.last?.maintainScrollAtEndThreshold).toBe(0);
    // MVCP's size channel is unconditional; the data channel rides the key
    // sequence and is off for a settled transcript - see the prop's own
    // comment, and the two cases below for each arm.
    expect(legendListPolicyProps.last?.maintainVisibleContentPosition).toEqual({
      data: false,
      size: true,
    });
    expect(legendListPolicyProps.last?.maintainScrollAtEnd).toBeUndefined();
  });

  it("keeps the MVCP data channel off while a streaming row changes in place", async () => {
    const messages = makeMessages(6);
    const { rerenderMessages } = renderTimeline({ messages });
    await settleLegendList();

    // A token: same rows in the same order, one row's content replaced. Fresh
    // objects throughout, which is what the store hands over on every update.
    const streamed = messages.map((message, index) =>
      index === messages.length - 1
        ? { ...message, content: `${message.content} more` }
        : { ...message },
    );
    act(() => {
      rerenderMessages(streamed, undefined);
    });

    expect(legendListPolicyProps.last?.maintainVisibleContentPosition).toEqual({
      data: false,
      size: true,
    });
  });

  it("turns the MVCP data channel on for the commit that changes the key sequence", async () => {
    const messages = makeMessages(6);
    const { rerenderMessages } = renderTimeline({ messages });
    await settleLegendList();

    // A row above the tail disappears - the shape a settled-row deletion, a
    // steer nesting into its assistant turn, or a moved setup card produces.
    const withRowRemoved = messages.filter((_, index) => index !== 1);
    act(() => {
      rerenderMessages(withRowRemoved, undefined);
    });

    expect(legendListPolicyProps.last?.maintainVisibleContentPosition).toEqual({
      data: true,
      size: true,
    });
  });

  it("retires the data channel once the moved sequence has been rendered", async () => {
    const messages = makeMessages(6);
    const { rerenderMessages } = renderTimeline({ messages });
    await settleLegendList();

    const withRowRemoved = messages.filter((_, index) => index !== 1);
    act(() => {
      rerenderMessages(withRowRemoved, undefined);
    });
    expect(legendListPolicyProps.last?.maintainVisibleContentPosition).toEqual({
      data: true,
      size: true,
    });

    // A token on top of the new sequence. The baseline advanced when the
    // removal COMMITTED, so this is content-only and needs no anchor.
    const streamed = withRowRemoved.map((message, index) =>
      index === withRowRemoved.length - 1
        ? { ...message, content: `${message.content} more` }
        : { ...message },
    );
    act(() => {
      rerenderMessages(streamed, undefined);
    });

    expect(legendListPolicyProps.last?.maintainVisibleContentPosition).toEqual({
      data: false,
      size: true,
    });
  });
});
