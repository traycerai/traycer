import { describe, expect, it } from "vitest";
import type { EpicCommunicationGraphEvent } from "@traycer/protocol/host/epic/communication-graph";
import {
  CommGraphSubscriptionManager,
  type CommGraphSubscriptionHandlers,
  type CommGraphSubscriptionRequest,
} from "@/lib/comm-graph/comm-graph-subscription";

interface FakeSubscription {
  readonly request: CommGraphSubscriptionRequest;
  readonly handlers: CommGraphSubscriptionHandlers;
  closed: boolean;
}

function createFakeOpener(): {
  readonly opener: (request: CommGraphSubscriptionRequest) => {
    readonly close: () => void;
  };
  readonly opened: FakeSubscription[];
} {
  const opened: FakeSubscription[] = [];
  return {
    opened,
    opener: (request) => {
      const entry: FakeSubscription = {
        request,
        handlers: request.handlers,
        closed: false,
      };
      opened.push(entry);
      return {
        close: () => {
          entry.closed = true;
        },
      };
    },
  };
}

function makeEvent(
  overrides: Partial<EpicCommunicationGraphEvent> & {
    readonly id: number;
    readonly timestamp: number;
  },
): EpicCommunicationGraphEvent {
  return {
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

function liveSubscription(entry: FakeSubscription): void {
  entry.handlers.onStatus("live");
}

describe("CommGraphSubscriptionManager", () => {
  it("opens one subscription per host and sends an explicit null first cursor", () => {
    const { opened, opener } = createFakeOpener();
    const manager = new CommGraphSubscriptionManager("epic-1", opener);
    manager.attach();

    manager.setHostIds(["host-a", "host-b"]);

    expect(opened).toHaveLength(2);
    expect(opened.map((entry) => entry.request.hostId)).toEqual([
      "host-a",
      "host-b",
    ]);
    // Required-and-nullable on the wire: the key must be present, not omitted.
    for (const entry of opened) {
      expect(Object.hasOwn(entry.request, "sinceCursor")).toBe(true);
      expect(entry.request.sinceCursor).toBeNull();
      expect(entry.request.epicId).toBe("epic-1");
    }
    manager.dispose();
  });

  it("draws each host's snapshot boundary independently, empty snapshots included", () => {
    const { opened, opener } = createFakeOpener();
    const manager = new CommGraphSubscriptionManager("epic-1", opener);
    manager.attach();
    manager.setHostIds(["host-a", "host-b"]);

    // No boundary before the handoff: we do not yet know what this host's
    // history is, so nothing from it can be classed as an arrival.
    const before = manager.getSnapshot().hosts;
    expect(before.every((host) => host.snapshotBoundary === null)).toBe(true);
    expect(manager.getSnapshot().initialHistoryCaughtUp).toBe(false);

    opened[0].handlers.onSnapshot(
      [
        makeEvent({ id: 1, timestamp: 10 }),
        makeEvent({ id: 4, timestamp: 20 }),
      ],
      4,
    );
    // A visible row from A does not prove that B's initial history is done.
    expect(manager.getSnapshot().initialHistoryCaughtUp).toBe(false);
    // A fresh epic legitimately has nothing - still a boundary, just an empty
    // one, which is what lets its FIRST row read as new.
    opened[1].handlers.onSnapshot([], null);

    const hosts = manager.getSnapshot().hosts;
    const hostA = hosts.find((host) => host.hostId === "host-a");
    const hostB = hosts.find((host) => host.hostId === "host-b");
    expect(hostA?.snapshotBoundary).toEqual({ highestId: 4 });
    expect(hostB?.snapshotBoundary).toEqual({ highestId: null });
    expect(manager.getSnapshot().initialHistoryCaughtUp).toBe(true);
    manager.dispose();
  });

  it("reports no arrival while hosts are only handing over history", () => {
    const { opened, opener } = createFakeOpener();
    const manager = new CommGraphSubscriptionManager("epic-1", opener);
    manager.attach();
    manager.setHostIds(["host-a", "host-b"]);

    opened[0].handlers.onSnapshot([makeEvent({ id: 1, timestamp: 100 })], 1);
    // Host B hands over its whole history LATE, and its rows sort ABOVE
    // everything host A holds. Against a single merged high-water mark this
    // reads as a burst of activity; against host B's own boundary it is history.
    opened[1].handlers.onSnapshot(
      [
        makeEvent({ id: 1, timestamp: 300 }),
        makeEvent({ id: 2, timestamp: 400 }),
      ],
      2,
    );

    expect(manager.getSnapshot().lastArrival).toBeNull();
    manager.dispose();
  });

  it("reports the first live row of a host that initialized EMPTY", () => {
    const { opened, opener } = createFakeOpener();
    const manager = new CommGraphSubscriptionManager("epic-1", opener);
    manager.attach();
    manager.setHostIds(["host-a"]);

    // A fresh epic: no history at all. Its very first row is genuinely new, so
    // an empty snapshot must still count as an initialization.
    opened[0].handlers.onSnapshot([], null);
    opened[0].handlers.onEvent(makeEvent({ id: 1, timestamp: 100 }));

    expect(manager.getSnapshot().lastArrival?.id).toBe(1);
    manager.dispose();
  });

  it("reports a live row from each host once both have boundaries", () => {
    const { opened, opener } = createFakeOpener();
    const manager = new CommGraphSubscriptionManager("epic-1", opener);
    manager.attach();
    manager.setHostIds(["host-a", "host-b"]);

    opened[0].handlers.onSnapshot([makeEvent({ id: 1, timestamp: 100 })], 1);
    opened[1].handlers.onSnapshot([makeEvent({ id: 1, timestamp: 300 })], 1);

    opened[0].handlers.onEvent(makeEvent({ id: 2, timestamp: 500 }));
    expect(manager.getSnapshot().lastArrival?.hostId).toBe("host-a");

    opened[1].handlers.onEvent(makeEvent({ id: 2, timestamp: 600 }));
    expect(manager.getSnapshot().lastArrival?.hostId).toBe("host-b");
    manager.dispose();
  });

  it("classes capped-snapshot overflow as history, not arrivals", () => {
    // The snapshot is BOUNDED: on a large backlog it is a prefix of the gap
    // and the remainder legally arrives as `event` frames. The wire headId -
    // the log's head at handoff - is what keeps that day-old overflow from
    // pulsing as live traffic.
    const { opened, opener } = createFakeOpener();
    const manager = new CommGraphSubscriptionManager("epic-1", opener);
    manager.attach();
    manager.setHostIds(["host-a"]);

    // A capped snapshot: two rows handed over, but the log's head is 5.
    opened[0].handlers.onSnapshot(
      [
        makeEvent({ id: 1, timestamp: 100 }),
        makeEvent({ id: 2, timestamp: 200 }),
      ],
      5,
    );
    // Overflow drains as event frames - ids at or below the head: history.
    opened[0].handlers.onEvent(makeEvent({ id: 3, timestamp: 300 }));
    opened[0].handlers.onEvent(makeEvent({ id: 5, timestamp: 500 }));
    expect(manager.getSnapshot().lastArrival).toBeNull();
    expect(manager.getSnapshot().events).toHaveLength(4);

    // The first row ABOVE the head is the first genuine arrival.
    opened[0].handlers.onEvent(makeEvent({ id: 6, timestamp: 600 }));
    expect(manager.getSnapshot().lastArrival?.id).toBe(6);
    manager.dispose();
  });

  it("keeps the newer arrival when an older host's row lands after it", () => {
    const { opened, opener } = createFakeOpener();
    const manager = new CommGraphSubscriptionManager("epic-1", opener);
    manager.attach();
    manager.setHostIds(["host-a", "host-b"]);
    opened[0].handlers.onSnapshot([], null);
    opened[1].handlers.onSnapshot([], null);

    opened[1].handlers.onEvent(makeEvent({ id: 1, timestamp: 900 }));
    // Above host A's own boundary, so it IS an arrival for that host - but it
    // is older than what host B already delivered, so it is not the newest one.
    opened[0].handlers.onEvent(makeEvent({ id: 1, timestamp: 100 }));

    expect(manager.getSnapshot().lastArrival?.hostId).toBe("host-b");
    manager.dispose();
  });

  it("forgets an arrival whose host leaves the epic", () => {
    const { opened, opener } = createFakeOpener();
    const manager = new CommGraphSubscriptionManager("epic-1", opener);
    manager.attach();
    manager.setHostIds(["host-a", "host-b"]);
    opened[0].handlers.onSnapshot([], null);
    opened[1].handlers.onSnapshot([], null);
    opened[1].handlers.onEvent(makeEvent({ id: 1, timestamp: 900 }));
    expect(manager.getSnapshot().lastArrival).not.toBeNull();

    // Its rows leave with it, so the arrival must not survive to be pulsed
    // against a node that is also gone.
    manager.setHostIds(["host-a"]);

    expect(manager.getSnapshot().lastArrival).toBeNull();
    manager.dispose();
  });

  it("does not move a host's boundary past a reconnect gap snapshot", () => {
    const { opened, opener } = createFakeOpener();
    const manager = new CommGraphSubscriptionManager("epic-1", opener);
    manager.attach();
    manager.setHostIds(["host-a"]);

    opened[0].handlers.onSnapshot([makeEvent({ id: 1, timestamp: 10 })], 1);
    opened[0].handlers.onStatus("reconnecting");
    // Rows that appeared while we were disconnected are ARRIVALS, not history,
    // so the initialization line must stay where it was first drawn.
    opened[1].handlers.onSnapshot([makeEvent({ id: 2, timestamp: 20 })], 2);

    const [hostA] = manager.getSnapshot().hosts;
    expect(hostA.snapshotBoundary).toEqual({ highestId: 1 });
    expect(hostA.cursor).toBe(2);
    manager.dispose();
  });

  it("merges disjoint per-host logs by timestamp without comparing ids across hosts", () => {
    const { opened, opener } = createFakeOpener();
    const manager = new CommGraphSubscriptionManager("epic-1", opener);
    manager.attach();
    manager.setHostIds(["host-a", "host-b"]);
    const [hostA, hostB] = opened;

    // Both hosts hand out id 1 and id 2 - per-host id spaces are independent.
    hostA.handlers.onSnapshot(
      [
        makeEvent({ id: 1, timestamp: 100 }),
        makeEvent({ id: 2, timestamp: 300 }),
      ],
      2,
    );
    hostB.handlers.onSnapshot(
      [
        makeEvent({ id: 1, timestamp: 200 }),
        makeEvent({ id: 2, timestamp: 400 }),
      ],
      2,
    );

    const merged = manager.getSnapshot().events;
    expect(
      merged.map((event) => [event.hostId, event.id, event.timestamp]),
    ).toEqual([
      ["host-a", 1, 100],
      ["host-b", 1, 200],
      ["host-a", 2, 300],
      ["host-b", 2, 400],
    ]);
    manager.dispose();
  });

  it("keeps BOTH rows when two land in the same millisecond", () => {
    const { opened, opener } = createFakeOpener();
    const manager = new CommGraphSubscriptionManager("epic-1", opener);
    manager.attach();
    manager.setHostIds(["host-a"]);

    opened[0].handlers.onSnapshot(
      [
        makeEvent({ id: 1, timestamp: 500, messageText: "first" }),
        makeEvent({ id: 2, timestamp: 500, messageText: "second" }),
      ],
      2,
    );

    const merged = manager.getSnapshot().events;
    expect(merged).toHaveLength(2);
    expect(merged.map((event) => event.messageText)).toEqual([
      "first",
      "second",
    ]);
    manager.dispose();
  });

  it("resumes from the highest seen id and drops re-delivered rows on reconnect", () => {
    const { opened, opener } = createFakeOpener();
    const manager = new CommGraphSubscriptionManager("epic-1", opener);
    manager.attach();
    manager.setHostIds(["host-a"]);
    liveSubscription(opened[0]);
    opened[0].handlers.onSnapshot(
      [
        makeEvent({ id: 1, timestamp: 100 }),
        makeEvent({ id: 2, timestamp: 200 }),
      ],
      2,
    );

    opened[0].handlers.onStatus("reconnecting");

    expect(opened[0].closed).toBe(true);
    expect(opened).toHaveLength(2);
    expect(opened[1].request.sinceCursor).toBe(2);

    // A resume that re-delivers already-applied rows must not double them.
    opened[1].handlers.onSnapshot(
      [
        makeEvent({ id: 2, timestamp: 200 }),
        makeEvent({ id: 3, timestamp: 300 }),
      ],
      3,
    );
    expect(manager.getSnapshot().events.map((event) => event.id)).toEqual([
      1, 2, 3,
    ]);
    manager.dispose();
  });

  it("does not re-dial on a reconnect that has no new rows to resume from", () => {
    const { opened, opener } = createFakeOpener();
    const manager = new CommGraphSubscriptionManager("epic-1", opener);
    manager.attach();
    manager.setHostIds(["host-a"]);

    opened[0].handlers.onStatus("reconnecting");
    opened[0].handlers.onStatus("reconnecting");

    expect(opened).toHaveLength(1);
    manager.dispose();
  });

  it("mutes a host that keeps failing to dial instead of spinning on reconnecting", () => {
    // A host with no dialable endpoint (removed / offline) only ever cycles
    // connecting → reconnecting, so without a bounded reporting rule its agents
    // would read "Reconnecting…" forever and never reach the muted state.
    const { opened, opener } = createFakeOpener();
    const manager = new CommGraphSubscriptionManager("epic-1", opener);
    manager.attach();
    manager.setHostIds(["host-a"]);

    opened[0].handlers.onStatus("reconnecting");
    expect(manager.getSnapshot().hosts[0].status).toBe("reconnecting");

    opened[0].handlers.onStatus("connecting");
    opened[0].handlers.onStatus("reconnecting");
    expect(manager.getSnapshot().hosts[0].status).toBe("unreachable");

    // Still muted while the session keeps retrying underneath.
    opened[0].handlers.onStatus("connecting");
    expect(manager.getSnapshot().hosts[0].status).toBe("unreachable");
    manager.dispose();
  });

  it("clears the muted state as soon as a dial succeeds", () => {
    const { opened, opener } = createFakeOpener();
    const manager = new CommGraphSubscriptionManager("epic-1", opener);
    manager.attach();
    manager.setHostIds(["host-a"]);
    opened[0].handlers.onStatus("reconnecting");
    opened[0].handlers.onStatus("reconnecting");
    expect(manager.getSnapshot().hosts[0].status).toBe("unreachable");

    opened[0].handlers.onStatus("live");

    expect(manager.getSnapshot().hosts[0].status).toBe("live");
    opened[0].handlers.onStatus("reconnecting");
    expect(manager.getSnapshot().hosts[0].status).toBe("reconnecting");
    manager.dispose();
  });

  it("reports an unsupported host without disturbing the others", () => {
    const { opened, opener } = createFakeOpener();
    const manager = new CommGraphSubscriptionManager("epic-1", opener);
    manager.attach();
    manager.setHostIds(["host-a", "host-b"]);
    const [hostA, hostB] = opened;

    hostA.handlers.onStatus("unsupported");
    liveSubscription(hostB);
    hostB.handlers.onSnapshot([makeEvent({ id: 1, timestamp: 10 })], 1);

    const snapshot = manager.getSnapshot();
    expect(snapshot.hosts.map((host) => [host.hostId, host.status])).toEqual([
      ["host-a", "unsupported"],
      ["host-b", "live"],
    ]);
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.initialHistoryCaughtUp).toBe(true);
    manager.dispose();
  });

  it("closes and forgets a host that leaves the epic's agent set", () => {
    const { opened, opener } = createFakeOpener();
    const manager = new CommGraphSubscriptionManager("epic-1", opener);
    manager.attach();
    manager.setHostIds(["host-a", "host-b"]);
    opened[0].handlers.onSnapshot([makeEvent({ id: 1, timestamp: 10 })], 1);
    opened[1].handlers.onSnapshot([makeEvent({ id: 1, timestamp: 20 })], 1);

    manager.setHostIds(["host-b"]);

    expect(opened[0].closed).toBe(true);
    const snapshot = manager.getSnapshot();
    expect(snapshot.hosts.map((host) => host.hostId)).toEqual(["host-b"]);
    expect(snapshot.events.map((event) => event.hostId)).toEqual(["host-b"]);
    manager.dispose();
  });

  it("is a no-op when the host set is unchanged", () => {
    const { opened, opener } = createFakeOpener();
    const manager = new CommGraphSubscriptionManager("epic-1", opener);
    manager.attach();
    manager.setHostIds(["host-a"]);
    manager.setHostIds(["host-a"]);

    expect(opened).toHaveLength(1);
    expect(opened[0].closed).toBe(false);
    manager.dispose();
  });

  it("sorts an older row that arrives as an event frame into place", () => {
    // `snapshot` is a BOUNDED initial batch, not a completeness claim: overflow
    // rows and reconnect gap-fills arrive as `event` frames and can predate
    // what we already hold. Frame kind is transport batching only.
    const { opened, opener } = createFakeOpener();
    const manager = new CommGraphSubscriptionManager("epic-1", opener);
    manager.attach();
    manager.setHostIds(["host-a"]);
    opened[0].handlers.onSnapshot([makeEvent({ id: 1, timestamp: 300 })], 1);

    opened[0].handlers.onEvent(makeEvent({ id: 2, timestamp: 100 }));

    expect(
      manager.getSnapshot().events.map((event) => event.timestamp),
    ).toEqual([100, 300]);
    manager.dispose();
  });

  it("re-attaches from the retained cursor after a detach/attach cycle", () => {
    // The StrictMode mount / unmount / remount shape: detach must not throw
    // away what was already applied, or every remount would re-pull the log.
    const { opened, opener } = createFakeOpener();
    const manager = new CommGraphSubscriptionManager("epic-1", opener);
    manager.attach();
    manager.setHostIds(["host-a"]);
    opened[0].handlers.onSnapshot([makeEvent({ id: 7, timestamp: 100 })], 7);

    manager.detach();
    expect(opened[0].closed).toBe(true);
    expect(manager.getSnapshot().events).toHaveLength(1);

    manager.attach();
    expect(opened).toHaveLength(2);
    expect(opened[1].request.sinceCursor).toBe(7);
    manager.dispose();
  });

  it("ignores frames from a subscription that was already replaced", () => {
    const { opened, opener } = createFakeOpener();
    const manager = new CommGraphSubscriptionManager("epic-1", opener);
    manager.attach();
    manager.setHostIds(["host-a"]);
    const stale = opened[0];
    manager.detach();
    manager.attach();

    stale.handlers.onSnapshot([makeEvent({ id: 1, timestamp: 10 })], 1);

    expect(manager.getSnapshot().events).toHaveLength(0);
    manager.dispose();
  });

  it("closes every subscription on dispose and reports itself disposed", () => {
    const { opened, opener } = createFakeOpener();
    const manager = new CommGraphSubscriptionManager("epic-1", opener);
    manager.attach();
    manager.setHostIds(["host-a", "host-b"]);

    manager.dispose();

    expect(opened.every((entry) => entry.closed)).toBe(true);
    expect(manager.isDisposed()).toBe(true);
  });
});

/**
 * Every dial and every close in this manager is nonthrowing by construction:
 * `open` is reachable only through the contained wrapper, and `closeEntry`
 * contains its own disposer. These pin the two paths that used to bypass that -
 * the stream STATUS CALLBACK's resume dial, and the teardown loops.
 */
describe("CommGraphSubscriptionManager failure containment", () => {
  it("contains a throwing resume dial from the stream status callback", () => {
    const opened: CommGraphSubscriptionRequest[] = [];
    let dialBroken = false;
    const manager = new CommGraphSubscriptionManager("epic-1", (request) => {
      if (dialBroken) throw new Error("wiring failed");
      opened.push(request);
      return { close: () => undefined };
    });
    manager.attach();
    manager.setHostIds(["host-a"]);
    // Advance the cursor so the drop takes the resume branch.
    opened[0].handlers.onSnapshot([makeEvent({ id: 4, timestamp: 100 })], 4);

    dialBroken = true;
    // The socket reports its own drop; nothing may escape that callback.
    expect(() => opened[0].handlers.onStatus("reconnecting")).not.toThrow();

    const [hostA] = manager.getSnapshot().hosts;
    expect(hostA.status).toBe("failed");
    manager.dispose();
  });

  it("closes every host on the final detach even when a disposer throws", () => {
    let secondClosed = false;
    const manager = new CommGraphSubscriptionManager("epic-1", (request) => {
      if (request.hostId === "host-a") {
        return {
          close: () => {
            throw new Error("disposer failed");
          },
        };
      }
      return {
        close: () => {
          secondClosed = true;
        },
      };
    });
    manager.attach();
    manager.setHostIds(["host-a", "host-b"]);

    // One broken disposer must not abandon the hosts after it - this runs in a
    // React cleanup, and the caller still has bookkeeping to do afterwards.
    expect(() => manager.detach()).not.toThrow();
    expect(secondClosed).toBe(true);
    manager.dispose();
  });

  it("removes a host whose disposer throws, leaving the others intact", () => {
    const opened: CommGraphSubscriptionRequest[] = [];
    const manager = new CommGraphSubscriptionManager("epic-1", (request) => {
      opened.push(request);
      if (request.hostId === "host-a") {
        return {
          close: () => {
            throw new Error("disposer failed");
          },
        };
      }
      return { close: () => undefined };
    });
    manager.attach();
    manager.setHostIds(["host-a", "host-b"]);
    opened[1].handlers.onSnapshot([makeEvent({ id: 1, timestamp: 100 })], 1);

    // Host removal runs from the standalone host-set effect, which is not
    // transactional either.
    expect(() => manager.setHostIds(["host-b"])).not.toThrow();

    // The departed host is gone from the published state and the survivor kept
    // its rows.
    expect(manager.getSnapshot().hosts.map((host) => host.hostId)).toEqual([
      "host-b",
    ]);
    expect(manager.getSnapshot().events).toHaveLength(1);
    manager.dispose();
  });
});
