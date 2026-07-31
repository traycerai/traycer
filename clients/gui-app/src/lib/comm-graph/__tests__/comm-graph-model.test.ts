import { describe, expect, it } from "vitest";
import type { CommGraphEvent } from "@/lib/comm-graph/comm-graph-events";
import { aggregateCommGraphEdges } from "@/lib/comm-graph/comm-graph-model";
import { layoutCommGraphNodes } from "@/lib/comm-graph/comm-graph-layout";
import type { CommGraphAgentNode } from "@/lib/comm-graph/comm-graph-model";

function a2a(
  overrides: Partial<CommGraphEvent> & {
    readonly id: number;
    readonly timestamp: number;
  },
): CommGraphEvent {
  return {
    hostId: "host-a",
    kind: "a2a_message",
    senderAgentId: "a",
    receiverAgentId: "b",
    responseId: "r1",
    inReplyTo: null,
    expectReply: false,
    messageText: "hi",
    noticeReason: null,
    originKind: null,
    originChatId: null,
    originRefId: null,
    ...overrides,
  };
}

const AGENT_IDS = new Set(["a", "b"]);

describe("aggregateCommGraphEdges", () => {
  it("draws exactly ONE edge for a pair with traffic in both directions", () => {
    // The canvas invariant: two directed curves per pair turn into unreadable
    // spaghetti, so a pair is one undirected edge no matter which way rows go.
    const edges = aggregateCommGraphEdges(
      [
        a2a({ id: 1, timestamp: 10 }),
        a2a({ id: 2, timestamp: 20 }),
        a2a({ id: 3, timestamp: 30, senderAgentId: "b", receiverAgentId: "a" }),
      ],
      AGENT_IDS,
    );

    expect(edges).toHaveLength(1);
    const pair = edges[0];
    expect(pair.id).toBe("a<->b");
    // Canonical endpoints, so they do not depend on which direction spoke first.
    expect([pair.agentAId, pair.agentBId]).toEqual(["a", "b"]);
    // Last activity is the newest row on the pair in EITHER direction.
    // Both directions interleaved chronologically - the click-through's list.
    expect(pair.events.map((event) => event.id)).toEqual([1, 2, 3]);
  });

  it("draws the lineage edge from a creation row alone - before any message", () => {
    // The whole point of capturing agent_created: a freshly spawned child is
    // linked to its creator at birth, not only once the first message crosses.
    const edges = aggregateCommGraphEdges(
      [
        a2a({
          id: 1,
          timestamp: 10,
          kind: "agent_created",
          responseId: null,
          expectReply: null,
          messageText: null,
        }),
      ],
      AGENT_IDS,
    );

    expect(edges).toHaveLength(1);
    expect(edges[0].id).toBe("a<->b");
    // Pure lineage: nothing here is an unanswered ask.
    expect(edges[0].hasOpenThread).toBe(false);
  });

  it("yields the same pair id whichever direction spoke first", () => {
    const forwardFirst = aggregateCommGraphEdges(
      [a2a({ id: 1, timestamp: 10 })],
      AGENT_IDS,
    );
    const reverseFirst = aggregateCommGraphEdges(
      [a2a({ id: 1, timestamp: 10, senderAgentId: "b", receiverAgentId: "a" })],
      AGENT_IDS,
    );

    expect(forwardFirst[0].id).toBe(reverseFirst[0].id);
    expect([reverseFirst[0].agentAId, reverseFirst[0].agentBId]).toEqual([
      "a",
      "b",
    ]);
  });

  it("counts notices separately from messages", () => {
    const edges = aggregateCommGraphEdges(
      [
        a2a({ id: 1, timestamp: 10 }),
        a2a({
          id: 2,
          timestamp: 20,
          kind: "a2a_notice",
          noticeReason: "turn-ended",
        }),
      ],
      AGENT_IDS,
    );

    // Both kinds land on the pair, uncollapsed - the detail view labels each
    // row for itself.
    expect(edges[0].events.map((event) => event.kind)).toEqual([
      "a2a_message",
      "a2a_notice",
    ]);
  });

  it("dashes the pair when EITHER direction is waiting on a reply", () => {
    // The edge says "this conversation has an unanswered ask"; which way it
    // points is the detail view's job, and it keeps that per direction.
    const edges = aggregateCommGraphEdges(
      [
        a2a({ id: 1, timestamp: 10 }),
        a2a({
          id: 2,
          timestamp: 20,
          senderAgentId: "b",
          receiverAgentId: "a",
          expectReply: true,
          responseId: "r-b",
        }),
      ],
      AGENT_IDS,
    );

    // One edge, dashed because the B→A direction is waiting - the edge says
    // "this conversation has an unanswered ask" and the rows say which way.
    expect(edges).toHaveLength(1);
    expect(edges[0].hasOpenThread).toBe(true);
  });

  it("marks an expectReply send with no later reply as an open thread", () => {
    const edges = aggregateCommGraphEdges(
      [a2a({ id: 1, timestamp: 10, expectReply: true, responseId: "r1" })],
      AGENT_IDS,
    );

    expect(edges[0].hasOpenThread).toBe(true);
  });

  it("closes the thread once a later reply carries its responseId", () => {
    const edges = aggregateCommGraphEdges(
      [
        a2a({ id: 1, timestamp: 10, expectReply: true, responseId: "r1" }),
        a2a({
          id: 2,
          timestamp: 20,
          senderAgentId: "b",
          receiverAgentId: "a",
          inReplyTo: "r1",
        }),
      ],
      AGENT_IDS,
    );

    expect(edges.find((edge) => edge.id === "a<->b")?.hasOpenThread).toBe(
      false,
    );
  });

  it("re-opens a reused responseId when every row shares one timestamp", () => {
    // Request, reply, and a re-opening request routinely land in the same
    // millisecond. Wall clock alone cannot order them; the host's monotonic row
    // id can, and both ends of an A2A exchange live on one host.
    const edges = aggregateCommGraphEdges(
      [
        a2a({ id: 1, timestamp: 100, expectReply: true, responseId: "r1" }),
        a2a({
          id: 2,
          timestamp: 100,
          senderAgentId: "b",
          receiverAgentId: "a",
          inReplyTo: "r1",
        }),
        a2a({ id: 3, timestamp: 100, expectReply: true, responseId: "r1" }),
      ],
      AGENT_IDS,
    );

    expect(edges.find((edge) => edge.id === "a<->b")?.hasOpenThread).toBe(true);
  });

  it("keeps a post-rollback request open when its clock reads EARLIER than the reply", () => {
    // The host's clock stepped backwards between the reply and the next
    // request, so wall-clock ordering would place the new request before the
    // reply that preceded it and mark it answered. Row id is the causal order.
    const edges = aggregateCommGraphEdges(
      [
        a2a({ id: 1, timestamp: 100, expectReply: true, responseId: "r1" }),
        a2a({
          id: 2,
          timestamp: 100,
          senderAgentId: "b",
          receiverAgentId: "a",
          inReplyTo: "r1",
        }),
        a2a({ id: 3, timestamp: 90, expectReply: true, responseId: "r1" }),
      ],
      AGENT_IDS,
    );

    expect(edges.find((edge) => edge.id === "a<->b")?.hasOpenThread).toBe(true);
  });

  it("closes a same-timestamp request that its reply follows by row id", () => {
    const edges = aggregateCommGraphEdges(
      [
        a2a({ id: 1, timestamp: 100, expectReply: true, responseId: "r1" }),
        a2a({
          id: 2,
          timestamp: 100,
          senderAgentId: "b",
          receiverAgentId: "a",
          inReplyTo: "r1",
        }),
      ],
      AGENT_IDS,
    );

    expect(edges.find((edge) => edge.id === "a<->b")?.hasOpenThread).toBe(
      false,
    );
  });

  it("does not let one host's reply close another host's identical responseId", () => {
    // Response ids are host-local, and row ids are not comparable across hosts.
    const edges = aggregateCommGraphEdges(
      [
        a2a({ id: 1, timestamp: 100, expectReply: true, responseId: "r1" }),
        a2a({
          id: 9,
          timestamp: 200,
          hostId: "host-b",
          senderAgentId: "b",
          receiverAgentId: "a",
          inReplyTo: "r1",
        }),
      ],
      AGENT_IDS,
    );

    expect(edges.find((edge) => edge.id === "a<->b")?.hasOpenThread).toBe(true);
  });

  it("re-opens a reused responseId when the newest send is unanswered", () => {
    // `responseId` is reused across a directed pair, so "has a reply somewhere"
    // is not enough - the reply must be LATER than the send.
    const edges = aggregateCommGraphEdges(
      [
        a2a({ id: 1, timestamp: 10, expectReply: true, responseId: "r1" }),
        a2a({
          id: 2,
          timestamp: 20,
          senderAgentId: "b",
          receiverAgentId: "a",
          inReplyTo: "r1",
        }),
        a2a({ id: 3, timestamp: 30, expectReply: true, responseId: "r1" }),
      ],
      AGENT_IDS,
    );

    expect(edges.find((edge) => edge.id === "a<->b")?.hasOpenThread).toBe(true);
  });

  it("skips rows whose endpoints have no node to attach to", () => {
    const edges = aggregateCommGraphEdges(
      [a2a({ id: 1, timestamp: 10, receiverAgentId: "ghost" })],
      AGENT_IDS,
    );

    expect(edges).toEqual([]);
  });
});

