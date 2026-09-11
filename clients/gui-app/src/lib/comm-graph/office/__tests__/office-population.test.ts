import { describe, expect, it } from "vitest";
import {
  partitionOfficePopulation,
  type OfficePopulation,
} from "@/lib/comm-graph/office/office-population";
import { isOfficeHotStatus } from "@/lib/comm-graph/office/office-status";
import {
  makeTestEpic,
  type OfficeTestEpicShape,
} from "@/lib/comm-graph/office/office-test-epic";
import type {
  OfficeAgentInput,
  OfficeAgentStatus,
  OfficeAppearance,
} from "@/lib/comm-graph/office/office-types";

const APPEARANCE: OfficeAppearance = {
  skin: "#e0b08a",
  hair: "#3a2a1a",
  hairStyle: 0,
  shirt: "#3b6fd6",
  pants: "#22262b",
  accent: "#7fd6ff",
};

/** Same shape as the factory at the top of `office-layout.test.ts`. */
function agent(
  overrides: Partial<OfficeAgentInput> & { readonly id: string },
): OfficeAgentInput {
  return {
    name: overrides.id,
    kind: "chat",
    hostId: null,
    archivedAt: null,
    modelTier: "medium",
    harnessId: null,
    model: null,
    parentId: null,
    archived: false,
    createdAt: 0,
    appearance: APPEARANCE,
    ...overrides,
  };
}

function statusMap(
  entries: ReadonlyArray<readonly [string, OfficeAgentStatus]>,
): ReadonlyMap<string, OfficeAgentStatus> {
  return new Map(entries);
}

/**
 * `HQ + Σ team members + solos` per host equals that host's agent count, and
 * every agent id appears exactly once across the whole partition. This is the
 * invariant the plans, boards and directory all lean on: two symptoms of one
 * agent counted twice (or not at all) is a bug, never two separate ones.
 */
function hostKeyOf(hostId: string | null): string {
  // Mirrors the partition's own grouping: a named host is prefixed, so the
  // bare word can never be produced by a host id.
  return hostId === null ? "unattributed" : `h:${hostId}`;
}

function assertEveryAgentPlacedExactlyOnce(
  agents: ReadonlyArray<OfficeAgentInput>,
  partition: OfficePopulation,
): void {
  const agentsByHostKey = new Map<string, number>();
  for (const candidate of agents) {
    const key = hostKeyOf(candidate.hostId);
    agentsByHostKey.set(key, (agentsByHostKey.get(key) ?? 0) + 1);
  }

  const seen = new Set<string>();
  for (const host of partition.hosts) {
    const key = hostKeyOf(host.hostId);
    let total = 0;
    if (host.hqAgentId !== null) {
      expect(seen.has(host.hqAgentId)).toBe(false);
      seen.add(host.hqAgentId);
      total += 1;
    }
    for (const team of host.teams) {
      for (const memberId of team.memberAgentIds) {
        expect(seen.has(memberId)).toBe(false);
        seen.add(memberId);
        total += 1;
      }
    }
    for (const solo of host.solos) {
      expect(seen.has(solo.agentId)).toBe(false);
      seen.add(solo.agentId);
      total += 1;
    }
    expect(total).toBe(agentsByHostKey.get(key) ?? 0);
  }
  expect(seen.size).toBe(agents.length);
  assertPlacementsMatchAgentHosts(partition);
  assertPresentLeadsAreInTheirOwnRoster(agents, partition);
}

/**
 * A host's roster only ever lists agents that actually live there.
 *
 * The count check above cannot see this on its own: swapping a member between
 * two hosts of equal size leaves every total intact. That swap is exactly what
 * a team resolved to the wrong building produces.
 */
function assertPlacementsMatchAgentHosts(partition: OfficePopulation): void {
  for (const host of partition.hosts) {
    if (host.hqAgentId !== null) {
      expect(partition.members.get(host.hqAgentId)?.hostId).toBe(host.hostId);
    }
    for (const team of host.teams) {
      for (const memberId of team.memberAgentIds) {
        expect(partition.members.get(memberId)?.hostId).toBe(host.hostId);
      }
    }
    for (const solo of host.solos) {
      expect(solo.hostId).toBe(host.hostId);
    }
  }
}

/**
 * A LEAD THAT IS STILL IN THE EPIC SITS IN THE TEAM IT LEADS.
 *
 * This has now been broken three separate ways - a team fabricated around a
 * frozen solo, one built from a removed lead's id, one built because an agent
 * merely shared the lead's id - so it is asserted by every case in this file
 * rather than by whichever case happens to remember it. A lead that has left
 * the epic is a different thing and stays allowed: the headless team keeps its
 * name and its surviving members.
 */
function assertPresentLeadsAreInTheirOwnRoster(
  agents: ReadonlyArray<OfficeAgentInput>,
  partition: OfficePopulation,
): void {
  const present = new Set(agents.map((candidate) => candidate.id));
  for (const host of partition.hosts) {
    for (const team of host.teams) {
      expect(team.memberAgentIds.length).toBeGreaterThan(0);
      if (!present.has(team.leadAgentId)) continue;
      expect(team.memberAgentIds).toContain(team.leadAgentId);
    }
  }
}

const SHAPES: ReadonlyArray<OfficeTestEpicShape> = [
  "triage",
  "one-team",
  "many-roots",
  "two-hosts",
];

