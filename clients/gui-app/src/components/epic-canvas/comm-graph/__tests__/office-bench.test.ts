/**
 * The dev bench's own half: what a URL means, and what it builds.
 *
 * The other half - that a benched tile actually draws an office - is in
 * `comm-graph-tile.test.tsx`, where there is a tile to draw one.
 */
import { describe, expect, it } from "vitest";
import type { CommGraphAgentNode } from "@/lib/comm-graph/comm-graph-model";
import { makeTestEpic } from "@/lib/comm-graph/office/office-test-epic";
import {
  officeBench,
  parseOfficeBenchSearch,
  OFFICE_BENCH_MAX_AGENTS,
  OFFICE_BENCH_SEED,
  type OfficeBenchRequest,
} from "@/components/epic-canvas/comm-graph/office/office-bench";

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
    });
  });

  it("reads a named shape, which is how the review's worst case is reachable", () => {
    expect(
      parseOfficeBenchSearch("?officeBench=1000&officeBenchShape=many-roots"),
    ).toEqual({ shape: "many-roots", agents: 1000 });
  });

  it("falls back to triage for a shape it does not know", () => {
    // An address bar, not a form: a typo in the shape should still give the
    // bench that every number in the plan is quoted at.
    expect(
      parseOfficeBenchSearch("?officeBench=12&officeBenchShape=atrium"),
    ).toEqual({ shape: "triage", agents: 12 });
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
    ).toEqual({ shape: "triage", agents: 309 });
  });
});

describe("officeBench", () => {
  it("projects the fixture as the comm-graph's own nodes", () => {
    const fixture = makeTestEpic("triage", 12, OFFICE_BENCH_SEED);

    const nodes = benchAgents({ shape: "triage", agents: 12 });

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
    const nodes = benchAgents({ shape: "triage", agents: 309 });

    // 4 % of the fixture, and the one status that rides on the agent record
    // rather than on a store the bench has no entry in.
    expect(nodes.filter((node) => node.archived)).toHaveLength(12);
  });

  it("builds a bench once, however often the tile asks for it", () => {
    // The tile calls this on every render and again on every remount, and a
    // view switch is a remount; rebuilding a thousand agents each time would
    // make the bench the thing being measured.
    const first = benchAgents({ shape: "many-roots", agents: 50 });
    const second = benchAgents({ shape: "many-roots", agents: 50 });

    expect(second).toBe(first);
  });

  it("rebuilds when the bench asked for changes", () => {
    const triage = benchAgents({ shape: "triage", agents: 50 });
    const roots = benchAgents({ shape: "many-roots", agents: 50 });

    expect(roots).not.toBe(triage);
    // Every root of its own, which is the shape's whole point.
    expect(roots.every((node) => node.parentId === null)).toBe(true);
  });

  it("dresses the bench in the fixture's own statuses, so it MOVES", () => {
    // A still office answers a cold open and a heap plateau and cannot answer
    // a p95 frame time. These are what put screens mid-alternation, hands up
    // and bubbles over desks at a thousand agents.
    const fixture = makeTestEpic("triage", 309, OFFICE_BENCH_SEED);

    const bench = officeBench({ shape: "triage", agents: 309 });

    expect(bench.statusById).toEqual(fixture.statusById);
    const hot = [...bench.statusById.values()].filter(
      (status) => status !== "idle",
    );
    expect(hot.length).toBeGreaterThan(0);
    // About a tenth of the floor, which is what an epic under way looks like.
    expect(hot.length).toBeLessThan(309 / 2);
  });

  it("is the same tenth of the floor on every run, not a fresh roll", () => {
    // The point of a bench: two profiles of one URL are comparable, so a
    // difference between them is the code's and not the dice's.
    const first = officeBench({ shape: "one-team", agents: 120 }).statusById;
    const rebuilt = officeBench({ shape: "triage", agents: 120 }).statusById;
    const again = officeBench({ shape: "one-team", agents: 120 }).statusById;

    expect(rebuilt).not.toBe(first);
    expect([...again]).toEqual([...first]);
  });

  it("keeps a bench's agents and statuses from two different fixtures apart", () => {
    // Held together rather than beside each other: a status map built from one
    // fixture and an agent set from another would name agents that are not
    // there and leave the ones that are reading idle.
    const bench = officeBench({ shape: "two-hosts", agents: 80 });

    const ids = new Set(bench.agents.map((node) => node.id));
    for (const agentId of bench.statusById.keys()) {
      expect(ids.has(agentId)).toBe(true);
    }
  });
});
