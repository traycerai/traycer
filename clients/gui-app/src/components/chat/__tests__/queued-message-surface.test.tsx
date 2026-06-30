import "../../../../__tests__/test-browser-apis";

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatQueuedItem,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { buildQueuedMessageOrderKey } from "@/components/chat/queued-message-reorder-dnd";
import { QueuedMessagePanel } from "@/components/chat/queued-message-surface";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ChatSessionState } from "@/stores/chats/chat-session-store";
import { optimisticQueuedItemId } from "@/stores/chats/optimistic-queue";

interface TestDndEvent {
  readonly active: {
    readonly data: { readonly current: unknown };
  };
  readonly over: {
    readonly data: { readonly current: unknown };
    readonly rect: { readonly top: number; readonly height: number };
  } | null;
}

type TestDndHandler = (event: TestDndEvent) => void;

interface TestCollisionArgs {
  readonly pointerCoordinates: {
    readonly x: number;
    readonly y: number;
  } | null;
}

interface TestTransform {
  readonly x: number;
  readonly y: number;
  readonly scaleX: number;
  readonly scaleY: number;
}

interface TestClientRect {
  readonly width: number;
  readonly height: number;
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

type TestDndModifier = (args: {
  readonly activatorEvent: Event | null;
  readonly active: null;
  readonly activeNodeRect: TestClientRect | null;
  readonly draggingNodeRect: TestClientRect | null;
  readonly containerNodeRect: TestClientRect | null;
  readonly over: null;
  readonly overlayNodeRect: TestClientRect | null;
  readonly scrollableAncestors: ReadonlyArray<Element>;
  readonly scrollableAncestorRects: ReadonlyArray<TestClientRect>;
  readonly transform: TestTransform;
  readonly windowRect: TestClientRect | null;
}) => TestTransform;

interface CapturedDndContextProps {
  readonly children: ReactNode;
  readonly autoScroll: boolean;
  readonly collisionDetection: (args: TestCollisionArgs) => unknown;
  readonly modifiers: ReadonlyArray<TestDndModifier>;
  readonly onDragStart: TestDndHandler;
  readonly onDragMove: TestDndHandler;
  readonly onDragOver: TestDndHandler;
  readonly onDragEnd: TestDndHandler;
}

interface CapturedSortableContextProps {
  readonly children: ReactNode;
}

const testState = vi.hoisted(() => ({
  providerProps: null as CapturedDndContextProps | null,
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: (props: CapturedDndContextProps) => {
    testState.providerProps = props;
    return (
      <div data-testid="queued-message-dnd-provider">{props.children}</div>
    );
  },
  KeyboardSensor: class {},
  PointerSensor: class {},
  closestCenter: () => [],
  useSensor: () => null,
  useSensors: () => [],
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: (props: CapturedSortableContextProps) => (
    <div data-testid="queued-message-sortable-context">{props.children}</div>
  ),
  sortableKeyboardCoordinates: () => null,
  verticalListSortingStrategy: () => [],
  useSortable: () => ({
    setNodeRef: () => null,
    setActivatorNodeRef: () => null,
    attributes: {},
    listeners: {},
    transform: null,
    transition: undefined,
    isDragging: false,
    isOver: false,
  }),
}));

const SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "codex-test",
  permissionMode: "supervised",
  reasoningEffort: "medium",
  serviceTier: null,
  agentMode: "epic",
};

const onAbortSteerSpy = vi.fn();

