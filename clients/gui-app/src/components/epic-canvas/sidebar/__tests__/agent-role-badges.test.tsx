import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RoleClaim } from "@traycer/protocol/persistence/epic/role-claims";
import { AgentRoleBadges } from "../agent-role-badges";

afterEach(cleanup);

function claim(claimId: string, role: string, scope: string): RoleClaim {
  return {
    claimId,
    agentId: "agent-a",
    userId: "user-a",
    role,
    scope,
    claimedAt: 1,
  };
}

describe("AgentRoleBadges", () => {
  it("renders role labels with scoped descriptions and an overflow count", () => {
    render(
      <AgentRoleBadges
        claims={[
          claim(
            "10000000-0000-4000-8000-000000000001",
            "Planner",
            "Authentication",
          ),
          claim("10000000-0000-4000-8000-000000000002", "Reviewer", "API"),
          claim("10000000-0000-4000-8000-000000000003", "Tester", "Desktop"),
        ]}
      />,
    );

    expect(
      screen
        .getByLabelText("Role Planner, scope Authentication")
        .getAttribute("title"),
    ).toBe("Planner — Authentication");
    expect(screen.getByText("Reviewer")).toBeTruthy();
    expect(screen.queryByText("Tester")).toBeNull();
    expect(screen.getByLabelText("1 more roles").textContent).toBe("+1");
  });

  it("renders nothing for an agent without roles", () => {
    const { container } = render(<AgentRoleBadges claims={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
