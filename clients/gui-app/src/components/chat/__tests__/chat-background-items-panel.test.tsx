import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackgroundItem } from "@traycer/protocol/host/agent/gui/subscribe";
import { BackgroundItemsPanel } from "@/components/chat/chat-background-items-panel";

describe("<BackgroundItemsPanel />", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders nested background items under their parents and keeps nested stops per row", () => {
    const onItemClick = vi.fn();
    const onStopItem = vi.fn(() => null);
    const parent = backgroundItem({
      taskId: "parent-agent",
      kind: "subagent",
      title: "Parent agent",
      blockId: "parent-agent",
      parentTaskId: null,
      scheduledFor: null,
    });
    const child = backgroundItem({
      taskId: "child-command",
      kind: "command",
      title: "Child command",
      blockId: "child-command-tool",
      parentTaskId: "parent-agent",
      scheduledFor: null,
    });
    const grandchild = backgroundItem({
      taskId: "grandchild-monitor",
      kind: "monitor",
      title: "Grandchild monitor",
      blockId: "grandchild-monitor-tool",
      parentTaskId: "child-command",
      scheduledFor: null,
    });

    renderPanel({
      items: [parent, child, grandchild],
      onItemClick,
      onStopItem,
      onStopAll: () => null,
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Background.*1 running/ }),
    );

    const parentButton = screen.getByRole("button", {
      name: /Parent agent.*Agent/,
    });
    const childButton = screen.getByRole("button", {
      name: /Child command.*Command/,
    });
    const grandchildButton = screen.getByRole("button", {
      name: /Grandchild monitor.*Monitor/,
    });

    expect(
      parentButton.compareDocumentPosition(childButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      childButton.compareDocumentPosition(grandchildButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getAllByRole("group")).toHaveLength(2);

    fireEvent.click(childButton);
    expect(onItemClick).toHaveBeenCalledWith(child);

    fireEvent.click(screen.getByRole("button", { name: "Stop Command" }));
    expect(onStopItem).toHaveBeenCalledWith("child-command");
  });

  it("keeps nested child rows in current item order after reordering", () => {
    const parent = backgroundItem({
      taskId: "parent-agent",
      kind: "subagent",
      title: "Parent agent",
      blockId: "parent-agent",
      parentTaskId: null,
      scheduledFor: null,
    });
    const firstChild = backgroundItem({
      taskId: "first-child-command",
      kind: "command",
      title: "First child",
      blockId: "first-child-command-tool",
      parentTaskId: "parent-agent",
      scheduledFor: null,
    });
    const secondChild = backgroundItem({
      taskId: "second-child-command",
      kind: "command",
      title: "Second child",
      blockId: "second-child-command-tool",
      parentTaskId: "parent-agent",
      scheduledFor: null,
    });
    const firstGrandchild = backgroundItem({
      taskId: "first-grandchild-monitor",
      kind: "monitor",
      title: "First grandchild",
      blockId: "first-grandchild-monitor-tool",
      parentTaskId: "first-child-command",
      scheduledFor: null,
    });
    const secondGrandchild = backgroundItem({
      taskId: "second-grandchild-monitor",
      kind: "monitor",
      title: "Second grandchild",
      blockId: "second-grandchild-monitor-tool",
      parentTaskId: "first-child-command",
      scheduledFor: null,
    });

    const { rerender } = renderPanel({
      items: [
        parent,
        firstChild,
        secondChild,
        firstGrandchild,
        secondGrandchild,
      ],
      onItemClick: () => undefined,
      onStopItem: () => null,
      onStopAll: () => null,
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Background.*1 running/ }),
    );

    rerender(
      panelElement({
        items: [
          parent,
          secondChild,
          firstChild,
          secondGrandchild,
          firstGrandchild,
        ],
        onItemClick: () => undefined,
        onStopItem: () => null,
        onStopAll: () => null,
      }),
    );

    const secondChildButton = screen.getByRole("button", {
      name: /Second child.*Command/,
    });
    const firstChildButton = screen.getByRole("button", {
      name: /First child.*Command/,
    });
    const secondGrandchildButton = screen.getByRole("button", {
      name: /Second grandchild.*Monitor/,
    });
    const firstGrandchildButton = screen.getByRole("button", {
      name: /First grandchild.*Monitor/,
    });

    expect(
      secondChildButton.compareDocumentPosition(firstChildButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      secondGrandchildButton.compareDocumentPosition(firstGrandchildButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps an orphaned child under the remembered parent title", () => {
    const parent = backgroundItem({
      taskId: "parent-agent",
      kind: "subagent",
      title: "Remembered parent",
      blockId: "parent-agent",
      parentTaskId: null,
      scheduledFor: null,
    });
    const child = backgroundItem({
      taskId: "child-command",
      kind: "command",
      title: "Still running child",
      blockId: "child-command-tool",
      parentTaskId: "parent-agent",
      scheduledFor: null,
    });

    const { rerender } = renderPanel({
      items: [parent, child],
      onItemClick: () => undefined,
      onStopItem: () => null,
      onStopAll: () => null,
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Background.*1 running/ }),
    );

    rerender(
      panelElement({
        items: [child],
        onItemClick: () => undefined,
        onStopItem: () => null,
        onStopAll: () => null,
      }),
    );

    const rememberedParent = screen.getByText("Remembered parent");
    const childButton = screen.getByRole("button", {
      name: /Still running child.*Command/,
    });

    expect(
      rememberedParent.compareDocumentPosition(childButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Remembered parent.*Agent/ }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Stop Command" })).toBeTruthy();
  });

  it("keeps a cold orphaned child under a synthetic parent row", () => {
    const child = backgroundItem({
      taskId: "child-command",
      kind: "command",
      title: "Cold orphan child",
      blockId: "child-command-tool",
      parentTaskId: "parent-agent",
      scheduledFor: null,
    });

    renderPanel({
      items: [child],
      onItemClick: () => undefined,
      onStopItem: () => null,
      onStopAll: () => null,
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Background.*1 running/ }),
    );

    const syntheticParent = screen.getByText("parent-agent");
    const childButton = screen.getByRole("button", {
      name: /Cold orphan child.*Command/,
    });

    expect(
      syntheticParent.compareDocumentPosition(childButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("prunes remembered parent rows once no current item references them", () => {
    const parent = backgroundItem({
      taskId: "parent-agent",
      kind: "subagent",
      title: "Remembered parent",
      blockId: "parent-agent",
      parentTaskId: null,
      scheduledFor: null,
    });
    const child = backgroundItem({
      taskId: "child-command",
      kind: "command",
      title: "Still running child",
      blockId: "child-command-tool",
      parentTaskId: "parent-agent",
      scheduledFor: null,
    });
    const laterChild = backgroundItem({
      taskId: "later-child-command",
      kind: "command",
      title: "Later child",
      blockId: "later-child-command-tool",
      parentTaskId: "parent-agent",
      scheduledFor: null,
    });

    const { rerender } = renderPanel({
      items: [parent, child],
      onItemClick: () => undefined,
      onStopItem: () => null,
      onStopAll: () => null,
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Background.*1 running/ }),
    );

    rerender(
      panelElement({
        items: [],
        onItemClick: () => undefined,
        onStopItem: () => null,
        onStopAll: () => null,
      }),
    );
    rerender(
      panelElement({
        items: [laterChild],
        onItemClick: () => undefined,
        onStopItem: () => null,
        onStopAll: () => null,
      }),
    );

    expect(screen.queryByText("Remembered parent")).toBeNull();
    expect(screen.getByText("parent-agent")).toBeTruthy();
  });

  it("renders wakeup rows with scheduled time and cancel affordance", () => {
    const onStopItem = vi.fn(() => null);
    const scheduledFor = new Date(2026, 0, 2, 9, 30).getTime();
    const wakeup = backgroundItem({
      taskId: "wake-tool",
      kind: "wakeup",
      title: "Review status",
      blockId: "wake-tool",
      parentTaskId: null,
      scheduledFor,
    });

    renderPanel({
      items: [wakeup],
      onItemClick: () => undefined,
      onStopItem,
      onStopAll: () => null,
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Background.*1 waiting/ }),
    );

    expect(
      screen.getByRole("button", {
        name: /Waiting until 09:30 · Review status.*Wake/,
      }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel wake" }));
    expect(onStopItem).toHaveBeenCalledWith("wake-tool");
  });
});

function renderPanel(input: {
  readonly items: ReadonlyArray<BackgroundItem>;
  readonly onItemClick: (item: BackgroundItem) => void;
  readonly onStopItem: (taskId: string) => string | null;
  readonly onStopAll: () => string | null;
}) {
  return render(panelElement(input));
}

function panelElement(input: {
  readonly items: ReadonlyArray<BackgroundItem>;
  readonly onItemClick: (item: BackgroundItem) => void;
  readonly onStopItem: (taskId: string) => string | null;
  readonly onStopAll: () => string | null;
}) {
  return (
    <BackgroundItemsPanel
      items={input.items}
      canAct
      readOnly={false}
      pendingStopTaskIds={new Set()}
      stopAllPending={false}
      scrollRegionMaxHeightClass="max-h-96"
      separated={false}
      onItemClick={input.onItemClick}
      onStopItem={input.onStopItem}
      onStopAll={input.onStopAll}
    />
  );
}

function backgroundItem(input: BackgroundItem): BackgroundItem {
  return input;
}
