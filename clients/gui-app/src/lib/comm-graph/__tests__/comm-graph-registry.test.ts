import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DETACHED_MANAGER_LIMIT,
  __commGraphSubscriptionRefCountForTests,
  __commGraphSubscriptionRetainedForTests,
  __resetCommGraphRegistryForTests,
  acquireCommGraphSubscription,
  getCommGraphSubscriptionManager,
  releaseCommGraphSubscription,
} from "@/lib/comm-graph/comm-graph-registry";
import type {
  CommGraphSubscriptionManager,
  CommGraphSubscriptionRequest,
} from "@/lib/comm-graph/comm-graph-subscription";
import type { EpicCommunicationGraphEvent } from "@traycer/protocol/host/epic/communication-graph";

interface RecordedOpener {
  readonly opener: (request: CommGraphSubscriptionRequest) => {
    readonly close: () => void;
  };
  readonly dials: CommGraphSubscriptionRequest[];
  /** How many transports this opener produced have been closed. */
  readonly closed: () => number;
}

/**
 * A surface's opener. In production each one closes over a ref that only THAT
 * surface's effect refreshes, which is why a released one must never be dialed
 * again; these tests tell them apart by which recorder saw the dial.
 */
function recordedOpener(): RecordedOpener {
  const dials: CommGraphSubscriptionRequest[] = [];
  let closedCount = 0;
  return {
    dials,
    closed: () => closedCount,
    opener: (request) => {
      dials.push(request);
      return {
        close: () => {
          closedCount += 1;
        },
      };
    },
  };
}

function row(id: number, timestamp: number): EpicCommunicationGraphEvent {
  return {
    id,
    kind: "a2a_message",
    timestamp,
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
  };
}

function hostStatus(
  manager: CommGraphSubscriptionManager,
  hostId: string,
): string | undefined {
  return manager.getSnapshot().hosts.find((host) => host.hostId === hostId)
    ?.status;
}

afterEach(() => {
  // Always restore real timers so a fake-timer test cannot leak into neighbors.
  vi.useRealTimers();
  __resetCommGraphRegistryForTests();
});

