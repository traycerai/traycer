import { describe, expect, it } from "vitest";
import type {
  AuthenticatedUser,
  TraycerTeamSubscription,
} from "@traycer/protocol/auth";
import {
  teamSubscription,
  userSubscription,
  userWith,
} from "@/lib/sandboxes/__tests__/auth-user-fixture";
import {
  defaultBelongsTo,
  SANDBOX_CREATE_ASK_ADMIN_LABEL,
  SANDBOX_CREATE_ENVIRONMENT_UNAVAILABLE_LINE,
  sandboxCreateTeams,
  sandboxNoProvidersLine,
  sandboxNotAMemberLine,
  sandboxTeamCreateLines,
  teamCannotCoverAnHour,
  teamHasNoProviders,
  teamSandboxBalanceMc,
  type SandboxCreateTeam,
} from "@/components/hosts/sandbox-create-model";

const EPOCH = new Date(0);

interface TeamCredits {
  readonly totalPlanCredits: number;
  readonly consumedFromPlan: number;
  readonly bonusCredits: number;
  readonly consumedFromBonus: number;
  readonly bundleRemaining: number;
}

/** One `teamSubscriptions` entry: the shared fixture's, under another team. */
function teamEntry(
  id: string,
  slug: string,
  credits: TeamCredits,
): TraycerTeamSubscription {
  const base = teamSubscription(credits.totalPlanCredits);
  return {
    ...base,
    teamID: id,
    team: { ...base.team, id, slug },
    bundleSummary: {
      bundleTotal: credits.bundleRemaining,
      bundleConsumed: 0,
      bundleRemaining: credits.bundleRemaining,
    },
    credit: {
      id: `credit-${id}`,
      userId: "u1",
      customerId: "cus",
      lastResetAt: EPOCH,
      consumedFromPlan: credits.consumedFromPlan,
      bonusCredits: credits.bonusCredits,
      consumedFromBonus: credits.consumedFromBonus,
      orgId: `org-${id}`,
    },
  };
}

const NO_CREDITS: TeamCredits = {
  totalPlanCredits: 0,
  consumedFromPlan: 0,
  bonusCredits: 0,
  consumedFromBonus: 0,
  bundleRemaining: 0,
};

const PERSONAL = userSubscription({
  totalPlanCredits: 3,
  consumedFromPlan: 0,
  bonusCredits: 0,
  consumedFromBonus: 0,
  bundleRemaining: 0,
});

function userInTeams(
  teams: readonly TraycerTeamSubscription[],
): AuthenticatedUser {
  return userWith(PERSONAL, [...teams]);
}

const ACME: SandboxCreateTeam = { teamId: "team-acme", name: "acme" };
const ZETA: SandboxCreateTeam = { teamId: "team-zeta", name: "zeta" };

describe("sandboxCreateTeams", () => {
  it("is an empty list for a user that has not loaded", () => {
    expect(sandboxCreateTeams(null)).toEqual([]);
  });

  it("is an empty list for a user in no team", () => {
    expect(sandboxCreateTeams(userInTeams([]))).toEqual([]);
  });

  it("names each team by its slug and sorts by name, then by id", () => {
    const user = userInTeams([
      teamEntry("team-zeta", "zeta", NO_CREDITS),
      teamEntry("t-2", "acme", NO_CREDITS),
      teamEntry("t-1", "acme", NO_CREDITS),
      teamEntry("team-mid", "mid", NO_CREDITS),
    ]);
    expect(sandboxCreateTeams(user)).toEqual([
      { teamId: "t-1", name: "acme" },
      { teamId: "t-2", name: "acme" },
      { teamId: "team-mid", name: "mid" },
      { teamId: "team-zeta", name: "zeta" },
    ]);
  });
});

describe("defaultBelongsTo", () => {
  const teams = [ACME, ZETA];

  it("lets an entry preselection of a team the person is in win over the working host's team", () => {
    expect(
      defaultBelongsTo(
        { kind: "team", teamId: ZETA.teamId },
        ACME.teamId,
        teams,
      ),
    ).toEqual({ kind: "team", teamId: ZETA.teamId });
  });

  it("lets an entry preselection of Personal win over the working host's team", () => {
    expect(defaultBelongsTo({ kind: "personal" }, ACME.teamId, teams)).toEqual({
      kind: "personal",
    });
  });

  it("falls a preselected team the person is not in through to the working host's team", () => {
    expect(
      defaultBelongsTo(
        { kind: "team", teamId: "team-gone" },
        ZETA.teamId,
        teams,
      ),
    ).toEqual({ kind: "team", teamId: ZETA.teamId });
  });

  it("falls a preselected team the person is not in, with no working host team, through to Personal", () => {
    expect(
      defaultBelongsTo({ kind: "team", teamId: "team-gone" }, null, teams),
    ).toEqual({ kind: "personal" });
  });

  it("picks the team that owns the host the person works from when nothing is preselected", () => {
    expect(defaultBelongsTo(null, ACME.teamId, teams)).toEqual({
      kind: "team",
      teamId: ACME.teamId,
    });
  });

  it("is Personal when the working host's team is one the person is not in", () => {
    expect(defaultBelongsTo(null, "team-gone", teams)).toEqual({
      kind: "personal",
    });
  });

  it("is Personal when nothing is preselected and the working host has no team", () => {
    expect(defaultBelongsTo(null, null, teams)).toEqual({ kind: "personal" });
  });

  it("is Personal for a person in no team, whatever the working host's team", () => {
    expect(defaultBelongsTo(null, ACME.teamId, [])).toEqual({
      kind: "personal",
    });
  });
});

