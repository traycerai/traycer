import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActiveAgentsPanel } from "@/components/chat/chat-active-agents-panel";
import { AgentStopList } from "@/components/chat/chat-agent-stop-list";
import { readEpicCanvasDragSourceData } from "@/components/epic-canvas/dnd/dnd";
import type { AgentRow } from "@/hooks/agent/use-agent-stop-controls";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

interface CapturedDraggable {
  readonly id: string;
  readonly disabled: boolean;
  readonly data: unknown;
}

const dnd = vi.hoisted(() => ({
  draggables: [] as CapturedDraggable[],
}));

const navigation = vi.hoisted(() => ({
  openTileInTab: vi.fn<(viewTabId: string, node: EpicCanvasTileRef) => null>(
    () => null,
  ),
}));

vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    useDraggable: (input: CapturedDraggable) => {
      dnd.draggables.push(input);
      return {
        attributes: {},
        listeners: {},
        setNodeRef: () => undefined,
        isDragging: false,
      };
    },
  };
});

vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({
    openTileInTab: navigation.openTileInTab,
  }),
}));

vi.mock("@/lib/epic-selectors", () => ({
  useMaybeEpicTuiAgentHarnessId: (nodeId: string) =>
    nodeId === "child-2" ? "claude" : null,
}));

// Stub the host-coupled stop button so these render tests stay focused on the
// panel/list structure (header "Stop all", per-row hover stops, self-stop
// inclusion) without the host client / mutation stack.
vi.mock("@/components/chat/agent-stop-button", () => ({
  AgentStopButton: (props: {
    readonly label: string;
    readonly iconOnly: boolean;
    readonly agentId: string;
    readonly testId: string | undefined;
  }) => (
    <button
      type="button"
      data-testid={props.testId ?? "agent-stop-row"}
      data-icon-only={props.iconOnly ? "true" : "false"}
      data-agent-id={props.agentId}
      aria-label={props.label}
    >
      {props.label}
    </button>
  ),
}));

function row(over: Partial<AgentRow> & Pick<AgentRow, "id">): AgentRow {
  return {
    title: `title-${over.id}`,
    surface: "gui",
    active: true,
    hostId: "d1",
    ...over,
  };
}

beforeEach(() => {
  dnd.draggables = [];
  navigation.openTileInTab.mockClear();
});

afterEach(cleanup);

