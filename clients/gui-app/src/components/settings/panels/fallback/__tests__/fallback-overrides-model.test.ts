import { describe, expect, it } from "vitest";
import {
  createDefaultFallbackPolicy,
  type FallbackPolicy,
  type FallbackRungKind,
} from "@traycer/protocol/host/fallback-policy";
import {
  effectiveLadderFor,
  overrideChipState,
  togglePolicyOverrideRung,
} from "@/components/settings/panels/fallback/fallback-overrides-model";

const BASE_LADDER: readonly FallbackRungKind[] = [
  "profile",
  "tier",
  "wait",
  "notify",
];

function policy(overrides: Partial<FallbackPolicy>): FallbackPolicy {
  return {
    ...createDefaultFallbackPolicy(),
    ladder: [...BASE_LADDER],
    ...overrides,
  };
}

describe("togglePolicyOverrideRung - notify is carried through (D142)", () => {
  it("keeps notify in a narrowed override even though the matrix has no notify chip to toggle it", () => {
    const next = togglePolicyOverrideRung({
      policy: policy({}),
      reason: "rate_limit",
      rung: "profile",
      rungOrder: BASE_LADDER,
    });
    // Turning "profile" off for this failure narrows the base four-step
    // ladder to three - "notify" must still be one of them. Rebuilding the
    // row from the three matrix chips alone (dropping the column-less
    // notify) is exactly the bug this pins: that would silently turn a
    // failure that holds-and-notifies into one that just exhausts.
    expect(next.reasonOverrides?.rate_limit).toEqual([
      "tier",
      "wait",
      "notify",
    ]);
  });
});

describe("togglePolicyOverrideRung - order comes from rungOrder, not from the row", () => {
  it("places a step turned ON at its rungOrder position, never appended in click order", () => {
    // The user has reordered their main steps to wait, tier, profile, notify
    // - a per-failure narrowing must respect THAT order, not the order chips
    // happen to be clicked in.
    const rungOrder: readonly FallbackRungKind[] = [
      "wait",
      "tier",
      "profile",
      "notify",
    ];
    const startingFromOff = policy({
      reasonOverrides: { auth: "off" },
    });

    const afterProfile = togglePolicyOverrideRung({
      policy: startingFromOff,
      reason: "auth",
      rung: "profile",
      rungOrder,
    });
    // "notify" rides along from the base ladder (see the `"off"` suite below)
    // and lands LAST because that is where this rungOrder puts it - not
    // because anything appends it.
    expect(afterProfile.reasonOverrides?.auth).toEqual(["profile", "notify"]);

    const afterWaitToo = togglePolicyOverrideRung({
      policy: afterProfile,
      reason: "auth",
      rung: "tier",
      rungOrder,
    });
    // "tier" was clicked SECOND, but rungOrder places it before "profile" -
    // if order were taken from click order the result would be
    // ["profile", "tier", "notify"] instead.
    expect(afterWaitToo.reasonOverrides?.auth).toEqual([
      "tier",
      "profile",
      "notify",
    ]);
  });
});

describe("togglePolicyOverrideRung - an override equal to the base ladder is removed, not stored", () => {
  it("drops the reason's key, and clears reasonOverrides to ABSENT (not `{}`) when it was the only one", () => {
    const narrowed = policy({
      reasonOverrides: { rate_limit: ["tier", "wait", "notify"] },
    });
    // Turning "profile" back on restores the narrowed ladder to exactly the
    // base ladder.
    const restored = togglePolicyOverrideRung({
      policy: narrowed,
      reason: "rate_limit",
      rung: "profile",
      rungOrder: BASE_LADDER,
    });
    expect(restored.reasonOverrides).toBeUndefined();
    expect(Object.hasOwn(restored, "reasonOverrides")).toBe(false);
  });

  it("removes only the affected reason's key when other overrides remain", () => {
    const twoOverrides = policy({
      reasonOverrides: {
        rate_limit: ["tier", "wait", "notify"],
        billing: ["tier", "notify"],
      },
    });
    const restoredRateLimitOnly = togglePolicyOverrideRung({
      policy: twoOverrides,
      reason: "rate_limit",
      rung: "profile",
      rungOrder: BASE_LADDER,
    });
    expect(restoredRateLimitOnly.reasonOverrides).toEqual({
      billing: ["tier", "notify"],
    });
  });

  it("does not restore the whole base ladder when turning a chip on for an 'off' row", () => {
    const offRow = policy({ reasonOverrides: { auth: "off" } });
    const next = togglePolicyOverrideRung({
      policy: offRow,
      reason: "auth",
      rung: "tier",
      rungOrder: BASE_LADDER,
    });
    // "tier" is the only STEP that runs - "profile" and "wait" stay out. The
    // terminal "notify" is not a step the chips author; see the suite below.
    expect(next.reasonOverrides?.auth).toEqual(["tier", "notify"]);
  });
});

