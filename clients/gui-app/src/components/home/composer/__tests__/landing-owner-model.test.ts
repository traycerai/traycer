import { describe, expect, it } from "vitest";
import type { EpicShareableTeam } from "@/stores/auth/auth-store";
import {
  epicCreateOwnerFor,
  landingOwnerRefusal,
  resolveLandingOwner,
  teamCreateSignInLine,
  teamFirstChatLine,
} from "@/components/home/composer/landing-owner-model";

/**
 * Landing owner model: who a new task belongs to, why a team create is refused
 * before any frame, and the verbatim lines the landing draft says.
 */

const ACME: EpicShareableTeam = {
  teamId: "t1",
  slug: "acme",
  avatarUrl: null,
};
const BETA: EpicShareableTeam = {
  teamId: "t2",
  slug: "beta",
  avatarUrl: null,
};
const TEAMS: ReadonlyArray<EpicShareableTeam> = [ACME, BETA];

const HOST_TOO_OLD = "This host can't create team tasks yet. Update the host.";
const OWNER = { teamId: "t1", slug: "acme" } as const;

describe("resolveLandingOwner", () => {
  it("is the team that owns the resolved host, with its slug, when the person is in it", () => {
    expect(
      resolveLandingOwner({ resolvedHostTeamId: "t1", teams: TEAMS }),
    ).toEqual({ teamId: "t1", slug: "acme" });
  });

  it("is Personal when the host's team is not among the person's teams", () => {
    expect(
      resolveLandingOwner({ resolvedHostTeamId: "t-gone", teams: TEAMS }),
    ).toBeNull();
  });

  it("is Personal when the host belongs to no team", () => {
    expect(
      resolveLandingOwner({ resolvedHostTeamId: null, teams: TEAMS }),
    ).toBeNull();
  });
});

describe("landingOwnerRefusal", () => {
  it("refuses a host with no epic.create at all", () => {
    expect(
      landingOwnerRefusal({
        owner: OWNER,
        hostEpicCreateVersion: false,
        cloudAuthorized: true,
      }),
    ).toBe(HOST_TOO_OLD);
  });

  it.each([
    { major: 1, minor: 0 },
    { major: 1, minor: 1 },
    { major: 1, minor: 2 },
  ])("refuses a host on epic.create $major.$minor", (version) => {
    expect(
      landingOwnerRefusal({
        owner: OWNER,
        hostEpicCreateVersion: version,
        cloudAuthorized: true,
      }),
    ).toBe(HOST_TOO_OLD);
  });

  it("names the host before the sign-in when both are wrong", () => {
    expect(
      landingOwnerRefusal({
        owner: OWNER,
        hostEpicCreateVersion: { major: 1, minor: 2 },
        cloudAuthorized: false,
      }),
    ).toBe(HOST_TOO_OLD);
    expect(
      landingOwnerRefusal({
        owner: OWNER,
        hostEpicCreateVersion: false,
        cloudAuthorized: false,
      }),
    ).toBe(HOST_TOO_OLD);
  });

  it.each([
    { major: 1, minor: 3 },
    { major: 1, minor: 4 },
  ])(
    "asks a signed-out person to sign in on epic.create $major.$minor",
    (version) => {
      expect(
        landingOwnerRefusal({
          owner: OWNER,
          hostEpicCreateVersion: version,
          cloudAuthorized: false,
        }),
      ).toBe("Sign in to create a task for acme.");
    },
  );

  it("does not refuse a signed-in person on a host that carries the owner", () => {
    expect(
      landingOwnerRefusal({
        owner: OWNER,
        hostEpicCreateVersion: { major: 1, minor: 3 },
        cloudAuthorized: true,
      }),
    ).toBeNull();
    expect(
      landingOwnerRefusal({
        owner: OWNER,
        hostEpicCreateVersion: { major: 1, minor: 4 },
        cloudAuthorized: true,
      }),
    ).toBeNull();
  });

  it("leaves an unknown version to the transport floor when signed in", () => {
    expect(
      landingOwnerRefusal({
        owner: OWNER,
        hostEpicCreateVersion: null,
        cloudAuthorized: true,
      }),
    ).toBeNull();
  });

  it("still asks an unknown-version host's signed-out person to sign in", () => {
    expect(
      landingOwnerRefusal({
        owner: OWNER,
        hostEpicCreateVersion: null,
        cloudAuthorized: false,
      }),
    ).toBe("Sign in to create a task for acme.");
  });
});

describe("verbatim landing lines", () => {
  it("states the sign-in line with the team's slug", () => {
    expect(teamCreateSignInLine("acme")).toBe(
      "Sign in to create a task for acme.",
    );
    expect(teamCreateSignInLine("platform-crew")).toBe(
      "Sign in to create a task for platform-crew.",
    );
  });

  it("states the first-chat line with no trailing period", () => {
    expect(teamFirstChatLine("acme")).toBe(
      "Chats here are visible to everyone in acme",
    );
    expect(teamFirstChatLine("platform-crew")).toBe(
      "Chats here are visible to everyone in platform-crew",
    );
  });
});

describe("epicCreateOwnerFor", () => {
  it("sends a team pick as a team owner", () => {
    expect(epicCreateOwnerFor({ teamId: "t1", slug: "acme" })).toEqual({
      kind: "team",
      teamId: "t1",
    });
  });

  it("sends Personal as no owner", () => {
    expect(epicCreateOwnerFor(null)).toBeNull();
  });
});
