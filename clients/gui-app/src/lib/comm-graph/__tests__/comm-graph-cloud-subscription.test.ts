import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostCommunicationGraphCloudFeedEvent } from "@traycer/protocol/host/epic/communication-graph";
import {
  CommGraphCloudSubscriptionManager,
  selectCommGraphAuthoritativeSnapshot,
  type CommGraphCloudSubscriptionOpener,
  type CommGraphCloudSubscriptionRequest,
} from "@/lib/comm-graph/comm-graph-cloud-subscription";
import type { CommGraphSnapshot } from "@/lib/comm-graph/comm-graph-events";
import {
  commGraphEventKey,
  commGraphEventsAsOfCursor,
  commGraphCursorForEvent,
} from "@/lib/comm-graph/comm-graph-timeline";
import {
  dropCommGraphRowOpenKeys,
  useCommGraphRowOpenStore,
} from "@/stores/epics/comm-graph-row-open-store";
import {
  readCommGraphTimelineEpicState,
  reconcilePrunedCommGraphTimelineRows,
  useCommGraphTimelineStore,
} from "@/stores/epics/comm-graph-timeline-store";

function cloudEvent(
  overrides: Partial<HostCommunicationGraphCloudFeedEvent>,
): HostCommunicationGraphCloudFeedEvent {
  return {
    eventId: "event-1",
    originHostId: "origin-a",
    originSequence: 7,
    ingestVersion: 10,
    kind: "a2a_message",
    capturedAt: 1_000,
    senderAgentId: "agent-a",
    receiverAgentId: "agent-b",
    responseId: "response-1",
    inReplyTo: null,
    expectReply: true,
    messageText: "hello",
    noticeReason: null,
    originKind: null,
    originChatId: null,
    originRefId: null,
    historicalUpload: false,
    ...overrides,
  };
}

function recordedOpener(): {
  readonly opener: CommGraphCloudSubscriptionOpener;
  readonly requests: CommGraphCloudSubscriptionRequest[];
} {
  const requests: CommGraphCloudSubscriptionRequest[] = [];
  return {
    requests,
    opener: (request) => {
      requests.push(request);
      return { close: () => undefined };
    },
  };
}

beforeEach(() => {
  useCommGraphRowOpenStore.setState({ openRowKeysByEpicId: {} });
  useCommGraphTimelineStore.setState({ stateByEpicId: {} });
});

