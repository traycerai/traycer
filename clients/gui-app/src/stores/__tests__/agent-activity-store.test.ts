import { afterEach, describe, expect, it } from "vitest";
import {
  __resetAgentActivityStoreForTests,
  __setHostAgentActivityHealthForTests,
  agentActivityPlaneAnswers,
  agentActivityPlaneCoversHost,
  agentActivityPlaneSpansFleet,
  noteAgentActivityConnectionStatus,
  subscribeAgentActivityPlaneHealth,
} from "@/stores/agent-activity-store";

/**
 * `agentActivityPlaneAnswers` / `subscribeAgentActivityPlaneHealth` in
 * isolation - the epic session registry's cap-eviction guard
 * (`epicIsBusy`/`session-registry.ts`) is the consumer these exist for, and
 * that file's own suite exercises them through the registry. This file pins
 * the predicate's truth table and the health subscription's edge-triggering
 * directly, without a registry in the loop.
 *
 * The store is keyed by host, so every fixture names the slice it writes. A
 * predicate's answer is the OR over slices; the second-host cases below pin
 * what that means when one host answers and another does not.
 */

const HOST_A = "host-a";
const HOST_B = "host-b";

afterEach(() => {
  __resetAgentActivityStoreForTests();
});

describe("agentActivityPlaneAnswers", () => {
  it("is false while the stream is closed", () => {
    __setHostAgentActivityHealthForTests(HOST_A, {
      connectionStatus: "closed",
      servedBy: "cloud",
      stateFrameSeenThisEpoch: true,
      cloudSyncStatus: "connected",
    });

    expect(agentActivityPlaneAnswers()).toBe(false);
  });

  it("is false while the stream is open but has not delivered a state frame of its OWN", () => {
    // `servedBy` non-null is deliberately part of the fixture: it is what a
    // replacement epoch inherits from the one it replaced, so a predicate
    // reading it would vouch here while the union on record is the old
    // epoch's. Only the frame marker separates the two.
    __setHostAgentActivityHealthForTests(HOST_A, {
      connectionStatus: "open",
      servedBy: "cloud",
      stateFrameSeenThisEpoch: false,
      cloudSyncStatus: null,
    });

    expect(agentActivityPlaneAnswers()).toBe(false);
  });

  it("is true once the stream is open, this epoch has a frame, and the cloud status makes no claim", () => {
    __setHostAgentActivityHealthForTests(HOST_A, {
      connectionStatus: "open",
      servedBy: "local",
      stateFrameSeenThisEpoch: true,
      cloudSyncStatus: null,
    });

    expect(agentActivityPlaneAnswers()).toBe(true);
  });

  it("is true when the host's cloud link is connected", () => {
    __setHostAgentActivityHealthForTests(HOST_A, {
      connectionStatus: "open",
      servedBy: "cloud",
      stateFrameSeenThisEpoch: true,
      cloudSyncStatus: "connected",
    });

    expect(agentActivityPlaneAnswers()).toBe(true);
  });

  it("is false while the host's cloud link is reconnecting", () => {
    __setHostAgentActivityHealthForTests(HOST_A, {
      connectionStatus: "open",
      servedBy: "cloud",
      stateFrameSeenThisEpoch: true,
      cloudSyncStatus: "reconnecting",
    });

    expect(agentActivityPlaneAnswers()).toBe(false);
  });

  it("is false while the host's cloud link is disconnected", () => {
    __setHostAgentActivityHealthForTests(HOST_A, {
      connectionStatus: "open",
      servedBy: "cloud",
      stateFrameSeenThisEpoch: true,
      cloudSyncStatus: "disconnected",
    });

    expect(agentActivityPlaneAnswers()).toBe(false);
  });

  it("is true when one host answers even though another host's stream is down", () => {
    __setHostAgentActivityHealthForTests(HOST_A, {
      connectionStatus: "open",
      servedBy: "local",
      stateFrameSeenThisEpoch: true,
      cloudSyncStatus: null,
    });
    __setHostAgentActivityHealthForTests(HOST_B, {
      connectionStatus: "closed",
      servedBy: null,
      stateFrameSeenThisEpoch: false,
      cloudSyncStatus: null,
    });

    // The plane can speak - for host A. Whether it can speak for host B is
    // `agentActivityPlaneCoversHost`'s question, pinned below.
    expect(agentActivityPlaneAnswers()).toBe(true);
    expect(agentActivityPlaneCoversHost(HOST_A)).toBe(true);
    expect(agentActivityPlaneCoversHost(HOST_B)).toBe(false);
  });
});

describe("subscribeAgentActivityPlaneHealth", () => {
  it("fires once per flip and stays silent on a same-state update", () => {
    __setHostAgentActivityHealthForTests(HOST_A, {
      connectionStatus: "closed",
      servedBy: null,
      cloudSyncStatus: null,
    });

    let callCount = 0;
    const unsubscribe = subscribeAgentActivityPlaneHealth(() => {
      callCount += 1;
    });

    // Still false: connectionStatus moved but the answer did not.
    __setHostAgentActivityHealthForTests(HOST_A, {
      connectionStatus: "connecting",
    });
    expect(callCount).toBe(0);

    // False -> true.
    __setHostAgentActivityHealthForTests(HOST_A, {
      connectionStatus: "open",
      servedBy: "local",
      stateFrameSeenThisEpoch: true,
    });
    expect(callCount).toBe(1);

    // Still true, and still narrow: a working-set change moves neither
    // predicate, and this subscription is not the one that reports it.
    __setHostAgentActivityHealthForTests(HOST_A, {
      byEpic: new Map([
        ["epic-1", { working: new Set(["agent-1"]), turn: new Set<string>() }],
      ]),
    });
    expect(callCount).toBe(1);

    // Narrow -> fleet-wide, with the answer unchanged at true. The cap's busy
    // gate reads both predicates, so a consumer not woken here would sit on
    // "cannot speak for this session" until an unrelated write.
    __setHostAgentActivityHealthForTests(HOST_A, {
      cloudSyncStatus: "connected",
    });
    expect(callCount).toBe(2);

    // True -> false.
    __setHostAgentActivityHealthForTests(HOST_A, {
      connectionStatus: "closed",
    });
    expect(callCount).toBe(3);

    unsubscribe();
    // Unsubscribed: a further flip must not be observed.
    __setHostAgentActivityHealthForTests(HOST_A, {
      connectionStatus: "open",
      servedBy: "local",
      stateFrameSeenThisEpoch: true,
    });
    expect(callCount).toBe(3);
  });
});

