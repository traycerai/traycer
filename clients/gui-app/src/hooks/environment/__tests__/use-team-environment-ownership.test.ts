import { describe, expect, it } from "vitest";
import type { EnvironmentListResponse } from "@traycer/protocol/host/environment/contracts";
import { teamEnvironmentOwnership } from "@/hooks/environment/use-team-environment-ownership";

const ENVIRONMENTS: EnvironmentListResponse = {
  environments: [
    {
      environmentId: "user-1",
      ownerKind: "user",
      ownerId: "user-1",
      roomId: "room-personal",
      label: "Personal",
    },
    {
      environmentId: "env-team-1",
      ownerKind: "organization",
      ownerId: "org-1",
      roomId: "room-team",
      label: "acme",
    },
  ],
};

describe("teamEnvironmentOwnership", () => {
  it("is team when the owner host's row is a team sandbox, before the list has answered", () => {
    expect(
      teamEnvironmentOwnership({
        ownerHostIsTeamSandbox: true,
        listApplies: true,
        environments: undefined,
        ownerUserId: "env-team-1",
      }),
    ).toBe("team");
  });

  it("is team from the row alone when the list does not apply", () => {
    expect(
      teamEnvironmentOwnership({
        ownerHostIsTeamSandbox: true,
        listApplies: false,
        environments: undefined,
        ownerUserId: null,
      }),
    ).toBe("team");
  });

  it("is team when the answered list holds an organization environment with the owner's id", () => {
    expect(
      teamEnvironmentOwnership({
        ownerHostIsTeamSandbox: false,
        listApplies: true,
        environments: ENVIRONMENTS,
        ownerUserId: "env-team-1",
      }),
    ).toBe("team");
  });

  it("is other when the answered list has no match, including the viewer's personal environment", () => {
    for (const ownerUserId of ["user-1", "some-collaborator"]) {
      expect(
        teamEnvironmentOwnership({
          ownerHostIsTeamSandbox: false,
          listApplies: true,
          environments: ENVIRONMENTS,
          ownerUserId,
        }),
      ).toBe("other");
    }
  });

  it("is other when the list does not apply, whatever it holds", () => {
    expect(
      teamEnvironmentOwnership({
        ownerHostIsTeamSandbox: false,
        listApplies: false,
        environments: undefined,
        ownerUserId: "env-team-1",
      }),
    ).toBe("other");
    expect(
      teamEnvironmentOwnership({
        ownerHostIsTeamSandbox: false,
        listApplies: false,
        environments: ENVIRONMENTS,
        ownerUserId: "env-team-1",
      }),
    ).toBe("other");
  });

  it("is other for an unresolved owner once the list has answered", () => {
    expect(
      teamEnvironmentOwnership({
        ownerHostIsTeamSandbox: false,
        listApplies: true,
        environments: ENVIRONMENTS,
        ownerUserId: null,
      }),
    ).toBe("other");
  });

  it("is unknown while the list applies but has not answered and no row says team", () => {
    expect(
      teamEnvironmentOwnership({
        ownerHostIsTeamSandbox: false,
        listApplies: true,
        environments: undefined,
        ownerUserId: "env-team-1",
      }),
    ).toBe("unknown");
    expect(
      teamEnvironmentOwnership({
        ownerHostIsTeamSandbox: false,
        listApplies: true,
        environments: undefined,
        ownerUserId: null,
      }),
    ).toBe("unknown");
  });
});
