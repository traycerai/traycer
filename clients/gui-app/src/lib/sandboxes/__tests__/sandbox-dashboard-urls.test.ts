import { describe, expect, it } from "vitest";
import {
  seatsManagementPath,
  teamPlanPath,
} from "@/components/settings/members/dashboard-urls";
import { billingPathFor } from "@/lib/auth/platform-base-url";
import { teamGithubDashboardUrl } from "@/lib/sandboxes/secrets-dashboard";
import {
  sandboxAddCreditsUrl,
  sandboxTeamUsageUrl,
} from "@/lib/sandboxes/sandbox-row-lines";

const SIGN_IN = "https://platform.example.dev/sign-in";
const ORIGIN = "https://platform.example.dev";

// The routes the dashboard serves for a team, by exact value.
describe("the dashboard's team routes", () => {
  it("opens the team's usage under its environment", () => {
    expect(sandboxTeamUsageUrl(SIGN_IN, "acme")).toBe(
      `${ORIGIN}/team/acme/environment/usage`,
    );
  });

  it("keeps the other team routes where the dashboard serves them", () => {
    expect(
      sandboxAddCreditsUrl(SIGN_IN, {
        kind: "team",
        teamId: "team-1",
        teamName: "acme",
        environmentId: null,
      }),
    ).toBe(`${ORIGIN}/team/acme/billing`);
    expect(seatsManagementPath("acme")).toBe("/team/acme/seat-management");
    expect(teamPlanPath("acme")).toBe("/team/acme/environment/plan");
    expect(teamGithubDashboardUrl(SIGN_IN, "acme")).toBe(
      `${ORIGIN}/team/acme/environment/github`,
    );
    expect(
      billingPathFor({ type: "TEAM", teamId: "team-1" }, [
        { teamId: "team-1", slug: "acme" },
      ]),
    ).toBe("/team/acme/billing");
  });
});
