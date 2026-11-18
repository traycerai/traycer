import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type {
  HostListItem,
  HostOwnerPrincipal,
} from "@traycer/protocol/host/host-status";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * A person who has joined a team but has not yet opened one of its hosts is
 * told where to start. "Newcomer" is read off the first-tab
 * disclosure record: a team none of whose hosts the person has opened.
 */

const mocks = vi.hoisted(() => {
  const hosts: { current: readonly HostListItem[] | null } = { current: null };
  return { hosts };
});

vi.mock("@/hooks/auth/use-registered-hosts-query", () => ({
  useRegisteredHosts: () => ({
    data: mocks.hosts.current === null ? null : { hosts: mocks.hosts.current },
  }),
}));
vi.mock("@/lib/host", () => ({ useHostBinding: () => null }));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => null,
}));
vi.mock("@/lib/mobile-app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mobile-app")>();
  return { ...actual, isMobileApp: () => false };
});

import {
  newcomerTeams,
  teamNewcomerLine,
} from "@/components/onboarding/set-up-team-model";
import { SetUpTeamGroup } from "@/components/onboarding/set-up-team-group";
import {
  teamHostDisclosureSeen,
  useTeamHostDisclosureSeenStore,
} from "@/stores/hosts/team-host-disclosure-seen-store";

const VIEWER = "user-viewer";
const ALPHA = { teamId: "team-a", slug: "alpha-slug", avatarUrl: null };
const BETA = { teamId: "team-b", slug: "beta-slug", avatarUrl: null };

function hostOf(hostId: string, owner: HostOwnerPrincipal): HostListItem {
  return {
    hostId,
    displayName: hostId,
    platform: "linux",
    kind: "sandbox",
    publicKey: `pk-${hostId}`,
    createdAt: "2026-10-01T00:00:00.000Z",
    status: {
      connectivity: "connectable",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.5.0",
      lastSeenAt: "2026-10-09T00:00:00.000Z",
    },
    updatePolicy: "manual",
    sandboxState: "awake",
    sandboxFrozen: false,
    profile: "agent",
    owner,
  };
}

function alphaHost(hostId: string): HostListItem {
  return hostOf(hostId, { kind: "team", id: ALPHA.teamId, name: "Alpha Team" });
}

function betaHost(hostId: string): HostListItem {
  return hostOf(hostId, { kind: "team", id: BETA.teamId, name: "Beta Team" });
}

function resetSeenStore(): void {
  window.localStorage.clear();
  useTeamHostDisclosureSeenStore.setState({ seen: {} });
}

function markSeen(viewerUserId: string, hostId: string): void {
  useTeamHostDisclosureSeenStore.getState().markSeen(viewerUserId, hostId);
}

describe("teamNewcomerLine", () => {
  it("names the team twice and says where to start", () => {
    expect(teamNewcomerLine("Alpha Team")).toBe(
      "To work in Alpha Team, open a tab on one of its sandboxes, in your host list under Alpha Team, or create one from there.",
    );
  });
});