describe("<QueuedMessagePanel />", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    testState.providerProps = null;
  });

  it("renders drag handles for movable queued rows and removes arrow actions", () => {
    renderPanel({
      queue: queueState([
        queuedItem("queue-1", "First queued prompt", "pending"),
        queuedItem("queue-2", "Second queued prompt", "pending"),
      ]),
      readOnly: false,
      canAct: true,
      onReorder: null,
    });

    expect(screen.getAllByTestId("queued-message-row")).toHaveLength(2);
    expect(screen.getAllByTestId("queued-message-drag-handle")).toHaveLength(2);
    expect(
      screen.queryByRole("button", { name: "Move queued message up" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Move queued message down" }),
    ).toBeNull();
  });

  it("renders the drag handle disabled when only one queued row is visible", () => {
    renderPanel({
      queue: queueState([queuedItem("queue-1", "Only prompt", "pending")]),
      readOnly: false,
      canAct: true,
      onReorder: null,
    });

    expect(screen.getAllByTestId("queued-message-row")).toHaveLength(1);
    const handle = screen.getByTestId("queued-message-drag-handle");
    expect(handle.getAttribute("data-disabled")).toBe("true");
    expect(handle.tagName).toBe("SPAN");
    expect(
      screen.queryByRole("button", { name: "Drag to reorder queued message" }),
    ).toBeNull();
  });

  it("collapses and expands queued rows from the header", () => {
    renderPanel({
      queue: queueState([
        queuedItem("queue-1", "First queued prompt", "pending"),
        queuedItem("queue-2", "Second queued prompt", "pending"),
      ]),
      readOnly: false,
      canAct: true,
      onReorder: null,
    });

    expect(screen.getByTestId("queued-message-list")).not.toBeNull();

    fireEvent.click(screen.getByTestId("queued-message-header-toggle"));
    expect(screen.queryByTestId("queued-message-list")).toBeNull();

    fireEvent.click(screen.getByTestId("queued-message-header-toggle"));
    expect(screen.getByTestId("queued-message-list")).not.toBeNull();
  });

  it("matches pinned section card chrome and header ordering", () => {
    renderPanel({
      queue: runningQueueState([
        queuedItem("queue-1", "First queued prompt", "pending"),
        queuedItem("queue-2", "Second queued prompt", "pending"),
      ]),
      readOnly: false,
      canAct: true,
      onReorder: null,
    });

    const panel = screen.getByTestId("queued-message-rows");
    const header = screen.getByTestId("queued-message-header");
    const toggle = screen.getByTestId("queued-message-header-toggle");
    const runningDot = screen.getByLabelText("Queue running");
    const title = screen.getByText("Message Queue");
    const divider = screen.getByTestId("queued-message-header-divider");
    const statusIcon = screen.getByTestId("queued-message-header-status-icon");
    const count = screen.getByText("2 messages");

    expect(panel.className).toContain("bg-muted/30");
    expect(header.className).toContain("items-stretch");
    expect(header.className).not.toContain("border-b");
    expect(toggle.className).toContain("hover:bg-muted/50");
    expect(screen.queryByText("Queue running")).toBeNull();
    expect(
      runningDot.compareDocumentPosition(title) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      title.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      divider.compareDocumentPosition(statusIcon) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      statusIcon.compareDocumentPosition(count) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps row actions in a sticky glass corner", () => {
    renderPanel({
      queue: queueState([
        queuedItem("queue-1", "First queued prompt", "pending"),
        queuedItem("queue-2", "Second queued prompt", "pending"),
      ]),
      readOnly: false,
      canAct: true,
      onReorder: null,
    });

    expect(
      screen.getAllByRole("button", { name: "Steer queued message now" }),
    ).toHaveLength(2);
    expect(screen.queryByText(/After current turn/)).toBeNull();

    const firstRow = screen.getAllByTestId("queued-message-row")[0];
    const rowButtons = within(firstRow).getAllByRole("button");
    expect(
      rowButtons.map((button) => button.getAttribute("aria-label")),
    ).toEqual([
      "Drag to reorder queued message",
      "Edit queued message",
      "Delete queued message",
      "Steer queued message now",
    ]);

    const toolbar = within(firstRow).getByTestId("queued-message-row-toolbar");
    expect(toolbar.className).toContain("sticky");
    expect(toolbar.className).toContain("top-0");
    expect(toolbar.className).toContain("float-right");
    expect(toolbar.className).toContain("backdrop-blur");

    const editButton = within(firstRow).getByRole("button", {
      name: "Edit queued message",
    });
    const revealSlot = editButton.parentElement;
    expect(revealSlot?.className).not.toContain("absolute");
    expect(revealSlot?.className).not.toContain("opacity-0");
  });

  it("places locked row status in the sticky row chrome", () => {
    renderPanel({
      queue: queueState([
        queuedItem("queue-1", "Frozen steering prompt", "steer_requested"),
      ]),
      readOnly: false,
      canAct: true,
      onReorder: null,
    });

    const row = screen.getByTestId("queued-message-row");
    expect(
      within(row).queryByRole("button", { name: "Edit queued message" }),
    ).toBeNull();

    const toolbar = within(row).getByTestId("queued-message-row-toolbar");
    expect(toolbar.className).toContain("sticky");
    expect(toolbar.className).toContain("float-right");
    expect(toolbar.className).not.toContain("border-border/60");
    expect(toolbar.className).not.toContain("shadow-lg");
    expect(within(toolbar).getByText("Waiting for steer")).not.toBeNull();
  });

  it("offers an un-stage control for a safe-point steer still waiting", () => {
    const waiting: ChatQueuedItem = {
      ...queuedItem("queue-1", "Waiting prompt", "steer_requested"),
      delivery: "same_turn",
      targetTurnId: "turn-1",
      steerRequest: {
        mode: "safe_point",
        targetTurnId: "turn-1",
        requestedAt: 1,
      },
    };
    renderPanel({
      queue: runningQueueState([waiting]),
      readOnly: false,
      canAct: true,
      onReorder: null,
    });

    const row = screen.getByTestId("queued-message-row");
    // The full edit/steer toolbar stays hidden while steer-locked...
    expect(
      within(row).queryByRole("button", { name: "Edit queued message" }),
    ).toBeNull();
    // ...but a single revert affordance is now offered.
    const abort = within(row).getByRole("button", { name: "Cancel steer" });
    fireEvent.click(abort);
    expect(onAbortSteerSpy).toHaveBeenCalledTimes(1);
    expect(onAbortSteerSpy.mock.calls[0]?.[0]).toMatchObject({
      queueItemId: "queue-1",
    });
  });

  it("hides the un-stage control for an interrupt-restart steer", () => {
    const restarting: ChatQueuedItem = {
      ...queuedItem("queue-1", "Restart prompt", "steer_requested"),
      targetTurnId: "turn-1",
      steerRequest: {
        mode: "interrupt_restart",
        targetTurnId: "turn-1",
        requestedAt: 1,
      },
    };
    renderPanel({
      queue: runningQueueState([restarting]),
      readOnly: false,
      canAct: true,
      onReorder: null,
    });

    const row = screen.getByTestId("queued-message-row");
    expect(
      within(row).queryByRole("button", { name: "Cancel steer" }),
    ).toBeNull();
    const toolbar = within(row).getByTestId("queued-message-row-toolbar");
    expect(within(toolbar).getByText("Restart pending")).not.toBeNull();
  });

  it("caps each queued prompt preview at three text lines", () => {
    renderPanel({
      queue: queueState([
        queuedItem(
          "queue-1",
          "First queued prompt\nSecond queued prompt\nThird queued prompt\nFourth queued prompt",
          "pending",
        ),
      ]),
      readOnly: false,
      canAct: true,
      onReorder: null,
    });

    const content = within(
      screen.getByTestId("queued-message-row"),
    ).getByTestId("queued-message-content-scroll");
    expect(content.className).toContain("max-h-[3lh]");
    expect(content.className).toContain("overflow-y-auto");
  });

  it("preserves ordered-list structure in queued prompt previews", () => {
    renderPanel({
      queue: queueState([
        {
          ...queuedItem("queue-1", "ignored", "pending"),
          message: {
            kind: "user",
            content: orderedListContent(["First step", "Second step"]),
          },
        },
      ]),
      readOnly: false,
      canAct: true,
      onReorder: null,
    });

    const preview = screen.getByTestId("queued-message-content-preview");
    const orderedList = within(preview).getByRole("list");
    expect(orderedList.tagName).toBe("OL");
    expect(preview.className).not.toContain("[&_ol]:inline");
    expect(within(orderedList).getByText("First step")).not.toBeNull();
    expect(within(orderedList).getByText("Second step")).not.toBeNull();
  });

  it("keeps steer-locked rows visible but frozen", () => {
    renderPanel({
      queue: queueState([
        queuedItem("queue-1", "First queued prompt", "pending"),
        queuedItem("queue-2", "Frozen steering prompt", "steer_requested"),
        queuedItem("queue-3", "Third queued prompt", "pending"),
      ]),
      readOnly: false,
      canAct: true,
      onReorder: null,
    });

    expect(screen.getAllByTestId("queued-message-row")).toHaveLength(3);
    expect(screen.getAllByTestId("queued-message-drag-handle")).toHaveLength(3);
    expect(screen.getByText("Frozen steering prompt")).not.toBeNull();
    expect(screen.getByText("Waiting for steer")).not.toBeNull();

    const frozenRow = screen.getAllByTestId("queued-message-row")[1];
    expect(within(frozenRow).queryByRole("button")).toBeNull();
    const frozenHandle = within(frozenRow).getByTestId(
      "queued-message-drag-handle",
    );
    expect(frozenHandle.getAttribute("data-disabled")).toBe("true");
  });

  it("renders optimistic queued sends as locked queuing rows", () => {
    renderPanel({
      queue: queueState([
        queuedItem(
          optimisticQueuedItemId("action-1"),
          "Attachment prompt",
          "pending",
        ),
      ]),
      readOnly: false,
      canAct: true,
      onReorder: null,
    });

    expect(screen.getAllByTestId("queued-message-row")).toHaveLength(1);
    expect(screen.getByText("Attachment prompt")).not.toBeNull();
    expect(screen.getByText("Queuing")).not.toBeNull();
    expect(
      within(screen.getByTestId("queued-message-row")).queryByRole("button"),
    ).toBeNull();
    expect(
      screen
        .getByTestId("queued-message-drag-handle")
        .getAttribute("data-disabled"),
    ).toBe("true");
  });

  it("does not render drag handles or owner actions in read-only mode", () => {
    renderPanel({
      queue: queueState([
        queuedItem("queue-1", "First queued prompt", "pending"),
        queuedItem("queue-2", "Second queued prompt", "pending"),
      ]),
      readOnly: true,
      canAct: false,
      onReorder: null,
    });

    expect(screen.queryByTestId("queued-message-drag-handle")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Edit queued message" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Delete queued message" }),
    ).toBeNull();
  });

  it("commits a dropped reorder through the queueReorder contract once", () => {
    const first = queuedItem("queue-1", "First queued prompt", "pending");
    const second = queuedItem("queue-2", "Second queued prompt", "pending");
    const onReorder = vi.fn();
    renderPanel({
      queue: queueState([first, second]),
      readOnly: false,
      canAct: true,
      onReorder,
    });

    const provider = testState.providerProps;
    expect(provider).not.toBeNull();
    if (provider === null) return;

    const orderKey = buildQueuedMessageOrderKey(["queue-1", "queue-2"]);

    act(() => {
      provider.onDragStart(
        makeDndEvent({
          sourceData: queuedDndData("queue-2", 1, orderKey),
          target: null,
        }),
      );
      // The drop math reads the pointer from the collision pass (the same
      // point that picked `over`), never from activatorEvent + delta.
      provider.collisionDetection({ pointerCoordinates: { x: 0, y: 101 } });
      provider.onDragEnd(
        makeDndEvent({
          sourceData: queuedDndData("queue-2", 1, orderKey),
          target: {
            data: queuedDndData("queue-1", 0, orderKey),
            top: 100,
            height: 40,
          },
        }),
      );
    });

    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith(second, "queue-1");
  });

  it("contains queue drags inside the queue scroll region without edge auto-scroll", () => {
    renderPanel({
      queue: queueState([
        queuedItem("queue-1", "First queued prompt", "pending"),
        queuedItem("queue-2", "Second queued prompt", "pending"),
      ]),
      readOnly: false,
      canAct: true,
      onReorder: null,
    });

    const provider = testState.providerProps;
    expect(provider).not.toBeNull();
    if (provider === null) return;

    expect(provider.autoScroll).toBe(false);
    expect(provider.modifiers).toHaveLength(1);

    const [modifier] = provider.modifiers;
    const sourceRect = makeClientRect({
      top: 100,
      left: 20,
      width: 300,
      height: 40,
    });
    const scrollRegionRect = makeClientRect({
      top: 120,
      left: 10,
      width: 320,
      height: 120,
    });

    expect(
      modifier(
        makeModifierArgs({
          transform: { x: -40, y: -120, scaleX: 1, scaleY: 1 },
          draggingNodeRect: sourceRect,
          scrollableAncestorRects: [scrollRegionRect],
        }),
      ),
    ).toEqual({ x: -10, y: 20, scaleX: 1, scaleY: 1 });

    expect(
      modifier(
        makeModifierArgs({
          transform: { x: 40, y: 200, scaleX: 1, scaleY: 1 },
          draggingNodeRect: sourceRect,
          scrollableAncestorRects: [scrollRegionRect],
        }),
      ),
    ).toEqual({ x: 10, y: 100, scaleX: 1, scaleY: 1 });
  });

  it("renders received A2A items as read-only rows with a sender badge", () => {
    renderPanel({
      queue: queueState([
        queuedItem("queue-user", "User prompt", "pending"),
        agentQueuedItem("queue-agent", "Agent response"),
      ]),
      readOnly: false,
      canAct: true,
      onReorder: null,
    });

    // Both the user-typed and the received A2A item render rows now.
    expect(screen.getAllByTestId("queued-message-row")).toHaveLength(2);
    expect(screen.getByText("Agent response")).not.toBeNull();

    const agentRow = screen.getAllByTestId("queued-message-row")[1];
    // The received row carries no owner actions...
    expect(
      within(agentRow).queryByRole("button", { name: "Edit queued message" }),
    ).toBeNull();
    expect(
      within(agentRow).queryByRole("button", { name: "Delete queued message" }),
    ).toBeNull();
    expect(
      within(agentRow).queryByRole("button", {
        name: "Steer queued message now",
      }),
    ).toBeNull();
    // ...but it is labelled as received and can still be reordered.
    expect(
      within(agentRow).getByTitle(/Response received from/),
    ).not.toBeNull();
    expect(
      within(agentRow).getByTestId("queued-message-drag-handle"),
    ).not.toBeNull();
  });

  it("renders received A2A items even when the queue holds only A2A items", () => {
    renderPanel({
      queue: queueState([agentQueuedItem("queue-agent", "Agent response")]),
      readOnly: false,
      canAct: true,
      onReorder: null,
    });

    expect(screen.getAllByTestId("queued-message-row")).toHaveLength(1);
    expect(screen.getByText("Agent response")).not.toBeNull();
  });

  it("does not label a received A2A response with the user steer affordance", () => {
    renderPanel({
      queue: queueState([
        {
          ...queuedItem("queue-user", "User follow-up", "pending"),
          delivery: "same_turn",
        },
        agentQueuedItem("queue-agent", "Agent response"),
      ]),
      readOnly: false,
      canAct: true,
      onReorder: null,
    });

    const userRow = screen.getAllByTestId("queued-message-row")[0];
    const agentRow = screen.getAllByTestId("queued-message-row")[1];
    // The user's own same-turn follow-up keeps the "Can steer" affordance...
    expect(within(userRow).getByText("Can steer")).not.toBeNull();
    // ...while the received A2A response is never labelled as user-steerable;
    // it only shows that it will auto-steer in.
    expect(within(agentRow).queryByText("Can steer")).toBeNull();
    expect(within(agentRow).getByText("Will steer")).not.toBeNull();
  });
});

