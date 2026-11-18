import { describe, expect, it, vi } from "vitest";
import {
  createCommGraphFindAdapter,
  type CommGraphFindNode,
  type CommGraphFindRenderer,
} from "@/components/epic-canvas/comm-graph/comm-graph-find-adapter";

const NODES: ReadonlyArray<CommGraphFindNode> = [
  { id: "agent-alpha", name: "Alpha Planner" },
  { id: "agent-beta", name: "Beta Builder" },
  { id: "agent-alpha-review", name: "Alpha Reviewer" },
];

function setup() {
  const renderer: CommGraphFindRenderer = {
    getNodes: () => NODES,
    showMatches: vi.fn(),
    frameMatches: vi.fn(),
    focusMatch: vi.fn(),
    clear: vi.fn(),
  };
  return {
    adapter: createCommGraphFindAdapter({
      tileInstanceId: "graph-instance",
      renderer,
    }),
    renderer,
  };
}

describe("createCommGraphFindAdapter", () => {
  it("matches names case-insensitively and frames every result together", () => {
    const { adapter, renderer } = setup();

    void adapter.search({ requestId: 4, query: "alpha", matchCase: false });

    const expected = new Set(["agent-alpha", "agent-alpha-review"]);
    expect(renderer.showMatches).toHaveBeenCalledWith(expected, 4);
    expect(renderer.frameMatches).toHaveBeenCalledWith(expected);
    expect(adapter.getSnapshot()).toEqual(
      expect.objectContaining({
        requestId: 4,
        status: "ready",
        current: 1,
        total: 2,
        activeUnitId: "agent-alpha",
        exactHighlight: "painted",
      }),
    );
  });

  it("honors match-case and reports no match without moving the viewport", () => {
    const { adapter, renderer } = setup();

    void adapter.search({ requestId: 5, query: "alpha", matchCase: true });

    expect(renderer.showMatches).toHaveBeenCalledWith(new Set(), 5);
    expect(renderer.frameMatches).not.toHaveBeenCalled();
    expect(adapter.getSnapshot()).toEqual(
      expect.objectContaining({ current: 0, total: 0, exactHighlight: "none" }),
    );
  });

  it("cycles individual matches while preserving the result highlight", () => {
    const { adapter, renderer } = setup();
    void adapter.search({ requestId: 6, query: "Alpha", matchCase: true });

    void adapter.next();
    expect(renderer.focusMatch).toHaveBeenLastCalledWith("agent-alpha-review");
    expect(adapter.getSnapshot().current).toBe(2);

    void adapter.next();
    expect(renderer.focusMatch).toHaveBeenLastCalledWith("agent-alpha");
    expect(adapter.getSnapshot().current).toBe(1);

    void adapter.previous();
    expect(renderer.focusMatch).toHaveBeenLastCalledWith("agent-alpha-review");
    expect(adapter.getSnapshot().current).toBe(2);
    expect(renderer.showMatches).toHaveBeenCalledTimes(1);
  });

  it("clears matches and the painted highlight", () => {
    const { adapter, renderer } = setup();
    void adapter.search({ requestId: 7, query: "Alpha", matchCase: false });

    void adapter.clear();

    expect(renderer.clear).toHaveBeenCalledOnce();
    expect(adapter.getSnapshot()).toEqual(
      expect.objectContaining({
        query: "",
        current: 0,
        total: 0,
        activeUnitId: null,
        exactHighlight: "none",
      }),
    );
  });
});