describe("sandboxTeamCreateLines", () => {
  it("is the four lines, verbatim and in order", () => {
    expect(sandboxTeamCreateLines("acme")).toEqual([
      "Belongs to: acme",
      "Charged to your bundle under acme.",
      "Chats on it are visible to the people of the task you use it in, which can include people outside acme.",
      "Agents on it work with acme's hosts only; they cannot work with agents on your own computer. The task still shares its files and chats.",
    ]);
  });
});

describe("teamSandboxBalanceMc", () => {
  it("is the remaining plan, bonus and bundle credits of that team's entry, in millicredits", () => {
    const user = userInTeams([
      teamEntry("team-acme", "acme", {
        totalPlanCredits: 100,
        consumedFromPlan: 40,
        bonusCredits: 10,
        consumedFromBonus: 4,
        bundleRemaining: 5,
      }),
      teamEntry("team-zeta", "zeta", {
        totalPlanCredits: 9_000,
        consumedFromPlan: 0,
        bonusCredits: 0,
        consumedFromBonus: 0,
        bundleRemaining: 0,
      }),
    ]);
    // 60 plan + 6 bonus + 5 bundle = 71 credits, under acme only.
    expect(teamSandboxBalanceMc(user, "team-acme")).toBe(71_000);
  });

  it("does not read the personal subscription", () => {
    const user = userInTeams([teamEntry("team-acme", "acme", NO_CREDITS)]);
    expect(teamSandboxBalanceMc(user, "team-acme")).toBe(0);
  });

  it("clamps an overspent team balance to zero", () => {
    const user = userInTeams([
      teamEntry("team-acme", "acme", {
        totalPlanCredits: 10,
        consumedFromPlan: 10,
        bonusCredits: 2,
        consumedFromBonus: 9,
        bundleRemaining: 0,
      }),
    ]);
    expect(teamSandboxBalanceMc(user, "team-acme")).toBe(0);
  });

  it("floors a fractional credit balance to whole millicredits", () => {
    const user = userInTeams([
      teamEntry("team-acme", "acme", {
        totalPlanCredits: 1,
        consumedFromPlan: 0.0004,
        bonusCredits: 0,
        consumedFromBonus: 0,
        bundleRemaining: 0,
      }),
    ]);
    expect(teamSandboxBalanceMc(user, "team-acme")).toBe(999);
  });

  it("is null for a team the user has no entry under", () => {
    const user = userInTeams([teamEntry("team-acme", "acme", NO_CREDITS)]);
    expect(teamSandboxBalanceMc(user, "team-gone")).toBeNull();
  });

  it("is null until a user has loaded", () => {
    expect(teamSandboxBalanceMc(null, "team-acme")).toBeNull();
  });
});

describe("teamCannotCoverAnHour", () => {
  it("is true when the balance is below the region's from price", () => {
    expect(teamCannotCoverAnHour(119, 120)).toBe(true);
    expect(teamCannotCoverAnHour(0, 120)).toBe(true);
  });

  it("is false when the balance equals the from price", () => {
    expect(teamCannotCoverAnHour(120, 120)).toBe(false);
  });

  it("is false when the balance is above the from price", () => {
    expect(teamCannotCoverAnHour(121, 120)).toBe(false);
  });

  it("is false when either side is unknown", () => {
    expect(teamCannotCoverAnHour(null, 120)).toBe(false);
    expect(teamCannotCoverAnHour(0, null)).toBe(false);
    expect(teamCannotCoverAnHour(null, null)).toBe(false);
  });
});

describe("teamHasNoProviders", () => {
  it("is true only for zero API keys and zero plans", () => {
    expect(
      teamHasNoProviders({ providerSecretCount: 0, connectedPlanCount: 0 }),
    ).toBe(true);
  });

  it("is false for an API key alone", () => {
    expect(
      teamHasNoProviders({ providerSecretCount: 1, connectedPlanCount: 0 }),
    ).toBe(false);
  });

  it("is false for a plan alone", () => {
    expect(
      teamHasNoProviders({ providerSecretCount: 0, connectedPlanCount: 1 }),
    ).toBe(false);
  });

  it("is false while the counts are not known", () => {
    expect(teamHasNoProviders(null)).toBe(false);
  });
});

describe("the refusal and warning copy", () => {
  it("names the team in the no-providers line", () => {
    expect(sandboxNoProvidersLine("acme")).toBe(
      "No providers configured for acme; agents cannot run until an admin adds one",
    );
  });

  it("names the team in the not-a-member line", () => {
    expect(sandboxNotAMemberLine("acme")).toBe("You are not a member of acme.");
  });

  it("carries the unavailable line and the ask-admin label verbatim", () => {
    expect(SANDBOX_CREATE_ENVIRONMENT_UNAVAILABLE_LINE).toBe(
      "Traycer couldn't check where this sandbox belongs. Try again in a moment.",
    );
    expect(SANDBOX_CREATE_ASK_ADMIN_LABEL).toBe(
      "Ask a team admin for more capacity",
    );
  });
});