describe("partitionOfficePopulation", () => {
  describe.each(SHAPES)("on the %s shape", (shape) => {
    it("places every agent in exactly one of HQ, one team, or solos", () => {
      const epic = makeTestEpic(shape, 200, 1);
      const partition = partitionOfficePopulation({
        agents: epic.agents,
        statusById: epic.statusById,
        previous: null,
      });
      assertEveryAgentPlacedExactlyOnce(epic.agents, partition);
    });
  });

  // The recording's shape, at the counts the ticket pins: the team count is
  // `min(30, floor((n-1)/7))`, so it only reaches the cap of 30 once n is well
  // past it - both 309 and 1000 are past that point and land on 30. Hot and
  // archived are pinned too, straight from the fixture's own stated rates
  // (`floor(n * .09)` hot, `floor(n * .04)` archived) rather than re-derived,
  // so a change to either side goes noticed here.
  it.each([
    { n: 309, hq: 1, teams: 30, solos: 224, hot: 27, archived: 12 },
    { n: 1000, hq: 1, teams: 30, solos: 915, hot: 90, archived: 40 },
  ])(
    "gives triage at $n agents $hq HQ, $teams teams, $solos solos, $hot hot and $archived archived",
    ({ n, hq, teams, solos, hot, archived }) => {
      const epic = makeTestEpic("triage", n, 1);
      const partition = partitionOfficePopulation({
        agents: epic.agents,
        statusById: epic.statusById,
        previous: null,
      });
      assertEveryAgentPlacedExactlyOnce(epic.agents, partition);

      expect(partition.hosts).toHaveLength(1);
      const host = partition.hosts[0];
      expect(host.hqAgentId !== null ? 1 : 0).toBe(hq);
      expect(host.teams).toHaveLength(teams);
      expect(host.solos).toHaveLength(solos);

      const hotCount = epic.agents.filter((candidate) =>
        isOfficeHotStatus(epic.statusById.get(candidate.id)),
      ).length;
      const archivedCount = epic.agents.filter(
        (candidate) => candidate.archived && candidate.archivedAt !== null,
      ).length;
      expect(hotCount).toBe(hot);
      expect(archivedCount).toBe(archived);
    },
  );

  it("repeats the same fixture deterministically for the same seed", () => {
    const first = makeTestEpic("triage", 309, 1);
    const second = makeTestEpic("triage", 309, 1);
    expect(second.agents).toEqual(first.agents);
    expect(second.statusById).toEqual(first.statusById);

    const firstPartition = partitionOfficePopulation({
      agents: first.agents,
      statusById: first.statusById,
      previous: null,
    });
    const secondPartition = partitionOfficePopulation({
      agents: second.agents,
      statusById: second.statusById,
      previous: null,
    });
    expect(secondPartition.hosts).toEqual(firstPartition.hosts);
    expect(secondPartition.members).toEqual(firstPartition.members);
  });

  it("gives a different seed a different solo count at the same scale", () => {
    // The reviewer measured 220 solos at 309 agents for seed 2 - verified
    // here rather than trusted, since team sizes (and so the solo count)
    // depend on the seed's own random draws.
    const epic = makeTestEpic("triage", 309, 2);
    const partition = partitionOfficePopulation({
      agents: epic.agents,
      statusById: epic.statusById,
      previous: null,
    });
    assertEveryAgentPlacedExactlyOnce(epic.agents, partition);
    expect(partition.hosts[0].solos).toHaveLength(220);
    expect(partition.hosts[0].solos.length).not.toBe(224);
  });

  it("seats the straddling team's cross-host member as a solo on its own host", () => {
    // `two-hosts` sends team-0's lead to host-a and its one member to host-b,
    // which is the only shape that produces a member whose lead lives
    // elsewhere - everything this case exists to pin.
    const epic = makeTestEpic("two-hosts", 40, 1);
    const partition = partitionOfficePopulation({
      agents: epic.agents,
      statusById: epic.statusById,
      previous: null,
    });

    expect(partition.hosts.map((host) => host.hostId)).toEqual([
      "host-a",
      "host-b",
    ]);
    const [hostA, hostB] = partition.hosts;
    expect(hostA.hqAgentId).toBe("agent-root");
    expect(hostB.hqAgentId).toBeNull();

    const strandedTeam = hostA.teams.find(
      (team) => team.teamId === "team-0-lead",
    );
    expect(strandedTeam).toBeDefined();
    // Nobody but the lead itself is left on host-a's roster: the member that
    // would have filled it out lives on host-b now.
    expect(strandedTeam?.memberAgentIds).toEqual(["team-0-lead"]);

    const strandedMember = hostB.solos.find(
      (solo) => solo.agentId === "team-0-member-0",
    );
    expect(strandedMember).toBeDefined();
    expect(strandedMember?.teamId).toBe("team-0-lead");
    expect(partition.classOf("team-0-member-0")).toBe("solo");
  });

  it("classifies an arrival by its parent and its status at arrival", () => {
    // A team already exists: "lead" has a child, so it leads "lead-child"'s
    // subtree. "root-leaf" is the HQ's own direct leaf, a solo by the rule.
    const before = partitionOfficePopulation({
      agents: [
        agent({ id: "root", createdAt: 0 }),
        agent({ id: "lead", parentId: "root", createdAt: 1 }),
        agent({ id: "lead-child", parentId: "lead", createdAt: 2 }),
      ],
      statusById: statusMap([]),
      previous: null,
    });
    expect(before.classOf("lead")).toBe("team");
    expect(before.teamOf("lead")?.teamId).toBe("lead");

    // Two arrivals: one under the existing lead, one a direct leaf of HQ.
    const after = partitionOfficePopulation({
      agents: [
        agent({ id: "root", createdAt: 0 }),
        agent({ id: "lead", parentId: "root", createdAt: 1 }),
        agent({ id: "lead-child", parentId: "lead", createdAt: 2 }),
        agent({ id: "lead-child-2", parentId: "lead", createdAt: 3 }),
        agent({ id: "root-leaf", parentId: "root", createdAt: 4 }),
      ],
      statusById: statusMap([
        ["lead-child-2", "working"],
        ["root-leaf", "idle"],
      ]),
      previous: before,
    });

    expect(after.classOf("lead-child-2")).toBe("team");
    expect(after.teamOf("lead-child-2")?.teamId).toBe("lead");
    expect(after.members.get("lead-child-2")?.hotAtArrival).toBe(true);

    expect(after.classOf("root-leaf")).toBe("solo");
    expect(after.members.get("root-leaf")?.teamId).toBeNull();
    expect(after.members.get("root-leaf")?.hotAtArrival).toBe(false);
  });

  it("records hotAtArrival at arrival, while hot always tracks today's status", () => {
    const before = partitionOfficePopulation({
      agents: [
        agent({ id: "root", createdAt: 0 }),
        agent({ id: "lead", parentId: "root", createdAt: 1 }),
        agent({ id: "lead-child", parentId: "lead", createdAt: 2 }),
      ],
      statusById: statusMap([]),
      previous: null,
    });
    const arrived = partitionOfficePopulation({
      agents: [
        agent({ id: "root", createdAt: 0 }),
        agent({ id: "lead", parentId: "root", createdAt: 1 }),
        agent({ id: "lead-child", parentId: "lead", createdAt: 2 }),
        agent({ id: "lead-child-2", parentId: "lead", createdAt: 3 }),
      ],
      statusById: statusMap([["lead-child-2", "working"]]),
      previous: before,
    });
    expect(arrived.members.get("lead-child-2")?.hot).toBe(true);
    expect(arrived.members.get("lead-child-2")?.hotAtArrival).toBe(true);

    // The arrival goes cold; `hot` follows, `hotAtArrival` stays put because
    // it is a fact about the moment the agent first appeared, not about now.
    const cooled = partitionOfficePopulation({
      agents: [
        agent({ id: "root", createdAt: 0 }),
        agent({ id: "lead", parentId: "root", createdAt: 1 }),
        agent({ id: "lead-child", parentId: "lead", createdAt: 2 }),
        agent({ id: "lead-child-2", parentId: "lead", createdAt: 3 }),
      ],
      statusById: statusMap([["lead-child-2", "idle"]]),
      previous: arrived,
    });
    expect(cooled.members.get("lead-child-2")?.hot).toBe(false);
    expect(cooled.members.get("lead-child-2")?.hotAtArrival).toBe(true);
  });

  it("keeps a known agent's class fixed across a status flip", () => {
    const agents: ReadonlyArray<OfficeAgentInput> = [
      agent({ id: "root", createdAt: 0 }),
      agent({ id: "lead", parentId: "root", createdAt: 1 }),
      agent({ id: "lead-child", parentId: "lead", createdAt: 2 }),
      agent({ id: "lead-child-2", parentId: "lead", createdAt: 3 }),
      agent({ id: "root-leaf", parentId: "root", createdAt: 4 }),
      agent({ id: "lone-root", createdAt: 5 }),
    ];
    const before = partitionOfficePopulation({
      agents,
      statusById: statusMap([["lead-child", "working"]]),
      previous: null,
    });
    // A mix, so both a hot-to-cold and a cold-to-hot flip are exercised.
    const after = partitionOfficePopulation({
      agents,
      statusById: statusMap([
        ["lead-child", "idle"],
        ["root-leaf", "attention"],
        ["lone-root", "failure"],
      ]),
      previous: before,
    });

    for (const candidate of agents) {
      expect(after.classOf(candidate.id)).toBe(before.classOf(candidate.id));
      expect(after.members.get(candidate.id)?.teamId).toBe(
        before.members.get(candidate.id)?.teamId,
      );
    }
    // ...and so does whether "lead"'s team reads as live: its only hot member
    // went cold and nothing else in it is hot, so the team goes dark.
    expect(after.members.get("lead-child")?.hot).toBe(false);
    expect(after.teamOf("lead-child")?.live).toBe(false);
    expect(after.members.get("root-leaf")?.hot).toBe(true);
    expect(after.members.get("lone-root")?.hot).toBe(true);
    // "lone-root" is a later, childless root: a solo, never a second HQ.
    expect(after.classOf("lone-root")).toBe("solo");
  });

  it("keeps a known agent's class fixed across a topology change, unlike a fresh partition", () => {
    // A status-only flip cannot tell "frozen" from "fresh", because class
    // derives from topology alone and neither pass touched it. A real
    // topology change - "solo" receiving its first child - is the case that
    // actually distinguishes the two: `previous` must keep it frozen, and a
    // fresh partition of the SAME agents must classify it differently.
    const before = partitionOfficePopulation({
      agents: [
        agent({ id: "root", createdAt: 0 }),
        agent({ id: "solo", parentId: "root", createdAt: 1 }),
      ],
      statusById: statusMap([]),
      previous: null,
    });
    expect(before.classOf("solo")).toBe("solo");

    const grownAgents: ReadonlyArray<OfficeAgentInput> = [
      agent({ id: "root", createdAt: 0 }),
      agent({ id: "solo", parentId: "root", createdAt: 1 }),
      agent({ id: "solo-child", parentId: "solo", createdAt: 2 }),
    ];

    const frozen = partitionOfficePopulation({
      agents: grownAgents,
      statusById: statusMap([]),
      previous: before,
    });
    // "solo" already existed under `before`, so it keeps the class `before`
    // gave it, even though it now has a child of its own that would make it
    // a team lead on a fresh read. Freezing is per-KNOWN-agent, not a topology
    // re-derivation, so this is the whole of what "keeps its class" pins.
    expect(frozen.classOf("solo")).toBe("solo");
    // "solo-child" is the ARRIVAL here, and this is exactly the input N1
    // reproduced: before the fix, "solo-child" was drafted as a member of a
    // team fabricated around "solo" as its lead - "solo" stayed a solo (the
    // assertion above), so that team's own lead was never in its roster, and
    // "solo" was ALSO double-counted in `host.solos`. Asserting only
    // `frozen.classOf("solo")` (as this case did before N1 slipped through)
    // cannot see any of that, so the arrival's class and both complete
    // rosters have to be pinned too.
    expect(frozen.classOf("solo-child")).toBe("solo");
    expect(frozen.teamOf("solo-child")).toBeNull();
    expect(frozen.hosts[0].teams).toEqual([]);
    expect(frozen.hosts[0].solos.map((member) => member.agentId)).toEqual([
      "solo",
      "solo-child",
    ]);
    assertEveryAgentPlacedExactlyOnce(grownAgents, frozen);

    const fresh = partitionOfficePopulation({
      agents: grownAgents,
      statusById: statusMap([]),
      previous: null,
    });
    // The same agents with no history read the topology as it is now: a
    // solo that has a child is a team lead.
    expect(fresh.classOf("solo")).toBe("team");
    expect(fresh.teamOf("solo")?.teamId).toBe("solo");
    expect(fresh.classOf("solo-child")).toBe("team");
  });

  it("N1a: an arrival under a frozen solo is a solo, and no team is fabricated around its lead", () => {
    // S is a direct leaf of HQ, so it is a solo by construction. Appending C
    // under it and re-partitioning with `previous` is the reviewer's exact
    // N1 sequence: fresh topology alone would read S as now leading a team,
    // but S is a KNOWN agent and stays frozen as a solo - so C, the arrival,
    // must be classified against that settled fact rather than against the
    // topology a fresh read would see.
    const before = partitionOfficePopulation({
      agents: [
        agent({ id: "R", createdAt: 0 }),
        agent({ id: "S", parentId: "R", createdAt: 1 }),
      ],
      statusById: statusMap([]),
      previous: null,
    });
    expect(before.classOf("S")).toBe("solo");

    const grownAgents: ReadonlyArray<OfficeAgentInput> = [
      agent({ id: "R", createdAt: 0 }),
      agent({ id: "S", parentId: "R", createdAt: 1 }),
      agent({ id: "C", parentId: "S", createdAt: 2 }),
    ];
    const after = partitionOfficePopulation({
      agents: grownAgents,
      statusById: statusMap([]),
      previous: before,
    });
    expect(after.classOf("S")).toBe("solo");
    expect(after.classOf("C")).toBe("solo");
    expect(after.teamOf("C")).toBeNull();
    // The point of this case: no team exists at all - in particular, none
    // whose lead (S) is absent from its own roster - and S is not silently
    // duplicated between a fabricated team and `host.solos`.
    expect(after.hosts[0].teams).toEqual([]);
    expect(after.hosts[0].solos.map((member) => member.agentId)).toEqual([
      "S",
      "C",
    ]);
    assertEveryAgentPlacedExactlyOnce(grownAgents, after);
  });

  it("N1b: an arrival under a surviving team member inherits that member's frozen team", () => {
    // R -> L -> M is partitioned fresh, so M is a team member of L's team.
    // L is then removed from the roster (M's frozen team identity survives
    // that, per F5b), and N arrives as M's child. Fresh topology alone would
    // read M's subtree as orphaned - M's parent, L, is gone from the record -
    // and classify N as a solo; N must instead inherit M's settled team.
    const base: ReadonlyArray<OfficeAgentInput> = [
      agent({ id: "R", createdAt: 0 }),
      agent({ id: "L", parentId: "R", createdAt: 1 }),
      agent({ id: "M", parentId: "L", createdAt: 2 }),
    ];
    const withLead = partitionOfficePopulation({
      agents: base,
      statusById: statusMap([]),
      previous: null,
    });
    expect(withLead.classOf("M")).toBe("team");

    const leadRemoved: ReadonlyArray<OfficeAgentInput> = [base[0], base[2]];
    const headless = partitionOfficePopulation({
      agents: leadRemoved,
      statusById: statusMap([]),
      previous: withLead,
    });
    expect(headless.teamOf("M")?.teamId).toBe("L");

    const grownAgents: ReadonlyArray<OfficeAgentInput> = [
      ...leadRemoved,
      agent({ id: "N", parentId: "M", createdAt: 3 }),
    ];
    const after = partitionOfficePopulation({
      agents: grownAgents,
      statusById: statusMap([]),
      previous: headless,
    });
    expect(after.classOf("N")).toBe("team");
    expect(after.teamOf("N")?.teamId).toBe("L");
    // The complete roster: M and N, with the removed lead L nowhere in it.
    expect(after.teamOf("N")?.memberAgentIds).toEqual(["M", "N"]);
    expect(after.hosts[0].solos).toEqual([]);
    assertEveryAgentPlacedExactlyOnce(grownAgents, after);
  });

  it("N1 at fixture scale: grows a triage epic in chunks without fabricating a team", () => {
    // The three-agent cases above name the defect; this one is the shape it
    // actually took in a real epic. Partitioning `triage` at 309 in twenty-
    // agent chunks against `previous` - which is what the app does, one
    // arrival at a time - produced a team whose own lead was sitting in the
    // solos ("team-13-lead" was the first), because every direct leaf of HQ
    // that later acquired a child was read fresh as leading a team while its
    // frozen class stayed `solo`.
    const epic = makeTestEpic("triage", 309, 1);
    const ordered = [...epic.agents].sort((left, right) =>
      left.createdAt === right.createdAt
        ? left.id.localeCompare(right.id)
        : left.createdAt - right.createdAt,
    );
    let grown = partitionOfficePopulation({
      agents: ordered.slice(0, 20),
      statusById: epic.statusById,
      previous: null,
    });
    for (let size = 40; size < ordered.length + 20; size += 20) {
      grown = partitionOfficePopulation({
        agents: ordered.slice(0, Math.min(size, ordered.length)),
        statusById: epic.statusById,
        previous: grown,
      });
    }

    for (const host of grown.hosts) {
      for (const team of host.teams) {
        expect(team.memberAgentIds.length).toBeGreaterThan(0);
        // A lead that is still in the epic sits in the team it leads. A lead
        // that has been archived out leaves a headless team (F5b), which is
        // why this is conditional rather than absolute.
        if (grown.members.has(team.leadAgentId)) {
          expect(team.memberAgentIds).toContain(team.leadAgentId);
        }
        expect(grown.members.get(team.leadAgentId)?.agentClass).not.toBe(
          "solo",
        );
      }
    }
    assertEveryAgentPlacedExactlyOnce(ordered, grown);

    // The grown office has FEWER teams than one read in a single pass, and
    // that gap is freezing working rather than teams going missing: a direct
    // leaf of HQ first seen childless is a solo for life, so the children it
    // gets later join it in the solos instead of a team being built around
    // it. Both numbers are pinned because the drift that matters is either
    // one moving - 28 rising back towards 30 is the fabricated teams coming
    // back, and 30 falling is the fresh read losing teams it should have.
    const atOnce = partitionOfficePopulation({
      agents: ordered,
      statusById: epic.statusById,
      previous: null,
    });
    expect(grown.hosts.flatMap((host) => host.teams).length).toBe(28);
    expect(atOnce.hosts.flatMap((host) => host.teams).length).toBe(30);
  });

  describe("orphans never become HQ or a team lead", () => {
    it("puts a childless orphan first among the input into solos, leaving the real root HQ", () => {
      // "orphan" is created BEFORE "root" and would win HQ if a missing
      // parent were treated as being a true root.
      const partition = partitionOfficePopulation({
        agents: [
          agent({ id: "orphan", parentId: "missing", createdAt: 0 }),
          agent({ id: "root", parentId: null, createdAt: 1 }),
        ],
        statusById: statusMap([]),
        previous: null,
      });
      expect(partition.classOf("orphan")).toBe("solo");
      expect(partition.hosts[0].hqAgentId).toBe("root");
    });

    it("folds an orphan's whole subtree into solos instead of making it a team lead", () => {
      const partition = partitionOfficePopulation({
        agents: [
          agent({ id: "root", parentId: null, createdAt: 0 }),
          agent({ id: "orphan", parentId: "missing", createdAt: 1 }),
          agent({ id: "orphan-kid", parentId: "orphan", createdAt: 2 }),
        ],
        statusById: statusMap([]),
        previous: null,
      });
      expect(partition.classOf("orphan")).toBe("solo");
      expect(partition.classOf("orphan-kid")).toBe("solo");
      expect(partition.teamOf("orphan")).toBeNull();
      expect(partition.hosts[0].hqAgentId).toBe("root");
    });

    it("keeps a whole multi-generation orphan subtree as solos", () => {
      // A grandchild under the orphan proves the fold recurses rather than
      // stopping one level down.
      const agents: ReadonlyArray<OfficeAgentInput> = [
        agent({ id: "root", parentId: null, createdAt: 0 }),
        agent({ id: "orphan", parentId: "missing", createdAt: 1 }),
        agent({ id: "orphan-kid", parentId: "orphan", createdAt: 2 }),
        agent({ id: "orphan-grandkid", parentId: "orphan-kid", createdAt: 3 }),
      ];
      const partition = partitionOfficePopulation({
        agents,
        statusById: statusMap([]),
        previous: null,
      });
      expect(partition.classOf("orphan")).toBe("solo");
      expect(partition.classOf("orphan-kid")).toBe("solo");
      expect(partition.classOf("orphan-grandkid")).toBe("solo");
      assertEveryAgentPlacedExactlyOnce(agents, partition);
    });
  });

  it("makes a later TRUE root with children a team lead, while HQ stays the first true root", () => {
    const agents: ReadonlyArray<OfficeAgentInput> = [
      agent({ id: "root", parentId: null, createdAt: 0 }),
      agent({ id: "root-leaf", parentId: "root", createdAt: 1 }),
      agent({ id: "later-root", parentId: null, createdAt: 2 }),
      agent({ id: "later-root-child", parentId: "later-root", createdAt: 3 }),
    ];
    const partition = partitionOfficePopulation({
      agents,
      statusById: statusMap([]),
      previous: null,
    });
    expect(partition.hosts[0].hqAgentId).toBe("root");
    expect(partition.classOf("root")).toBe("hq");
    // A later true root with a child leads its own team rather than being a
    // solo or a second HQ.
    expect(partition.classOf("later-root")).toBe("team");
    expect(partition.teamOf("later-root")?.teamId).toBe("later-root");
    expect(partition.teamOf("later-root")?.memberAgentIds).toEqual([
      "later-root",
      "later-root-child",
    ]);
    assertEveryAgentPlacedExactlyOnce(agents, partition);
  });

  it("F5a: does not let an older-created arriving root displace the known HQ", () => {
    const base: ReadonlyArray<OfficeAgentInput> = [
      agent({ id: "R", parentId: null, createdAt: 5 }),
      agent({ id: "L", parentId: "R", createdAt: 6 }),
      agent({ id: "M", parentId: "L", createdAt: 7 }),
    ];
    const before = partitionOfficePopulation({
      agents: base,
      statusById: statusMap([]),
      previous: null,
    });
    expect(before.hosts[0].hqAgentId).toBe("R");

    const agents: ReadonlyArray<OfficeAgentInput> = [
      ...base,
      agent({ id: "Older", parentId: null, createdAt: 1 }),
    ];
    const after = partitionOfficePopulation({
      agents,
      statusById: statusMap([]),
      previous: before,
    });
    // "Older" was created before R, but R is the known incumbent: the office
    // does not change hands because an older record showed up late.
    expect(after.hosts[0].hqAgentId).toBe("R");
    expect(after.classOf("R")).toBe("hq");
    // A childless arriving root is classified as the solo it is.
    expect(after.classOf("Older")).toBe("solo");
    assertEveryAgentPlacedExactlyOnce(agents, after);
  });

  it("F5b: keeps a removed lead's surviving members in the team, with the lead gone from the roster", () => {
    const base: ReadonlyArray<OfficeAgentInput> = [
      agent({ id: "R", parentId: null, createdAt: 0 }),
      agent({ id: "L", parentId: "R", createdAt: 1 }),
      agent({ id: "M", parentId: "L", createdAt: 2 }),
    ];
    const before = partitionOfficePopulation({
      agents: base,
      statusById: statusMap([]),
      previous: null,
    });
    expect(before.classOf("M")).toBe("team");

    // L is removed from the roster; R and M survive.
    const agents: ReadonlyArray<OfficeAgentInput> = [base[0], base[2]];
    const after = partitionOfficePopulation({
      agents,
      statusById: statusMap([]),
      previous: before,
    });
    expect(after.classOf("M")).toBe("team");
    expect(after.teamOf("M")?.teamId).toBe("L");
    // L is not in the current roster at all - not as lead, not as a member.
    expect(after.teamOf("M")?.memberAgentIds).toEqual(["M"]);
    expect(after.classOf("L")).toBeNull();

    // Every surviving agent is still in exactly one of HQ, a team, or solos.
    assertEveryAgentPlacedExactlyOnce(agents, after);
  });

  describe("N3: an arrival under a surviving member of a lead-less team", () => {
    // R -> L -> M all on host-a, fresh. L is then removed with M retained -
    // exactly F5b/N1b's sequence - so M is a frozen team member of L on
    // host-a with no lead left in the record. N then arrives as M's child
    // on a REMOTE host. `strandCrossHostMembers` used to resolve a team's
    // building only through its current lead, so a lead-less team was
    // skipped outright: N inherited team L unstranded, host-a's roster grew
    // to include an agent that actually lives elsewhere, and the remote host
    // had no placement at all for its only agent.
    const BASE_HOST_A: ReadonlyArray<OfficeAgentInput> = [
      agent({ id: "R", hostId: "host-a", createdAt: 0 }),
      agent({ id: "L", parentId: "R", hostId: "host-a", createdAt: 1 }),
      agent({ id: "M", parentId: "L", hostId: "host-a", createdAt: 2 }),
    ];

    it.each([
      { label: "a different host", remoteHostId: "host-b" },
      { label: "a null host", remoteHostId: null },
    ])(
      "strands the arrival on $label instead of listing it on host-a",
      ({ remoteHostId }) => {
        const withLead = partitionOfficePopulation({
          agents: BASE_HOST_A,
          statusById: statusMap([]),
          previous: null,
        });
        expect(withLead.classOf("M")).toBe("team");

        const leadRemoved: ReadonlyArray<OfficeAgentInput> = [
          BASE_HOST_A[0],
          BASE_HOST_A[2],
        ];
        const headless = partitionOfficePopulation({
          agents: leadRemoved,
          statusById: statusMap([]),
          previous: withLead,
        });
        expect(headless.teamOf("M")?.teamId).toBe("L");

        const grownAgents: ReadonlyArray<OfficeAgentInput> = [
          ...leadRemoved,
          agent({ id: "N", parentId: "M", hostId: remoteHostId, createdAt: 3 }),
        ];
        const after = partitionOfficePopulation({
          agents: grownAgents,
          statusById: statusMap([]),
          previous: headless,
        });

        // N keeps the accent, but as a stranded solo living on its own host.
        expect(after.classOf("N")).toBe("solo");
        expect(after.members.get("N")?.teamId).toBe("L");
        expect(after.members.get("N")?.hostId).toBe(remoteHostId);

        const hostA = after.hosts.find((host) => host.hostId === "host-a");
        // The complete roster: M only. N must NOT be in it.
        expect(hostA?.teams).toHaveLength(1);
        expect(hostA?.teams[0]?.teamId).toBe("L");
        expect(hostA?.teams[0]?.memberAgentIds).toEqual(["M"]);
        expect(hostA?.solos).toEqual([]);

        const remoteHost = after.hosts.find(
          (host) => host.hostId === remoteHostId,
        );
        expect(remoteHost?.teams).toEqual([]);
        expect(remoteHost?.solos.map((solo) => solo.agentId)).toEqual(["N"]);

        assertEveryAgentPlacedExactlyOnce(grownAgents, after);
      },
    );

    it("control: with the lead still present, the remote arrival is a stranded solo", () => {
      const withLead = partitionOfficePopulation({
        agents: BASE_HOST_A,
        statusById: statusMap([]),
        previous: null,
      });

      const grownAgents: ReadonlyArray<OfficeAgentInput> = [
        ...BASE_HOST_A,
        agent({ id: "N", parentId: "M", hostId: "host-b", createdAt: 3 }),
      ];
      const after = partitionOfficePopulation({
        agents: grownAgents,
        statusById: statusMap([]),
        previous: withLead,
      });

      expect(after.classOf("N")).toBe("solo");
      expect(after.members.get("N")?.teamId).toBe("L");
      expect(after.members.get("N")?.hostId).toBe("host-b");

      const hostA = after.hosts.find((host) => host.hostId === "host-a");
      expect(hostA?.teams).toHaveLength(1);
      expect(hostA?.teams[0]?.teamId).toBe("L");
      expect(hostA?.teams[0]?.memberAgentIds).toEqual(["L", "M"]);

      const hostB = after.hosts.find((host) => host.hostId === "host-b");
      expect(hostB?.solos.map((solo) => solo.agentId)).toEqual(["N"]);

      assertEveryAgentPlacedExactlyOnce(grownAgents, after);
    });

    it("control: the same-host arrival still joins the lead-less team", () => {
      const withLead = partitionOfficePopulation({
        agents: BASE_HOST_A,
        statusById: statusMap([]),
        previous: null,
      });
      const leadRemoved: ReadonlyArray<OfficeAgentInput> = [
        BASE_HOST_A[0],
        BASE_HOST_A[2],
      ];
      const headless = partitionOfficePopulation({
        agents: leadRemoved,
        statusById: statusMap([]),
        previous: withLead,
      });

      const grownAgents: ReadonlyArray<OfficeAgentInput> = [
        ...leadRemoved,
        agent({ id: "N", parentId: "M", hostId: "host-a", createdAt: 3 }),
      ];
      const after = partitionOfficePopulation({
        agents: grownAgents,
        statusById: statusMap([]),
        previous: headless,
      });

      expect(after.classOf("N")).toBe("team");
      const hostA = after.hosts.find((host) => host.hostId === "host-a");
      expect(hostA?.teams).toHaveLength(1);
      expect(hostA?.teams[0]?.teamId).toBe("L");
      expect(hostA?.teams[0]?.memberAgentIds).toEqual(["M", "N"]);
      expect(hostA?.solos).toEqual([]);

      assertEveryAgentPlacedExactlyOnce(grownAgents, after);
    });
  });

  describe("N4: an arrival under a stranded solo", () => {
    // R and L on host-a, M under L on host-b: M is a stranded solo carrying
    // teamId L from the moment it is first seen. N then arrives as M's
    // child. `adoptedUnder` used to key off the PARENT'S CLASS, so a
    // stranded solo (class `solo`) read the same as an ordinary team-less
    // solo and N's inherited accent was dropped.
    const STRANDED_BASE: ReadonlyArray<OfficeAgentInput> = [
      agent({ id: "R", hostId: "host-a", createdAt: 0 }),
      agent({ id: "L", parentId: "R", hostId: "host-a", createdAt: 1 }),
      agent({ id: "M", parentId: "L", hostId: "host-b", createdAt: 2 }),
    ];

    it("inherits the stranded parent's team identity, not just its class", () => {
      const before = partitionOfficePopulation({
        agents: STRANDED_BASE,
        statusById: statusMap([]),
        previous: null,
      });
      expect(before.classOf("M")).toBe("solo");
      expect(before.members.get("M")?.teamId).toBe("L");

      const grownAgents: ReadonlyArray<OfficeAgentInput> = [
        ...STRANDED_BASE,
        agent({ id: "N", parentId: "M", hostId: "host-b", createdAt: 3 }),
      ];
      const after = partitionOfficePopulation({
        agents: grownAgents,
        statusById: statusMap([]),
        previous: before,
      });

      // Both solos carry the accent, and `teamOf` resolves it for both.
      expect(after.classOf("M")).toBe("solo");
      expect(after.members.get("M")?.teamId).toBe("L");
      expect(after.teamOf("M")?.teamId).toBe("L");
      expect(after.classOf("N")).toBe("solo");
      expect(after.members.get("N")?.teamId).toBe("L");
      expect(after.teamOf("N")?.teamId).toBe("L");

      const hostA = after.hosts.find((host) => host.hostId === "host-a");
      expect(hostA?.teams).toHaveLength(1);
      expect(hostA?.teams[0]?.teamId).toBe("L");
      expect(hostA?.teams[0]?.memberAgentIds).toEqual(["L"]);

      const hostB = after.hosts.find((host) => host.hostId === "host-b");
      expect(hostB?.solos.map((solo) => solo.agentId)).toEqual(["M", "N"]);

      assertEveryAgentPlacedExactlyOnce(grownAgents, after);
    });

    it("control: an arrival under an ORDINARY team-less solo stays team-less", () => {
      const base: ReadonlyArray<OfficeAgentInput> = [
        agent({ id: "R", hostId: "host-a", createdAt: 0 }),
        agent({ id: "S", parentId: "R", hostId: "host-a", createdAt: 1 }),
      ];
      const before = partitionOfficePopulation({
        agents: base,
        statusById: statusMap([]),
        previous: null,
      });
      expect(before.members.get("S")?.teamId).toBeNull();

      const grownAgents: ReadonlyArray<OfficeAgentInput> = [
        ...base,
        agent({ id: "C", parentId: "S", hostId: "host-a", createdAt: 2 }),
      ];
      const after = partitionOfficePopulation({
        agents: grownAgents,
        statusById: statusMap([]),
        previous: before,
      });

      expect(after.classOf("C")).toBe("solo");
      expect(after.members.get("C")?.teamId).toBeNull();
      expect(after.teamOf("C")).toBeNull();
      assertEveryAgentPlacedExactlyOnce(grownAgents, after);
    });

    it("sits an arrival beside its stranded parent when the lead is gone too", () => {
      // N3 and N4 at once: M is stranded on host-b AND its team's lead has
      // since been removed, so nothing left in the record can say which
      // building team L was ever in. A team with no establishable building is
      // not a room anybody can be seated in, so N is treated exactly as the
      // parent it inherited from - a solo on host-b carrying the accent -
      // rather than being made a member of a team that would then appear to
      // have relocated to a building it was never in.
      const withLead = partitionOfficePopulation({
        agents: STRANDED_BASE,
        statusById: statusMap([]),
        previous: null,
      });
      const leadRemoved: ReadonlyArray<OfficeAgentInput> = [
        STRANDED_BASE[0],
        STRANDED_BASE[2],
      ];
      const headless = partitionOfficePopulation({
        agents: leadRemoved,
        statusById: statusMap([]),
        previous: withLead,
      });
      expect(headless.classOf("M")).toBe("solo");
      expect(headless.members.get("M")?.teamId).toBe("L");

      const grownAgents: ReadonlyArray<OfficeAgentInput> = [
        ...leadRemoved,
        agent({ id: "N", parentId: "M", hostId: "host-b", createdAt: 3 }),
      ];
      const after = partitionOfficePopulation({
        agents: grownAgents,
        statusById: statusMap([]),
        previous: headless,
      });

      expect(after.classOf("N")).toBe("solo");
      expect(after.members.get("N")?.teamId).toBe("L");
      const hostB = after.hosts.find((host) => host.hostId === "host-b");
      expect(hostB?.teams).toEqual([]);
      expect(hostB?.solos.map((solo) => solo.agentId)).toEqual(["M", "N"]);
      assertEveryAgentPlacedExactlyOnce(grownAgents, after);
    });
  });

  describe("N5: a returning orphan lead does not become the nonmember lead of a fabricated team", () => {
    it("keeps the returning lead a teamless solo, and its stranded child's arrival a solo carrying only the accent", () => {
      const base: ReadonlyArray<OfficeAgentInput> = [
        agent({ id: "R", hostId: "host-a", createdAt: 0 }),
        agent({ id: "L", parentId: "R", hostId: "host-a", createdAt: 1 }),
        agent({ id: "M", parentId: "L", hostId: "host-b", createdAt: 2 }),
      ];
      const withLeadAndRoot = partitionOfficePopulation({
        agents: base,
        statusById: statusMap([]),
        previous: null,
      });
      expect(withLeadAndRoot.classOf("M")).toBe("solo");
      expect(withLeadAndRoot.members.get("M")?.teamId).toBe("L");

      // R and L are both removed; only the stranded M survives.
      const onlyM: ReadonlyArray<OfficeAgentInput> = [base[2]];
      const rootAndLeadGone = partitionOfficePopulation({
        agents: onlyM,
        statusById: statusMap([]),
        previous: withLeadAndRoot,
      });
      expect(rootAndLeadGone.classOf("M")).toBe("solo");

      // L returns with its original parentId "R", but R is still absent,
      // so L is now an orphan. M is unchanged, and N arrives under M on
      // host-a - a different host than the one M actually lives on.
      const grownAgents: ReadonlyArray<OfficeAgentInput> = [
        agent({ id: "L", parentId: "R", hostId: "host-a", createdAt: 1 }),
        base[2],
        agent({ id: "N", parentId: "M", hostId: "host-a", createdAt: 3 }),
      ];
      const after = partitionOfficePopulation({
        agents: grownAgents,
        statusById: statusMap([]),
        previous: rootAndLeadGone,
      });

      // A returning orphan lead is not a team.
      expect(after.classOf("L")).toBe("solo");
      expect(after.members.get("L")?.teamId).toBeNull();

      // N's accent survives; its membership in a team L never actually
      // held does not.
      expect(after.classOf("N")).toBe("solo");
      expect(after.members.get("N")?.teamId).toBe("L");

      const hostA = after.hosts.find((host) => host.hostId === "host-a");
      expect(hostA?.teams).toEqual([]);
      expect(hostA?.solos.map((solo) => solo.agentId)).toEqual(["L", "N"]);

      const hostB = after.hosts.find((host) => host.hostId === "host-b");
      expect(hostB?.solos.map((solo) => solo.agentId)).toEqual(["M"]);
      expect(hostB?.solos[0]?.teamId).toBe("L");

      assertEveryAgentPlacedExactlyOnce(grownAgents, after);
    });

    it("will not take a lead the PREVIOUS partition knew as a solo for a team either", () => {
      // N5 one step further on. Once the returning lead has settled as an
      // orphan solo, the only thing left anywhere that names a host for team
      // L is the previous partition's record of an agent CALLED L - and that
      // agent was a solo there, which says nothing about where team L ever
      // was. Reading it anyway rebuilds exactly the roster N5 just removed,
      // one partition later, which is why the resolver asks the previous
      // partition about the TEAM and never about an agent sharing its name.
      const base: ReadonlyArray<OfficeAgentInput> = [
        agent({ id: "R", hostId: "host-a", createdAt: 0 }),
        agent({ id: "L", parentId: "R", hostId: "host-a", createdAt: 1 }),
        agent({ id: "M", parentId: "L", hostId: "host-b", createdAt: 2 }),
      ];
      const first = partitionOfficePopulation({
        agents: base,
        statusById: statusMap([]),
        previous: null,
      });
      const rootAndLeadGone = partitionOfficePopulation({
        agents: [base[2]],
        statusById: statusMap([]),
        previous: first,
      });
      const returned: ReadonlyArray<OfficeAgentInput> = [
        base[1],
        base[2],
        agent({ id: "N", parentId: "M", hostId: "host-a", createdAt: 3 }),
      ];
      const withReturnedLead = partitionOfficePopulation({
        agents: returned,
        statusById: statusMap([]),
        previous: rootAndLeadGone,
      });
      // The state N5 settles on: L a teamless solo, N carrying the accent.
      expect(withReturnedLead.members.get("L")?.teamId).toBeNull();
      expect(withReturnedLead.members.get("N")?.teamId).toBe("L");

      const grownAgents: ReadonlyArray<OfficeAgentInput> = [
        ...returned,
        agent({ id: "P", parentId: "N", hostId: "host-a", createdAt: 4 }),
      ];
      const after = partitionOfficePopulation({
        agents: grownAgents,
        statusById: statusMap([]),
        previous: withReturnedLead,
      });

      expect(after.classOf("P")).toBe("solo");
      expect(after.members.get("P")?.teamId).toBe("L");
      const hostA = after.hosts.find((host) => host.hostId === "host-a");
      expect(hostA?.teams).toEqual([]);
      assertEveryAgentPlacedExactlyOnce(grownAgents, after);
    });
  });

  describe("N6: an arrival on a team's recorded home host joins it, even when the last local member leaves in the same step", () => {
    it.each([
      { label: "a named home host", home: "host-a" },
      { label: "a null home host", home: null },
    ])(
      "consults the previous partition's own team record before declaring the home unknown ($label)",
      ({ home }) => {
        const base: ReadonlyArray<OfficeAgentInput> = [
          agent({ id: "R", hostId: home, createdAt: 0 }),
          agent({ id: "L", parentId: "R", hostId: home, createdAt: 1 }),
          agent({ id: "M", parentId: "L", hostId: home, createdAt: 2 }),
          agent({ id: "S", parentId: "L", hostId: "host-far", createdAt: 3 }),
        ];
        const withLead = partitionOfficePopulation({
          agents: base,
          statusById: statusMap([]),
          previous: null,
        });
        expect(withLead.teamOf("M")?.teamId).toBe("L");
        expect(withLead.classOf("S")).toBe("solo");

        // L is removed; team L survives with roster [M] on its home
        // host (F5b), and S stays a stranded solo carrying the accent.
        const leadRemoved: ReadonlyArray<OfficeAgentInput> = [
          base[0],
          base[2],
          base[3],
        ];
        const withoutLead = partitionOfficePopulation({
          agents: leadRemoved,
          statusById: statusMap([]),
          previous: withLead,
        });
        expect(withoutLead.teamOf("M")?.teamId).toBe("L");
        expect(withoutLead.teamOf("M")?.hostId).toBe(home);
        expect(withoutLead.teamOf("M")?.memberAgentIds).toEqual(["M"]);

        // M leaves and N arrives under S, on the team's recorded home
        // host, in the same step.
        const grownAgents: ReadonlyArray<OfficeAgentInput> = [
          base[0],
          base[3],
          agent({ id: "N", parentId: "S", hostId: home, createdAt: 4 }),
        ];
        const after = partitionOfficePopulation({
          agents: grownAgents,
          statusById: statusMap([]),
          previous: withoutLead,
        });

        // N joins team L on its recorded home rather than being stranded
        // from a room it is standing in.
        expect(after.classOf("N")).toBe("team");
        expect(after.teamOf("N")?.teamId).toBe("L");

        const homeHost = after.hosts.find((host) => host.hostId === home);
        expect(homeHost?.teams).toHaveLength(1);
        expect(homeHost?.teams[0]?.teamId).toBe("L");
        expect(homeHost?.teams[0]?.memberAgentIds).toEqual(["N"]);

        assertEveryAgentPlacedExactlyOnce(grownAgents, after);
      },
    );
  });

  it("pins teamOf against member.teamId: a stranded solo keeps its accent though no team exists to look up", () => {
    // Same shape as N4's stranded-solo case: M carries teamId "L" from
    // the moment it is first seen. Removing L leaves that accent on
    // member.teamId, but there is no team-class roster left for teamOf
    // to return - the documented distinction, pinned directly rather
    // than only implied by a case built for something else.
    const base: ReadonlyArray<OfficeAgentInput> = [
      agent({ id: "R", hostId: "host-a", createdAt: 0 }),
      agent({ id: "L", parentId: "R", hostId: "host-a", createdAt: 1 }),
      agent({ id: "M", parentId: "L", hostId: "host-b", createdAt: 2 }),
    ];
    const withLead = partitionOfficePopulation({
      agents: base,
      statusById: statusMap([]),
      previous: null,
    });
    expect(withLead.classOf("M")).toBe("solo");
    expect(withLead.members.get("M")?.teamId).toBe("L");

    const leadRemoved: ReadonlyArray<OfficeAgentInput> = [base[0], base[2]];
    const after = partitionOfficePopulation({
      agents: leadRemoved,
      statusById: statusMap([]),
      previous: withLead,
    });

    // The accent survives on the member...
    expect(after.members.get("M")?.teamId).toBe("L");
    // ...but no team-class roster exists anywhere to carry it, so
    // teamOf answers null rather than an empty team being invented.
    expect(after.teamOf("M")).toBeNull();
    for (const host of after.hosts) {
      expect(host.teams).toEqual([]);
    }
    assertEveryAgentPlacedExactlyOnce(leadRemoved, after);
  });
});
