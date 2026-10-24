import { describe, expect, it } from "vitest";
import type { HostCommunicationGraphCloudFeedEvent } from "@traycer/protocol/host/epic/communication-graph";
import {
  type CommGraphEvent,
  type CommGraphSnapshot,
} from "../comm-graph-events";
import { withEnvironmentArmGraphEvents } from "../compose-comm-graph-events";

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

describe("withEnvironmentArmGraphEvents", () => {
  it("returns the same snapshot for an empty arm", () => {
    const snapshot = snapshotOf([viewerEvent("a", 1)]);
    expect(withEnvironmentArmGraphEvents(snapshot, [])).toBe(snapshot);
  });

  it("returns the same snapshot when the arm holds nothing new", () => {
    const snapshot = snapshotOf([viewerEvent("a", 1)]);
    expect(withEnvironmentArmGraphEvents(snapshot, [armEvent("a", 1)])).toBe(
      snapshot,
    );
  });

  it("normalizes events not held by eventId, merges in graph order, and keeps the viewer's accounting", () => {
    const snapshot = snapshotOf([viewerEvent("a", 10), viewerEvent("c", 30)]);

    const composed = withEnvironmentArmGraphEvents(snapshot, [
      armEvent("a", 10),
      armEvent("b", 20),
    ]);

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
    expect(composed.initialHistoryCaughtUp).toBe(
      snapshot.initialHistoryCaughtUp,
    );
    expect(composed.lastArrival).toBe(snapshot.lastArrival);
    expect(composed.hosts).toBe(snapshot.hosts);
  });
});