describe("agentActivityPlaneSpansFleet", () => {
  it("is false for a cloud-served frame that carries no stamp", () => {
    // `agent.activity.subscribe@1.0` predates `cloudSyncStatus`, so a host on
    // that minor sends `servedBy: "cloud"` with an absent stamp whether or
    // not its cloud link is up - reading `servedBy` as fleet-wide would trust
    // exactly the frame that cannot report the loss.
    __setHostAgentActivityHealthForTests(HOST_A, {
      connectionStatus: "open",
      stateFrameSeenThisEpoch: true,
      servedBy: "cloud",
      cloudSyncStatus: null,
    });

    expect(agentActivityPlaneSpansFleet()).toBe(false);
  });

  it("is true for a local plane whose host attests a connected cloud link", () => {
    __setHostAgentActivityHealthForTests(HOST_A, {
      connectionStatus: "open",
      stateFrameSeenThisEpoch: true,
      servedBy: "local",
      cloudSyncStatus: "connected",
    });

    expect(agentActivityPlaneSpansFleet()).toBe(true);
  });

  it("is false for a local plane with no cloud claim", () => {
    // NO CLAIM, not "connected": a host with no cloud link, or one too old to
    // stamp the field, reports the agents it can see and no others.
    __setHostAgentActivityHealthForTests(HOST_A, {
      connectionStatus: "open",
      stateFrameSeenThisEpoch: true,
      servedBy: "local",
      cloudSyncStatus: null,
    });

    expect(agentActivityPlaneSpansFleet()).toBe(false);
  });

  it("is false for a local plane whose cloud link is reconnecting", () => {
    __setHostAgentActivityHealthForTests(HOST_A, {
      connectionStatus: "open",
      stateFrameSeenThisEpoch: true,
      servedBy: "local",
      cloudSyncStatus: "reconnecting",
    });

    expect(agentActivityPlaneSpansFleet()).toBe(false);
  });

  it("does not let a stale connected stamp on a dropped stream vouch for the fleet", () => {
    // Host A dropped to `reconnecting` in place, which keeps its last stamp
    // but withdraws its attestation; host B is answering narrowly. With one
    // flat slice the caller's `agentActivityPlaneAnswers` gate excluded A's
    // stamp; with two, only an ANSWERING slice's stamp may count.
    __setHostAgentActivityHealthForTests(HOST_A, {
      connectionStatus: "reconnecting",
      stateFrameSeenThisEpoch: false,
      servedBy: "cloud",
      cloudSyncStatus: "connected",
    });
    __setHostAgentActivityHealthForTests(HOST_B, {
      connectionStatus: "open",
      stateFrameSeenThisEpoch: true,
      servedBy: "local",
      cloudSyncStatus: null,
    });

    expect(agentActivityPlaneAnswers()).toBe(true);
    expect(agentActivityPlaneSpansFleet()).toBe(false);
    expect(agentActivityPlaneCoversHost(HOST_A)).toBe(false);
  });
});

describe("agentActivityPlaneCoversHost", () => {
  it("covers any host once the union spans the fleet", () => {
    __setHostAgentActivityHealthForTests(HOST_A, {
      connectionStatus: "open",
      stateFrameSeenThisEpoch: true,
      servedBy: "cloud",
      cloudSyncStatus: "connected",
    });

    expect(agentActivityPlaneCoversHost(HOST_A)).toBe(true);
    // A fleet-wide union proves every host, not only the one that built it.
    expect(agentActivityPlaneCoversHost(HOST_B)).toBe(true);
  });

  it("covers only the serving host while the union is narrow", () => {
    __setHostAgentActivityHealthForTests(HOST_A, {
      connectionStatus: "open",
      stateFrameSeenThisEpoch: true,
      servedBy: "local",
      cloudSyncStatus: null,
    });

    expect(agentActivityPlaneCoversHost(HOST_A)).toBe(true);
    expect(agentActivityPlaneCoversHost(HOST_B)).toBe(false);
  });

  it("covers no host once the serving connection has fully closed", () => {
    // Driven through the real setter, not hand-set to the post-close shape:
    // a future `closed` branch that stopped withdrawing the attestation
    // would still pass a fixture that assumes the withdrawal already
    // happened.
    __setHostAgentActivityHealthForTests(HOST_A, {
      connectionStatus: "open",
      stateFrameSeenThisEpoch: true,
      servedBy: "local",
      cloudSyncStatus: null,
    });
    expect(agentActivityPlaneCoversHost(HOST_A)).toBe(true);

    noteAgentActivityConnectionStatus(HOST_A, "closed", null);

    // `host-a`, the union's own former host, reads uncovered rather than
    // stale now that the connection that attested it is gone.
    expect(agentActivityPlaneCoversHost(HOST_A)).toBe(false);
  });
});