describe("comm-graph subscription registry", () => {
  it("dials through the opener of a surface that is still mounted", () => {
    // The defect this pins: pinning the FIRST opener (or the last acquirer's)
    // leaves the pinned surface free to unmount, after which its transport refs
    // stop being refreshed and every later dial goes into a disposed runtime.
    const first = recordedOpener();
    const second = recordedOpener();
    const claimA = {};
    const claimB = {};

    getCommGraphSubscriptionManager("epic-1");
    acquireCommGraphSubscription("epic-1", claimA, first.opener, ["host-a"]);
    expect(first.dials).toHaveLength(1);

    // Surface A goes away; a new surface arrives with a live opener.
    releaseCommGraphSubscription("epic-1", claimA);
    acquireCommGraphSubscription("epic-1", claimB, second.opener, ["host-a"]);

    // The reattach dialed through B, not through A's frozen one.
    expect(second.dials).toHaveLength(1);
    expect(first.dials).toHaveLength(1);
  });

  it("keeps dialing through a surviving claim when another surface leaves", () => {
    // Two surfaces, and the one that acquired LAST is the one that unmounts -
    // the case a "last acquirer wins" opener slot would get wrong.
    const panel = recordedOpener();
    const tile = recordedOpener();
    const panelClaim = {};
    const tileClaim = {};

    getCommGraphSubscriptionManager("epic-1");
    acquireCommGraphSubscription("epic-1", panelClaim, panel.opener, [
      "host-a",
    ]);
    acquireCommGraphSubscription("epic-1", tileClaim, tile.opener, ["host-a"]);
    // One dial for one host, however many surfaces are watching.
    expect(panel.dials.length + tile.dials.length).toBe(1);

    releaseCommGraphSubscription("epic-1", tileClaim);
    expect(__commGraphSubscriptionRefCountForTests("epic-1")).toBe(1);

    // Still attached (the panel holds it), and a new host dials through the
    // panel's opener - the only one still live. The departed tile's opener is
    // never reached, which is the whole point.
    getCommGraphSubscriptionManager("epic-1").setHostIds(["host-a", "host-b"]);
    expect(panel.dials.at(-1)?.hostId).toBe("host-b");
    expect(tile.dials).toHaveLength(0);
  });

  it("declares the current host set BEFORE reattaching", () => {
    // A retained manager still holds the previous surface's desired set.
    // Attaching first would dial the departed host for a beat.
    const first = recordedOpener();
    const second = recordedOpener();
    const claimA = {};
    const claimB = {};

    getCommGraphSubscriptionManager("epic-1");
    acquireCommGraphSubscription("epic-1", claimA, first.opener, ["host-a"]);
    releaseCommGraphSubscription("epic-1", claimA);

    acquireCommGraphSubscription("epic-1", claimB, second.opener, ["host-b"]);

    expect(second.dials.map((request) => request.hostId)).toEqual(["host-b"]);
  });

  it("counts one subscription no matter how many surfaces claim it", () => {
    const opener = recordedOpener();
    const claimA = {};
    const claimB = {};

    getCommGraphSubscriptionManager("epic-1");
    acquireCommGraphSubscription("epic-1", claimA, opener.opener, ["host-a"]);
    acquireCommGraphSubscription("epic-1", claimB, opener.opener, ["host-a"]);

    // Two claims even though a test override hands both surfaces the same
    // opener function - claims are keyed by surface identity.
    expect(__commGraphSubscriptionRefCountForTests("epic-1")).toBe(2);
    expect(opener.dials).toHaveLength(1);

    releaseCommGraphSubscription("epic-1", claimA);
    releaseCommGraphSubscription("epic-1", claimB);
    expect(__commGraphSubscriptionRefCountForTests("epic-1")).toBe(0);
  });

  it("retains a detached manager so reopening resumes instead of re-pulling", () => {
    const opener = recordedOpener();
    const claim = {};

    getCommGraphSubscriptionManager("epic-1");
    acquireCommGraphSubscription("epic-1", claim, opener.opener, ["host-a"]);
    releaseCommGraphSubscription("epic-1", claim);

    expect(__commGraphSubscriptionRetainedForTests("epic-1")).toBe(true);
    expect(getCommGraphSubscriptionManager("epic-1").isDisposed()).toBe(false);
  });

  it("disposes the oldest detached manager once the retention bound is passed", () => {
    // Each retained manager holds a whole epic's log - uncapped message text,
    // up to 50k rows per host - so the set has to be bounded.
    const epicIds = Array.from(
      { length: DETACHED_MANAGER_LIMIT + 1 },
      (_value, index) => `epic-${index}`,
    );
    for (const epicId of epicIds) {
      const claim = {};
      getCommGraphSubscriptionManager(epicId);
      acquireCommGraphSubscription(epicId, claim, recordedOpener().opener, [
        "host-a",
      ]);
      releaseCommGraphSubscription(epicId, claim);
    }

    // Oldest evicted, the rest retained.
    expect(__commGraphSubscriptionRetainedForTests(epicIds[0])).toBe(false);
    for (const epicId of epicIds.slice(1)) {
      expect(__commGraphSubscriptionRetainedForTests(epicId)).toBe(true);
    }
  });

  it("re-pulls from a null cursor after an eviction", () => {
    const evictedEpicId = "epic-evicted";
    const first = recordedOpener();
    const claim = {};
    getCommGraphSubscriptionManager(evictedEpicId);
    acquireCommGraphSubscription(evictedEpicId, claim, first.opener, [
      "host-a",
    ]);
    // Apply a row so the retained manager would have had a cursor to resume
    // from, had it survived.
    first.dials[0].handlers.onSnapshot([row(7, 100)], 7);
    releaseCommGraphSubscription(evictedEpicId, claim);

    for (let index = 0; index < DETACHED_MANAGER_LIMIT; index += 1) {
      const otherClaim = {};
      const otherEpicId = `epic-other-${index}`;
      getCommGraphSubscriptionManager(otherEpicId);
      acquireCommGraphSubscription(
        otherEpicId,
        otherClaim,
        recordedOpener().opener,
        ["host-a"],
      );
      releaseCommGraphSubscription(otherEpicId, otherClaim);
    }
    expect(__commGraphSubscriptionRetainedForTests(evictedEpicId)).toBe(false);

    // Coming back builds a fresh manager: no events, and an explicit null
    // cursor on the wire (omitting the key fails the open-request parse).
    const second = recordedOpener();
    const revisitClaim = {};
    const manager = getCommGraphSubscriptionManager(evictedEpicId);
    acquireCommGraphSubscription(evictedEpicId, revisitClaim, second.opener, [
      "host-a",
    ]);

    expect(manager.getSnapshot().events).toEqual([]);
    expect(second.dials[0].sinceCursor).toBeNull();
    expect(Object.hasOwn(second.dials[0], "sinceCursor")).toBe(true);
  });
});

