import { describe, expect, it } from "vitest";
import * as lifecycleConstants from "../lifecycle-constants";

// R3 §0/§38: `HOST_UPDATE_SERVICE_UNSTARTABLE_EXIT_CODE` is renamed
// `HOST_UPDATE_SERVICE_UNSTARTABLE_EXIT_CODE` (the value, 79, unchanged) -
// the refusal now covers both a disabled task and another user's task, so
// the old name no longer describes every case it fires for.
//
// RED-FIRST against the pre-R3 snapshot: the new name is not exported there
// (`undefined`), and the old name is STILL exported (this file asserts it is
// not).

describe("HOST_UPDATE_SERVICE_UNSTARTABLE_EXIT_CODE (renamed from _DISABLED_)", () => {
  it("is exported and is 79", () => {
    expect(
      (lifecycleConstants as Record<string, unknown>)
        .HOST_UPDATE_SERVICE_UNSTARTABLE_EXIT_CODE,
    ).toBe(79);
  });

  it("the OLD name is no longer exported", () => {
    expect(
      (lifecycleConstants as Record<string, unknown>)
        .HOST_UPDATE_SERVICE_DISABLED_EXIT_CODE,
    ).toBeUndefined();
  });
});
