import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
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

  describe("reconcileRelays", () => {
    function trackedOpener(): {
      readonly opener: CommGraphCloudSubscriptionOpener;
      readonly opens: CommGraphCloudSubscriptionRequest[];
      readonly closeSpyFor: (hostId: string) => Mock;
    } {
      const opens: CommGraphCloudSubscriptionRequest[] = [];
      const closeSpies = new Map<string, Mock>();
      const closeSpyFor = (hostId: string): Mock => {
        const existing = closeSpies.get(hostId);
        if (existing !== undefined) return existing;
        const spy = vi.fn();
        closeSpies.set(hostId, spy);
        return spy;
      };
      return {
        opens,
        closeSpyFor,
        opener: (request) => {
          opens.push(request);
          return { close: closeSpyFor(request.hostId) };
        },
      };
    }

    it("keeps a live incumbent through a pure order change: no close, no open, no timer change", () => {
      vi.useFakeTimers();
      const tracked = trackedOpener();
      const manager = new CommGraphCloudSubscriptionManager(
        "epic-1",
        tracked.opener,
        () => undefined,
      );
      try {
        manager.reconcileRelays({
          hostIds: ["relay-a", "relay-b"],
          readinessKeys: new Map([
            ["relay-a", "available:v1"],
            ["relay-b", "available:v1"],
          ]),
        });
        manager.attach();
        expect(tracked.opens.map((request) => request.hostId)).toEqual([
          "relay-a",
        ]);

        // The list-equality guard in `reconcileRelays` compares by INDEX
        // (`every((hostId, index) => hostId === this.relayHostIds[index])`),
        // not as sets, so putting "relay-b" first makes `hostIdsUnchanged`
        // false and this call falls through past the early return into the
        // incumbent decision and the trailing `scheduleReconnectingFailover`.
        // The assertions below are therefore about what the KEEP branch does,
        // not about the update being swallowed by the guard.
        manager.reconcileRelays({
          hostIds: ["relay-b", "relay-a"],
          readinessKeys: new Map([
            ["relay-a", "available:v1"],
            ["relay-b", "available:v1"],
          ]),
        });

        // Falsification: delete the
        // `!nextHostIds.includes(incumbentHostId) || changedHostIds.has(incumbentHostId)`
        // condition guarding `closeCurrent()` in `reconcileRelays` (e.g.
        // always close) and this reddens.
        expect(tracked.closeSpyFor("relay-a")).not.toHaveBeenCalled();
        expect(tracked.opens).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        manager.dispose();
        vi.useRealTimers();
      }
    });

    it("clears only the changed host's verdict on another host's readiness change, keeping the incumbent", () => {
      let rejectRelayB = true;
      const opens: CommGraphCloudSubscriptionRequest[] = [];
      const closeSpies = new Map<string, Mock>();
      const manager = new CommGraphCloudSubscriptionManager(
        "epic-1",
        (request) => {
          // Recorded BEFORE the throw: a dial that fails is still a dial, and
          // a recorder that skips it turns every "no open" count in this test
          // into a count of SUCCESSFUL opens - which would not notice the
          // manager re-attempting a rejected candidate.
          opens.push(request);
          if (request.hostId === "relay-b" && rejectRelayB) {
            throw new Error("relay-b not ready yet");
          }
          const spy = vi.fn();
          closeSpies.set(request.hostId, spy);
          return { close: spy };
        },
        () => undefined,
      );

      // relay-b is tried first and throws, so relay-a becomes the incumbent
      // and relay-b is left in the rejected set. Both attempts are recorded.
      manager.reconcileRelays({
        hostIds: ["relay-b", "relay-a"],
        readinessKeys: new Map([
          ["relay-b", "available:v1"],
          ["relay-a", "available:v1"],
        ]),
      });
      manager.attach();
      expect(opens.map((request) => request.hostId)).toEqual([
        "relay-b",
        "relay-a",
      ]);

      // relay-b's own readiness key changes; relay-a's is untouched.
      manager.reconcileRelays({
        hostIds: ["relay-b", "relay-a"],
        readinessKeys: new Map([
          ["relay-b", "available:v2"],
          ["relay-a", "available:v1"],
        ]),
      });

      // No close and no dial of ANY kind - the readiness change belongs to a
      // host that is not the incumbent, so nothing is retried yet.
      expect(closeSpies.get("relay-a")).not.toHaveBeenCalled();
      expect(opens).toHaveLength(2);

      // Positive control proving relay-b's rejected verdict was actually
      // cleared (not merely "incumbent untouched"): force relay-a to fail and
      // confirm relay-b - previously rejected - is now retried. relay-a is the
      // SECOND recorded request, since relay-b's failed dial holds index 0.
      rejectRelayB = false;
      opens[1].handlers.onStatus("unreachable");

      // Falsification: delete the per-changed-host
      // `rejectedRelayHostIds.delete(hostId)` / `unsupportedRelayHostIds.delete(hostId)`
      // loop in `reconcileRelays` and this reddens - relay-b stays rejected
      // forever, so `openNextRelay` finds no candidate and no third request is
      // ever issued.
      expect(closeSpies.get("relay-a")).toHaveBeenCalledTimes(1);
      expect(opens.map((request) => request.hostId)).toEqual([
        "relay-b",
        "relay-a",
        "relay-b",
      ]);
    });

    it("reopens onto the new first candidate when the incumbent's own key changes", () => {
      const tracked = trackedOpener();
      const manager = new CommGraphCloudSubscriptionManager(
        "epic-1",
        tracked.opener,
        () => undefined,
      );
      manager.reconcileRelays({
        hostIds: ["relay-incumbent"],
        readinessKeys: new Map([["relay-incumbent", "available:v1"]]),
      });
      manager.attach();
      expect(tracked.opens.map((request) => request.hostId)).toEqual([
        "relay-incumbent",
      ]);

      manager.reconcileRelays({
        hostIds: ["relay-ahead", "relay-incumbent"],
        readinessKeys: new Map([
          ["relay-ahead", "available:v1"],
          ["relay-incumbent", "available:v2"],
        ]),
      });

      // Falsification: drop the `changedHostIds.has(incumbentHostId)`
      // disjunct from the incumbent close condition in `reconcileRelays` and
      // this reddens - the reopen never happens, so the new head of the list
      // (relay-ahead) is never dialed.
      expect(tracked.opens.map((request) => request.hostId)).toEqual([
        "relay-incumbent",
        "relay-ahead",
      ]);
      expect(tracked.closeSpyFor("relay-incumbent")).toHaveBeenCalledTimes(1);
      expect(tracked.closeSpyFor("relay-ahead")).not.toHaveBeenCalled();
    });

    it("opens exactly one relay - the new first candidate - when the active host is removed and replaced together", () => {
      const tracked = trackedOpener();
      const manager = new CommGraphCloudSubscriptionManager(
        "epic-1",
        tracked.opener,
        () => undefined,
      );
      manager.reconcileRelays({
        hostIds: ["relay-a", "relay-b"],
        readinessKeys: new Map([
          ["relay-a", "available:v1"],
          ["relay-b", "available:v1"],
        ]),
      });
      manager.attach();
      expect(tracked.opens.map((request) => request.hostId)).toEqual([
        "relay-a",
      ]);

      manager.reconcileRelays({
        hostIds: ["relay-c"],
        readinessKeys: new Map([["relay-c", "available:v1"]]),
      });

      // Falsification: replace the `reconcileRelays` call above with the two
      // setters it supersedes, in the order the hook used to run them -
      // readiness keys FIRST, then host ids:
      //
      //   manager.setRelayReadinessKeys(new Map([["relay-c", "available:v1"]]));
      //   manager.setRelayHostIds(["relay-c"]);
      //
      // This reddens on the close count (relay-a closed twice, not once) and
      // then on the sequence, which becomes `["relay-a", "relay-a",
      // "relay-c"]`. The readiness call runs while the host list is still
      // ["relay-a", "relay-b"], sees the incumbent's own key change
      // ("available:v1" -> absent) and so closes and REDIALS relay-a - a host
      // the caller had already dropped - before the second call closes it
      // again and moves to relay-c. That wasted dial against half-installed
      // state is what "exactly one open" exists to pin.
      expect(tracked.closeSpyFor("relay-a")).toHaveBeenCalledTimes(1);
      expect(tracked.opens.map((request) => request.hostId)).toEqual([
        "relay-a",
        "relay-c",
      ]);
    });

    it("keeps a synchronous unsupported verdict through the same reconcile and opens the next candidate once", () => {
      const opens: CommGraphCloudSubscriptionRequest[] = [];
      const closeSpies = new Map<string, Mock>();
      const manager = new CommGraphCloudSubscriptionManager(
        "epic-1",
        (request) => {
          opens.push(request);
          const spy = vi.fn();
          closeSpies.set(request.hostId, spy);
          if (request.hostId === "relay-new") {
            request.handlers.onStatus("unsupported");
          }
          return { close: spy };
        },
        () => undefined,
      );
      manager.reconcileRelays({
        hostIds: ["relay-a"],
        readinessKeys: new Map([["relay-a", "available:v1"]]),
      });
      manager.attach();
      expect(opens.map((request) => request.hostId)).toEqual(["relay-a"]);

      manager.reconcileRelays({
        hostIds: ["relay-new", "relay-fallback"],
        readinessKeys: new Map([
          ["relay-new", "available:v1"],
          ["relay-fallback", "available:v1"],
        ]),
      });

      expect(opens.map((request) => request.hostId)).toEqual([
        "relay-a",
        "relay-new",
        "relay-fallback",
      ]);
      // relay-new's stale handle is torn down once its onStatus callback
      // fails over to relay-fallback synchronously, inside the same open.
      expect(closeSpies.get("relay-new")).toHaveBeenCalledTimes(1);
      expect(closeSpies.get("relay-fallback")).not.toHaveBeenCalled();

      // Positive control proving the verdict outlives the reconcile call
      // that set it: fail relay-fallback and confirm relay-new - marked
      // unsupported inside THIS reconcile - is never retried.
      opens[2].handlers.onStatus("unreachable");

      // Falsification: move the per-changed-host verdict-clearing loop in
      // `reconcileRelays` to run AFTER `this.openNextRelay()` instead of
      // before, and this reddens - relay-new's synchronous `unsupported`
      // verdict (set during that same `openNextRelay()` call) would then be
      // wiped by the same reconcile's own clearing pass, so relay-new
      // becomes a candidate again and gets redialed here.
      expect(opens).toHaveLength(3);
    });

    it("arms exactly one failover timer for a reconnecting incumbent once an alternative appears, unmoved by a later reorder or unrelated readiness change", () => {
      vi.useFakeTimers();
      const tracked = trackedOpener();
      const manager = new CommGraphCloudSubscriptionManager(
        "epic-1",
        tracked.opener,
        () => undefined,
      );
      try {
        manager.reconcileRelays({
          hostIds: ["relay-a"],
          readinessKeys: new Map([["relay-a", "available:v1"]]),
        });
        manager.attach();
        tracked.opens[0].handlers.onStatus("reconnecting");
        // No alternative listed yet: no deadline armed.
        expect(vi.getTimerCount()).toBe(0);

        manager.reconcileRelays({
          hostIds: ["relay-a", "relay-b"],
          readinessKeys: new Map([
            ["relay-a", "available:v1"],
            ["relay-b", "available:v1"],
          ]),
        });
        expect(vi.getTimerCount()).toBe(1);
        expect(tracked.opens).toHaveLength(1);
        expect(tracked.closeSpyFor("relay-a")).not.toHaveBeenCalled();

        vi.advanceTimersByTime(10_000);
        expect(tracked.opens).toHaveLength(1);

        // Pure reorder, same keys - must not restart the budget.
        manager.reconcileRelays({
          hostIds: ["relay-b", "relay-a"],
          readinessKeys: new Map([
            ["relay-a", "available:v1"],
            ["relay-b", "available:v1"],
          ]),
        });
        expect(vi.getTimerCount()).toBe(1);

        vi.advanceTimersByTime(4_000);
        expect(tracked.opens).toHaveLength(1);

        // Unrelated readiness change (relay-b's own key, not the incumbent's)
        // - must also not restart the budget.
        manager.reconcileRelays({
          hostIds: ["relay-b", "relay-a"],
          readinessKeys: new Map([
            ["relay-a", "available:v1"],
            ["relay-b", "available:v2"],
          ]),
        });
        expect(vi.getTimerCount()).toBe(1);

        vi.advanceTimersByTime(999);
        // Total elapsed since the timer armed: 14_999ms - one short of the
        // ORIGINAL deadline. Nothing has fired.
        expect(tracked.opens).toHaveLength(1);

        // Falsification: remove the `this.reconnectingFailoverTimer !== null`
        // early-return guard in `scheduleReconnectingFailover` and this
        // reddens at the FIRST `getTimerCount()` after the reorder, with 2
        // rather than 1. The guard's absence does not restart the existing
        // deadline - nothing clears it - it ADDS a second timer beside it, so
        // each later reconcile leaves another one armed and the host is
        // failed over from a deadline the budget never accounted for.
        vi.advanceTimersByTime(1);
        expect(tracked.opens.map((request) => request.hostId)).toEqual([
          "relay-a",
          "relay-b",
        ]);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        manager.dispose();
        vi.useRealTimers();
      }
    });

    it("clears an unsupported alternative's verdict and arms the failover timer on its readiness change", () => {
      vi.useFakeTimers();
      const opens: CommGraphCloudSubscriptionRequest[] = [];
      const closeSpies = new Map<string, Mock>();
      // Only the FIRST dial of relay-b reports unsupported. Its later retry
      // (after the incumbent's failover timer fires) must succeed normally,
      // or the test could not tell "retried" from "retried and rejected
      // again" - a real opener's compatibility verdict for a given transport
      // identity does not flip back and forth within one attach cycle.
      let reportRelayBUnsupported = true;
      const manager = new CommGraphCloudSubscriptionManager(
        "epic-1",
        (request) => {
          opens.push(request);
          const spy = vi.fn();
          closeSpies.set(request.hostId, spy);
          if (request.hostId === "relay-b" && reportRelayBUnsupported) {
            reportRelayBUnsupported = false;
            request.handlers.onStatus("unsupported");
          }
          return { close: spy };
        },
        () => undefined,
      );
      try {
        // relay-b is tried first and marks itself unsupported synchronously,
        // so relay-a becomes the incumbent.
        manager.reconcileRelays({
          hostIds: ["relay-b", "relay-a"],
          readinessKeys: new Map([
            ["relay-b", "available:v1"],
            ["relay-a", "available:v1"],
          ]),
        });
        manager.attach();
        expect(opens.map((request) => request.hostId)).toEqual([
          "relay-b",
          "relay-a",
        ]);

        opens[1].handlers.onStatus("reconnecting");
        // relay-b is rejected AND sticky-unsupported, so it is not a
        // retryable alternative: no deadline armed.
        expect(vi.getTimerCount()).toBe(0);

        // relay-b's own readiness key changes; relay-a's incumbent key does
        // not, so it stays put.
        manager.reconcileRelays({
          hostIds: ["relay-b", "relay-a"],
          readinessKeys: new Map([
            ["relay-b", "available:v2"],
            ["relay-a", "available:v1"],
          ]),
        });

        // Falsification: drop the trailing `scheduleReconnectingFailover`
        // call in `reconcileRelays` and this reddens - clearing relay-b's
        // verdict would make it a valid alternative, but nothing would ever
        // arm the deadline to fail over to it.
        expect(vi.getTimerCount()).toBe(1);
        expect(closeSpies.get("relay-a")).not.toHaveBeenCalled();
        expect(opens).toHaveLength(2);

        vi.advanceTimersByTime(15_000);
        expect(opens.map((request) => request.hostId)).toEqual([
          "relay-b",
          "relay-a",
          "relay-b",
        ]);
      } finally {
        manager.dispose();
        vi.useRealTimers();
      }
    });
  });
});
