import { describe, expect, it } from "vitest";
import type { HostCommunicationGraphCloudFeedEvent } from "@traycer/protocol/host/epic/communication-graph";
import {
  type CommGraphEvent,
  type CommGraphSnapshot,
} from "../comm-graph-events";
import {
  withEnvironmentArmGraphEvents,
  type EnvironmentArmGraph,
} from "../compose-comm-graph-events";

function viewerEvent(eventId: string, timestamp: number): CommGraphEvent {
  return {
    id: 1,
    eventId,
    hostId: "host-1",
    kind: "a2a_message",
    timestamp,
    senderAgentId: null,
    receiverAgentId: null,
    responseId: null,
    inReplyTo: null,
    expectReply: null,
    messageText: eventId,
    noticeReason: null,
    originKind: null,
    originChatId: null,
    originRefId: null,
    peerEpicId: null,
  };
}

function armEvent(
  eventId: string,
  capturedAt: number,
): HostCommunicationGraphCloudFeedEvent {
  return {
    eventId,
    originHostId: "host-2",
    originSequence: 1,
    ingestVersion: 1,
    kind: "a2a_message",
    capturedAt,
    senderAgentId: null,
    receiverAgentId: null,
    responseId: null,
    inReplyTo: null,
    expectReply: null,
    messageText: eventId,
    noticeReason: null,
    originKind: null,
    originChatId: null,
    originRefId: null,
    historicalUpload: false,
    peerEpicId: null,
  };
}

function snapshotOf(events: readonly CommGraphEvent[]): CommGraphSnapshot {
  return {
    events,
    hosts: [],
    initialHistoryCaughtUp: true,
    lastArrival: viewerEvent("arrival", 5),
  };
}

function armOf(
  events: readonly HostCommunicationGraphCloudFeedEvent[],
  caughtUp: boolean,
): EnvironmentArmGraph {
  return { events, caughtUp };
}

describe("withEnvironmentArmGraphEvents", () => {
  it("returns the same snapshot for an empty arm that is caught up", () => {
    const snapshot = snapshotOf([viewerEvent("a", 1)]);
    expect(withEnvironmentArmGraphEvents(snapshot, armOf([], true))).toBe(
      snapshot,
    );
  });

  it("returns the same snapshot when the arm holds nothing new and is caught up", () => {
    const snapshot = snapshotOf([viewerEvent("a", 1)]);
    expect(
      withEnvironmentArmGraphEvents(snapshot, armOf([armEvent("a", 1)], true)),
    ).toBe(snapshot);
  });

  it("normalizes events not held by eventId and merges them in graph order, keeping the viewer's arrival and hosts", () => {
    const snapshot = snapshotOf([viewerEvent("a", 10), viewerEvent("c", 30)]);

    const composed = withEnvironmentArmGraphEvents(
      snapshot,
      armOf([armEvent("a", 10), armEvent("b", 20)], true),
    );

    expect(composed.events.map((event) => event.eventId)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(composed.events[1]).toMatchObject({
      hostId: "host-2",
      timestamp: 20,
      messageText: "b",
    });
    expect(composed.initialHistoryCaughtUp).toBe(true);
    expect(composed.lastArrival).toBe(snapshot.lastArrival);
    expect(composed.hosts).toBe(snapshot.hosts);
  });

  it("is not caught up while an arm has not handed over its history, though its events are merged", () => {
    const snapshot = snapshotOf([viewerEvent("a", 10)]);

    const composed = withEnvironmentArmGraphEvents(
      snapshot,
      armOf([armEvent("b", 20)], false),
    );

    expect(composed.initialHistoryCaughtUp).toBe(false);
    expect(composed.events.map((event) => event.eventId)).toEqual(["a", "b"]);
    expect(composed.lastArrival).toBe(snapshot.lastArrival);
    expect(composed.hosts).toBe(snapshot.hosts);
  });

  it("is not caught up while the viewer feed has not, whatever the arm", () => {
    const snapshot = { ...snapshotOf([]), initialHistoryCaughtUp: false };

    expect(
      withEnvironmentArmGraphEvents(snapshot, armOf([], true))
        .initialHistoryCaughtUp,
    ).toBe(false);
  });
});
