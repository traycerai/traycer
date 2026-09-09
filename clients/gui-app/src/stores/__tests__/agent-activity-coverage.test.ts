import { afterEach, describe, expect, it } from "vitest";
import {
  __resetAgentActivityStoreForTests,
  __setHostAgentActivityHealthForTests,
  __setHostAgentActivityStateForTests,
  agentActivityPlaneCoversHost,
  selectAgentActivityCoverage,
  useAgentActivityStore,
} from "@/stores/agent-activity-store";

/**
 * `AgentActivityCoverage` (lane 9 item 1). The defect: absence from a
 * host-selected activity union was rendered as idleness for EVERY host,
 * including one the union never reached. These pin the three-way split a
 * boolean truth table cannot express.
 */

const HOST_A = "host-a";
const HOST_B = "host-b";
const EPIC = "epic-1";

afterEach(() => {
  __resetAgentActivityStoreForTests();
});

function byHost() {
  return useAgentActivityStore.getState().byHost;
}

describe("selectAgentActivityCoverage", () => {
  it("reads a fleet-spanning union as covered for ANY host, including one with no slice", () => {
    __setHostAgentActivityHealthForTests(HOST_A, {
      connectionStatus: "open",
      servedBy: "cloud",
      cloudSyncStatus: "connected",
      stateFrameSeenThisEpoch: true,
    });
    __setHostAgentActivityStateForTests(
      HOST_A,
      { [EPIC]: { working: ["agent-1"], turn: [] } },
      "cloud",
      "connected",
    );

    expect(selectAgentActivityCoverage(byHost(), HOST_A)).toBe("covered");
    expect(selectAgentActivityCoverage(byHost(), HOST_B)).toBe("covered");
    expect(selectAgentActivityCoverage(byHost(), "host-with-no-slice")).toBe(
      "covered",
    );
  });

  it("reads a narrow answering union as covered for its own host, unserved for another - the whole defect", () => {
    __setHostAgentActivityHealthForTests(HOST_A, {
      connectionStatus: "open",
      servedBy: "local",
      cloudSyncStatus: null,
      stateFrameSeenThisEpoch: true,
    });

    expect(selectAgentActivityCoverage(byHost(), HOST_A)).toBe("covered");
    expect(selectAgentActivityCoverage(byHost(), HOST_B)).toBe("unserved");
  });

  it("reads indeterminate for every host when nothing answers - an empty store", () => {
    expect(selectAgentActivityCoverage(byHost(), HOST_A)).toBe(
      "indeterminate",
    );
    expect(selectAgentActivityCoverage(byHost(), HOST_B)).toBe(
      "indeterminate",
    );
  });

  it("reads indeterminate when a slice is open but has not attested a frame this epoch", () => {
    __setHostAgentActivityHealthForTests(HOST_A, {
      connectionStatus: "open",
      servedBy: "local",
      cloudSyncStatus: null,
      stateFrameSeenThisEpoch: false,
    });

    expect(selectAgentActivityCoverage(byHost(), HOST_A)).toBe(
      "indeterminate",
    );
    expect(selectAgentActivityCoverage(byHost(), HOST_B)).toBe(
      "indeterminate",
    );
  });

  it("reads a null host id as indeterminate when nothing answers", () => {
    expect(selectAgentActivityCoverage(byHost(), null)).toBe("indeterminate");
  });

  // NOT pinned: the docstring on `selectAgentActivityCoverage` says a `null`
  // host is "indeterminate by construction", but the implementation does not
  // special-case `hostId === null` before the final
  // `selectPlaneAnswers(byHost) ? "unserved" : "indeterminate"` line, so a
  // `null` host id reads as `"unserved"` whenever a narrow union answers -
  // contradicting its own doc. Reported back rather than pinned; fixing it
  // is a production change I'm not making here.
});

describe("agentActivityPlaneCoversHost agrees with selectAgentActivityCoverage", () => {
  it("is true only when the coverage answer is covered - fleet-spanning case", () => {
    __setHostAgentActivityHealthForTests(HOST_A, {
      connectionStatus: "open",
      servedBy: "cloud",
      cloudSyncStatus: "connected",
      stateFrameSeenThisEpoch: true,
    });
    __setHostAgentActivityStateForTests(
      HOST_A,
      { [EPIC]: { working: ["agent-1"], turn: [] } },
      "cloud",
      "connected",
    );

    expect(agentActivityPlaneCoversHost(HOST_B)).toBe(
      selectAgentActivityCoverage(byHost(), HOST_B) === "covered",
    );
    expect(agentActivityPlaneCoversHost(HOST_B)).toBe(true);
  });

  it("is false for the unserved host of a narrow answering union", () => {
    __setHostAgentActivityHealthForTests(HOST_A, {
      connectionStatus: "open",
      servedBy: "local",
      cloudSyncStatus: null,
      stateFrameSeenThisEpoch: true,
    });

    expect(agentActivityPlaneCoversHost(HOST_B)).toBe(
      selectAgentActivityCoverage(byHost(), HOST_B) === "covered",
    );
    expect(agentActivityPlaneCoversHost(HOST_B)).toBe(false);
  });

  it("is false when nothing answers", () => {
    expect(agentActivityPlaneCoversHost(HOST_A)).toBe(
      selectAgentActivityCoverage(byHost(), HOST_A) === "covered",
    );
    expect(agentActivityPlaneCoversHost(HOST_A)).toBe(false);
  });
});