/**
 * A transport that is ALREADY OPEN keeps reading the refs of whichever surface
 * opened it - claim-carried openers only decide future dials. These pin the
 * handover for the live ones.
 */
describe("comm-graph registry orphaned transports", () => {
  it("redials a departing claim's host through a surviving claim, resuming its cursor", () => {
    const a = recordedOpener();
    const b = recordedOpener();
    const claimA = {};
    const claimB = {};

    const manager = getCommGraphSubscriptionManager("epic-1");
    acquireCommGraphSubscription("epic-1", claimA, a.opener, ["host-a"]);
    a.dials[0].handlers.onSnapshot([row(1, 100), row(2, 200)], 2);
    acquireCommGraphSubscription("epic-1", claimB, b.opener, ["host-a"]);
    // B joined an already-open socket: nothing to dial yet.
    expect(b.dials).toHaveLength(0);

    releaseCommGraphSubscription("epic-1", claimA);

    // A's socket was orphaned, so it is replaced through B's live opener...
    expect(a.closed()).toBe(1);
    expect(b.dials).toHaveLength(1);
    expect(b.dials[0].hostId).toBe("host-a");
    // ...resuming from the applied cursor, which is what makes it lossless.
    expect(b.dials[0].sinceCursor).toBe(2);

    // The resumed socket re-delivers the boundary row and then continues: no
    // row is lost, and none is duplicated.
    b.dials[0].handlers.onSnapshot([row(2, 200), row(3, 300)], 3);
    expect(manager.getSnapshot().events.map((event) => event.id)).toEqual([
      1, 2, 3,
    ]);
  });

  it("leaves a surviving claim's transport alone when the OTHER surface leaves", () => {
    // The inverse order. Cycling a healthy socket would drop frames for nothing.
    const a = recordedOpener();
    const b = recordedOpener();
    const claimA = {};
    const claimB = {};

    getCommGraphSubscriptionManager("epic-1");
    acquireCommGraphSubscription("epic-1", claimA, a.opener, ["host-a"]);
    acquireCommGraphSubscription("epic-1", claimB, b.opener, ["host-a"]);
    expect(a.dials).toHaveLength(1);

    releaseCommGraphSubscription("epic-1", claimB);

    // Host-a was opened through A, which is still here - untouched.
    expect(a.closed()).toBe(0);
    expect(a.dials).toHaveLength(1);
    expect(b.dials).toHaveLength(0);
  });

  it("redials only the hosts the departing claim opened", () => {
    const a = recordedOpener();
    const b = recordedOpener();
    const claimA = {};
    const claimB = {};

    const manager = getCommGraphSubscriptionManager("epic-1");
    acquireCommGraphSubscription("epic-1", claimA, a.opener, ["host-a"]);
    acquireCommGraphSubscription("epic-1", claimB, b.opener, ["host-a"]);
    // A second host arrives while both watch: it dials through B (newest live).
    manager.setHostIds(["host-a", "host-b"]);
    expect(b.dials.map((request) => request.hostId)).toEqual(["host-b"]);

    releaseCommGraphSubscription("epic-1", claimA);

    // Only host-a was A's; host-b was already B's and is not cycled.
    expect(a.closed()).toBe(1);
    expect(b.closed()).toBe(0);
    expect(b.dials.map((request) => request.hostId)).toEqual([
      "host-b",
      "host-a",
    ]);
  });
});

