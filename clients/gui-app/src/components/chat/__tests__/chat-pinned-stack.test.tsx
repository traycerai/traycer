import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PinnedTodoPanel } from "@/components/chat/chat-pinned-stack";
import type { PinnedTodoSnapshot } from "@/components/chat/chat-pinned-todos";
import type { SegmentTodoItem } from "@/stores/composer/chat-store";

/**
 * The dock's pinned Todo panel (L-97).
 *
 * `ChatPinnedStack` itself is gone: it was the pre-dock wrapper and had no
 * production caller left once `ChatLowerDock` took over the frame. How the
 * Todo and Changed files panels stack inside that frame is
 * `chat-lower-dock.test.tsx`'s; this file owns the Todo panel's own content.
 */
describe("the dock's pinned Todo panel", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows active todo copy, done counts, and cancelled counts in the header", () => {
    renderStack(todoSnapshot("todo-1", todoItems()));

    const panel = screen.getByTestId("pinned-todo-panel");

    expect(panel.textContent).toContain("Todo");
    expect(panel.textContent).toContain("Writing tests");
    expect(panel.textContent).toContain("1/4 done");
    expect(panel.textContent).toContain("1 cancelled");
  });

  it("places the todo status icon after the divider beside the active copy", () => {
    renderStack(todoSnapshot("todo-1", todoItems()));

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
    renderStack(todoSnapshot("todo-1", todoItems()));

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
    const { rerender } = renderStack(todoSnapshot("todo-1", todoItems()));

    fireEvent.click(screen.getByRole("button", { name: /Todo/ }));
    expect(screen.queryByTestId("pinned-todo-list")).not.toBeNull();

    rerender(stackUi(todoSnapshot("todo-1", [todoItem("same", "pending")])));
    expect(screen.queryByTestId("pinned-todo-list")).not.toBeNull();

    rerender(stackUi(todoSnapshot("todo-2", [todoItem("next", "pending")])));
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
    );

    fireEvent.click(screen.getByRole("button", { name: /Todo/ }));

    const list = screen.getByTestId("pinned-todo-list");
    expect(list.className).toContain("max-h-[min(40dvh,24rem)]");
    expect(list.className).toContain("overflow-y-auto");
  });
});

function renderStack(todo: PinnedTodoSnapshot) {
  return render(stackUi(todo));
}

function stackUi(todo: PinnedTodoSnapshot) {
  return (
    <TooltipProvider delay={0}>
      <PinnedTodoPanel
        todo={todo}
        scrollRegionMaxHeightClass="max-h-[min(40dvh,24rem)]"
        separated={false}
      />
    </TooltipProvider>
  );
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
