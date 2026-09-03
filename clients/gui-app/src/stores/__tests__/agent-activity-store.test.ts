import { afterEach, describe, expect, it } from "vitest";
import {
  __resetAgentActivityStoreForTests,
  agentActivityPlaneAnswers,
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
      cloudSyncStatus: "connected",
    });

    expect(agentActivityPlaneAnswers()).toBe(false);
  });

  it("is false while the stream is open but has not yet delivered a served-by state frame", () => {
    useAgentActivityStore.setState({
      connectionStatus: "open",
      servedBy: null,
      cloudSyncStatus: null,
    });

    expect(agentActivityPlaneAnswers()).toBe(false);
  });

  it("is true once the stream is open, served-by is known, and the cloud status makes no claim", () => {
    useAgentActivityStore.setState({
      connectionStatus: "open",
      servedBy: "local",
      cloudSyncStatus: null,
    });

    expect(agentActivityPlaneAnswers()).toBe(true);
  });

  it("is true when the host's cloud link is connected", () => {
    useAgentActivityStore.setState({
      connectionStatus: "open",
      servedBy: "cloud",
      cloudSyncStatus: "connected",
    });

    expect(agentActivityPlaneAnswers()).toBe(true);
  });

  it("is false while the host's cloud link is reconnecting", () => {
    useAgentActivityStore.setState({
      connectionStatus: "open",
      servedBy: "cloud",
      cloudSyncStatus: "reconnecting",
    });

    expect(agentActivityPlaneAnswers()).toBe(false);
  });

  it("is false while the host's cloud link is disconnected", () => {
    useAgentActivityStore.setState({
      connectionStatus: "open",
      servedBy: "cloud",
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
    });
    expect(callCount).toBe(1);

    // Still true: a byEpic-shaped change with no effect on the answer.
    useAgentActivityStore.setState({ cloudSyncStatus: "connected" });
    expect(callCount).toBe(1);

    // True -> false.
    useAgentActivityStore.setState({ connectionStatus: "closed" });
    expect(callCount).toBe(2);

    unsubscribe();
    // Unsubscribed: a further flip must not be observed.
    useAgentActivityStore.setState({
      connectionStatus: "open",
      servedBy: "local",
    });
    expect(callCount).toBe(2);
  });
});