describe("comm-graph registry acquire with a broken host", () => {
  it("degrades the broken host and still dials the good one", () => {
    // A dial failure is NOT an acquire failure. One host that cannot build a
    // transport must not stop a surface from mounting, nor block the other
    // hosts in the same reconcile pass.
    const dials: string[] = [];
    const partlyBroken = (request: CommGraphSubscriptionRequest) => {
      dials.push(request.hostId);
      if (request.hostId === "host-broken") {
        throw new Error("wiring failed");
      }
      return { close: () => undefined };
    };
    const claim = {};
    const manager = getCommGraphSubscriptionManager("epic-1");

    expect(() =>
      acquireCommGraphSubscription("epic-1", claim, partlyBroken, [
        "host-broken",
        "host-good",
      ]),
    ).not.toThrow();

    // The claim stands, the good host is live, the broken one degraded.
    expect(__commGraphSubscriptionRefCountForTests("epic-1")).toBe(1);
    expect(dials).toContain("host-good");
    expect(hostStatus(manager, "host-good")).not.toBe("failed");
    expect(hostStatus(manager, "host-broken")).toBe("failed");
  });

  it("keeps a pre-existing claim's subscription when a later acquire hits a broken host", () => {
    const good = recordedOpener();
    const broken = () => {
      throw new Error("wiring failed");
    };
    const claimA = {};
    getCommGraphSubscriptionManager("epic-1");
    acquireCommGraphSubscription("epic-1", claimA, good.opener, ["host-a"]);

    // A second surface arrives declaring an extra host it cannot dial.
    acquireCommGraphSubscription("epic-1", {}, broken, ["host-a", "host-b"]);

    // Both claims stand and the first surface's transport is untouched.
    expect(__commGraphSubscriptionRefCountForTests("epic-1")).toBe(2);
    expect(good.closed()).toBe(0);
  });
});

describe("comm-graph registry redial containment", () => {
  it("contains a cleanup-path redial failure and marks the host failed", () => {
    const a = recordedOpener();
    const broken = () => {
      throw new Error("wiring failed");
    };
    const claimA = {};
    const claimB = {};

    const manager = getCommGraphSubscriptionManager("epic-1");
    acquireCommGraphSubscription("epic-1", claimA, a.opener, ["host-a"]);
    acquireCommGraphSubscription("epic-1", claimB, broken, ["host-a"]);

    // Releasing A orphans host-a; replacing it dials through B, which throws.
    // Nothing may escape - this is a React cleanup.
    expect(() => releaseCommGraphSubscription("epic-1", claimA)).not.toThrow();

    expect(hostStatus(manager, "host-a")).toBe("failed");
  });

  it("retries a contained failure and recovers when the transport builds again", async () => {
    const a = recordedOpener();
    const recovering = recordedOpener();
    let failNextDial = true;
    const flaky = (request: CommGraphSubscriptionRequest) => {
      if (failNextDial) {
        failNextDial = false;
        throw new Error("wiring failed");
      }
      return recovering.opener(request);
    };
    const claimA = {};
    const claimB = {};

    const manager = getCommGraphSubscriptionManager("epic-1");
    acquireCommGraphSubscription("epic-1", claimA, a.opener, ["host-a"]);
    a.dials[0].handlers.onSnapshot([row(1, 100)], 1);
    acquireCommGraphSubscription("epic-1", claimB, flaky, ["host-a"]);

    releaseCommGraphSubscription("epic-1", claimA);
    expect(hostStatus(manager, "host-a")).toBe("failed");

    // The bounded retry picks it up once the opener recovers...
    await vi.waitFor(() => {
      expect(recovering.dials).toHaveLength(1);
    });
    // ...resuming from the cursor, so the swap stays lossless even across a
    // failed attempt.
    expect(recovering.dials[0].sinceCursor).toBe(1);
    expect(hostStatus(manager, "host-a")).not.toBe("failed");
  });

  it("caps the retries and leaves the host failed, then reconciles on a later acquire", async () => {
    // Production schedule in comm-graph-subscription.ts (not exported):
    // REDIAL_RETRY_BASE_MS=200, REDIAL_MAX_ATTEMPTS=3 → delays 200ms, 400ms.
    const redialRetryBaseMs = 200;
    const redialMaxAttempts = 3;

    // Install fake timers before the release that schedules the retry chain so
    // we never wait on the real 200+400ms backoff window.
    vi.useFakeTimers();

    const a = recordedOpener();
    let dialAttempts = 0;
    const alwaysBroken = () => {
      dialAttempts += 1;
      throw new Error("wiring failed");
    };
    const claimA = {};
    const claimB = {};

    const manager = getCommGraphSubscriptionManager("epic-1");
    acquireCommGraphSubscription("epic-1", claimA, a.opener, ["host-a"]);
    acquireCommGraphSubscription("epic-1", claimB, alwaysBroken, ["host-a"]);
    // Orphaned host-a redials through alwaysBroken (budget reset) and fails
    // synchronously on attempt 1; attempt 2 is scheduled for baseMs.
    releaseCommGraphSubscription("epic-1", claimA);
    expect(dialAttempts).toBe(1);
    expect(hostStatus(manager, "host-a")).toBe("failed");

    // Attempt 2 after the first backoff window.
    await vi.advanceTimersByTimeAsync(redialRetryBaseMs);
    expect(dialAttempts).toBe(2);
    expect(hostStatus(manager, "host-a")).toBe("failed");

    // Attempt 3 after the doubled backoff; that hits the configured cap.
    await vi.advanceTimersByTimeAsync(redialRetryBaseMs * 2);
    expect(dialAttempts).toBe(redialMaxAttempts);
    expect(hostStatus(manager, "host-a")).toBe("failed");

    // Bounded: past the cap, further time does not schedule another dial.
    // A redial loop is worse than an honest failed state.
    await vi.advanceTimersByTimeAsync(redialRetryBaseMs * 8);
    expect(dialAttempts).toBe(redialMaxAttempts);
    expect(hostStatus(manager, "host-a")).toBe("failed");

    // Exhausting the cap is not the end: the next surface to mount reconciles
    // the host, because `reconcile` reopens any attached host with no handle.
    const healthy = recordedOpener();
    acquireCommGraphSubscription("epic-1", {}, healthy.opener, ["host-a"]);

    expect(healthy.dials.map((request) => request.hostId)).toEqual(["host-a"]);
    expect(hostStatus(manager, "host-a")).not.toBe("failed");
  });
});

