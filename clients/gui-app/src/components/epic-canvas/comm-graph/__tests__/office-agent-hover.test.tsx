const agentHoverTooltipMock = vi.hoisted(() =>
  vi.fn((_props: Record<string, unknown>) => null),
);

vi.mock("@/components/epic-canvas/sidebar/agent-hover-tooltip", () => ({
  AgentHoverTooltip: agentHoverTooltipMock,
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({ status: "reachable" }),
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicNodeHostId: () => "host-a",
  useEpicNodeOwnerKind: () => "chat",
  useEpicAgentRoleClaims: () => [],
}));

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { OfficeAgentHover } from "@/components/epic-canvas/comm-graph/office/office-agent-hover";
import { OfficeHoverSupplement } from "@/components/epic-canvas/comm-graph/office/office-hover-supplement";

const RECT = { x: 40, y: 24, width: 16, height: 20 };

function renderHover(onSelect: (agentId: string) => void) {
  return render(
    <OfficeAgentHover
      epicId="epic-1"
      agentId="agent-1"
      name="Reviewer"
      screenRect={RECT}
      extraContent={
        <OfficeHoverSupplement status="working" modelTier="large" />
      }
      onSelect={onSelect}
      onLeave={vi.fn()}
      onPointerDown={vi.fn()}
    />,
  );
}

function tooltipProps(): Record<string, unknown> {
  const props = agentHoverTooltipMock.mock.lastCall?.[0];
  if (props === undefined) throw new Error("The shared tooltip never rendered");
  return props;
}

/**
 * The claim under test is REUSE, not appearance: the office must hand the
 * hovered agent to the SAME component the sidebar and the graph use, with the
 * props resolved from the node id the same way. What that component then
 * renders - worktree, branch, the harness/model header - is covered by its own
 * suites, and re-asserting it here would only pin a copy of them.
 */
afterEach(() => {
  cleanup();
  agentHoverTooltipMock.mockClear();
});

describe("OfficeAgentHover", () => {
  it("renders the shared agent tooltip rather than a card of its own", () => {
    renderHover(vi.fn());

    const props = tooltipProps();
    expect(props.epicId).toBe("epic-1");
    expect(props.nodeId).toBe("agent-1");
    expect(props.nodeName).toBe("Reviewer");
    // Resolved from the node id inside the component, exactly as the graph
    // node resolves them - the canvas hands over no description of its own.
    expect(props.hostId).toBe("host-a");
    expect(props.ownerKind).toBe("chat");
    expect(props.ownerHostUnreachable).toBe(false);
    // Upward: below a character is the rest of the floor.
    expect(props.side).toBe("top");
  });

  it("appends the floor's own reading under the shared card", () => {
    renderHover(vi.fn());

    render(tooltipProps().extraContent as ReactElement);
    expect(
      screen.getByTestId("comm-graph-office-hover-supplement").textContent,
    ).toBe("Working · large model");
  });

  it("puts the trigger exactly over the character it describes", () => {
    renderHover(vi.fn());

    render(tooltipProps().trigger as ReactElement);
    const trigger = screen.getByTestId(
      "comm-graph-office-hover-trigger-agent-1",
    );
    // The canvas has no per-agent DOM, so this one element IS the agent as far
    // as the pointer is concerned; a wrong box would open the wrong card.
    expect(trigger.style.left).toBe("40px");
    expect(trigger.style.top).toBe("24px");
    expect(trigger.style.width).toBe("16px");
    expect(trigger.style.height).toBe("20px");
  });

  it("selects the agent when the trigger is clicked", () => {
    const onSelect = vi.fn();
    renderHover(onSelect);

    render(tooltipProps().trigger as ReactElement);
    fireEvent.click(
      screen.getByTestId("comm-graph-office-hover-trigger-agent-1"),
    );

    expect(onSelect).toHaveBeenCalledWith("agent-1");
  });
});
