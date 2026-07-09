import "../../../../__tests__/test-browser-apis";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  BackgroundItem,
  ChatQueuedItem,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { ChatLowerDock } from "@/components/chat/chat-lower-dock";
import type { AccumulatedFileChange } from "@/lib/chat/accumulated-file-changes-from-messages";
import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import type { PinnedTodoSnapshot } from "@/components/chat/chat-pinned-todos";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ChatSessionState } from "@/stores/chats/chat-session-store";
import type { SegmentTodoItem } from "@/stores/composer/chat-store";

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
    };

    renderDock({
      queue: queueState([]),
      todo: null,
      changes: [],
      backgroundItems: [item],
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
});

function renderDock(input: {
  readonly queue: ChatSessionState["queue"];
  readonly todo: PinnedTodoSnapshot | null;
  readonly changes: ReadonlyArray<AccumulatedFileChange>;
  readonly backgroundItems: ReadonlyArray<BackgroundItem> | undefined;
  readonly onBackgroundItemClick: (item: BackgroundItem) => void;
  readonly onBackgroundItemStop: (taskId: string) => string | null;
  readonly onBackgroundItemsStopAll: () => string | null;
}) {
  return render(
    <TooltipProvider delayDuration={0}>
      <ChatLowerDock
        snapshotLoaded
        epicId="epic-1"
        selfAgent={null}
        activeAgents={[]}
        todo={input.todo}
        restore={baseRestore(input.changes)}
        queue={input.queue}
        backgroundItems={input.backgroundItems}
        backgroundStopPendingTaskIds={new Set()}
        backgroundStopAllPending={false}
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
      />
    </TooltipProvider>,
  );
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

function queuedItem(queueItemId: string, text: string): ChatQueuedItem {
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
