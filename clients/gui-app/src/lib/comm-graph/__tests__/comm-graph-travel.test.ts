import { describe, expect, it } from "vitest";
import {
  commGraphEdgeTravel,
  commGraphTravelKeyPoints,
} from "@/lib/comm-graph/comm-graph-travel";
import type { CommGraphPulse } from "@/lib/comm-graph/comm-graph-timeline";

const EDGE_ID = "a<->b";

function edgePulse(
  fromAgentId: string,
  toAgentId: string,
  pulseKind: "request" | "reply" | "notice",
): CommGraphPulse {
  return { kind: "edge", edgeId: EDGE_ID, pulseKind, fromAgentId, toAgentId };
}

describe("commGraphEdgeTravel", () => {
  it("runs forward when the message goes source→target", () => {
    expect(
      commGraphEdgeTravel(edgePulse("a", "b", "request"), EDGE_ID, "a", "b"),
    ).toEqual({ kind: "request", reversed: false });
  });

  it("REVERSES a reply, so it travels back the way its request came", () => {
    // The drawn edge is undirected and its endpoints are in canonical order, so
    // the same edge carries both directions - this is what makes the two read
    // differently on screen.
    expect(
      commGraphEdgeTravel(edgePulse("b", "a", "reply"), EDGE_ID, "a", "b"),
    ).toEqual({ kind: "reply", reversed: true });
  });

  it("carries a notice with its own kind", () => {
    expect(
      commGraphEdgeTravel(edgePulse("a", "b", "notice"), EDGE_ID, "a", "b"),
    ).toEqual({ kind: "notice", reversed: false });
  });

  it("is null for another pair's pulse", () => {
    expect(
      commGraphEdgeTravel(edgePulse("a", "b", "request"), "c<->d", "c", "d"),
    ).toBeNull();
  });

  it("is null for a node pulse - a half-edge has no path to travel", () => {
    expect(
      commGraphEdgeTravel(
        { kind: "agent", agentId: "a", senderAgentId: "a" },
        EDGE_ID,
        "a",
        "b",
      ),
    ).toBeNull();
  });

  it("is null when there is no pulse at all", () => {
    expect(commGraphEdgeTravel(null, EDGE_ID, "a", "b")).toBeNull();
  });

  it("declines rather than guessing when the endpoints do not match", () => {
    // Should not happen (the pair id derives from these two ids), but animating
    // an arbitrary direction would be worse than not animating.
    expect(
      commGraphEdgeTravel(edgePulse("a", "z", "request"), EDGE_ID, "a", "b"),
    ).toBeNull();
  });
});

describe("commGraphTravelKeyPoints", () => {
  it("walks the SAME path backwards rather than computing a second one", () => {
    expect(commGraphTravelKeyPoints(false)).toBe("0;1");
    expect(commGraphTravelKeyPoints(true)).toBe("1;0");
  });
});
