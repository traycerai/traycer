import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackgroundItem } from "@traycer/protocol/host/agent/gui/subscribe";

// The one faked boundary: the host RPCs behind the managed-command rows. This
// suite is about how background items nest and read; the managed-command
// surfaces have their own suite.
vi.mock(
  "@/hooks/managed-command/use-managed-command-lifecycle-mutations",
  () => ({
    useManagedCommandStart: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStop: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStopAll: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStopAllIsPending: () => false,
    useManagedCommandDelete: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandDeliverHeld: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandDeliverHeldIsPending: () => false,
  }),
);

import { BackgroundItemsPanel } from "@/components/chat/chat-background-items-panel";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";

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
      individualStopUnavailable: null,
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
      name: /Parent agent.*Sub-agent/,
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
      individualStopUnavailable: null,
    });
    const secondChild = backgroundItem({
      taskId: "second-child-command",
      kind: "command",
      title: "Second child",
      blockId: "second-child-command-tool",
      parentTaskId: "parent-agent",
      scheduledFor: null,
      individualStopUnavailable: null,
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
      individualStopUnavailable: null,
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
      screen.queryByRole("button", { name: /Remembered parent.*Sub-agent/ }),
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
      individualStopUnavailable: null,
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
      individualStopUnavailable: null,
    });
    const laterChild = backgroundItem({
      taskId: "later-child-command",
      kind: "command",
      title: "Later child",
      blockId: "later-child-command-tool",
      parentTaskId: "parent-agent",
      scheduledFor: null,
      individualStopUnavailable: null,
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

  it("renders an mcp row with structured identity, live elapsed, and its stop affordance", () => {
    const onStopItem = vi.fn(() => null);
    const mcp = backgroundItem({
      taskId: "mcp-task",
      kind: "mcp",
      title: "probe/slow_op",
      blockId: "tool-9",
      parentTaskId: null,
      serverName: "probe",
      toolName: "slow_op",
      startedAt: Date.now() - 65_000,
    });

    renderPanel({
      items: [mcp],
      onItemClick: () => undefined,
      onStopItem,
      onStopAll: () => null,
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Background.*1 running/ }),
    );

    const row = screen.getByRole("button", {
      name: /probe · slow_op.*1m 5s.*MCP tool/,
    });
    expect(row).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Stop MCP tool" }));
    expect(onStopItem).toHaveBeenCalledWith("mcp-task");
  });

  it("hides the mcp elapsed counter when the host predates startedAt", () => {
    const mcp = backgroundItem({
      taskId: "mcp-task",
      kind: "mcp",
      title: "probe/slow_op",
      blockId: "tool-9",
      parentTaskId: null,
      serverName: "probe",
      toolName: "slow_op",
      startedAt: null,
    });

    renderPanel({
      items: [mcp],
      onItemClick: () => undefined,
      onStopItem: () => null,
      onStopAll: () => null,
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Background.*1 running/ }),
    );

    const row = screen.getByRole("button", { name: /probe · slow_op/ });
    expect(row.textContent).toBe("probe · slow_opMCP tool");
  });

  it("renders a workflow row with its phase/active-label/counts summary and Workflow chip", () => {
    const onItemClick = vi.fn();
    const workflow = backgroundItem({
      taskId: "workflow-1",
      kind: "workflow",
      title: "max-effort-review",
      blockId: "workflow-1",
      parentTaskId: null,
      phase: "Verify",
      activeLabel: "verify:chat-loss",
      agentsStarted: 47,
      agentsFinished: 31,
    });

    renderPanel({
      items: [workflow],
      onItemClick,
      onStopItem: () => null,
      onStopAll: () => null,
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Background.*1 running/ }),
    );

    const row = screen.getByRole("button", {
      name: /max-effort-review — Verify · verify:chat-loss · 31\/47 done.*Workflow/,
    });
    expect(row).toBeTruthy();

    fireEvent.click(row);
    expect(onItemClick).toHaveBeenCalledWith(workflow);
  });

  it("falls back to the plain title when a workflow row has no progress yet", () => {
    const workflow = backgroundItem({
      taskId: "workflow-2",
      kind: "workflow",
      title: "fresh-workflow",
      blockId: "workflow-2",
      parentTaskId: null,
      phase: null,
      activeLabel: null,
      agentsStarted: null,
      agentsFinished: null,
    });

    renderPanel({
      items: [workflow],
      onItemClick: () => undefined,
      onStopItem: () => null,
      onStopAll: () => null,
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Background.*1 running/ }),
    );

    expect(
      screen.getByRole("button", { name: /^fresh-workflow.*Workflow/ }),
    ).toBeTruthy();
  });

  it("stops a workflow row via its own stop affordance", () => {
    const onStopItem = vi.fn(() => null);
    const workflow = backgroundItem({
      taskId: "workflow-3",
      kind: "workflow",
      title: "review-fleet",
      blockId: "workflow-3",
      parentTaskId: null,
      phase: "Find",
      activeLabel: "find:host-core",
      agentsStarted: 10,
      agentsFinished: 2,
    });

    renderPanel({
      items: [workflow],
      onItemClick: () => undefined,
      onStopItem,
      onStopAll: () => null,
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Background.*1 running/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop Workflow" }));
    expect(onStopItem).toHaveBeenCalledWith("workflow-3");
  });

  it("nests a fleet-attributed command under its owning workflow row", () => {
    const workflow = backgroundItem({
      taskId: "workflow-4",
      kind: "workflow",
      title: "review-fleet",
      blockId: "workflow-4",
      parentTaskId: null,
      phase: "Find",
      activeLabel: "find:host-core",
      agentsStarted: 10,
      agentsFinished: 2,
    });
    const fleetCommand = backgroundItem({
      taskId: "fleet-command",
      kind: "command",
      title: "bun run compile",
      blockId: "fleet-command-tool",
      parentTaskId: "workflow-4",
      scheduledFor: null,
      individualStopUnavailable: null,
    });

    renderPanel({
      items: [workflow, fleetCommand],
      onItemClick: () => undefined,
      onStopItem: () => null,
      onStopAll: () => null,
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Background.*1 running/ }),
    );

    const workflowRow = screen.getByRole("button", {
      name: /review-fleet.*Workflow/,
    });
    const commandRow = screen.getByRole("button", {
      name: /bun run compile.*Command/,
    });
    expect(
      workflowRow.compareDocumentPosition(commandRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getAllByRole("group")).toHaveLength(1);
  });

  it("disables a gated command's own stop button while a sibling row's stop stays enabled", () => {
    const gatedCommand = backgroundItem({
      taskId: "gated-command",
      kind: "command",
      title: "Codex command",
      blockId: "gated-command-tool",
      parentTaskId: null,
      scheduledFor: null,
      individualStopUnavailable: {
        providerLabel: "Codex",
        minVersion: "0.146.0",
      },
    });
    const subagent = backgroundItem({
      taskId: "sub-agent",
      kind: "subagent",
      title: "Sub agent",
      blockId: "sub-agent",
      parentTaskId: null,
      scheduledFor: null,
    });

    renderPanel({
      items: [gatedCommand, subagent],
      onItemClick: () => undefined,
      onStopItem: () => null,
      onStopAll: () => null,
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Background.*2 running/ }),
    );

    const gatedStopButton = screen.getByRole<HTMLButtonElement>("button", {
      name: "Stopping this command needs Codex 0.146.0 or newer. Use Stop all to stop the Codex session.",
    });
    expect(gatedStopButton.disabled).toBe(true);

    const subagentStopButton = screen.getByRole<HTMLButtonElement>("button", {
      name: "Stop Sub-agent",
    });
    expect(subagentStopButton.disabled).toBe(false);
  });

  it("escalates Stop all to a confirm dialog when a gated command is present, firing the session stop only on confirm", () => {
    const onStopAll = vi.fn(() => null);
    const onStopSession = vi.fn(() => "action-1");
    const gatedCommand = backgroundItem({
      taskId: "gated-command",
      kind: "command",
      title: "Codex command",
      blockId: "gated-command-tool",
      parentTaskId: null,
      scheduledFor: null,
      individualStopUnavailable: {
        providerLabel: "Codex",
        minVersion: "0.146.0",
      },
    });

    renderPanel({
      items: [gatedCommand],
      onItemClick: () => undefined,
      onStopItem: () => null,
      onStopAll,
      onStopSession,
    });

    fireEvent.click(screen.getByTestId("background-stop-all"));
    expect(screen.getByTestId("confirm-destructive-dialog")).toBeTruthy();
    expect(onStopAll).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("confirm-cancel"));
    expect(onStopSession).not.toHaveBeenCalled();
    expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();

    fireEvent.click(screen.getByTestId("background-stop-all"));
    fireEvent.click(screen.getByTestId("confirm-action"));
    expect(onStopSession).toHaveBeenCalledTimes(1);
    expect(onStopAll).not.toHaveBeenCalled();
  });

  it("keeps Stop all's plain behavior when no command needs the session escalation", () => {
    const onStopAll = vi.fn(() => null);
    const onStopSession = vi.fn(() => null);
    const command = backgroundItem({
      taskId: "plain-command",
      kind: "command",
      title: "Plain command",
      blockId: "plain-command-tool",
      parentTaskId: null,
      scheduledFor: null,
      individualStopUnavailable: null,
    });

    renderPanel({
      items: [command],
      onItemClick: () => undefined,
      onStopItem: () => null,
      onStopAll,
      onStopSession,
    });

    fireEvent.click(screen.getByTestId("background-stop-all"));

    expect(onStopAll).toHaveBeenCalledTimes(1);
    expect(onStopSession).not.toHaveBeenCalled();
    expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
  });

  it("mentions the active turn in the confirm dialog only when a turn is active", () => {
    const gatedCommand = backgroundItem({
      taskId: "gated-command",
      kind: "command",
      title: "Codex command",
      blockId: "gated-command-tool",
      parentTaskId: null,
      scheduledFor: null,
      individualStopUnavailable: {
        providerLabel: "Codex",
        minVersion: "0.146.0",
      },
    });

    const { rerender } = renderPanel({
      items: [gatedCommand],
      onItemClick: () => undefined,
      onStopItem: () => null,
      onStopAll: () => null,
      turnActive: false,
    });

    fireEvent.click(screen.getByTestId("background-stop-all"));
    expect(
      screen.getByTestId("confirm-destructive-dialog").textContent,
    ).not.toContain("The active turn will also be stopped.");

    rerender(
      panelElement({
        items: [gatedCommand],
        onItemClick: () => undefined,
        onStopItem: () => null,
        onStopAll: () => null,
        turnActive: true,
      }),
    );

    expect(
      screen.getByTestId("confirm-destructive-dialog").textContent,
    ).toContain("The active turn will also be stopped.");
  });

  it("counts every affected row, not just root groups, in the session-stop confirm dialog", () => {
    const gatedCommand = backgroundItem({
      taskId: "gated-command",
      kind: "command",
      title: "Codex command",
      blockId: "gated-command-tool",
      parentTaskId: null,
      scheduledFor: null,
      individualStopUnavailable: {
        providerLabel: "Codex",
        minVersion: "0.146.0",
      },
    });
    const firstChild = backgroundItem({
      taskId: "child-one",
      kind: "subagent",
      title: "Child one",
      blockId: "child-one",
      parentTaskId: "gated-command",
      scheduledFor: null,
    });
    const secondChild = backgroundItem({
      taskId: "child-two",
      kind: "subagent",
      title: "Child two",
      blockId: "child-two",
      parentTaskId: "gated-command",
      scheduledFor: null,
    });

    renderPanel({
      items: [gatedCommand, firstChild, secondChild],
      onItemClick: () => undefined,
      onStopItem: () => null,
      onStopAll: () => null,
      onStopSession: () => "action-1",
    });

    fireEvent.click(screen.getByTestId("background-stop-all"));

    expect(
      screen.getByTestId("confirm-destructive-dialog").textContent,
    ).toContain("Stopping the session ends all 3 background items.");
  });

  it("excludes wakeups from the session-stop confirm dialog's count - a session stop can't end a host-owned wake", () => {
    const gatedCommand = backgroundItem({
      taskId: "gated-command",
      kind: "command",
      title: "Codex command",
      blockId: "gated-command-tool",
      parentTaskId: null,
      scheduledFor: null,
      individualStopUnavailable: {
        providerLabel: "Codex",
        minVersion: "0.146.0",
      },
    });
    const child = backgroundItem({
      taskId: "child-command",
      kind: "command",
      title: "Child command",
      blockId: "child-command-tool",
      parentTaskId: "gated-command",
      scheduledFor: null,
      individualStopUnavailable: null,
    });
    const wakeup = backgroundItem({
      taskId: "wake-task",
      kind: "wakeup",
      title: "Review status",
      blockId: "wake-tool",
      parentTaskId: null,
      scheduledFor: 1_769_000_000_000,
    });

    renderPanel({
      items: [gatedCommand, child, wakeup],
      onItemClick: () => undefined,
      onStopItem: () => null,
      onStopAll: () => null,
      onStopSession: () => "action-1",
    });

    fireEvent.click(screen.getByTestId("background-stop-all"));

    expect(
      screen.getByTestId("confirm-destructive-dialog").textContent,
    ).toContain("Stopping the session ends all 2 background items.");
  });
});