/**
 * `setHostIds` is reached from a PLAIN effect as well as from the transactional
 * acquire, so no caller can be relied on to own a dial failure. These pin the
 * consequences of containing it universally.
 */
describe("comm-graph host-set reconcile with a failed host", () => {
  it("dials a newly added host and re-schedules the failed one's recovery", async () => {
    const initial = recordedOpener();
    const recovering = recordedOpener();
    let hostABroken = true;
    const opener = (request: CommGraphSubscriptionRequest) => {
      if (request.hostId === "host-a" && hostABroken) {
        throw new Error("wiring failed");
      }
      return recovering.opener(request);
    };
    const claimA = {};
    const claimB = {};

    // host-a ends up failed with a retry pending: it was opened by A, then
    // orphaned when A released, and the surviving opener cannot rebuild it.
    const manager = getCommGraphSubscriptionManager("epic-1");
    acquireCommGraphSubscription("epic-1", claimA, initial.opener, ["host-a"]);
    acquireCommGraphSubscription("epic-1", claimB, opener, ["host-a"]);
    releaseCommGraphSubscription("epic-1", claimA);
    expect(hostStatus(manager, "host-a")).toBe("failed");

    // The epic gains a second host. This is the standalone host-set effect -
    // NOT a transactional caller - so nothing may escape it.
    expect(() => manager.setHostIds(["host-a", "host-b"])).not.toThrow();

    // host-b was dialed and published even though host-a threw first in the
    // same pass: one broken host cannot block another's dial.
    expect(recovering.dials.map((request) => request.hostId)).toContain(
      "host-b",
    );
    expect(hostStatus(manager, "host-b")).not.toBe("failed");
    expect(hostStatus(manager, "host-a")).toBe("failed");

    // ...and host-a's bounded recovery was RE-SCHEDULED by the reconcile, not
    // cancelled by it, so it comes back on its own once its opener does.
    hostABroken = false;
    await vi.waitFor(() => {
      expect(hostStatus(manager, "host-a")).not.toBe("failed");
    });
    expect(recovering.dials.map((request) => request.hostId)).toContain(
      "host-a",
    );
  });
});