describe("layoutCommGraphNodes", () => {
  function agent(
    id: string,
    parentId: string | null,
    createdAt: number,
  ): CommGraphAgentNode {
    return {
      id,
      kind: "chat",
      name: id,
      hostId: "host-a",
      parentId,
      harnessId: null,
      archived: false,
      createdAt,
    };
  }

  it("ranks children below their creator", () => {
    // Lineage is a layout constraint, never a drawn edge - this is the only
    // place it shows up on the canvas.
    const positions = layoutCommGraphNodes(
      [
        agent("root", null, 1),
        agent("child", "root", 2),
        agent("grandchild", "child", 3),
      ],
      [],
    );

    expect(positions.get("child")?.y).toBeGreaterThan(
      positions.get("root")?.y ?? 0,
    );
    expect(positions.get("grandchild")?.y).toBeGreaterThan(
      positions.get("child")?.y ?? 0,
    );
  });

  it("pulls conversing agents together rather than leaving them at opposite ends", () => {
    // Two lineage siblings, only one of which talks to the third agent. Feeding
    // the pair edge to the layout is what stops the talkers reading as
    // unrelated - the old hand-rolled pass placed by lineage order alone.
    const nodes = [
      agent("root", null, 1),
      agent("far", "root", 2),
      agent("near", "root", 3),
      agent("talker", null, 4),
    ];
    const withPair = layoutCommGraphNodes(nodes, [
      { agentAId: "near", agentBId: "talker" },
    ]);

    const nearGap = Math.abs(
      (withPair.get("near")?.x ?? 0) - (withPair.get("talker")?.x ?? 0),
    );
    const farGap = Math.abs(
      (withPair.get("far")?.x ?? 0) - (withPair.get("talker")?.x ?? 0),
    );
    expect(nearGap).toBeLessThan(farGap);
  });

  it("places an identical topology identically, whatever order the pairs arrived in", () => {
    // The aggregation yields pairs in Map insertion order - "whichever spoke
    // first" - so a late row on an existing pair can reorder the layout input
    // for a graph that has not actually changed. Positions must not move under
    // the user because of that.
    const nodes = [
      agent("root", null, 1),
      agent("b", "root", 2),
      agent("c", "root", 3),
    ];
    const oneOrder = layoutCommGraphNodes(nodes, [
      { agentAId: "b", agentBId: "c" },
      { agentAId: "root", agentBId: "c" },
    ]);
    const otherOrder = layoutCommGraphNodes(nodes, [
      { agentAId: "root", agentBId: "c" },
      { agentAId: "b", agentBId: "c" },
    ]);

    for (const id of ["root", "b", "c"]) {
      expect(oneOrder.get(id)).toEqual(otherOrder.get(id));
    }
  });

  it("terminates on a parentId cycle instead of hanging", () => {
    const positions = layoutCommGraphNodes(
      [agent("a", "b", 1), agent("b", "a", 2)],
      [],
    );

    expect(positions.size).toBe(2);
  });
});