interface PanelInput {
  readonly items: ReadonlyArray<BackgroundItem>;
  readonly onItemClick: (item: BackgroundItem) => void;
  readonly onStopItem: (taskId: string) => string | null;
  readonly onStopAll: () => string | null;
  readonly sessionStopPending?: boolean;
  readonly turnActive?: boolean;
  readonly onStopSession?: () => string | null;
}

function renderPanel(input: PanelInput) {
  return render(panelElement(input));
}

function panelElement(input: PanelInput) {
  // The panel only ever mounts inside a chat tile, and its managed-command
  // rows act on that tile's host - so the provider is part of its contract,
  // not test scaffolding.
  return (
    <TabHostProvider hostId="host-1">
      <BackgroundItemsPanel
        items={input.items}
        epicId="epic-1"
        chatId="chat-1"
        viewTabId="tab-1"
        canAct
        readOnly={false}
        pendingStopTaskIds={new Set()}
        stopAllPending={false}
        sessionStopPending={input.sessionStopPending ?? false}
        turnActive={input.turnActive ?? false}
        scrollRegionMaxHeightClass="max-h-96"
        separated={false}
        onItemClick={input.onItemClick}
        onStopItem={input.onStopItem}
        onStopAll={input.onStopAll}
        onStopSession={input.onStopSession ?? (() => null)}
      />
    </TabHostProvider>
  );
}

function backgroundItem(input: BackgroundItem): BackgroundItem {
  return input;
}
