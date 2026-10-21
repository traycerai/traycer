import { describe, expect, it } from "vitest";
import type {
  HostListItem,
  HostOwnerPrincipal,
} from "@traycer/protocol/host/host-status";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import {
  groupHostOptions,
  pickableHostOptions,
  startPageHostOptions,
} from "@/components/settings/host-scope/host-option-model";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";

/**
 * The host list groups a team's sandboxes and pods
 * under the team's name, from the registry row's `?include=owner` principal.
 *
 * A team row follows the SAME picker rules as an own row - burst hidden from a
 * picker, a pod only where the surface lists or offers it, an unconfirmed row
 * (`summary === null`) listed by the host list and hidden from a picker - it
 * only lands in its team's group instead of the user's own `sandboxes`.
 */

const TEAM_A: HostOwnerPrincipal = {
  kind: "team",
  id: "team-a",
  name: "Alpha",
};
const TEAM_B: HostOwnerPrincipal = {
  kind: "team",
  id: "team-b",
  name: "Bravo",
};
const ME: HostOwnerPrincipal = { kind: "user", id: "user-me" };

function registryItem(
  hostId: string,
  owner: HostOwnerPrincipal | undefined,
): HostListItem {
  const base: HostListItem = {
    hostId,
    displayName: hostId,
    platform: "linux-x64",
    kind: "sandbox",
    publicKey: "pk",
    createdAt: new Date(0).toISOString(),
    updatePolicy: "manual",
    status: {
      connectivity: "connectable",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.4.2",
      lastSeenAt: new Date(0).toISOString(),
    },
  };
  return owner === undefined ? base : { ...base, owner };
}

/** A sandbox row; `summary: null` is a control-plane row that has not answered. */
function sandboxRow(
  hostId: string,
  owner: HostOwnerPrincipal | undefined,
  summary: Partial<SandboxSummary> | null,
): HostScopeOption {
  return hostScopeOptionFixture({
    hostId,
    kind: "sandbox",
    isLocalMachine: false,
    item: registryItem(hostId, owner),
    sandbox: {
      state: "awake",
      frozen: false,
      summary:
        summary === null ? null : sandboxSummaryFixture({ hostId, ...summary }),
      teamOwned: owner?.kind === "team",
    },
  });
}

function personalRow(
  hostId: string,
  owner: HostOwnerPrincipal | undefined,
): HostScopeOption {
  return hostScopeOptionFixture({
    hostId,
    item: { ...registryItem(hostId, owner), kind: "personal" },
  });
}

function ids(rows: readonly HostScopeOption[]): readonly string[] {
  return rows.map((row) => row.hostId);
}