describe("togglePolicyOverrideRung - the 'off' row keeps its terminal notify", () => {
  it("carries notify through the FIRST chip turned on for a stored 'off' reason", () => {
    // The bug this pins: `desired` seeded empty for `"off"`, and `notify` has
    // no chip and no other writer on this page - so one click on an "off" row
    // stored a ladder with no terminal hold and left the user no control to
    // put it back. `FALLBACK_OVERRIDES_DISCLOSURE` promises "Notify stays
    // last"; without the carry that sentence is false the moment it matters.
    const offRow = policy({ reasonOverrides: { auth: "off" } });
    const next = togglePolicyOverrideRung({
      policy: offRow,
      reason: "auth",
      rung: "profile",
      rungOrder: BASE_LADDER,
    });
    expect(next.reasonOverrides?.auth).toEqual(["profile", "notify"]);
  });

  it("leaves the terminal notify standing when that one chip is turned back off", () => {
    // The round trip out of "off" and back to "nothing chosen". The
    // disclosure's other half - "turning every chip off preserves that
    // failure's ... terminal Notify" - is what this is; an empty array here
    // would arm and exhaust silently.
    const offRow = policy({ reasonOverrides: { auth: "off" } });
    const on = togglePolicyOverrideRung({
      policy: offRow,
      reason: "auth",
      rung: "profile",
      rungOrder: BASE_LADDER,
    });
    const backOff = togglePolicyOverrideRung({
      policy: on,
      reason: "auth",
      rung: "profile",
      rungOrder: BASE_LADDER,
    });
    expect(backOff.reasonOverrides?.auth).toEqual(["notify"]);
  });

  it("does not invent notify for a user whose own ladder has none", () => {
    // The carry reads the BASE ladder rather than adding a rung
    // unconditionally: a user who took the terminal hold out of their main
    // order is not given it back by clicking a per-failure chip. Without this
    // arm the fix above would pass just as well written as `["notify"]`.
    const noNotify = policy({
      ladder: ["profile", "tier", "wait"],
      reasonOverrides: { auth: "off" },
    });
    const next = togglePolicyOverrideRung({
      policy: noNotify,
      reason: "auth",
      rung: "tier",
      rungOrder: BASE_LADDER,
    });
    expect(next.reasonOverrides?.auth).toEqual(["tier"]);
  });
});

describe("overrideChipState / effectiveLadderFor", () => {
  it("reads 'impossible' for a rung REASON_ELIGIBLE_RUNGS excludes, regardless of the stored ladder", () => {
    // provider_unavailable's eligible set is ["tier"] only.
    expect(
      overrideChipState(policy({}), "provider_unavailable", "profile"),
    ).toBe("impossible");
    expect(overrideChipState(policy({}), "provider_unavailable", "tier")).toBe(
      "runs",
    );
  });

  it("reads the whole row as 'off' when the stored override is the literal 'off', not an empty array", () => {
    const offRow = policy({ reasonOverrides: { auth: "off" } });
    expect(effectiveLadderFor(offRow, "auth")).toBe("off");
    expect(overrideChipState(offRow, "auth", "profile")).toBe("off");
  });
});
