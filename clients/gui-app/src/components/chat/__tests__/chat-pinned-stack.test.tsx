import "../../../../__tests__/test-browser-apis";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccumulatedFileChange } from "@/lib/chat/accumulated-file-changes-from-messages";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChatPinnedStack } from "@/components/chat/chat-pinned-stack";
import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import type { PinnedTodoSnapshot } from "@/components/chat/chat-pinned-todos";
import type { SegmentTodoItem } from "@/stores/composer/chat-store";

describe("<ChatPinnedStack />", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows active todo copy, done counts, and cancelled counts in the header", () => {
    renderStack(todoSnapshot("todo-1", todoItems()), baseRestore([]));

    const panel = screen.getByTestId("pinned-todo-panel");

    expect(panel.textContent).toContain("Todo");
    expect(panel.textContent).toContain("Writing tests");
    expect(panel.textContent).toContain("1/4 done");
    expect(panel.textContent).toContain("1 cancelled");
  });

  it("places the todo status icon after the divider beside the active copy", () => {
    renderStack(todoSnapshot("todo-1", todoItems()), baseRestore([]));

    const divider = screen.getByTestId("pinned-todo-header-divider");
    const statusIcon = screen.getByTestId("pinned-todo-header-status-icon");
    const activeCopy = screen.getByText("Writing tests");

    expect(
      divider.compareDocumentPosition(statusIcon) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      statusIcon.compareDocumentPosition(activeCopy) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("preserves provider row order with single-line todo rows", () => {
    renderStack(todoSnapshot("todo-1", todoItems()), baseRestore([]));

    fireEvent.click(screen.getByRole("button", { name: /Todo/ }));

    const rows = within(screen.getByTestId("pinned-todo-list")).getAllByRole(
      "listitem",
    );
    expect(rows.map((row) => row.textContent)).toEqual([
      "Plan work",
      "Write tests",
      "Ship change",
      "Skip cleanup",
    ]);
    expect(screen.getByTestId("pinned-todo-list").textContent).not.toContain(
      "Currently",
    );
  });

  it("keeps user expansion state when a newer todo snapshot replaces the pinned block", () => {
    const { rerender } = renderStack(
      todoSnapshot("todo-1", todoItems()),
      baseRestore([]),
    );

    fireEvent.click(screen.getByRole("button", { name: /Todo/ }));
    expect(screen.queryByTestId("pinned-todo-list")).not.toBeNull();

    rerender(
      stackUi(todoSnapshot("todo-1", [todoItem("same", "pending")]), []),
    );
    expect(screen.queryByTestId("pinned-todo-list")).not.toBeNull();

    rerender(
      stackUi(todoSnapshot("todo-2", [todoItem("next", "pending")]), []),
    );
    expect(screen.queryByTestId("pinned-todo-list")).not.toBeNull();
  });

  it("caps long expanded todo lists with internal scrolling", () => {
    renderStack(
      todoSnapshot(
        "todo-long",
        Array.from({ length: 30 }, (_unused, index) =>
          todoItem(`Task ${index}`, "pending"),
        ),
      ),
      baseRestore([]),
    );

    fireEvent.click(screen.getByRole("button", { name: /Todo/ }));

    const list = screen.getByTestId("pinned-todo-list");
    expect(list.className).toContain("max-h-[min(40dvh,24rem)]");
    expect(list.className).toContain("overflow-y-auto");
  });

  it("renders todo above accumulated file changes in one stack", () => {
    renderStack(
      todoSnapshot("todo-1", todoItems()),
      baseRestore([fileChange()]),
    );

    const stack = screen.getByTestId("chat-pinned-stack");
    const todoPanel = screen.getByTestId("pinned-todo-panel");
    const changesPanel = screen.getByTestId("accumulated-changes-panel");

    const text = stack.textContent;

    expect(stack.contains(todoPanel)).toBe(true);
    expect(stack.contains(changesPanel)).toBe(true);
    expect(text.indexOf("Todo")).toBeLessThan(text.indexOf("1 file changed"));
  });
});

function renderStack(
  todo: PinnedTodoSnapshot,
  restore: ChatRestoreContextValue,
) {
  return render(stackUi(todo, restore.accumulatedFileChanges));
}

function stackUi(
  todo: PinnedTodoSnapshot,
  changes: ReadonlyArray<AccumulatedFileChange>,
) {
  return (
    <TooltipProvider delayDuration={0}>
      <ChatPinnedStack
        todo={todo}
        restore={baseRestore(changes)}
        topSpacing="normal"
      />
    </TooltipProvider>
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

function todoSnapshot(
  id: string,
  items: ReadonlyArray<SegmentTodoItem>,
): PinnedTodoSnapshot {
  return { id, items };
}

function todoItems(): ReadonlyArray<SegmentTodoItem> {
  return [
    todoItem("Plan work", "pending"),
    {
      ...todoItem("Write tests", "in_progress"),
      activeForm: "Writing tests",
    },
    todoItem("Ship change", "completed"),
    todoItem("Skip cleanup", "cancelled"),
  ];
}

function todoItem(
  text: string,
  status: SegmentTodoItem["status"],
): SegmentTodoItem {
  return {
    id: `todo-${text}`,
    status,
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