function renderPanel(input: {
  readonly queue: ChatSessionState["queue"];
  readonly readOnly: boolean;
  readonly canAct: boolean;
  readonly onReorder:
    ((item: ChatQueuedItem, beforeQueueItemId: string | null) => void) | null;
}) {
  return render(
    <TooltipProvider delayDuration={0}>
      <QueuedMessagePanel
        queue={input.queue}
        activeTurnStatus="running"
        canAct={input.canAct}
        readOnly={input.readOnly}
        editingQueueItemId={null}
        scrollRegionMaxHeightClass="max-h-96"
        onResume={() => null}
        onEdit={vi.fn()}
        onCancel={vi.fn()}
        onAbortSteer={onAbortSteerSpy}
        onReorder={input.onReorder ?? vi.fn()}
        onSteerNow={vi.fn()}
      />
    </TooltipProvider>,
  );
}

function queueState(
  items: ReadonlyArray<ChatQueuedItem>,
): ChatSessionState["queue"] {
  return { status: "idle", items: [...items] };
}

function runningQueueState(
  items: ReadonlyArray<ChatQueuedItem>,
): ChatSessionState["queue"] {
  return { status: "running", items: [...items] };
}

function queuedItem(
  queueItemId: string,
  text: string,
  status: ChatQueuedItem["status"],
): ChatQueuedItem {
  return {
    queueItemId,
    messageId: `${queueItemId}-message`,
    message: {
      kind: "user",
      content: content(text),
    },
    sender: { type: "user", userId: "owner-1" },
    settings: SETTINGS,
    accountContext: { type: "PERSONAL" as const },
    delivery: "next_turn",
    status,
    targetTurnId: null,
    steerRequest: null,
    fallbackReason: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function agentQueuedItem(queueItemId: string, text: string): ChatQueuedItem {
  return {
    ...queuedItem(queueItemId, text, "pending"),
    sender: {
      type: "agent",
      harnessId: "claude",
      agentId: "agent-1",
      displayName: null,
      reply: { expectsReply: false },
    },
    // Received A2A responses are enqueued as `same_turn` so they steer into the
    // running turn (matches the host delivery path).
    delivery: "same_turn",
  };
}

function content(text: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

function orderedListContent(items: ReadonlyArray<string>): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "orderedList",
        content: items.map((text) => ({
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text }],
            },
          ],
        })),
      },
    ],
  };
}

