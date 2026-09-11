import { describe, expect, it } from "vitest";
import {
  partitionOfficePopulation,
  type OfficePopulation,
} from "@/lib/comm-graph/office/office-population";
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
  // past it - both 309 and 1000 are past that point and land on 30.
  it.each([
    { n: 309, hq: 1, teams: 30, solos: 224 },
    { n: 1000, hq: 1, teams: 30, solos: 915 },
  ])(
    "gives triage at $n agents $hq HQ, $teams teams and $solos solos",
    ({ n, hq, teams, solos }) => {
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
    },
  );

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
});
