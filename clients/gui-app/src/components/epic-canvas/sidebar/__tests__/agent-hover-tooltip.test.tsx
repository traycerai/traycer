import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoleClaim } from "@traycer/protocol/persistence/epic/role-claims";

const worktreeTooltipSpy = vi.hoisted(() => vi.fn());
vi.mock("@/components/worktree/worktree-owner-metadata", () => ({
  WorktreeOwnerMetadataTooltip: (props: {
    readonly trigger: React.ReactElement;
    readonly supplementalContent: React.ReactNode | null;
    readonly side: "top" | "right" | "bottom" | "left";
  }) => {
    worktreeTooltipSpy(props);
    return (
      <div data-testid="worktree-owner-tooltip" data-side={props.side}>
        {props.trigger}
        <div data-testid="worktree-supplemental">
          {props.supplementalContent}
        </div>
      </div>
    );
  },
}));

import { AgentHoverTooltip } from "@/components/epic-canvas/sidebar/agent-hover-tooltip";
import { TooltipProvider } from "@/components/ui/tooltip";

const CLAIM: RoleClaim = {
  claimId: "claim-1",
  role: "Edge owner",
  scope: "comm-graph edges",
  agentId: "agent-1",
  userId: "user-1",
  claimedAt: 1,
};

function renderHover(overrides: {
  readonly hostId: string | null;
  readonly ownerKind: "chat" | "terminal-agent" | null;
  readonly roleClaims: readonly RoleClaim[];
  readonly side: "top" | "right" | "bottom" | "left";
}) {
  render(
    <TooltipProvider>
      <AgentHoverTooltip
        trigger={<button type="button">Reviewer</button>}
        epicId="epic-1"
        nodeId="agent-1"
        nodeName="Reviewer"
        hostId={overrides.hostId}
        ownerKind={overrides.ownerKind}
        roleClaims={overrides.roleClaims}
        side={overrides.side}
      />
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
  worktreeTooltipSpy.mockClear();
});

/**
 * ONE hover for both the Agents navigator and the graph nodes. These pin the
 * precedence the sidebar established, so extracting it cannot quietly change
 * what either surface shows.
 */
describe("AgentHoverTooltip", () => {
  it("prefers owner metadata, carrying role claims as supplemental content", () => {
    renderHover({
      hostId: "host-a",
      ownerKind: "chat",
      roleClaims: [CLAIM],
      side: "top",
    });

    expect(
      screen.getByTestId("worktree-owner-tooltip").getAttribute("data-side"),
    ).toBe("top");
    // The roles ride along rather than replacing the richer card.
    expect(screen.getByTestId("worktree-supplemental").textContent).toContain(
      "Edge owner",
    );
    expect(screen.getByRole("button", { name: "Reviewer" })).toBeDefined();
  });

  it("falls back to a role-only tooltip when there is no owner metadata", async () => {
    renderHover({
      hostId: null,
      ownerKind: null,
      roleClaims: [CLAIM],
      side: "top",
    });

    expect(screen.queryByTestId("worktree-owner-tooltip")).toBeNull();
    await userEvent.hover(screen.getByRole("button", { name: "Reviewer" }));

    const content = await screen.findByTestId("agent-role-hover-content");
    expect(content.closest('[data-side="top"]')).not.toBeNull();
    expect(content.textContent).toContain("Edge owner");
    expect(content.textContent).toContain("comm-graph edges");
  });

  /**
   * An agent with nothing to say about itself gets NO hover - a card that opens
   * onto an empty box is worse than no card.
   */
  it("renders the bare trigger when there is nothing to show", async () => {
    renderHover({
      hostId: null,
      ownerKind: null,
      roleClaims: [],
      side: "top",
    });

    expect(screen.queryByTestId("worktree-owner-tooltip")).toBeNull();
    const trigger = screen.getByRole("button", { name: "Reviewer" });
    await userEvent.hover(trigger);
    expect(screen.queryByTestId("agent-role-hover-content")).toBeNull();
  });

  it("keeps the trigger's own click working under the tooltip", async () => {
    const onClick = vi.fn();
    render(
      <TooltipProvider>
        <AgentHoverTooltip
          trigger={
            <button type="button" onClick={onClick}>
              Reviewer
            </button>
          }
          epicId="epic-1"
          nodeId="agent-1"
          nodeName="Reviewer"
          hostId={null}
          ownerKind={null}
          roleClaims={[CLAIM]}
          side="top"
        />
      </TooltipProvider>,
    );

    // The graph node's detail-panel click and the sidebar's row click both live
    // on the trigger; a tooltip that swallowed them would break both surfaces.
    await userEvent.click(screen.getByRole("button", { name: "Reviewer" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("keeps the sidebar metadata hover on the right", () => {
    renderHover({
      hostId: "host-a",
      ownerKind: "chat",
      roleClaims: [CLAIM],
      side: "right",
    });

    expect(
      screen.getByTestId("worktree-owner-tooltip").getAttribute("data-side"),
    ).toBe("right");
  });
});
