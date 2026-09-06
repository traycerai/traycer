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
    expect(afterProfile.reasonOverrides?.auth).toEqual(["profile"]);

    const afterWaitToo = togglePolicyOverrideRung({
      policy: afterProfile,
      reason: "auth",
      rung: "tier",
      rungOrder,
    });
    // "tier" was clicked SECOND, but rungOrder places it before "profile" -
    // if order were taken from click order the result would be
    // ["profile", "tier"] instead.
    expect(afterWaitToo.reasonOverrides?.auth).toEqual(["tier", "profile"]);
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

  it("starts from nothing, not from the base ladder, when turning a chip on for an 'off' row", () => {
    const offRow = policy({ reasonOverrides: { auth: "off" } });
    const next = togglePolicyOverrideRung({
      policy: offRow,
      reason: "auth",
      rung: "tier",
      rungOrder: BASE_LADDER,
    });
    // Only "tier" runs - not the whole base ladder restored.
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
