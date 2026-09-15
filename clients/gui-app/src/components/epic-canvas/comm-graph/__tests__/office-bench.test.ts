/**
 * The dev bench's own half: what a URL means, and what it builds.
 *
 * The other half - that a benched tile actually draws an office - is in
 * `comm-graph-tile.test.tsx`, where there is a tile to draw one.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { CommGraphAgentNode } from "@/lib/comm-graph/comm-graph-model";
import { civicCapacityFor } from "@/lib/comm-graph/office/office-layout";
import { makeTestEpic } from "@/lib/comm-graph/office/office-test-epic";
import type { OfficeAgentStatus } from "@/lib/comm-graph/office/office-types";
import {
  officeBench,
  officeBenchStatuses,
  parseOfficeBenchSearch,
  OFFICE_BENCH_MAX_AGENTS,
  OFFICE_BENCH_OUTBREAK_DEFAULT,
  OFFICE_BENCH_SEED,
  type OfficeBenchRequest,
} from "@/components/epic-canvas/comm-graph/office/office-bench";

/**
 * A URL that asked for no script: the two script fields a request always
 * carries, at the values "nothing happens to this office" takes.
 */
const STILL_OFFICE = {
  script: null,
  outbreak: OFFICE_BENCH_OUTBREAK_DEFAULT,
} as const;

/** The bench's agents alone, which most of these cases are about. */
function benchAgents(
  request: OfficeBenchRequest,
): ReadonlyArray<CommGraphAgentNode> {
  return officeBench(request).agents;
}

describe("parseOfficeBenchSearch", () => {
  it("reads the count, and defaults to the shape every estimate is quoted at", () => {
    expect(parseOfficeBenchSearch("?officeBench=1000")).toEqual({
      shape: "triage",
      agents: 1000,
      ...STILL_OFFICE,
    });
  });

  it("reads a named shape, which is how the review's worst case is reachable", () => {
    expect(
      parseOfficeBenchSearch("?officeBench=1000&officeBenchShape=many-roots"),
    ).toEqual({ shape: "many-roots", agents: 1000, ...STILL_OFFICE });
  });

  it("falls back to triage for a shape it does not know", () => {
    // An address bar, not a form: a typo in the shape should still give the
    // bench that every number in the plan is quoted at.
    expect(
      parseOfficeBenchSearch("?officeBench=12&officeBenchShape=atrium"),
    ).toEqual({ shape: "triage", agents: 12, ...STILL_OFFICE });
  });

  it("caps a count that would take the window down with it", () => {
    const parsed = parseOfficeBenchSearch("?officeBench=10000000");
    expect(parsed?.agents).toBe(OFFICE_BENCH_MAX_AGENTS);
  });

  it.each([
    ["no bench at all", "?focusedAt=3"],
    ["an empty string", ""],
    ["a count that is not a number", "?officeBench=lots"],
    ["a count of zero", "?officeBench=0"],
    ["a negative count", "?officeBench=-5"],
  ])("asks for no bench given %s", (_case, search) => {
    expect(parseOfficeBenchSearch(search)).toBeNull();
  });

  it("keeps other search parameters out of it", () => {
    expect(
      parseOfficeBenchSearch("?focusedAt=3&officeBench=309&focusPaneId=pane-1"),
    ).toEqual({ shape: "triage", agents: 309, ...STILL_OFFICE });
  });

  it("reads officeBenchScript=outbreak and officeBenchOutbreak=12", () => {
    expect(
      parseOfficeBenchSearch(
        "?officeBench=400&officeBenchScript=outbreak&officeBenchOutbreak=12",
      ),
    ).toEqual({
      shape: "triage",
      agents: 400,
      script: "outbreak",
      outbreak: 12,
    });
  });

  it("defaults outbreak when the param is absent or unreadable", () => {
    // TWO, the ambulance row: three or more crashers on one sync is K3's
    // trigger for an engine, which is a different vehicle. Comparing to
    // the constant alone moves both sides together, and is
    // `undefined === undefined` against a tree that has no field at all.
    expect(OFFICE_BENCH_OUTBREAK_DEFAULT).toBe(2);
    expect(parseOfficeBenchSearch("?officeBench=20")?.outbreak).toBe(2);
    expect(
      parseOfficeBenchSearch("?officeBench=20&officeBenchOutbreak=nope")
        ?.outbreak,
    ).toBe(2);
  });

  it("falls a zero or negative outbreak back to the default, and caps a count at the population", () => {
    expect(OFFICE_BENCH_OUTBREAK_DEFAULT).toBe(2);
    expect(
      parseOfficeBenchSearch("?officeBench=20&officeBenchOutbreak=0")?.outbreak,
    ).toBe(2);
    expect(
      parseOfficeBenchSearch("?officeBench=20&officeBenchOutbreak=-2")
        ?.outbreak,
    ).toBe(2);
    expect(
      parseOfficeBenchSearch("?officeBench=20&officeBenchOutbreak=100")
        ?.outbreak,
    ).toBe(20);
  });

  it("ignores an unknown script rather than defaulting one", () => {
    // A typo must not put an outbreak on a floor a dev asked to leave
    // still. The shape falls back to triage; the script does not.
    expect(
      parseOfficeBenchSearch("?officeBench=20&officeBenchScript=plague"),
    ).toEqual({
      shape: "triage",
      agents: 20,
      script: null,
      outbreak: OFFICE_BENCH_OUTBREAK_DEFAULT,
    });
  });
});

