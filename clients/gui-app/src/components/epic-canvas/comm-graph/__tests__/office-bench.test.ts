/**
 * The dev bench's own half: what a URL means, and what it builds.
 *
 * The other half - that a benched tile actually draws an office - is in
 * `comm-graph-tile.test.tsx`, where there is a tile to draw one.
 */
import { describe, expect, it } from "vitest";
import { makeTestEpic } from "@/lib/comm-graph/office/office-test-epic";
import {
  officeBenchAgents,
  parseOfficeBenchSearch,
  OFFICE_BENCH_MAX_AGENTS,
  OFFICE_BENCH_SEED,
} from "@/components/epic-canvas/comm-graph/office/office-bench";

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

describe("officeBenchAgents", () => {
  it("projects the fixture as the comm-graph's own nodes", () => {
    const fixture = makeTestEpic("triage", 12, OFFICE_BENCH_SEED);

    const nodes = officeBenchAgents({ shape: "triage", agents: 12 });

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
    const nodes = officeBenchAgents({ shape: "triage", agents: 309 });

    // 4 % of the fixture, and the one status that rides on the agent record
    // rather than on a store the bench has no entry in.
    expect(nodes.filter((node) => node.archived)).toHaveLength(12);
  });

  it("builds a bench once, however often the tile asks for it", () => {
    // The tile calls this on every render and again on every remount, and a
    // view switch is a remount; rebuilding a thousand agents each time would
    // make the bench the thing being measured.
    const first = officeBenchAgents({ shape: "many-roots", agents: 50 });
    const second = officeBenchAgents({ shape: "many-roots", agents: 50 });

    expect(second).toBe(first);
  });

  it("rebuilds when the bench asked for changes", () => {
    const triage = officeBenchAgents({ shape: "triage", agents: 50 });
    const roots = officeBenchAgents({ shape: "many-roots", agents: 50 });

    expect(roots).not.toBe(triage);
    // Every root of its own, which is the shape's whole point.
    expect(roots.every((node) => node.parentId === null)).toBe(true);
  });
});