function queuedDndData(queueItemId: string, index: number, orderKey: string) {
  return {
    kind: "queued-message",
    queueItemId,
    index,
    orderKey,
  };
}

function makeDndEvent(input: {
  readonly sourceData: unknown;
  readonly target: {
    readonly data: unknown;
    readonly top: number;
    readonly height: number;
  } | null;
}): TestDndEvent {
  return {
    active: { data: { current: input.sourceData } },
    over:
      input.target === null
        ? null
        : {
            data: { current: input.target.data },
            rect: { top: input.target.top, height: input.target.height },
          },
  };
}

function makeModifierArgs(input: {
  readonly transform: TestTransform;
  readonly draggingNodeRect: TestClientRect | null;
  readonly scrollableAncestorRects: ReadonlyArray<TestClientRect>;
}) {
  return {
    activatorEvent: null,
    active: null,
    activeNodeRect: null,
    draggingNodeRect: input.draggingNodeRect,
    containerNodeRect: null,
    over: null,
    overlayNodeRect: null,
    scrollableAncestors: [],
    scrollableAncestorRects: input.scrollableAncestorRects,
    transform: input.transform,
    windowRect: null,
  };
}

function makeClientRect(input: {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}): TestClientRect {
  return {
    width: input.width,
    height: input.height,
    top: input.top,
    bottom: input.top + input.height,
    left: input.left,
    right: input.left + input.width,
  };
}
