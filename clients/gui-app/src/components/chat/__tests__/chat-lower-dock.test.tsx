import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  BackgroundItem,
  ChatQueuedItem,
  ChatQueuedPromptItem,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { ChatLowerDock } from "@/components/chat/chat-lower-dock";
import type { AccumulatedFileChange } from "@/lib/chat/accumulated-file-changes-from-messages";
import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import type { PinnedTodoSnapshot } from "@/components/chat/chat-pinned-todos";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ChatSessionState } from "@/stores/chats/chat-session-store";
import type { SegmentTodoItem } from "@/stores/composer/chat-store";
import type { AgentRow } from "@/hooks/agent/use-agent-stop-controls";

interface CapturedDndContextProps {
  readonly children: ReactNode;
}

interface CapturedSortableContextProps {
  readonly children: ReactNode;
}

vi.mock("@dnd-kit/core", () => ({
  DndContext: (props: CapturedDndContextProps) => (
    <div data-testid="queued-message-dnd-provider">{props.children}</div>
  ),
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

vi.mock("@/components/chat/agent-stop-button", () => ({
  AgentStopButton: (props: { readonly label: string }) => (
    <button type="button">{props.label}</button>
  ),
}));

// The background panel reaches for the managed half's RPCs whether or not any
// managed command is on screen; this suite is about the dock's layout and
// dispatch, so the host boundary behind them is the one thing faked.
vi.mock(
  "@/hooks/managed-command/use-managed-command-lifecycle-mutations",
  () => ({
    useManagedCommandStart: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStop: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStopAll: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandDelete: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStopAllIsPending: () => false,
    useManagedCommandDeliverHeld: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandDeliverHeldIsPending: () => false,
  }),
);

const SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "codex-test",
  permissionMode: "supervised",
  reasoningEffort: "medium",
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

describe("<ChatLowerDock />", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders queue, todo, and file changes in a stable top-down order", () => {
    renderDock({
      queue: queueState([queuedItem("queue-1", "Queued prompt")]),
      todo: todoSnapshot([todoItem("Current task")]),
      changes: [fileChange()],
      backgroundItems: undefined,
      heldManagedCommandCount: 0,
      selfAgent: null,
      activeAgents: [],
      onBackgroundItemClick: () => undefined,
      onBackgroundItemStop: () => null,
      onBackgroundItemsStopAll: () => null,
    });

    const dock = screen.getByTestId("chat-lower-dock");
    const queue = screen.getByTestId("queued-message-rows");
    const todo = screen.getByTestId("pinned-todo-panel");
    const changes = screen.getByTestId("accumulated-changes-panel");

    expect(dock.contains(queue)).toBe(true);
    expect(dock.contains(todo)).toBe(true);
    expect(dock.contains(changes)).toBe(true);
    expect(queue.compareDocumentPosition(todo)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(todo.compareDocumentPosition(changes)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("keeps the first visible section flush to the rounded top frame", () => {
    renderDock({
      queue: queueState([]),
      todo: null,
      changes: [fileChange()],
      backgroundItems: undefined,
      heldManagedCommandCount: 0,
      selfAgent: null,
      activeAgents: [],
      onBackgroundItemClick: () => undefined,
      onBackgroundItemStop: () => null,
      onBackgroundItemsStopAll: () => null,
    });

    const dock = screen.getByTestId("chat-lower-dock");
    const frame = dock.querySelector(".rounded-t-lg");
    const changes = screen.getByTestId("accumulated-changes-panel");

    expect(frame).not.toBeNull();
    expect(changes.className).not.toContain("border-t");
  });

  it("renders background items and dispatches item actions", () => {
    const onBackgroundItemClick = vi.fn();
    const onBackgroundItemStop = vi.fn(() => null);
    const onBackgroundItemsStopAll = vi.fn(() => null);
    const item: BackgroundItem = {
      taskId: "task-1",
      kind: "command",
      title: "bun test",
      blockId: "tool-1",
      parentTaskId: null,
      scheduledFor: null,
      individualStopUnavailable: null,
    };

    renderDock({
      queue: queueState([]),
      todo: null,
      changes: [],
      backgroundItems: [item],
      heldManagedCommandCount: 0,
      selfAgent: null,
      activeAgents: [],
      onBackgroundItemClick,
      onBackgroundItemStop,
      onBackgroundItemsStopAll,
    });

    const backgroundPanel = screen.getByRole("button", {
      name: /Background.*1 running/,
    });
    expect(backgroundPanel).not.toBeNull();
    const stopAll = screen.getByRole("button", { name: "Stop all" });
    fireEvent.click(stopAll);
    expect(onBackgroundItemsStopAll).toHaveBeenCalledTimes(1);

    fireEvent.click(backgroundPanel);
    fireEvent.click(stopAll);
    expect(onBackgroundItemsStopAll).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: /bun test.*Command/ }));
    expect(onBackgroundItemClick).toHaveBeenCalledWith(item);

    fireEvent.click(screen.getByRole("button", { name: "Stop Command" }));
    expect(onBackgroundItemStop).toHaveBeenCalledWith("task-1");
  });

  // The dock's own half of the hold gate. A hold lingers only on a shell that
  // has FINISHED, so it reaches neither the harness's background items nor the
  // running-command count - and on those two alone the dock returned null,
  // taking the only affordance that clears a hold off screen. The count is the
  // parent's to compute (the surfaces below size themselves from the same one);
  // what this pins is that the dock opens the section on it.
  it("opens the Background section on the held count alone", () => {
    renderDock({
      queue: queueState([]),
      todo: null,
      changes: [],
      backgroundItems: [],
      heldManagedCommandCount: 1,
      selfAgent: null,
      activeAgents: [],
      onBackgroundItemClick: () => undefined,
      onBackgroundItemStop: () => null,
      onBackgroundItemsStopAll: () => null,
    });

    expect(screen.getByTestId("chat-lower-dock")).not.toBeNull();
    expect(screen.getByTestId("background-items-panel")).not.toBeNull();
  });

  it("stays closed when nothing is held, running, or queued", () => {
    renderDock({
      queue: queueState([]),
      todo: null,
      changes: [],
      backgroundItems: [],
      heldManagedCommandCount: 0,
      selfAgent: null,
      activeAgents: [],
      onBackgroundItemClick: () => undefined,
      onBackgroundItemStop: () => null,
      onBackgroundItemsStopAll: () => null,
    });

    expect(screen.queryByTestId("chat-lower-dock")).toBeNull();
  });

  it("mounts the parent Active agents bar when awareness reports an active child", () => {
    renderDock({
      queue: queueState([]),
      todo: null,
      changes: [],
      backgroundItems: undefined,
      heldManagedCommandCount: 0,
      selfAgent: agentRow("parent", "Parent agent", false),
      activeAgents: [agentRow("child", "Unopened child", true)],
      onBackgroundItemClick: () => undefined,
      onBackgroundItemStop: () => null,
      onBackgroundItemsStopAll: () => null,
    });

    expect(screen.getByTestId("active-agents-panel")).toBeDefined();
    expect(
      screen.getByRole("button", { name: /Active agents.*1 running/i }),
    ).toBeDefined();
  });
});

interface DockInput {
  readonly queue: ChatSessionState["queue"];
  readonly todo: PinnedTodoSnapshot | null;
  readonly changes: ReadonlyArray<AccumulatedFileChange>;
  readonly backgroundItems: ReadonlyArray<BackgroundItem> | undefined;
  readonly heldManagedCommandCount: number;
  readonly selfAgent: AgentRow | null;
  readonly activeAgents: ReadonlyArray<AgentRow>;
  readonly onBackgroundItemClick: (item: BackgroundItem) => void;
  readonly onBackgroundItemStop: (taskId: string) => string | null;
  readonly onBackgroundItemsStopAll: () => string | null;
}

function renderDock(input: DockInput) {
  return render(
    // The dock's background panel reads the tile's bound host to open a
    // managed command's output window, the same as it does inside a real tile.
    <TabHostProvider hostId="host-1">
      <TooltipProvider delayDuration={0}>
        <ChatLowerDock
          snapshotLoaded
          epicId="epic-1"
          chatId="chat-1"
          viewTabId="tab-1"
          selfAgent={input.selfAgent}
          activeAgents={input.activeAgents}
          todo={input.todo}
          restore={baseRestore(input.changes)}
          queue={input.queue}
          queueResumeRequested={false}
          queueKeepPausedRequested={false}
          backgroundItems={input.backgroundItems}
          runningManagedCommandCount={0}
          heldManagedCommandCount={input.heldManagedCommandCount}
          backgroundStopPendingTaskIds={new Set()}
          backgroundStopAllPending={false}
          backgroundSessionStopPending={false}
          activeTurnStatus="running"
          canAct
          readOnly={false}
          editingQueueItemId={null}
          topSpacing="normal"
          scrollRegionMaxHeightClass="max-h-96"
          onQueuePause={() => null}
          onQueueResume={() => null}
          onQueueEdit={vi.fn()}
          onQueueCancel={vi.fn()}
          onQueueAbortSteer={vi.fn()}
          onQueueReorder={vi.fn()}
          onQueueSteerNow={vi.fn()}
          onBackgroundItemClick={input.onBackgroundItemClick}
          onBackgroundItemStop={input.onBackgroundItemStop}
          onBackgroundItemsStopAll={input.onBackgroundItemsStopAll}
          onBackgroundSessionStop={() => null}
        />
      </TooltipProvider>
    </TabHostProvider>,
  );
}

function agentRow(id: string, title: string, active: boolean): AgentRow {
  return {
    id,
    title,
    surface: "gui",
    activity: active ? "turn" : false,
    hostId: "host-1",
  };
}

function baseRestore(
  changes: ReadonlyArray<AccumulatedFileChange>,
): ChatRestoreContextValue {
  return {
    accessRole: "owner",
    currentUserId: "owner-1",
    activeHostId: "host-1",
    activeTurnStatus: null,
    localSnapshotsClearedAt: null,
    restore: null,
    restoreActionPending: false,
    restoreCheckpoint: vi.fn().mockReturnValue(null),
    accumulatedFileChanges: changes,
    revertFileChanges: vi.fn().mockReturnValue(null),
  };
}

function queueState(
  items: ReadonlyArray<ChatQueuedItem>,
): ChatSessionState["queue"] {
  return { status: "idle", items: [...items] };
}

function queuedItem(queueItemId: string, text: string): ChatQueuedPromptItem {
  return {
    kind: "prompt",
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
    status: "pending",
    targetTurnId: null,
    steerRequest: null,
    fallbackReason: null,
    createdAt: 1,
    updatedAt: 1,
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

function todoSnapshot(
  items: ReadonlyArray<SegmentTodoItem>,
): PinnedTodoSnapshot {
  return { id: "todo-1", items };
}

function todoItem(text: string): SegmentTodoItem {
  return {
    id: `todo-${text}`,
    status: "in_progress",
    text,
    priority: null,
    activeForm: null,
  };
}

function fileChange(): AccumulatedFileChange {
  return {
    filePath: "/repo/src/app.ts",
    operation: "edit",
    diffSource: "snapshot",
    beforeContent: "old\n",
    afterContent: "new\n",
    reason: "snapshot",
    undoable: true,
    streamingCounts: null,
  };
}
