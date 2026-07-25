import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RoleClaim } from "@traycer/protocol/persistence/epic/role-claims";
import { AgentRoleBadges, AgentRoleHoverContent } from "../agent-role-badges";

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
  it("keeps role metadata compact in the sidebar row", () => {
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

    expect(screen.getByLabelText("3 roles").textContent).toBe("3");
    expect(screen.queryByText("Planner")).toBeNull();
    expect(screen.queryByText("Reviewer")).toBeNull();
    expect(screen.queryByText("Tester")).toBeNull();
  });

  it("uses a short, truncated role label when there is one claim", () => {
    render(
      <AgentRoleBadges
        claims={[
          claim(
            "10000000-0000-4000-8000-000000000001",
            "Chief Prankster & Master of Ceremonies",
            "Epic-wide",
          ),
        ]}
      />,
    );

    const badge = screen.getByLabelText(
      "Role Chief Prankster & Master of Ceremonies, scope Epic-wide",
    );
    expect(badge.textContent).toContain("Chief Prankster");
    expect(badge.querySelector(".truncate")).toBeTruthy();
  });

  it("renders every role and scope in the hover detail", () => {
    render(
      <AgentRoleHoverContent
        agentName="Prankster and Master of Ceremonies"
        claims={[
          claim(
            "10000000-0000-4000-8000-000000000001",
            "Chief Prankster & Master of Ceremonies",
            "Epic-wide",
          ),
          claim("10000000-0000-4000-8000-000000000002", "Reviewer", "API"),
        ]}
      />,
    );

    expect(screen.getByText("Agent roles")).toBeTruthy();
    expect(screen.getByText("Prankster and Master of Ceremonies")).toBeTruthy();
    expect(
      screen.getByText("Chief Prankster & Master of Ceremonies"),
    ).toBeTruthy();
    expect(screen.getByText("Scope · Epic-wide")).toBeTruthy();
    expect(screen.getByText("Reviewer")).toBeTruthy();
    expect(screen.getByText("Scope · API")).toBeTruthy();
  });

  it("renders nothing for an agent without roles", () => {
    const { container } = render(<AgentRoleBadges claims={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
