import { afterEach, describe, expect, it } from "vitest";
import {
  __resetAgentActivityStoreForTests,
  __setHostAgentActivityHealthForTests,
  __setHostAgentActivityStateForTests,
  agentActivityPlaneAnswers,
  agentActivityPlaneCoversHost,
  agentActivityPlaneSpansFleet,
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
    expect(selectAgentActivityCoverage(byHost(), HOST_A)).toBe("indeterminate");
    expect(selectAgentActivityCoverage(byHost(), HOST_B)).toBe("indeterminate");
  });

  it("reads indeterminate when a slice is open but has not attested a frame this epoch", () => {
    __setHostAgentActivityHealthForTests(HOST_A, {
      connectionStatus: "open",
      servedBy: "local",
      cloudSyncStatus: null,
      stateFrameSeenThisEpoch: false,
    });

    expect(selectAgentActivityCoverage(byHost(), HOST_A)).toBe("indeterminate");
    expect(selectAgentActivityCoverage(byHost(), HOST_B)).toBe("indeterminate");
  });

  it("reads a null host id as indeterminate when nothing answers", () => {
    expect(selectAgentActivityCoverage(byHost(), null)).toBe("indeterminate");
  });

  it("reads a null host id as indeterminate even when a NARROW union answers", () => {
    // Reported as unpinned by the test author who found it, and confirmed by
    // the cold reviewer: the docstring promised "indeterminate by
    // construction" for a `null` host while the implementation fell through to
    // `selectPlaneAnswers(byHost) ? "unserved" : "indeterminate"`, so a local
    // union answering for SOME host made every host-less surface read
    // `unserved` - "the plane answers and not about this entity" - when there
    // was no entity to exclude and nothing had been said either way.
    //
    // Distinct from the case above: there, nothing answers, so both the old
    // and the new code say `indeterminate` and the row cannot tell them apart.
    // The narrow union is the discriminating input.
    __setHostAgentActivityHealthForTests(HOST_A, {
      connectionStatus: "open",
      servedBy: "local",
      cloudSyncStatus: null,
      stateFrameSeenThisEpoch: true,
    });

    // The control, stated rather than assumed: this very union IS read as
    // exclusion for a NAMED host that it does not serve. So `indeterminate`
    // below is the `null` case being special-cased, not the union failing to
    // answer.
    expect(selectAgentActivityCoverage(byHost(), HOST_B)).toBe("unserved");
    expect(selectAgentActivityCoverage(byHost(), null)).toBe("indeterminate");
  });

  it("still reads a FLEET-SPANNING union as covered for a null host", () => {
    // The `null` special-case goes BELOW the fleet-spanning check, not above
    // it: a union that reaches everywhere covers an entity whose host the
    // surface cannot name, and answering `indeterminate` there would throw
    // away a real answer.
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

    expect(selectAgentActivityCoverage(byHost(), null)).toBe("covered");
  });
});

describe("merged-plane servedBy interplay (lane: merged agent-activity plane)", () => {
  // The merged plane sends `servedBy: "local"` (this host's origin store)
  // under the REAL link stamp whenever its union does not reach the fleet -
  // including a `connected`-adjacent value like `disconnected` while a room
  // is held. `servedBy` is part of the claim these predicates read, not
  // decoration on top of it.

  it("a merged host's local frame under a down link covers its own host, and reads indeterminate (not unserved) for another", () => {
    __setHostAgentActivityHealthForTests(HOST_A, {
      connectionStatus: "open",
      servedBy: "local",
      cloudSyncStatus: "disconnected",
      stateFrameSeenThisEpoch: true,
    });

    expect(selectAgentActivityCoverage(byHost(), HOST_A)).toBe("covered");
    expect(selectAgentActivityCoverage(byHost(), HOST_B)).toBe("indeterminate");
    expect(agentActivityPlaneSpansFleet()).toBe(false);
    // A `disconnected` stamp is not the "nobody is working" vouch either -
    // `hostActivityAnswers` excludes `disconnected` by name.
    expect(agentActivityPlaneAnswers()).toBe(false);
  });

  it("a local frame stamped connected does not span the fleet - servedBy is part of the claim", () => {
    __setHostAgentActivityHealthForTests(HOST_A, {
      connectionStatus: "open",
      servedBy: "local",
      cloudSyncStatus: "connected",
      stateFrameSeenThisEpoch: true,
    });

    expect(agentActivityPlaneSpansFleet()).toBe(false);
    // The slice answers (a `connected` stamp is not excluded by
    // `hostActivityAnswers`), so the OTHER host reads the narrow-union
    // exclusion, `unserved` - not `indeterminate`.
    expect(selectAgentActivityCoverage(byHost(), HOST_B)).toBe("unserved");
    expect(selectAgentActivityCoverage(byHost(), HOST_A)).toBe("covered");
  });

  it("a cloud frame stamped connected still spans the fleet (unchanged)", () => {
    __setHostAgentActivityHealthForTests(HOST_A, {
      connectionStatus: "open",
      servedBy: "cloud",
      cloudSyncStatus: "connected",
      stateFrameSeenThisEpoch: true,
    });

    expect(selectAgentActivityCoverage(byHost(), HOST_A)).toBe("covered");
    expect(selectAgentActivityCoverage(byHost(), HOST_B)).toBe("covered");
  });

  it("an old cloud-plane host's disconnected frame still reads indeterminate for its own host (unchanged)", () => {
    __setHostAgentActivityHealthForTests(HOST_A, {
      connectionStatus: "open",
      servedBy: "cloud",
      cloudSyncStatus: "disconnected",
      stateFrameSeenThisEpoch: true,
    });

    expect(selectAgentActivityCoverage(byHost(), HOST_A)).toBe("indeterminate");
    expect(selectAgentActivityCoverage(byHost(), HOST_B)).toBe("indeterminate");
  });
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
