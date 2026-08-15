import { describe, expect, it } from "vitest";
import {
  compareCommGraphEvents,
  mergeCommGraphEvents,
  type CommGraphEvent,
} from "@/lib/comm-graph/comm-graph-events";
import type { CommGraphAgentNode } from "@/lib/comm-graph/comm-graph-model";
import {
  commGraphAgentIdsAsOfCursor,
  commGraphCreationCursorByAgentId,
  commGraphCursorForEvent,
  commGraphEventsAsOfCursor,
  commGraphPulseForEvent,
  nextCommGraphTimelineEvent,
} from "@/lib/comm-graph/comm-graph-timeline";

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

function created(
  overrides: Partial<CommGraphEvent> & {
    readonly id: number;
    readonly timestamp: number;
  },
): CommGraphEvent {
  return {
    hostId: "host-a",
    kind: "agent_created",
    senderAgentId: "a",
    receiverAgentId: "b",
    responseId: null,
    inReplyTo: null,
    expectReply: null,
    messageText: null,
    noticeReason: null,
    originKind: null,
    originChatId: null,
    originRefId: null,
    ...overrides,
  };
}

function agent(id: string, createdAt: number): CommGraphAgentNode {
  return {
    id,
    kind: "chat",
    name: id,
    hostId: "host-a",
    parentId: null,
    harnessId: null,
    archived: false,
    createdAt,
  };
}

const VISIBLE = new Set(["a", "b"]);

describe("commGraphEventsAsOfCursor", () => {
  it("returns the whole array for a live (null) cursor", () => {
    const events = [
      a2a({ id: 1, timestamp: 10 }),
      a2a({ id: 2, timestamp: 20 }),
    ];
    expect(commGraphEventsAsOfCursor(events, null)).toBe(events);
  });

  it("includes the cursor row and everything before it", () => {
    const events = [
      a2a({ id: 1, timestamp: 10 }),
      a2a({ id: 2, timestamp: 20 }),
      a2a({ id: 3, timestamp: 30 }),
    ];
    const asOf = commGraphEventsAsOfCursor(
      events,
      commGraphCursorForEvent(events[1]),
    );
    expect(asOf.map((event) => event.id)).toEqual([1, 2]);
  });

  it("keeps every same-millisecond row up to the cursor, split by row id", () => {
    // Two rows landing in the same millisecond. A cursor on the first must not
    // sweep in the second - the row id is what separates them.
    const events = [
      a2a({ id: 7, timestamp: 100 }),
      a2a({ id: 8, timestamp: 100 }),
    ];
    const asOf = commGraphEventsAsOfCursor(
      events,
      commGraphCursorForEvent(events[0]),
    );
    expect(asOf.map((event) => event.id)).toEqual([7]);
  });

  it("still names the same row after an older event is merged in behind it", () => {
    // Snapshot overflow and reconnect gap-fill legally arrive as `event`
    // frames, so a row can land BEFORE the cursor in the merged array. An
    // index-based cursor would slide onto its neighbour here.
    const hostA = [
      a2a({ id: 1, timestamp: 10 }),
      a2a({ id: 2, timestamp: 30 }),
    ];
    const cursor = commGraphCursorForEvent(hostA[1]);
    const withBackfill = mergeCommGraphEvents([
      hostA,
      [a2a({ id: 5, timestamp: 20, hostId: "host-b" })],
    ]);

    const asOf = commGraphEventsAsOfCursor(withBackfill, cursor);

    expect(asOf.map((event) => `${event.hostId}:${event.id}`)).toEqual([
      "host-a:1",
      "host-b:5",
      "host-a:2",
    ]);
    expect(asOf[asOf.length - 1].id).toBe(2);
  });

  it("orders the same way the merged array is sorted", () => {
    const events = [
      a2a({ id: 2, timestamp: 20, hostId: "host-b" }),
      a2a({ id: 9, timestamp: 20, hostId: "host-a" }),
    ].sort(compareCommGraphEvents);
    const asOf = commGraphEventsAsOfCursor(
      events,
      commGraphCursorForEvent(events[0]),
    );
    expect(asOf).toHaveLength(1);
    expect(asOf[0]).toBe(events[0]);
  });
});