describe("ActiveAgentsPanel", () => {
  function renderPanel() {
    return render(
      <ActiveAgentsPanel
        epicId="epic-1"
        viewTabId="tab-1"
        self={row({ id: "self", title: "Root chat", active: true })}
        descendants={[
          row({ id: "child-1", title: "Sub-agent one" }),
          row({
            id: "child-2",
            title: "Sub-agent two",
            surface: "tui",
            hostId: "d2",
          }),
        ]}
        scrollRegionMaxHeightClass="max-h-40"
        separated={false}
      />,
    );
  }

  it("shows 'Stop all' in the header even while collapsed", () => {
    renderPanel();
    const stopAll = screen.getByTestId("agent-stop-all");
    expect(stopAll.getAttribute("data-agent-id")).toBe("self");
    // Header action carries its label, not the icon-only treatment.
    expect(stopAll.getAttribute("data-icon-only")).toBe("false");
    // The list is collapsed, so descendant rows are not mounted yet.
    expect(screen.queryByText("Sub-agent one")).toBeNull();
  });

  it("moves 'Stop all' onto the current agent's row and reveals descendant stops on hover when expanded", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /active agents/i }));

    // "Stop all" now lives on the current agent's row (compact, icon-only) and
    // stays visible there - the header no longer shows a duplicate, and the
    // parent row is never stop-less.
    const stopAll = screen.getAllByTestId("agent-stop-all");
    expect(stopAll).toHaveLength(1);
    expect(stopAll[0].getAttribute("data-agent-id")).toBe("self");
    expect(stopAll[0].getAttribute("data-icon-only")).toBe("true");
    // The current agent's stop is always visible, not gated behind hover.
    expect(stopAll[0].parentElement?.className ?? "").not.toContain(
      "group-hover:opacity-100",
    );

    // Each descendant carries its own icon-only stop, revealed on row hover.
    const rowStops = screen.getAllByTestId("agent-stop-row");
    expect(rowStops.map((stop) => stop.getAttribute("data-agent-id"))).toEqual([
      "child-1",
      "child-2",
    ]);
    for (const stop of rowStops) {
      expect(stop.getAttribute("data-icon-only")).toBe("true");
      expect(stop.parentElement?.className).toContain(
        "group-hover:opacity-100",
      );
    }
  });

  it("opens the current agent or a descendant from its row", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /active agents/i }));

    fireEvent.click(screen.getByRole("button", { name: "Open Root chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Sub-agent two" }));

    expect(
      navigation.openTileInTab.mock.calls.map(
        ([viewTabId, { instanceId, ...node }]) => ({
          viewTabId,
          instanceIdType: typeof instanceId,
          node,
        }),
      ),
    ).toEqual([
      {
        viewTabId: "tab-1",
        instanceIdType: "string",
        node: {
          id: "self",
          type: "chat",
          name: "Root chat",
          hostId: "d1",
        },
      },
      {
        viewTabId: "tab-1",
        instanceIdType: "string",
        node: {
          id: "child-2",
          type: "terminal-agent",
          name: "Sub-agent two",
          hostId: "d2",
        },
      },
    ]);
  });

  it("registers every row as a unique, host-bound active-agent drag source", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /active agents/i }));

    expect(dnd.draggables).toHaveLength(3);
    expect(new Set(dnd.draggables.map((draggable) => draggable.id)).size).toBe(
      3,
    );
    expect(
      dnd.draggables.every((draggable) =>
        draggable.id.startsWith("active-agent:"),
      ),
    ).toBe(true);
    expect(
      dnd.draggables.map((draggable) => ({
        disabled: draggable.disabled,
        source: readEpicCanvasDragSourceData(draggable.data),
      })),
    ).toEqual([
      {
        disabled: false,
        source: {
          kind: "active-agent",
          epicId: "epic-1",
          viewTabId: "tab-1",
          agent: {
            id: "self",
            type: "chat",
            name: "Root chat",
            hostId: "d1",
            harnessId: null,
          },
        },
      },
      {
        disabled: false,
        source: {
          kind: "active-agent",
          epicId: "epic-1",
          viewTabId: "tab-1",
          agent: {
            id: "child-1",
            type: "chat",
            name: "Sub-agent one",
            hostId: "d1",
            harnessId: null,
          },
        },
      },
      {
        disabled: false,
        source: {
          kind: "active-agent",
          epicId: "epic-1",
          viewTabId: "tab-1",
          agent: {
            id: "child-2",
            type: "terminal-agent",
            name: "Sub-agent two",
            hostId: "d2",
            harnessId: "claude",
          },
        },
      },
    ]);
  });
});

describe("AgentStopList (TUI popover surface)", () => {
  it("keeps an inline, always-visible 'Stop all' on the self row", () => {
    render(
      <AgentStopList
        epicId="epic-1"
        viewTabId="tab-1"
        self={row({ id: "self", title: "Root chat" })}
        descendants={[row({ id: "child-1", title: "Sub-agent one" })]}
        surface="tui-popover"
      />,
    );

    const stopAll = screen.getByTestId("agent-stop-all");
    expect(stopAll.getAttribute("data-agent-id")).toBe("self");
    // Inline (labelled, not icon-only) and not wrapped in the hover affordance.
    expect(stopAll.getAttribute("data-icon-only")).toBe("false");
    expect(stopAll.parentElement?.className ?? "").not.toContain(
      "group-hover:opacity-100",
    );

    const childStop = screen.getByTestId("agent-stop-row");
    expect(childStop.getAttribute("data-icon-only")).toBe("false");
  });
});
