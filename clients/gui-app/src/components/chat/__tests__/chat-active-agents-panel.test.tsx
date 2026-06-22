import "../../../../__tests__/test-browser-apis";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActiveAgentsPanel } from "@/components/chat/chat-active-agents-panel";
import { AgentStopList } from "@/components/chat/chat-agent-stop-list";
import type { AgentRow } from "@/hooks/agent/use-agent-stop-controls";

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

afterEach(cleanup);

describe("ActiveAgentsPanel", () => {
  function renderPanel() {
    return render(
      <ActiveAgentsPanel
        epicId="epic-1"
        self={row({ id: "self", title: "Root chat", active: true })}
        descendants={[
          row({ id: "child-1", title: "Sub-agent one" }),
          row({ id: "child-2", title: "Sub-agent two" }),
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
    fireEvent.click(screen.getByText("Active agents"));

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
});

describe("AgentStopList (TUI popover surface)", () => {
  it("keeps an inline, always-visible 'Stop all' on the self row", () => {
    render(
      <AgentStopList
        epicId="epic-1"
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
