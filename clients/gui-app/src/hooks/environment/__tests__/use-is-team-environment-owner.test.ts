import { describe, expect, it } from "vitest";
import type { EnvironmentListResponse } from "@traycer/protocol/host/environment/contracts";
import { isTeamEnvironmentOwner } from "@/hooks/environment/use-is-team-environment-owner";

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

describe("isTeamEnvironmentOwner", () => {
  it("is true when the chat's owner is one of the viewer's team environments", () => {
    expect(isTeamEnvironmentOwner(ENVIRONMENTS, "env-team-1")).toBe(true);
  });

  it("is false for the viewer's personal environment, a person and an unknown id", () => {
    expect(isTeamEnvironmentOwner(ENVIRONMENTS, "user-1")).toBe(false);
    expect(isTeamEnvironmentOwner(ENVIRONMENTS, "some-collaborator")).toBe(
      false,
    );
  });

  it("is false for an unresolved owner and for a list not answered yet", () => {
    expect(isTeamEnvironmentOwner(ENVIRONMENTS, null)).toBe(false);
    expect(isTeamEnvironmentOwner(undefined, "env-team-1")).toBe(false);
  });
});
