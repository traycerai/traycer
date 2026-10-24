import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvironmentApplyFailedCard } from "@/components/notifications/environment-apply-failed-card";
import { EnvironmentMoveStalledCard } from "@/components/notifications/environment-move-stalled-card";
import { SecretRemovedCard } from "@/components/notifications/secret-removed-card";
import { TeamHostReturnedCard } from "@/components/notifications/team-host-returned-card";
import type { TeamRole } from "@/components/settings/members/types";
import { TeamRoleChangedCard } from "@/components/notifications/team-role-changed-card";

afterEach(cleanup);

const VIEWER: TeamRole = "viewer";

const DETAILS = <button type="button">Details</button>;

describe("SecretRemovedCard", () => {
  it.each([
    ["revoked", "Access revoked"],
    ["cleanup_requested", "Cleanup requested"],
    ["destroyed", "Destroyed"],
  ] as const)("says %s as %s", (outcome, word) => {
    render(
      <SecretRemovedCard
        secretName="GH_TOKEN"
        outcome={outcome}
        details={DETAILS}
      />,
    );
    expect(screen.getByTestId("secret-removed-name").textContent).toBe(
      "GH_TOKEN",
    );
    expect(screen.getByTestId("secret-removed-outcome").textContent).toBe(word);
    expect(screen.getByRole("button", { name: "Details" })).toBeTruthy();
  });
});

describe("TeamRoleChangedCard", () => {
  it("shows the grant for the new role with Details", () => {
    render(
      <TeamRoleChangedCard
        teamName="Acme"
        role={VIEWER}
        noticeText="notice"
        details={DETAILS}
      />,
    );
    expect(screen.getByTestId("role-grant-prefix").textContent).toBe(
      "Read-only environment settings.",
    );
    expect(screen.getByRole("button", { name: "Details" })).toBeTruthy();
  });
});

describe("TeamHostReturnedCard", () => {
  it("names the host and the team", () => {
    render(
      <TeamHostReturnedCard
        hostName="dev-box"
        teamName="Acme"
        details={DETAILS}
      />,
    );
    expect(screen.getByTestId("team-host-returned-body").textContent).toBe(
      "dev-box went back to your own settings from Acme.",
    );
    expect(screen.getByRole("button", { name: "Details" })).toBeTruthy();
  });
});

describe("EnvironmentMoveStalledCard", () => {
  it("names the remainder and opens the host Overview", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(
      <EnvironmentMoveStalledCard
        hostName="dev-box"
        remaining={3}
        reason="Host offline."
        details={DETAILS}
        onOpenHostOverview={onOpen}
      />,
    );
    expect(
      screen.getByTestId("environment-move-stalled-body").textContent,
    ).toBe("dev-box has not finished moving. 3 remaining. Host offline.");
    await user.click(screen.getByRole("button", { name: "Open Overview" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("offers no Overview jump without a handler", () => {
    render(
      <EnvironmentMoveStalledCard
        hostName="dev-box"
        remaining={1}
        reason="x"
        details={DETAILS}
        onOpenHostOverview={null}
      />,
    );
    expect(screen.queryByRole("button", { name: "Open Overview" })).toBeNull();
  });
});

describe("EnvironmentApplyFailedCard", () => {
  it("names the item, the host and the reason", () => {
    render(
      <EnvironmentApplyFailedCard
        hostName="dev-box"
        itemKey="MCP_URL"
        reason="Permission denied."
        details={DETAILS}
      />,
    );
    expect(
      screen.getByTestId("environment-apply-failed-body").textContent,
    ).toBe("MCP_URL was not applied on dev-box. Permission denied.");
    expect(screen.getByRole("button", { name: "Details" })).toBeTruthy();
  });
});