describe("groupHostOptions teams", () => {
  it("is an empty list when no row is team-owned", () => {
    const groups = groupHostOptions(
      [
        personalRow("p1", ME),
        sandboxRow("own-1", ME, {}),
        sandboxRow("own-2", undefined, {}),
      ],
      true,
      false,
      null,
    );
    expect(groups.teams).toEqual([]);
  });

  it("moves a team's sandbox out of the user's own sandboxes and into the team's group", () => {
    const groups = groupHostOptions(
      [sandboxRow("own-1", ME, {}), sandboxRow("team-a-1", TEAM_A, {})],
      true,
      false,
      null,
    );
    expect(ids(groups.sandboxes)).toEqual(["own-1"]);
    expect(groups.teams).toHaveLength(1);
    const [group] = groups.teams;
    expect(group.teamId).toBe("team-a");
    expect(group.teamName).toBe("Alpha");
    expect(ids(group.sandboxes)).toEqual(["team-a-1"]);
    expect(ids(group.agentSandboxes)).toEqual([]);
  });

  it("puts a team's burst sandbox in the team's agentSandboxes on the host list", () => {
    const groups = groupHostOptions(
      [
        sandboxRow("team-a-1", TEAM_A, {}),
        sandboxRow("team-a-burst", TEAM_A, { burst: true }),
      ],
      true,
      false,
      null,
    );
    expect(ids(groups.agentSandboxes)).toEqual([]);
    expect(ids(groups.sandboxes)).toEqual([]);
    expect(ids(groups.teams[0].sandboxes)).toEqual(["team-a-1"]);
    expect(ids(groups.teams[0].agentSandboxes)).toEqual(["team-a-burst"]);
  });

  it("hides a team's burst sandbox from a picker, in every group", () => {
    const groups = groupHostOptions(
      [
        sandboxRow("team-a-1", TEAM_A, {}),
        sandboxRow("team-a-burst", TEAM_A, { burst: true }),
      ],
      false,
      false,
      null,
    );
    const everywhere = [
      ...ids(groups.personal),
      ...ids(groups.sandboxes),
      ...ids(groups.agentSandboxes),
      ...groups.teams.flatMap((team) => [
        ...ids(team.sandboxes),
        ...ids(team.agentSandboxes),
      ]),
    ];
    expect(everywhere).toEqual(["team-a-1"]);
    expect(ids(groups.teams[0].sandboxes)).toEqual(["team-a-1"]);
  });

  it("lists a team's pod in the team's sandboxes on the host list", () => {
    const groups = groupHostOptions(
      [
        sandboxRow("team-a-1", TEAM_A, {}),
        sandboxRow("team-a-pod", TEAM_A, { kind: "automation" }),
      ],
      true,
      false,
      null,
    );
    expect(ids(groups.sandboxes)).toEqual([]);
    expect(ids(groups.teams[0].sandboxes)).toEqual(["team-a-1", "team-a-pod"]);
  });

  it("lists a team's pod for a picker that offers automations, and hides it from one that does not", () => {
    const rows = [
      sandboxRow("team-a-1", TEAM_A, {}),
      sandboxRow("team-a-pod", TEAM_A, { kind: "automation" }),
    ];
    const offering = groupHostOptions(rows, false, true, null);
    expect(ids(offering.teams[0].sandboxes)).toEqual([
      "team-a-1",
      "team-a-pod",
    ]);
    const plain = groupHostOptions(rows, false, false, null);
    expect(ids(plain.teams[0].sandboxes)).toEqual(["team-a-1"]);
    expect(ids(plain.sandboxes)).toEqual([]);
  });

  it("makes one group per team, ordered by team name then team id, rows in input order", () => {
    const groups = groupHostOptions(
      [
        sandboxRow("bravo-1", TEAM_B, {}),
        sandboxRow("zeta-1", { kind: "team", id: "team-z", name: "Zeta" }, {}),
        sandboxRow("alpha-1", TEAM_A, {}),
        sandboxRow("bravo-2", TEAM_B, {}),
        sandboxRow("zeta-2", { kind: "team", id: "team-z", name: "Zeta" }, {}),
        sandboxRow("alpha-2", TEAM_A, {}),
      ],
      true,
      false,
      null,
    );
    expect(groups.teams.map((team) => team.teamName)).toEqual([
      "Alpha",
      "Bravo",
      "Zeta",
    ]);
    expect(groups.teams.map((team) => ids(team.sandboxes))).toEqual([
      ["alpha-1", "alpha-2"],
      ["bravo-1", "bravo-2"],
      ["zeta-1", "zeta-2"],
    ]);
  });

  it("orders two teams of the same name by team id", () => {
    const groups = groupHostOptions(
      [
        sandboxRow("late", { kind: "team", id: "team-2", name: "Same" }, {}),
        sandboxRow("early", { kind: "team", id: "team-1", name: "Same" }, {}),
      ],
      true,
      false,
      null,
    );
    expect(groups.teams.map((team) => team.teamId)).toEqual([
      "team-1",
      "team-2",
    ]);
    expect(groups.teams.map((team) => ids(team.sandboxes))).toEqual([
      ["early"],
      ["late"],
    ]);
  });

  it("keeps a sandbox with no owner, or no registry row, in the user's own groups", () => {
    const noItem = hostScopeOptionFixture({
      hostId: "no-item",
      kind: "sandbox",
      item: null,
      sandbox: {
        state: "awake",
        frozen: false,
        summary: sandboxSummaryFixture({ hostId: "no-item" }),
        teamOwned: false,
      },
    });
    const noItemBurst = hostScopeOptionFixture({
      hostId: "no-item-burst",
      kind: "sandbox",
      item: null,
      sandbox: {
        state: "awake",
        frozen: false,
        summary: sandboxSummaryFixture({
          hostId: "no-item-burst",
          burst: true,
        }),
        teamOwned: false,
      },
    });
    const groups = groupHostOptions(
      [
        sandboxRow("no-owner", undefined, {}),
        sandboxRow("no-owner-burst", undefined, { burst: true }),
        noItem,
        noItemBurst,
      ],
      true,
      false,
      null,
    );
    expect(groups.teams).toEqual([]);
    expect(ids(groups.sandboxes)).toEqual(["no-owner", "no-item"]);
    expect(ids(groups.agentSandboxes)).toEqual([
      "no-owner-burst",
      "no-item-burst",
    ]);
  });

  it("keeps a sandbox owned by a user in the user's own sandboxes", () => {
    const groups = groupHostOptions(
      [
        sandboxRow("mine", ME, {}),
        sandboxRow("mine-burst", ME, { burst: true }),
      ],
      true,
      false,
      null,
    );
    expect(groups.teams).toEqual([]);
    expect(ids(groups.sandboxes)).toEqual(["mine"]);
    expect(ids(groups.agentSandboxes)).toEqual(["mine-burst"]);
  });

  it("keeps a personal host in personal, whatever its owner says", () => {
    const groups = groupHostOptions(
      [personalRow("p-team", TEAM_A), personalRow("p-me", ME)],
      true,
      false,
      null,
    );
    expect(ids(groups.personal)).toEqual(["p-team", "p-me"]);
    expect(groups.teams).toEqual([]);
  });

  it("lists a team row that has not answered (summary null) on the host list, and hides it from a picker", () => {
    const rows = [sandboxRow("team-a-unconfirmed", TEAM_A, null)];
    const hostList = groupHostOptions(rows, true, false, null);
    expect(ids(hostList.teams[0].sandboxes)).toEqual(["team-a-unconfirmed"]);
    expect(ids(hostList.sandboxes)).toEqual([]);

    const picker = groupHostOptions(rows, false, false, null);
    expect(picker.teams.flatMap((team) => ids(team.sandboxes))).toEqual([]);
    expect(picker.teams.flatMap((team) => ids(team.agentSandboxes))).toEqual(
      [],
    );
    expect(ids(picker.sandboxes)).toEqual([]);
  });

  it("keeps a hidden team burst row that keepHostId names, in that team's sandboxes", () => {
    const rows = [
      sandboxRow("team-a-1", TEAM_A, {}),
      sandboxRow("team-a-burst", TEAM_A, { burst: true }),
    ];
    const kept = groupHostOptions(rows, false, false, "team-a-burst");
    expect(kept.teams).toHaveLength(1);
    expect(ids(kept.teams[0].sandboxes)).toEqual(["team-a-1", "team-a-burst"]);
    expect(ids(kept.teams[0].agentSandboxes)).toEqual([]);
    expect(ids(kept.sandboxes)).toEqual([]);

    const notKept = groupHostOptions(rows, false, false, "someone-else");
    expect(ids(notKept.teams[0].sandboxes)).toEqual(["team-a-1"]);
  });
});