/**
 * ADDENDUM 7: an edge carries no statistics - its one adornment is the
 * "awaiting reply" chip (plus dashing), and this flag is the whole of what
 * decides it. React Flow edges do not mount in jsdom, so the flag is where that
 * behaviour is pinned; the chip's own rendering is a dev-app check.
 */
describe("open-thread lifecycle - the edge's only adornment", () => {
  it("leaves a settled pair with nothing to show", () => {
    const edges = aggregateCommGraphEdges(
      [
        a2a({ id: 1, timestamp: 10 }),
        a2a({ id: 2, timestamp: 20, senderAgentId: "b", receiverAgentId: "a" }),
      ],
      AGENT_IDS,
    );
    expect(edges[0].hasOpenThread).toBe(false);
  });

  it("marks the pair while a reply is owed", () => {
    const edges = aggregateCommGraphEdges(
      [a2a({ id: 1, timestamp: 10, expectReply: true, responseId: "r9" })],
      AGENT_IDS,
    );
    expect(edges[0].hasOpenThread).toBe(true);
  });

  it("clears it once the reply lands, so the chip disappears", () => {
    const edges = aggregateCommGraphEdges(
      [
        a2a({ id: 1, timestamp: 10, expectReply: true, responseId: "r9" }),
        a2a({
          id: 2,
          timestamp: 20,
          senderAgentId: "b",
          receiverAgentId: "a",
          responseId: "r9",
          inReplyTo: "r9",
        }),
      ],
      AGENT_IDS,
    );
    expect(edges[0].hasOpenThread).toBe(false);
  });
});