describe("officeBench", () => {
  const originalHref = window.location.href;
  afterEach(() => {
    window.history.replaceState({}, "", originalHref);
  });

  it("projects the fixture as the comm-graph's own nodes", () => {
    const fixture = makeTestEpic("triage", 12, OFFICE_BENCH_SEED);

    const nodes = benchAgents({ shape: "triage", agents: 12, ...STILL_OFFICE });

    expect(nodes).toHaveLength(12);
    // The same agents, in the same order, carrying every field the tile's own
    // projection carries - which is what makes the bench the ordinary input
    // path rather than a second one.
    expect(nodes.map((node) => node.id)).toEqual(
      fixture.agents.map((agent) => agent.id),
    );
    for (const [index, node] of nodes.entries()) {
      const agent = fixture.agents[index];
      expect(node).toEqual({
        id: agent.id,
        kind: agent.kind,
        name: agent.name,
        hostId: agent.hostId,
        parentId: agent.parentId,
        harnessId: agent.harnessId,
        model: agent.model,
        archived: agent.archived,
        archivedAt: agent.archivedAt,
        createdAt: agent.createdAt,
      });
    }
  });

  it("carries the archived agents, which are the ones a still bench can show", () => {
    const nodes = benchAgents({
      shape: "triage",
      agents: 309,
      ...STILL_OFFICE,
    });

    // 4 % of the fixture, and the one status that rides on the agent record
    // rather than on a store the bench has no entry in.
    expect(nodes.filter((node) => node.archived)).toHaveLength(12);
  });

  it("builds a bench once, however often the tile asks for it", () => {
    // The tile calls this on every render and again on every remount, and a
    // view switch is a remount; rebuilding a thousand agents each time would
    // make the bench the thing being measured.
    const first = benchAgents({
      shape: "many-roots",
      agents: 50,
      ...STILL_OFFICE,
    });
    const second = benchAgents({
      shape: "many-roots",
      agents: 50,
      ...STILL_OFFICE,
    });

    expect(second).toBe(first);
  });

  it("rebuilds when the bench asked for changes", () => {
    const triage = benchAgents({
      shape: "triage",
      agents: 50,
      ...STILL_OFFICE,
    });
    const roots = benchAgents({
      shape: "many-roots",
      agents: 50,
      ...STILL_OFFICE,
    });

    expect(roots).not.toBe(triage);
    // Every root of its own, which is the shape's whole point.
    expect(roots.every((node) => node.parentId === null)).toBe(true);
  });

  it("dresses the bench in the fixture's own statuses, so it MOVES", () => {
    // A still office answers a cold open and a heap plateau and cannot answer
    // a p95 frame time. These are what put screens mid-alternation, hands up
    // and bubbles over desks at a thousand agents.
    const fixture = makeTestEpic("triage", 309, OFFICE_BENCH_SEED);

    const bench = officeBench({
      shape: "triage",
      agents: 309,
      ...STILL_OFFICE,
    });

    expect(bench.statusById).toEqual(fixture.statusById);
    // NEITHER of the two still statuses counts. `idle` is seated with nothing
    // to do and `archived` is a dust sheet over a desk - an office of nothing
    // but archives would satisfy a `!== "idle"` filter and move not at all,
    // which is the one thing this case exists to rule out.
    const hot = [...bench.statusById.values()].filter(
      (status) => status !== "idle" && status !== "archived",
    );
    expect(hot.length).toBeGreaterThan(0);
    // About a tenth of the floor, which is what an epic under way looks like.
    expect(hot.length).toBeLessThan(309 / 2);
  });

  it("is the same tenth of the floor on every run, not a fresh roll", () => {
    // The point of a bench: two profiles of one URL are comparable, so a
    // difference between them is the code's and not the dice's.
    const first = officeBench({
      shape: "one-team",
      agents: 120,
      ...STILL_OFFICE,
    }).statusById;
    const rebuilt = officeBench({
      shape: "triage",
      agents: 120,
      ...STILL_OFFICE,
    }).statusById;
    const again = officeBench({
      shape: "one-team",
      agents: 120,
      ...STILL_OFFICE,
    }).statusById;

    expect(rebuilt).not.toBe(first);
    expect([...again]).toEqual([...first]);
  });

  it("keeps a bench's agents and statuses from two different fixtures apart", () => {
    // Held together rather than beside each other: a status map built from one
    // fixture and an agent set from another would name agents that are not
    // there and leave the ones that are reading idle.
    const bench = officeBench({
      shape: "two-hosts",
      agents: 80,
      ...STILL_OFFICE,
    });

    const ids = new Set(bench.agents.map((node) => node.id));
    for (const agentId of bench.statusById.keys()) {
      expect(ids.has(agentId)).toBe(true);
    }
  });

  function statusCount(
    map: ReadonlyMap<string, OfficeAgentStatus>,
    want: OfficeAgentStatus,
  ): number {
    let n = 0;
    for (const status of map.values()) {
      if (status === want) n += 1;
    }
    return n;
  }

  function failureIds(
    map: ReadonlyMap<string, OfficeAgentStatus>,
  ): ReadonlyArray<string> {
    const ids: string[] = [];
    for (const [id, status] of map) {
      if (status === "failure") ids.push(id);
    }
    return ids;
  }

  it("plays outbreak as a transition off the resting map, three more failures on one host", () => {
    const request: OfficeBenchRequest = {
      shape: "two-hosts",
      agents: 80,
      script: "outbreak",
      outbreak: 3,
    };
    const fixture = makeTestEpic(
      request.shape,
      request.agents,
      OFFICE_BENCH_SEED,
    );
    const bench = officeBench(request);
    expect(bench.steps.length).toBeGreaterThan(1);
    expect(bench.steps[0]).toBe(bench.statusById);
    // The resting map is NOT the fixture's roll: civic-wanting statuses
    // are stood down so the first script step is a transition rather than
    // a floor that opened already full. The identity with `statusById`
    // stays — that is now structural (`statusById` is `steps[0]`).
    expect(bench.steps[0]).not.toEqual(fixture.statusById);

    const resting = failureIds(bench.steps[0]);
    const next = failureIds(bench.steps[1]);
    const extra = next.filter((id) => !resting.includes(id));
    expect(extra).toHaveLength(3);
    expect(statusCount(bench.steps[1], "failure")).toBe(
      statusCount(bench.steps[0], "failure") + 3,
    );
    const hosts = new Set(
      extra.map((id) => {
        const node = bench.agents.find((agent) => agent.id === id);
        if (node === undefined) throw new Error(`missing ${id}`);
        return node.hostId;
      }),
    );
    expect(hosts.size).toBe(1);
  });

  const CIVIC_WANTING: ReadonlySet<OfficeAgentStatus> = new Set([
    "failure",
    "awaiting",
    "attention",
  ]);
  const KEPT_HOT: ReadonlySet<OfficeAgentStatus> = new Set([
    "working",
    "background",
    "archived",
  ]);

  function hostIdOf(
    agents: ReadonlyArray<CommGraphAgentNode>,
    agentId: string,
  ): string | null {
    const node = agents.find((agent) => agent.id === agentId);
    if (node === undefined) throw new Error(`missing ${agentId}`);
    return node.hostId;
  }

  it("rests every civic-wanting status on every host, and keeps working, background and archived", () => {
    // two-hosts/400: both buildings are in frame in Towers, Building and
    // the Floor's stacked storeys, so a total that hid a dirty second
    // host would still look clean.
    const request: OfficeBenchRequest = {
      shape: "two-hosts",
      agents: 400,
      script: "outbreak",
      outbreak: OFFICE_BENCH_OUTBREAK_DEFAULT,
    };
    const fixture = makeTestEpic(
      request.shape,
      request.agents,
      OFFICE_BENCH_SEED,
    );
    const bench = officeBench(request);
    const hosts = new Set(bench.agents.map((agent) => agent.hostId));
    expect(hosts.size).toBeGreaterThan(1);

    for (const host of hosts) {
      const ids = bench.agents
        .filter((agent) => agent.hostId === host)
        .map((agent) => agent.id);
      const fixtureCivic = ids.filter((id) => {
        const status = fixture.statusById.get(id);
        return status !== undefined && CIVIC_WANTING.has(status);
      });
      // Vacuity: the fixture itself must have carried civic-wanting
      // statuses on this host, or the rest is congratulating a clean roll.
      expect(fixtureCivic.length, String(host)).toBeGreaterThan(0);
      for (const id of ids) {
        const rested = bench.steps[0].get(id);
        // The label carries the status found, not just the id: on a
        // 400-agent loop "expected true to be false" is a failure you
        // have to go hunting for, and "leaf-137 on host-b rests as
        // awaiting" is one you have already read.
        expect(
          rested === undefined || CIVIC_WANTING.has(rested),
          `${id} on ${String(host)} rests as ${String(rested)}`,
        ).toBe(false);
      }
      const fixtureKept = ids.filter((id) => {
        const status = fixture.statusById.get(id);
        return status !== undefined && KEPT_HOT.has(status);
      });
      expect(fixtureKept.length, String(host)).toBeGreaterThan(0);
      for (const id of fixtureKept) {
        expect(bench.steps[0].get(id), id).toBe(fixture.statusById.get(id));
      }
    }
  });

  it("makes outbreak step 1's failures all new, exactly two, on one host", () => {
    const request: OfficeBenchRequest = {
      shape: "many-roots",
      agents: 1000,
      script: "outbreak",
      outbreak: 2,
    };
    const bench = officeBench(request);
    const atRest = failureIds(bench.steps[0]);
    const crashed = failureIds(bench.steps[1]);
    expect(crashed).toHaveLength(2);
    expect(atRest).toHaveLength(0);
    for (const id of crashed) {
      expect(bench.steps[0].get(id)).not.toBe("failure");
    }
    const hosts = new Set(crashed.map((id) => hostIdOf(bench.agents, id)));
    expect(hosts.size).toBe(1);
  });

  /**
   * NAMED FOR WHAT IT ASSERTS, which is a status sequence and not a chair.
   *
   * This suite builds status maps; it mounts no scene, so it cannot watch
   * anybody hold a seat or receive one. The title used to promise a freed
   * chair passing to somebody who queued, and a reader who believed it would
   * have thought the handoff was covered here.
   *
   * The nearest thing that DOES observe an arrival-ordered handoff is
   * `office-scene.test.ts`'s "gives a freed bed to the earliest overflow
   * agent, not whoever sorts first by id" - but that is the INFIRMARY's beds,
   * driven by `outbreakScript`. No scene case observes the earliest overflow
   * waiter receiving a freed lounge CHAIR: the two `waitingScript` scene cases
   * walk one agent to the lounge and home again and name the room, which is a
   * different claim. Said plainly here rather than pointed at a case that
   * would not bear the weight.
   */
  it("queues two past the lounge's chairs, then frees exactly one, every change landing on awaiting", () => {
    const request: OfficeBenchRequest = {
      shape: "triage",
      agents: 60,
      script: "waiting",
      outbreak: OFFICE_BENCH_OUTBREAK_DEFAULT,
    };
    const fixture = makeTestEpic(
      request.shape,
      request.agents,
      OFFICE_BENCH_SEED,
    );
    const bench = officeBench(request);
    const chairs = civicCapacityFor(request.agents).chairs;
    expect(chairs).toBeGreaterThan(0);
    const overflow = statusCount(bench.steps[1], "awaiting");
    // EXACTLY two past the chairs, measured: `chairs` is 5 at 60 agents and
    // the step queues 7. The 2 is the module's own `OFFICE_BENCH_WAITING_
    // OVERFLOW`, which is not exported, so it is written out here with the
    // numbers it produces rather than imported. The exact count is only
    // meaningful because the fixture can supply it - `scriptSubjects` takes
    // the first `count` unarchived agents on ONE host, and triage/60 puts all
    // 60 on one, so a queue of 7 is never truncated. A `> chairs` alone would
    // also hold if the script silently queued three, or thirty.
    expect(overflow).toBe(chairs + 2);
    expect(bench.agents.length).toBeGreaterThan(overflow);
    expect(statusCount(bench.steps[2], "awaiting")).toBe(overflow - 1);

    const queued: string[] = [];
    for (const [id, status] of bench.steps[1]) {
      if (status === "awaiting") queued.push(id);
    }
    const still: string[] = [];
    for (const [id, status] of bench.steps[2]) {
      if (status === "awaiting") still.push(id);
    }
    const left = queued.filter((id) => !still.includes(id));
    expect(left).toHaveLength(1);
    // EVERY awaiting agent at the overflow step is one the script put
    // there, not a fixture bystander the old resting map left awaiting
    // at both steps. Same shape as outbreak step 1's failures.
    for (const id of queued) {
      expect(bench.steps[0].get(id), id).not.toBe("awaiting");
    }

    // AND THE STEP ADDS NOTHING ELSE, which is the half the line above
    // cannot see. Building the script from the FIXTURE's map rather than
    // the rested one puts every bystander's hot status back at step 1
    // while step 0 stays clean - so "was this waiter idle at rest" is
    // still true of every waiter, and the count, the one-fewer and the
    // single leaver all survive, because `waitingScript` carries its
    // base's non-subject statuses through untouched.
    //
    // Asserting the CHANGED set rather than the awaiting set is what
    // closes it: skipping the waiters would skip a returning bystander
    // too, since a bystander the fixture left `awaiting` is IN the
    // awaiting set. Every agent whose status moved between the two steps
    // must have moved to `awaiting`; a bystander coming back as
    // `failure` or `attention` moved somewhere else and reddens here.
    for (const [agentId, rested] of bench.steps[0]) {
      const atOverflow = bench.steps[1].get(agentId);
      if (atOverflow === rested) continue;
      expect(atOverflow, `${agentId} moved from ${rested}`).toBe("awaiting");
    }

    const fixtureAwaiting = [...fixture.statusById.values()].filter(
      (status) => status === "awaiting",
    ).length;
    expect(fixtureAwaiting).toBeGreaterThan(0);
    // Vacuity for the CHANGED-set assertion specifically: the fixture has
    // to carry civic-wanting statuses OTHER than `awaiting`, or a script
    // built from it would differ from one built from the rested map only
    // in agents the script names, and the check above would hold either
    // way.
    const fixtureOtherHot = [...fixture.statusById.values()].filter(
      (status) => status === "failure" || status === "attention",
    ).length;
    expect(fixtureOtherHot).toBeGreaterThan(0);
  });

  it("plays waiting so more agents await than the lounge has chairs", () => {
    const request: OfficeBenchRequest = {
      shape: "triage",
      agents: 60,
      script: "waiting",
      outbreak: OFFICE_BENCH_OUTBREAK_DEFAULT,
    };
    const bench = officeBench(request);
    expect(bench.steps.length).toBeGreaterThan(1);
    expect(bench.steps[0]).toBe(bench.statusById);
    const chairs = civicCapacityFor(request.agents).chairs;
    expect(chairs).toBeGreaterThan(0);
    expect(statusCount(bench.steps[1], "awaiting")).toBeGreaterThan(chairs);
  });

  it("has exactly one step with no script, and clamps a step index into that range", () => {
    window.history.replaceState({}, "", "?officeBench=12");
    expect(window.location.search).toBe("?officeBench=12");
    const still = officeBench({
      shape: "triage",
      agents: 12,
      ...STILL_OFFICE,
    });
    expect(still.steps).toHaveLength(1);
    expect(still.steps[0]).toBe(still.statusById);
    expect(officeBenchStatuses(0)).toBe(still.steps[0]);
    expect(officeBenchStatuses(1)).toBe(still.steps[0]);
    expect(officeBenchStatuses(-1)).toBe(still.steps[0]);
    expect(officeBenchStatuses(99)).toBe(still.steps[0]);

    window.history.replaceState(
      {},
      "",
      "?officeBench=40&officeBenchScript=outbreak&officeBenchOutbreak=3",
    );
    expect(window.location.search).toBe(
      "?officeBench=40&officeBenchScript=outbreak&officeBenchOutbreak=3",
    );
    const moving = officeBench({
      shape: "triage",
      agents: 40,
      script: "outbreak",
      outbreak: 3,
    });
    expect(moving.steps.length).toBeGreaterThan(1);
    const last = moving.steps[moving.steps.length - 1];
    // Clamp, not wrap: 999 and -4 are the ticket's indices, and
    // `steps.length` is the wrap-killer (a wrap lands on the resting
    // map; a clamp stays on the last step).
    expect(officeBenchStatuses(999)).toBe(last);
    expect(officeBenchStatuses(-4)).toBe(moving.steps[0]);
    expect(officeBenchStatuses(moving.steps.length)).toBe(last);
  });
});