describe("pickableHostOptions teams", () => {
  it("lists personal, then own sandboxes, then each team's sandboxes in team order, never a burst one", () => {
    const flat = pickableHostOptions(
      [
        sandboxRow("bravo-1", TEAM_B, {}),
        sandboxRow("own-1", ME, {}),
        personalRow("p1", ME),
        sandboxRow("alpha-burst", TEAM_A, { burst: true }),
        sandboxRow("alpha-1", TEAM_A, {}),
        sandboxRow("own-burst", ME, { burst: true }),
        sandboxRow("bravo-2", TEAM_B, {}),
        sandboxRow("own-2", undefined, {}),
      ],
      null,
    );
    expect(ids(flat)).toEqual([
      "p1",
      "own-1",
      "own-2",
      "alpha-1",
      "bravo-1",
      "bravo-2",
    ]);
  });
});

describe("startPageHostOptions", () => {
  it("drops a team's sandbox and keeps every other row, in input order", () => {
    const flat = startPageHostOptions([
      sandboxRow("team-a-1", TEAM_A, {}),
      personalRow("p1", ME),
      sandboxRow("own-1", ME, {}),
      sandboxRow("team-b-1", TEAM_B, {}),
      sandboxRow("own-2", undefined, {}),
    ]);
    expect(ids(flat)).toEqual(["p1", "own-1", "own-2"]);
  });

  it("keeps a personal host whatever its owner says", () => {
    const flat = startPageHostOptions([
      personalRow("p-team", TEAM_A),
      personalRow("p-me", ME),
    ]);
    expect(ids(flat)).toEqual(["p-team", "p-me"]);
  });
});
