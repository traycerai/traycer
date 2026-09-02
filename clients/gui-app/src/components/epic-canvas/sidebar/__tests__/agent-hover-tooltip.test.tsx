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

interface HoverOverrides {
  readonly hostId: string | null;
  readonly ownerKind: "chat" | "terminal-agent" | null;
  readonly ownerHostUnreachable: boolean;
  readonly roleClaims: readonly RoleClaim[];
  readonly side: "top" | "right" | "bottom" | "left";
  readonly extraContent: React.ReactNode | null;
}

const NO_EXTRA: Pick<HoverOverrides, "extraContent"> = { extraContent: null };

function renderHover(overrides: HoverOverrides) {
  render(
    <TooltipProvider>
      <AgentHoverTooltip
        trigger={<button type="button">Reviewer</button>}
        epicId="epic-1"
        nodeId="agent-1"
        nodeName="Reviewer"
        hostId={overrides.hostId}
        ownerHostUnreachable={overrides.ownerHostUnreachable}
        ownerKind={overrides.ownerKind}
        roleClaims={overrides.roleClaims}
        extraContent={overrides.extraContent}
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
      ownerHostUnreachable: false,
      ownerKind: "chat",
      roleClaims: [CLAIM],
      side: "top",
      ...NO_EXTRA,
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

  it("degrades to the role tooltip when the owner host is unreachable", async () => {
    // Outcome 1's content is a live RPC chain against the row's OWN binding
    // host, and branch and worktree path are filesystem facts of that machine
    // - so there is nothing to replicate that would let the card render
    // truthfully while the host is gone. Falling back shows what is still
    // true. Same inputs as the test above apart from this one flag, so the
    // flag is what proves to be the gate.
    renderHover({
      hostId: "host-a",
      ownerHostUnreachable: true,
      ownerKind: "chat",
      roleClaims: [CLAIM],
      side: "top",
      ...NO_EXTRA,
    });

    expect(screen.queryByTestId("worktree-owner-tooltip")).toBeNull();
    await userEvent.hover(screen.getByRole("button", { name: "Reviewer" }));

    const content = await screen.findByTestId("agent-role-hover-content");
    expect(content.textContent).toContain("Edge owner");
  });

  it("still shows the NAME on hover for an unreachable owner with no roles", async () => {
    // Never a bare trigger: sidebar rows and graph nodes truncate, so the
    // tooltip is the only place a long agent name is readable - and an offline
    // machine does not make its agent's name less true.
    renderHover({
      hostId: "host-a",
      ownerHostUnreachable: true,
      ownerKind: "chat",
      roleClaims: [],
      side: "top",
      ...NO_EXTRA,
    });

    const trigger = screen.getByRole("button", { name: "Reviewer" });
    await userEvent.hover(trigger);
    expect(await screen.findAllByText("Reviewer")).not.toHaveLength(0);
  });

  it("falls back to a role-only tooltip when there is no owner metadata", async () => {
    renderHover({
      hostId: null,
      ownerHostUnreachable: false,
      ownerKind: null,
      roleClaims: [CLAIM],
      side: "top",
      ...NO_EXTRA,
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
      ownerHostUnreachable: false,
      ownerKind: null,
      roleClaims: [],
      side: "top",
      ...NO_EXTRA,
    });

    expect(screen.queryByTestId("worktree-owner-tooltip")).toBeNull();
    const trigger = screen.getByRole("button", { name: "Reviewer" });
    await userEvent.hover(trigger);
    expect(screen.queryByTestId("agent-role-hover-content")).toBeNull();
  });

  it("puts the caller's own content under the role content", () => {
    // The office adds a line of its own beneath the shared card. Both have to
    // survive: the floor's posture line replacing the roles would be a
    // regression the surfaces could not see in each other.
    renderHover({
      hostId: "host-a",
      ownerHostUnreachable: false,
      ownerKind: "chat",
      roleClaims: [CLAIM],
      side: "top",
      extraContent: (
        <span data-testid="caller-extra">Working · large model</span>
      ),
    });

    const supplemental = screen.getByTestId("worktree-supplemental");
    expect(supplemental.textContent).toContain("Edge owner");
    expect(supplemental.textContent).toContain("Working · large model");
    // Under, not over: the shared card's own content comes first.
    const roles = supplemental.textContent.indexOf("Edge owner");
    const own = supplemental.textContent.indexOf("Working");
    expect(roles).toBeLessThan(own);
  });

  it("still names the agent when the caller passes no extra content", async () => {
    // `ReactNode` includes `undefined`, so an omitted `extraContent` is not
    // `null`. Testing only for `null` built an empty fragment, and a non-null
    // supplemental is what displaces the name label - so the card lost its
    // title and put nothing in its place.
    render(
      <TooltipProvider>
        <AgentHoverTooltip
          trigger={<button type="button">Reviewer of everything</button>}
          epicId="epic-1"
          nodeId="agent-1"
          nodeName="Reviewer of everything"
          hostId="host-a"
          ownerHostUnreachable
          ownerKind="chat"
          roleClaims={[]}
          // EXPLICITLY undefined, which is what the prop's `ReactNode` admits
          // and what a caller that has nothing to add passes.
          extraContent={undefined}
          side="top"
        />
      </TooltipProvider>,
    );

    const trigger = screen.getByRole("button", {
      name: "Reviewer of everything",
    });
    await userEvent.hover(trigger);

    const labels = await screen.findAllByText("Reviewer of everything");
    expect(labels).not.toHaveLength(0);
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
          ownerHostUnreachable={false}
          ownerKind={null}
          roleClaims={[CLAIM]}
          extraContent={null}
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
      ownerHostUnreachable: false,
      ownerKind: "chat",
      roleClaims: [CLAIM],
      side: "right",
      ...NO_EXTRA,
    });

    expect(
      screen.getByTestId("worktree-owner-tooltip").getAttribute("data-side"),
    ).toBe("right");
  });
});
