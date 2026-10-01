import { afterEach, describe, expect, it } from "vitest";
import {
  __resetAgentActivityStoreForTests,
  __setHostAgentActivityHealthForTests,
  __setHostAgentActivityStateForTests,
  selectKnownHostsActivityCoverage,
  useAgentActivityStore,
} from "@/stores/agent-activity-store";

/**
 * `selectKnownHostsActivityCoverage` (F8 round 2): `AgentActivityCoverage`
 * for something whose agents may be on ANY of the account's machines - a
 * task, or the account as a whole - given the directory's settled host list.
 * Distinct from `selectAgentActivityCoverage`, which answers for ONE named
 * host; this one folds that answer over every known host.
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

describe("selectKnownHostsActivityCoverage", () => {
  it("reads a fleet-spanning union as covered even with a null (unsettled) known-hosts list", () => {
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

    expect(selectKnownHostsActivityCoverage(byHost(), null)).toBe("covered");
  });

  it("reads indeterminate while the directory has not settled (null known-hosts list)", () => {
    // A narrow answering union on record, so the only reason this isn't
    // `unserved`/`covered` is the unsettled directory itself.
    __setHostAgentActivityHealthForTests(HOST_A, {
      connectionStatus: "open",
      servedBy: "local",
      cloudSyncStatus: null,
      stateFrameSeenThisEpoch: true,
    });

    expect(selectKnownHostsActivityCoverage(byHost(), null)).toBe(
      "indeterminate",
    );
  });

  it("reads indeterminate for an empty known-hosts list (settled, but the account owns no host)", () => {
    __setHostAgentActivityHealthForTests(HOST_A, {
      connectionStatus: "open",
      servedBy: "local",
      cloudSyncStatus: null,
      stateFrameSeenThisEpoch: true,
    });

    expect(selectKnownHostsActivityCoverage(byHost(), [])).toBe(
      "indeterminate",
    );
  });

  it("reads covered for a single known host under a narrow (non-fleet-spanning) plane that covers itself", () => {
    __setHostAgentActivityHealthForTests(HOST_A, {
      connectionStatus: "open",
      servedBy: "local",
      cloudSyncStatus: null,
      stateFrameSeenThisEpoch: true,
    });

    expect(selectKnownHostsActivityCoverage(byHost(), [HOST_A])).toBe(
      "covered",
    );
  });

  it("reads unserved when one of two known hosts has no answering slice of its own", () => {
    __setHostAgentActivityHealthForTests(HOST_A, {
      connectionStatus: "open",
      servedBy: "local",
      cloudSyncStatus: null,
      stateFrameSeenThisEpoch: true,
    });
    // HOST_B is known to the directory but never gets a slice - the plane
    // answers (via HOST_A) and says nothing about HOST_B.

    expect(selectKnownHostsActivityCoverage(byHost(), [HOST_A, HOST_B])).toBe(
      "unserved",
    );
  });

  it("reads indeterminate when nothing answers at all, even with known hosts listed", () => {
    // HOST_A has a slice, but its stream has never attested a frame - it does
    // not answer, so neither host has anything to say.
    __setHostAgentActivityHealthForTests(HOST_A, {
      connectionStatus: "connecting",
      servedBy: null,
      cloudSyncStatus: null,
      stateFrameSeenThisEpoch: false,
    });

    expect(selectKnownHostsActivityCoverage(byHost(), [HOST_A, HOST_B])).toBe(
      "indeterminate",
    );
  });
});