describe("CommGraphCloudSubscriptionManager", () => {
  it("normalizes cloud identity and uses one cursor-aware path for snapshots and events", () => {
    const recorded = recordedOpener();
    const manager = new CommGraphCloudSubscriptionManager(
      "epic-1",
      recorded.opener,
      () => undefined,
    );
    manager.setRelayHostIds(["relay-b"]);
    manager.attach();
    const handlers = recorded.requests[0].handlers;

    handlers.onAvailability("available");
    handlers.onSnapshot([cloudEvent({})], 10, null);
    expect(manager.isInitialHistoryCaughtUp()).toBe(false);
    expect(manager.getSnapshot().initialHistoryCaughtUp).toBe(false);
    handlers.onCaughtUp({ ingestVersion: 10, eventId: "event-1" }, 10);
    expect(manager.isInitialHistoryCaughtUp()).toBe(true);
    expect(manager.getSnapshot().initialHistoryCaughtUp).toBe(true);
    // A changed head/snapshot may replay the retained cursor; it is never a
    // bootstrap replacement and cannot duplicate or clear the first row.
    handlers.onSnapshot(
      [
        cloudEvent({}),
        cloudEvent({
          eventId: "event-2",
          originSequence: 8,
          ingestVersion: 11,
          capturedAt: 2_000,
        }),
      ],
      11,
      null,
    );

    const snapshot = manager.getSnapshot();
    expect(snapshot.events.map((event) => event.eventId)).toEqual([
      "event-1",
      "event-2",
    ]);
    expect(snapshot.events[0]).toMatchObject({
      id: 7,
      hostId: "origin-a",
      timestamp: 1_000,
    });
    expect(commGraphEventKey(snapshot.events[0])).toBe("event-1");
    expect(recorded.requests[0].readSinceCursor()).toEqual({
      ingestVersion: 11,
      eventId: "event-2",
    });

    manager.detach();
    manager.attach();
    expect(recorded.requests[1].readSinceCursor()).toEqual({
      ingestVersion: 11,
      eventId: "event-2",
    });
    recorded.requests[1].handlers.onSnapshot(
      [
        cloudEvent({
          eventId: "event-3",
          originSequence: 9,
          ingestVersion: 12,
          capturedAt: 3_000,
        }),
      ],
      12,
      null,
    );
    expect(manager.getSnapshot().lastArrival).toBeNull();
  });

  it("advances resume progress through a caught-up skipped terminal row", () => {
    const recorded = recordedOpener();
    const manager = new CommGraphCloudSubscriptionManager(
      "epic-1",
      recorded.opener,
      () => undefined,
    );
    manager.setRelayHostIds(["relay-b"]);
    manager.attach();
    const handlers = recorded.requests[0].handlers;

    handlers.onAvailability("available");
    handlers.onSnapshot([cloudEvent({})], 11, null);
    handlers.onCaughtUp(
      { ingestVersion: 11, eventId: "unrepresentable-row" },
      11,
    );

    expect(manager.isInitialHistoryCaughtUp()).toBe(true);
    expect(recorded.requests[0].readSinceCursor()).toEqual({
      ingestVersion: 11,
      eventId: "unrepresentable-row",
    });
  });

  it("suppresses initial and historical-upload pulses but reports a later live row", () => {
    const recorded = recordedOpener();
    const manager = new CommGraphCloudSubscriptionManager(
      "epic-1",
      recorded.opener,
      () => undefined,
    );
    manager.setRelayHostIds(["relay-b"]);
    manager.attach();
    const handlers = recorded.requests[0].handlers;

    handlers.onAvailability("available");
    handlers.onSnapshot([cloudEvent({})], 10, null);
    expect(manager.getSnapshot().lastArrival).toBeNull();

    handlers.onEvent(
      cloudEvent({
        eventId: "history-late",
        ingestVersion: 11,
        historicalUpload: true,
      }),
    );
    expect(manager.getSnapshot().lastArrival).toBeNull();

    handlers.onEvent(
      cloudEvent({
        eventId: "live",
        originSequence: 9,
        ingestVersion: 12,
        capturedAt: 3_000,
      }),
    );
    expect(manager.getSnapshot().lastArrival?.eventId).toBe("live");
  });

  it("keeps cloud authority and rows through transient relay failure", () => {
    const localRow = cloudEvent({ eventId: "local-only" });
    const cloudRow = cloudEvent({ eventId: "cloud-only" });
    const local = {
      events: [{ ...localRow, id: 1, timestamp: 1, hostId: "local" }],
      hosts: [],
      initialHistoryCaughtUp: false,
      lastArrival: null,
    } satisfies CommGraphSnapshot;
    const cloud = {
      events: [{ ...cloudRow, id: 2, timestamp: 2, hostId: "origin" }],
      hosts: [
        {
          hostId: "relay",
          status: "reconnecting",
          cursor: 2,
          snapshotBoundary: null,
        },
      ],
      initialHistoryCaughtUp: true,
      lastArrival: null,
    } satisfies CommGraphSnapshot;

    const selected = selectCommGraphAuthoritativeSnapshot(
      "available",
      cloud,
      local,
    );
    expect(selected.events.map((event) => event.eventId)).toEqual([
      "cloud-only",
    ]);
    expect(selected.events).not.toContainEqual(
      expect.objectContaining({ eventId: "local-only" }),
    );
  });

  it("fails over when the preferred relay throws synchronously while dialing", () => {
    const requests: CommGraphCloudSubscriptionRequest[] = [];
    const manager = new CommGraphCloudSubscriptionManager(
      "epic-1",
      (request) => {
        if (request.hostId === "relay-broken") {
          throw new Error("dial failed");
        }
        requests.push(request);
        return { close: () => undefined };
      },
      () => undefined,
    );

    manager.setRelayHostIds(["relay-broken", "relay-healthy"]);
    manager.attach();

    expect(requests).toHaveLength(1);
    expect(requests[0].hostId).toBe("relay-healthy");
    expect(manager.getSnapshot().hosts[0]?.hostId).toBe("relay-healthy");
  });

  it("keeps the replacement handle when a relay fails synchronously during opening", () => {
    const requests: CommGraphCloudSubscriptionRequest[] = [];
    let staleClosed = false;
    let replacementClosed = false;
    const manager = new CommGraphCloudSubscriptionManager(
      "epic-1",
      (request) => {
        requests.push(request);
        if (request.hostId === "relay-stale") {
          request.handlers.onStatus("unsupported");
          return {
            close: () => {
              staleClosed = true;
            },
          };
        }
        return {
          close: () => {
            replacementClosed = true;
          },
        };
      },
      () => undefined,
    );

    manager.setRelayHostIds(["relay-stale", "relay-healthy"]);
    manager.attach();

    expect(requests.map((request) => request.hostId)).toEqual([
      "relay-stale",
      "relay-healthy",
    ]);
    expect(staleClosed).toBe(true);
    expect(replacementClosed).toBe(false);

    manager.detach();
    expect(replacementClosed).toBe(true);
  });

  it("retries a rejected relay when its directory readiness changes in place", () => {
    const requests: CommGraphCloudSubscriptionRequest[] = [];
    let shouldFail = true;
    const manager = new CommGraphCloudSubscriptionManager(
      "epic-1",
      (request) => {
        if (shouldFail) throw new Error("not published yet");
        requests.push(request);
        return { close: () => undefined };
      },
      () => undefined,
    );

    manager.setRelayHostIds(["relay-a"]);
    manager.setRelayReadinessKeys(new Map([["relay-a", "missing-endpoint"]]));
    manager.attach();
    expect(requests).toHaveLength(0);

    shouldFail = false;
    manager.setRelayReadinessKeys(new Map([["relay-a", "available:v2"]]));

    expect(requests).toHaveLength(1);
    expect(requests[0].hostId).toBe("relay-a");
  });

  it("reopens an active relay when its directory readiness rotates", () => {
    const requests: CommGraphCloudSubscriptionRequest[] = [];
    let firstClosed = false;
    const manager = new CommGraphCloudSubscriptionManager(
      "epic-1",
      (request) => {
        requests.push(request);
        return {
          close: () => {
            if (requests.length === 1) firstClosed = true;
          },
        };
      },
      () => undefined,
    );

    manager.setRelayHostIds(["relay-a"]);
    manager.setRelayReadinessKeys(new Map([["relay-a", "available:v1"]]));
    manager.attach();
    expect(requests).toHaveLength(1);

    manager.setRelayReadinessKeys(new Map([["relay-a", "available:v2"]]));

    expect(firstClosed).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1].hostId).toBe("relay-a");
  });

  it("keeps an active relay open when another host's readiness changes", () => {
    const requests: CommGraphCloudSubscriptionRequest[] = [];
    const close = vi.fn();
    const manager = new CommGraphCloudSubscriptionManager(
      "epic-1",
      (request) => {
        requests.push(request);
        return { close };
      },
      () => undefined,
    );

    manager.setRelayHostIds(["relay-a", "relay-b"]);
    manager.setRelayReadinessKeys(
      new Map([
        ["relay-a", "available:v1"],
        ["relay-b", "available:v1"],
      ]),
    );
    manager.attach();

    manager.setRelayReadinessKeys(
      new Map([
        ["relay-a", "available:v1"],
        ["relay-b", "available:v2"],
      ]),
    );

    expect(close).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(requests[0].hostId).toBe("relay-a");
  });

  it("retries retained relays after a detached surface reattaches", () => {
    const recorded = recordedOpener();
    const manager = new CommGraphCloudSubscriptionManager(
      "epic-1",
      recorded.opener,
      () => undefined,
    );
    manager.setRelayHostIds(["relay-a"]);
    manager.attach();
    recorded.requests[0].handlers.onStatus("unsupported");
    expect(manager.getAvailability()).toBe("unsupported");

    manager.detach();
    manager.attach();

    expect(recorded.requests).toHaveLength(2);
    expect(recorded.requests[1].hostId).toBe("relay-a");
  });

  it("revokes established cloud authority when every relay is incompatible", () => {
    const recorded = recordedOpener();
    const manager = new CommGraphCloudSubscriptionManager(
      "epic-1",
      recorded.opener,
      () => undefined,
    );
    manager.setRelayHostIds(["relay-a"]);
    manager.attach();
    recorded.requests[0].handlers.onAvailability("available");

    recorded.requests[0].handlers.onStatus("unsupported");

    expect(manager.getAvailability()).toBe("unsupported");
  });

  it("fails over a replacement relay without losing established cloud authority", () => {
    const recorded = recordedOpener();
    const manager = new CommGraphCloudSubscriptionManager(
      "epic-1",
      recorded.opener,
      () => undefined,
    );
    manager.setRelayHostIds(["relay-a", "relay-b"]);
    manager.attach();
    recorded.requests[0].handlers.onAvailability("available");
    recorded.requests[0].handlers.onStatus("unreachable");

    expect(manager.getAvailability()).toBe("available");
    expect(recorded.requests).toHaveLength(2);
    expect(recorded.requests[1].hostId).toBe("relay-b");
  });

  it("fails over when a relay remains reconnecting past the bounded deadline", () => {
    vi.useFakeTimers();
    const recorded = recordedOpener();
    const manager = new CommGraphCloudSubscriptionManager(
      "epic-1",
      recorded.opener,
      () => undefined,
    );
    try {
      manager.setRelayHostIds(["relay-a", "relay-b"]);
      manager.attach();
      recorded.requests[0].handlers.onAvailability("available");
      recorded.requests[0].handlers.onStatus("reconnecting");

      vi.advanceTimersByTime(14_999);
      expect(recorded.requests).toHaveLength(1);

      vi.advanceTimersByTime(1);
      expect(manager.getAvailability()).toBe("available");
      expect(recorded.requests).toHaveLength(2);
      expect(recorded.requests[1].hostId).toBe("relay-b");
    } finally {
      manager.dispose();
      vi.useRealTimers();
    }
  });

  it("starts a new bounded relay cycle after every retryable candidate times out", () => {
    vi.useFakeTimers();
    const recorded = recordedOpener();
    const manager = new CommGraphCloudSubscriptionManager(
      "epic-1",
      recorded.opener,
      () => undefined,
    );
    try {
      manager.setRelayHostIds(["relay-a", "relay-b"]);
      manager.attach();
      recorded.requests[0].handlers.onAvailability("available");
      recorded.requests[0].handlers.onStatus("reconnecting");

      vi.advanceTimersByTime(15_000);
      expect(recorded.requests[1].hostId).toBe("relay-b");
      recorded.requests[1].handlers.onStatus("reconnecting");

      vi.advanceTimersByTime(15_000);
      expect(recorded.requests).toHaveLength(3);
      expect(recorded.requests[2].hostId).toBe("relay-a");
      expect(manager.getAvailability()).toBe("available");
    } finally {
      manager.dispose();
      vi.useRealTimers();
    }
  });

  it("projects a cloud feed status to every origin host", () => {
    const recorded = recordedOpener();
    const manager = new CommGraphCloudSubscriptionManager(
      "epic-1",
      recorded.opener,
      () => undefined,
    );
    manager.setOriginHostIds(["origin-a", "origin-b"]);
    manager.setRelayHostIds(["relay-a"]);
    manager.attach();
    recorded.requests[0].handlers.onStatus("reconnecting");

    expect(manager.getSnapshot().hosts).toEqual([
      expect.objectContaining({ hostId: "origin-a", status: "reconnecting" }),
      expect.objectContaining({ hostId: "origin-b", status: "reconnecting" }),
    ]);
  });

  it("keeps duplicate cloud origin sequences independently addressable in playback", () => {
    const recorded = recordedOpener();
    const manager = new CommGraphCloudSubscriptionManager(
      "epic-1",
      recorded.opener,
      () => undefined,
    );
    manager.setRelayHostIds(["relay-a"]);
    manager.attach();
    const handlers = recorded.requests[0].handlers;
    handlers.onSnapshot(
      [
        cloudEvent({
          eventId: "event-a",
          originSequence: 7,
          capturedAt: 1_000,
        }),
        cloudEvent({
          eventId: "event-b",
          originSequence: 7,
          ingestVersion: 11,
          capturedAt: 1_000,
        }),
      ],
      11,
      null,
    );

    const events = manager.getSnapshot().events;
    expect(
      commGraphEventsAsOfCursor(events, commGraphCursorForEvent(events[0])),
    ).toEqual([events[0]]);
  });

  it("applies an advancing frontier without reconnecting and returns a pruned playback cursor to live", () => {
    const recorded = recordedOpener();
    const manager = new CommGraphCloudSubscriptionManager(
      "epic-1",
      recorded.opener,
      (rowKeys) => {
        dropCommGraphRowOpenKeys("epic-1", rowKeys);
        reconcilePrunedCommGraphTimelineRows("epic-1", rowKeys);
      },
    );
    manager.setRelayHostIds(["relay-b"]);
    manager.attach();
    const handlers = recorded.requests[0].handlers;
    handlers.onAvailability("available");
    handlers.onSnapshot(
      [
        cloudEvent({ eventId: "below", ingestVersion: 4 }),
        cloudEvent({ eventId: "at", ingestVersion: 5 }),
        cloudEvent({ eventId: "above", ingestVersion: 7 }),
      ],
      7,
      4,
    );
    useCommGraphRowOpenStore.getState().setRowOpen("epic-1", "below", true);
    useCommGraphRowOpenStore.getState().setRowOpen("epic-1", "at", true);
    const below = manager
      .getSnapshot()
      .events.find((event) => event.eventId === "below");
    expect(below).toBeDefined();
    if (below === undefined) return;
    useCommGraphTimelineStore
      .getState()
      .setCursor("epic-1", commGraphCursorForEvent(below));
    useCommGraphTimelineStore.getState().setPlaying("epic-1", true);
    handlers.onEvent(
      cloudEvent({ eventId: "live-8", ingestVersion: 8, capturedAt: 8_000 }),
    );
    const cursorBefore = recorded.requests[0].readSinceCursor();

    handlers.onSnapshot([], 8, 5);

    expect(manager.getSnapshot().events.map((event) => event.eventId)).toEqual([
      "above",
      "at",
      "live-8",
    ]);
    expect(recorded.requests).toHaveLength(1);
    expect(recorded.requests[0].readSinceCursor()).toEqual(cursorBefore);
    const openRows =
      useCommGraphRowOpenStore.getState().openRowKeysByEpicId["epic-1"];
    expect(openRows?.has("below")).toBe(false);
    expect(openRows?.has("at")).toBe(true);
    expect(readCommGraphTimelineEpicState("epic-1")).toEqual({
      cursor: null,
      playing: false,
      speed: 1,
    });

    handlers.onEvent(
      cloudEvent({ eventId: "live-9", ingestVersion: 9, capturedAt: 9_000 }),
    );
    expect(recorded.requests[0].readSinceCursor()).toEqual({
      ingestVersion: 9,
      eventId: "live-9",
    });
  });
});
