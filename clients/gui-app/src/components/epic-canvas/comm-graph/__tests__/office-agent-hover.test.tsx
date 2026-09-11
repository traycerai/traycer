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
import { followOfficeHover } from "@/components/epic-canvas/comm-graph/office/office-hover-follow";
import { OfficeHoverSupplement } from "@/components/epic-canvas/comm-graph/office/office-hover-supplement";
import type { OfficeHitRegion } from "@/lib/comm-graph/office/office-types";

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

/**
 * The floor is repainted every frame and a character away from its desk moves
 * a fraction of a tile per frame. The card is placed on a pointer event, so
 * between events it is the frame loop that has to decide whether the pointer
 * is still on the agent and where the agent has got to - and it must do that
 * from the pointer's position, not from whether the box is where it was.
 * Comparing boxes closed the card on the first frame of every walk.
 */
describe("followOfficeHover", () => {
  const IDENTITY = { x: 0, y: 0, zoom: 1 };
  function walker(x: number, agentId: string): OfficeHitRegion {
    return { agentId, rect: { x, y: 32, width: 16, height: 20 } };
  }

  it("moves the card with a walking character while the pointer stays on it", () => {
    const anchor = { agentId: "agent-1", screenX: 48, screenY: 40 };
    expect(
      followOfficeHover(anchor, [walker(40, "agent-1")], IDENTITY),
    ).toEqual({ x: 40, y: 32, width: 16, height: 20 });
    // A fraction of a tile later - the same pointer is still inside the box,
    // so the card is kept and re-placed over where the character now is.
    expect(
      followOfficeHover(anchor, [walker(40.75, "agent-1")], IDENTITY),
    ).toEqual({ x: 40.75, y: 32, width: 16, height: 20 });
  });

  it("closes once the character has walked out from under the pointer", () => {
    const anchor = { agentId: "agent-1", screenX: 48, screenY: 40 };
    expect(followOfficeHover(anchor, [walker(60, "agent-1")], IDENTITY)).toBe(
      null,
    );
  });

  it("closes when the character leaves the floor", () => {
    const anchor = { agentId: "agent-1", screenX: 48, screenY: 40 };
    expect(followOfficeHover(anchor, [], IDENTITY)).toBe(null);
  });

  it("closes rather than re-targeting when another character is painted over the pointer", () => {
    const anchor = { agentId: "agent-1", screenX: 48, screenY: 40 };
    // FRONT-MOST FIRST, which is the order the scene now reports its hit
    // regions in: agent-2 was painted over agent-1, so it leads the list and
    // the pointer is on it rather than on the agent the card belongs to.
    expect(
      followOfficeHover(
        anchor,
        [walker(44, "agent-2"), walker(40, "agent-1")],
        IDENTITY,
      ),
    ).toBe(null);
  });

  it("re-reads the pointer through the camera, so a pan under a still pointer is a real move", () => {
    const anchor = { agentId: "agent-1", screenX: 96, screenY: 80 };
    const camera = { x: 16, y: 16, zoom: 2 };
    // Sprite point (40, 32) sits inside the box; the card is placed in screen
    // pixels through the same camera.
    expect(followOfficeHover(anchor, [walker(40, "agent-1")], camera)).toEqual({
      x: 96,
      y: 80,
      width: 32,
      height: 40,
    });
    // The floor slides 40 screen pixels left under the stationary pointer,
    // which now lands past the character's box.
    expect(
      followOfficeHover(anchor, [walker(40, "agent-1")], {
        ...camera,
        x: -24,
      }),
    ).toBe(null);
  });
});