describe("newcomerTeams", () => {
  beforeEach(resetSeenStore);
  afterEach(resetSeenStore);

  const TEAMS = [
    { teamId: "team-a", name: "Alpha Team" },
    { teamId: "team-b", name: "Beta Team" },
    { teamId: "team-c", name: "Gamma Team" },
  ] as const;

  function hostIdsByTeam(): ReadonlyMap<string, readonly string[]> {
    return new Map<string, readonly string[]>([
      ["team-a", ["host-a1", "host-a2"]],
      ["team-b", ["host-b1"]],
    ]);
  }

  it("keeps every team whose hosts the person has not opened, in input order", () => {
    const result = newcomerTeams({
      teams: TEAMS,
      hostIdsByTeam: hostIdsByTeam(),
      seen: useTeamHostDisclosureSeenStore.getState().seen,
      viewerUserId: VIEWER,
    });

    expect(result.map((t) => t.teamId)).toEqual(["team-a", "team-b", "team-c"]);
    expect(result[0]).toEqual({ teamId: "team-a", name: "Alpha Team" });
  });

  it("drops a team once the disclosure was seen on any one of its hosts", () => {
    markSeen(VIEWER, "host-a2");

    const result = newcomerTeams({
      teams: TEAMS,
      hostIdsByTeam: hostIdsByTeam(),
      seen: useTeamHostDisclosureSeenStore.getState().seen,
      viewerUserId: VIEWER,
    });

    expect(result.map((t) => t.teamId)).toEqual(["team-b", "team-c"]);
  });

  it("still lists a team whose host only another person has opened", () => {
    markSeen("user-someone-else", "host-a1");
    const seen = useTeamHostDisclosureSeenStore.getState().seen;
    expect(teamHostDisclosureSeen(seen, "user-someone-else", "host-a1")).toBe(
      true,
    );

    const result = newcomerTeams({
      teams: TEAMS,
      hostIdsByTeam: hostIdsByTeam(),
      seen,
      viewerUserId: VIEWER,
    });

    expect(result.map((t) => t.teamId)).toContain("team-a");
  });

  it("treats a team with no known hosts as a newcomer team", () => {
    const result = newcomerTeams({
      teams: TEAMS,
      hostIdsByTeam: new Map<string, readonly string[]>(),
      seen: useTeamHostDisclosureSeenStore.getState().seen,
      viewerUserId: VIEWER,
    });

    expect(result.map((t) => t.teamId)).toEqual(["team-a", "team-b", "team-c"]);
  });

  it("returns nothing for no teams", () => {
    expect(
      newcomerTeams({
        teams: [],
        hostIdsByTeam: hostIdsByTeam(),
        seen: useTeamHostDisclosureSeenStore.getState().seen,
        viewerUserId: VIEWER,
      }),
    ).toEqual([]);
  });
});

describe("<SetUpTeamGroup />", () => {
  beforeEach(() => {
    resetSeenStore();
    mocks.hosts.current = [alphaHost("host-a1"), betaHost("host-b1")];
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: VIEWER, username: "viewer" },
      shareableTeams: [ALPHA, BETA],
    });
  });
  afterEach(() => {
    cleanup();
    resetSeenStore();
    useAuthStore.setState({
      status: "signed-out",
      contextMetadata: null,
      shareableTeams: [],
    });
  });

  it("lists one line per newcomer team, named by the registry", () => {
    render(<SetUpTeamGroup surface="settings" />);

    const group = screen.getByTestId("set-up-team-group");
    const items = within(group).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain(teamNewcomerLine("Alpha Team"));
    expect(items[1]?.textContent).toContain(teamNewcomerLine("Beta Team"));
  });

  it("falls back to the team's slug when the registry names none of its hosts", () => {
    mocks.hosts.current = [betaHost("host-b1")];

    render(<SetUpTeamGroup surface="home" />);

    const items = within(screen.getByTestId("set-up-team-group")).getAllByRole(
      "listitem",
    );
    expect(items[0]?.textContent).toContain(teamNewcomerLine("alpha-slug"));
    expect(items[1]?.textContent).toContain(teamNewcomerLine("Beta Team"));
  });

  it("falls back to the slug while the registry has not answered", () => {
    mocks.hosts.current = null;

    render(<SetUpTeamGroup surface="home" />);

    const group = screen.getByTestId("set-up-team-group");
    expect(group.textContent).toContain(teamNewcomerLine("alpha-slug"));
    expect(group.textContent).toContain(teamNewcomerLine("beta-slug"));
  });

  it("drops a team once the person has opened one of its hosts", () => {
    markSeen(VIEWER, "host-a1");

    render(<SetUpTeamGroup surface="settings" />);

    const group = screen.getByTestId("set-up-team-group");
    expect(group.textContent).not.toContain("Alpha Team");
    expect(group.textContent).toContain(teamNewcomerLine("Beta Team"));
  });

  it("renders nothing when every team has been opened", () => {
    markSeen(VIEWER, "host-a1");
    markSeen(VIEWER, "host-b1");

    render(<SetUpTeamGroup surface="settings" />);

    expect(screen.queryByTestId("set-up-team-group")).toBeNull();
  });

  it("renders nothing for a person in no team", () => {
    useAuthStore.setState({ shareableTeams: [] });

    render(<SetUpTeamGroup surface="home" />);

    expect(screen.queryByTestId("set-up-team-group")).toBeNull();
  });
});
