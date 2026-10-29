import { describe, expect, it, vi } from "vitest";
import {
  createHostRpcTierPlan,
  decideHostRpcDispatch,
} from "../host-rpc-routing";
import {
  localEntry,
  personalRemoteEntry,
  poolEntry,
  teamSandboxEntry,
} from "./routing-entry-fixtures";

// The build that ships without environments: a selected-host call goes to the
// host it was addressed to, as every call did before the Settings host picker
// could point at a sandbox.
vi.mock("../../unreleased-features", () => ({
  UNRELEASED_FEATURES_ENABLED: false,
}));

const POOL_PLAN = createHostRpcTierPlan(poolEntry);

describe("decideHostRpcDispatch without environments", () => {
  it("dispatches a selected-host call to its target, whatever host is selected", () => {
    for (const selected of [teamSandboxEntry, poolEntry, null]) {
      expect(
        decideHostRpcDispatch(
          "selected-host",
          personalRemoteEntry,
          POOL_PLAN,
          selected,
        ),
      ).toEqual({ kind: "dispatch", entry: personalRemoteEntry });
    }
    expect(
      decideHostRpcDispatch("selected-host", localEntry, POOL_PLAN, null),
    ).toEqual({ kind: "dispatch", entry: localEntry });
  });
});
