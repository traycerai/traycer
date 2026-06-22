import "../../../../__tests__/test-browser-apis";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
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
    });

    const dock = screen.getByTestId("chat-lower-dock");
    const frame = dock.querySelector(".rounded-t-lg");
    const changes = screen.getByTestId("accumulated-changes-panel");

    expect(frame).not.toBeNull();
    expect(changes.className).not.toContain("border-t");
  });
});

function renderDock(input: {
  readonly queue: ChatSessionState["queue"];
  readonly todo: PinnedTodoSnapshot | null;
  readonly changes: ReadonlyArray<AccumulatedFileChange>;
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
        activeTurnStatus="running"
        canAct
        readOnly={false}
        editingQueueItemId={null}
        topSpacing="normal"
        scrollRegionMaxHeightClass="max-h-96"
        onQueueResume={() => null}
        onQueueEdit={vi.fn()}
        onQueueCancel={vi.fn()}
        onQueueAbortSteer={vi.fn()}
        onQueueReorder={vi.fn()}
        onQueueSteerNow={vi.fn()}
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