describe("commGraphAgentIdsAsOfCursor", () => {
  it("shows every agent when live", () => {
    const agents = [agent("a", 10), agent("b", 500)];
    expect(
      [...commGraphAgentIdsAsOfCursor(agents, null, new Map())].sort(),
    ).toEqual(["a", "b"]);
  });

  it("reveals an agent only at its createdAt", () => {
    const agents = [agent("a", 10), agent("b", 500)];
    const cursor = commGraphCursorForEvent(a2a({ id: 1, timestamp: 100 }));
    expect([...commGraphAgentIdsAsOfCursor(agents, cursor, new Map())]).toEqual(
      ["a"],
    );
  });

  it("does not reveal an agent before its same-millisecond creation row", () => {
    const agents = [agent("a", 10), agent("b", 500)];
    const events = [
      a2a({ id: 1, timestamp: 500 }),
      created({ id: 2, timestamp: 500 }),
    ];

    expect([
      ...commGraphAgentIdsAsOfCursor(
        agents,
        commGraphCursorForEvent(events[0]),
        commGraphCreationCursorByAgentId(events),
      ),
    ]).toEqual(["a"]);
  });
});

describe("nextCommGraphTimelineEvent", () => {
  it("steps to the following row", () => {
    const events = [
      a2a({ id: 1, timestamp: 10 }),
      a2a({ id: 2, timestamp: 20 }),
    ];
    const next = nextCommGraphTimelineEvent(
      events,
      commGraphCursorForEvent(events[0]),
    );
    expect(next?.id).toBe(2);
  });

  it("returns null at the end of the list", () => {
    const events = [a2a({ id: 1, timestamp: 10 })];
    expect(
      nextCommGraphTimelineEvent(events, commGraphCursorForEvent(events[0])),
    ).toBeNull();
  });

  it("steps over a row that was merged in behind the cursor", () => {
    const events = [
      a2a({ id: 1, timestamp: 10 }),
      a2a({ id: 2, timestamp: 20 }),
      a2a({ id: 3, timestamp: 30 }),
    ];
    const next = nextCommGraphTimelineEvent(
      events,
      commGraphCursorForEvent(events[1]),
    );
    expect(next?.id).toBe(3);
  });
});

describe("commGraphPulseForEvent", () => {
  it("pulses the edge for a request", () => {
    expect(
      commGraphPulseForEvent(a2a({ id: 1, timestamp: 10 }), VISIBLE),
    ).toEqual({
      kind: "edge",
      edgeId: "a<->b",
      pulseKind: "request",
      fromAgentId: "a",
      toAgentId: "b",
    });
  });

  it("addresses the PAIR, and reads reply-vs-request from inReplyTo", () => {
    // The canvas edge is undirected, so a reverse-direction row lands on the
    // same edge as the request it answers - direction lives in `pulseKind`.
    expect(
      commGraphPulseForEvent(
        a2a({ id: 1, timestamp: 10, inReplyTo: "r1" }),
        VISIBLE,
      ),
    ).toEqual({
      kind: "edge",
      edgeId: "a<->b",
      pulseKind: "reply",
      fromAgentId: "a",
      toAgentId: "b",
    });
  });

  it("pulses a notice distinctly from a message", () => {
    expect(
      commGraphPulseForEvent(
        a2a({
          id: 1,
          timestamp: 10,
          kind: "a2a_notice",
          noticeReason: "errored",
        }),
        VISIBLE,
      ),
    ).toEqual({
      kind: "edge",
      edgeId: "a<->b",
      pulseKind: "notice",
      // A notice is broker feedback to the agent that opened the request, so
      // it travels back from the agent that owed the reply.
      fromAgentId: "b",
      toAgentId: "a",
    });
  });

  it("falls back to the on-canvas endpoint for a half-edge", () => {
    expect(
      commGraphPulseForEvent(
        a2a({ id: 1, timestamp: 10, receiverAgentId: "outside" }),
        VISIBLE,
      ),
    ).toEqual({ kind: "agent", agentId: "a" });
  });

  it("pulses nothing when neither endpoint is on the canvas", () => {
    expect(
      commGraphPulseForEvent(
        a2a({ id: 1, timestamp: 10, senderAgentId: "x", receiverAgentId: "y" }),
        VISIBLE,
      ),
    ).toBeNull();
  });

  it("pulses nothing when there is no cursor row", () => {
    expect(commGraphPulseForEvent(null, VISIBLE)).toBeNull();
  });
});
