import { afterEach, describe, expect, it } from "vitest";
import {
  __resetAgentActivityStoreForTests,
  agentActivityPlaneAnswers,
  agentActivityPlaneSpansFleet,
  subscribeAgentActivityPlaneHealth,
  useAgentActivityStore,
} from "@/stores/agent-activity-store";

/**
 * `agentActivityPlaneAnswers` / `subscribeAgentActivityPlaneHealth` in
 * isolation - the epic session registry's cap-eviction guard
 * (`epicIsBusy`/`session-registry.ts`) is the consumer these exist for, and
 * that file's own suite exercises them through the registry. This file pins
 * the predicate's truth table and the health subscription's edge-triggering
 * directly, without a registry in the loop.
 */

afterEach(() => {
  __resetAgentActivityStoreForTests();
});

describe("agentActivityPlaneAnswers", () => {
  it("is false while the stream is closed", () => {
    useAgentActivityStore.setState({
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
    useAgentActivityStore.setState({
      connectionStatus: "open",
      servedBy: "cloud",
      stateFrameSeenThisEpoch: false,
      cloudSyncStatus: null,
    });

    expect(agentActivityPlaneAnswers()).toBe(false);
  });

  it("is true once the stream is open, this epoch has a frame, and the cloud status makes no claim", () => {
    useAgentActivityStore.setState({
      connectionStatus: "open",
      servedBy: "local",
      stateFrameSeenThisEpoch: true,
      cloudSyncStatus: null,
    });

    expect(agentActivityPlaneAnswers()).toBe(true);
  });

  it("is true when the host's cloud link is connected", () => {
    useAgentActivityStore.setState({
      connectionStatus: "open",
      servedBy: "cloud",
      stateFrameSeenThisEpoch: true,
      cloudSyncStatus: "connected",
    });

    expect(agentActivityPlaneAnswers()).toBe(true);
  });

  it("is false while the host's cloud link is reconnecting", () => {
    useAgentActivityStore.setState({
      connectionStatus: "open",
      servedBy: "cloud",
      stateFrameSeenThisEpoch: true,
      cloudSyncStatus: "reconnecting",
    });

    expect(agentActivityPlaneAnswers()).toBe(false);
  });

  it("is false while the host's cloud link is disconnected", () => {
    useAgentActivityStore.setState({
      connectionStatus: "open",
      servedBy: "cloud",
      stateFrameSeenThisEpoch: true,
      cloudSyncStatus: "disconnected",
    });

    expect(agentActivityPlaneAnswers()).toBe(false);
  });
});

describe("subscribeAgentActivityPlaneHealth", () => {
  it("fires once per flip and stays silent on a same-state update", () => {
    useAgentActivityStore.setState({
      connectionStatus: "closed",
      servedBy: null,
      cloudSyncStatus: null,
    });

    let callCount = 0;
    const unsubscribe = subscribeAgentActivityPlaneHealth(() => {
      callCount += 1;
    });

    // Still false: connectionStatus moved but the answer did not.
    useAgentActivityStore.setState({ connectionStatus: "connecting" });
    expect(callCount).toBe(0);

    // False -> true.
    useAgentActivityStore.setState({
      connectionStatus: "open",
      servedBy: "local",
      stateFrameSeenThisEpoch: true,
    });
    expect(callCount).toBe(1);

    // Still true, and still narrow: a working-set change moves neither
    // predicate, and this subscription is not the one that reports it.
    useAgentActivityStore.setState({
      byEpic: new Map([
        ["epic-1", { working: new Set(["agent-1"]), turn: new Set<string>() }],
      ]),
    });
    expect(callCount).toBe(1);

    // Narrow -> fleet-wide, with the answer unchanged at true. The cap's busy
    // gate reads both predicates, so a consumer not woken here would sit on
    // "cannot speak for this session" until an unrelated write.
    useAgentActivityStore.setState({ cloudSyncStatus: "connected" });
    expect(callCount).toBe(2);

    // True -> false.
    useAgentActivityStore.setState({ connectionStatus: "closed" });
    expect(callCount).toBe(3);

    unsubscribe();
    // Unsubscribed: a further flip must not be observed.
    useAgentActivityStore.setState({
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
    useAgentActivityStore.setState({
      servedBy: "cloud",
      cloudSyncStatus: null,
    });

    expect(agentActivityPlaneSpansFleet()).toBe(false);
  });

  it("is true for a local plane whose host attests a connected cloud link", () => {
    useAgentActivityStore.setState({
      servedBy: "local",
      cloudSyncStatus: "connected",
    });

    expect(agentActivityPlaneSpansFleet()).toBe(true);
  });

  it("is false for a local plane with no cloud claim", () => {
    // NO CLAIM, not "connected": a host with no cloud link, or one too old to
    // stamp the field, reports the agents it can see and no others.
    useAgentActivityStore.setState({
      servedBy: "local",
      cloudSyncStatus: null,
    });

    expect(agentActivityPlaneSpansFleet()).toBe(false);
  });

  it("is false for a local plane whose cloud link is reconnecting", () => {
    useAgentActivityStore.setState({
      servedBy: "local",
      cloudSyncStatus: "reconnecting",
    });

    expect(agentActivityPlaneSpansFleet()).toBe(false);
  });
});
