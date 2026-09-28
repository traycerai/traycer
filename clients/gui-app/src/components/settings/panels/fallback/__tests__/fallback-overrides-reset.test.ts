import { describe, expect, it } from "vitest";
import {
  createDefaultFallbackPolicy,
  type FallbackPolicy,
} from "@traycer/protocol/host/fallback-policy";
import {
  createFallbackPolicyDraftState,
  type FallbackPolicyDraftState,
} from "@/components/settings/panels/fallback/fallback-policy-draft";
import {
  clearPolicyOverride,
  restorePolicyOverrides,
} from "@/components/settings/panels/fallback/fallback-overrides-model";
import {
  overrideChangesSaved,
  overrideResetUndoState,
  type OverrideReset,
} from "@/components/settings/panels/fallback/fallback-overrides-reset";

function policy(overrides: Partial<FallbackPolicy>): FallbackPolicy {
  return { ...createDefaultFallbackPolicy(), ...overrides };
}

const BEFORE = policy({
  reasonOverrides: { rate_limit: ["profile", "notify"], billing: ["notify"] },
});
const AFTER_ONE = clearPolicyOverride(BEFORE, "rate_limit");
const AFTER_ALL = policy({});

function reset(
  reason: OverrideReset["reason"],
  next: FallbackPolicy,
): OverrideReset {
  return { requestId: 7, reason, previous: BEFORE, next };
}

/** A confirmed state: the reset's policy is displayed and is the host's row. */
function confirmed(next: FallbackPolicy): FallbackPolicyDraftState {
  return {
    ...createFallbackPolicyDraftState(next),
    revision: 3,
    confirmedViewRevision: 3,
  };
}

function pending(next: FallbackPolicy): FallbackPolicyDraftState {
  const base = createFallbackPolicyDraftState(BEFORE);
  return {
    ...base,
    draft: next,
    revision: 3,
    pendingSaves: [{ requestId: 7, carries: "reset", revision: 3 }],
  };
}

describe("overrideResetUndoState", () => {
  it("offers nothing without a reset record", () => {
    expect(overrideResetUndoState(confirmed(AFTER_ONE), null)).toBeNull();
  });

  it("offers an enabled Undo once the displayed reset is confirmed", () => {
    const undo = overrideResetUndoState(
      confirmed(AFTER_ONE),
      reset("rate_limit", AFTER_ONE),
    );
    expect(undo).toEqual({
      message: "Rate limit reached now follows the main plan.",
      disabled: false,
    });
  });

  it("uses the plural message for a bulk reset", () => {
    const undo = overrideResetUndoState(
      confirmed(AFTER_ALL),
      reset(null, AFTER_ALL),
    );
    expect(undo?.message).toBe("All problems now follow the main plan.");
  });

  it("shows a disabled Undo while the reset's own save is pending", () => {
    const undo = overrideResetUndoState(
      pending(AFTER_ONE),
      reset("rate_limit", AFTER_ONE),
    );
    expect(undo).not.toBeNull();
    expect(undo?.disabled).toBe(true);
  });

  it("disables a confirmed Undo while some other save is in flight", () => {
    const state: FallbackPolicyDraftState = {
      ...confirmed(AFTER_ONE),
      pendingSaves: [{ requestId: 99, carries: "draft", revision: 3 }],
    };
    expect(
      overrideResetUndoState(state, reset("rate_limit", AFTER_ONE))?.disabled,
    ).toBe(true);
  });

  it("withholds Undo when neither pending nor confirmed", () => {
    const state: FallbackPolicyDraftState = {
      ...createFallbackPolicyDraftState(AFTER_ONE),
      revision: 3,
      confirmedViewRevision: null,
    };
    expect(
      overrideResetUndoState(state, reset("rate_limit", AFTER_ONE)),
    ).toBeNull();
  });

  it("withholds Undo when the displayed policy is not the reset's result (a later edit)", () => {
    const edited = policy({
      reasonOverrides: { billing: ["notify"], auth: ["profile", "notify"] },
    });
    expect(
      overrideResetUndoState(confirmed(edited), reset("rate_limit", AFTER_ONE)),
    ).toBeNull();
  });

  it("withholds Undo when the confirmed view is from an older revision", () => {
    const state: FallbackPolicyDraftState = {
      ...confirmed(AFTER_ONE),
      revision: 4,
      confirmedViewRevision: 3,
    };
    expect(
      overrideResetUndoState(state, reset("rate_limit", AFTER_ONE)),
    ).toBeNull();
  });

  it("withholds a blind Undo for an unconfirmed (unknown) reset", () => {
    const state: FallbackPolicyDraftState = {
      ...pending(AFTER_ONE),
      pendingSaves: [],
      unknownSave: { requestId: 7, carries: "reset", revision: 3 },
    };
    expect(
      overrideResetUndoState(state, reset("rate_limit", AFTER_ONE)),
    ).toBeNull();
  });

  it("withholds Undo for a refused save, a local error, or an unverified host row", () => {
    const base = confirmed(AFTER_ONE);
    const record = reset("rate_limit", AFTER_ONE);
    expect(
      overrideResetUndoState(
        { ...base, hostError: { message: "no", outcome: "refused-kept" } },
        record,
      ),
    ).toBeNull();
    expect(
      overrideResetUndoState({ ...base, localError: "bad" }, record),
    ).toBeNull();
    expect(
      overrideResetUndoState({ ...base, unverifiedHostRow: "reset" }, record),
    ).toBeNull();
  });

  it("withholds Undo while an unrefreshed reset is outstanding", () => {
    const state: FallbackPolicyDraftState = {
      ...confirmed(AFTER_ONE),
      unrefreshedReset: { message: "stale", revision: 3, requestId: 7 },
    };
    expect(
      overrideResetUndoState(state, reset("rate_limit", AFTER_ONE)),
    ).toBeNull();
  });
});

describe("clearPolicyOverride and restorePolicyOverrides (inverse)", () => {
  it("clears only the named reason and leaves the rest of the policy", () => {
    expect(AFTER_ONE.reasonOverrides).toEqual({ billing: ["notify"] });
    expect(
      clearPolicyOverride(AFTER_ONE, "billing").reasonOverrides,
    ).toBeUndefined();
  });

  it("restoring one reason puts back only that override, preserving unrelated later edits", () => {
    const current = policy({
      maxWaitMinutes: 45,
      reasonOverrides: { billing: ["notify"], auth: ["tier", "notify"] },
    });
    const restored = restorePolicyOverrides(current, BEFORE, "rate_limit");
    expect(restored.reasonOverrides).toEqual({
      billing: ["notify"],
      auth: ["tier", "notify"],
      rate_limit: ["profile", "notify"],
    });
    expect(restored.maxWaitMinutes).toBe(45);
  });

  it("restoring a reason that had no prior override removes any current one", () => {
    const current = policy({ reasonOverrides: { auth: ["notify"] } });
    expect(
      restorePolicyOverrides(current, BEFORE, "auth").reasonOverrides,
    ).toBeUndefined();
  });

  it("restoring all replaces the override map with the previous one, keeping other fields", () => {
    const current = policy({ maxWaitMinutes: 45 });
    const restored = restorePolicyOverrides(current, BEFORE, null);
    expect(restored.reasonOverrides).toEqual(BEFORE.reasonOverrides);
    expect(restored.maxWaitMinutes).toBe(45);
  });

  it("restoring all when nothing was overridden yields an absent map, not {}", () => {
    const current = policy({ reasonOverrides: { billing: ["notify"] } });
    const restored = restorePolicyOverrides(current, policy({}), null);
    expect("reasonOverrides" in restored).toBe(false);
  });

  it("clear then restore round-trips to the original overrides", () => {
    expect(
      restorePolicyOverrides(AFTER_ONE, BEFORE, "rate_limit").reasonOverrides,
    ).toEqual(BEFORE.reasonOverrides);
  });
});

describe("overrideChangesSaved", () => {
  const draftEdit = policy({ reasonOverrides: { billing: ["notify"] } });

  it("is true only when the displayed policy is the confirmed one", () => {
    expect(overrideChangesSaved(confirmed(draftEdit))).toBe(true);
  });

  it("is false while any save is pending", () => {
    expect(overrideChangesSaved(pending(draftEdit))).toBe(false);
  });

  it("is false when the confirmed view is not the latest revision", () => {
    expect(
      overrideChangesSaved({
        ...confirmed(draftEdit),
        revision: 4,
        confirmedViewRevision: 3,
      }),
    ).toBe(false);
    expect(
      overrideChangesSaved({
        ...confirmed(draftEdit),
        confirmedViewRevision: null,
      }),
    ).toBe(false);
  });

  it("is false when the draft differs from the persisted row (a newer draft)", () => {
    expect(
      overrideChangesSaved({ ...confirmed(draftEdit), draft: BEFORE }),
    ).toBe(false);
  });

  it("is false for unknown, refused, local-error, unverified or unrefreshed states", () => {
    const base = confirmed(draftEdit);
    expect(
      overrideChangesSaved({
        ...base,
        unknownSave: { requestId: 1, carries: "draft", revision: 3 },
      }),
    ).toBe(false);
    expect(
      overrideChangesSaved({
        ...base,
        hostError: { message: "no", outcome: "refused-kept" },
      }),
    ).toBe(false);
    expect(overrideChangesSaved({ ...base, localError: "bad" })).toBe(false);
    expect(overrideChangesSaved({ ...base, unverifiedHostRow: "draft" })).toBe(
      false,
    );
    expect(
      overrideChangesSaved({
        ...base,
        unrefreshedReset: { message: "stale", revision: 3, requestId: 1 },
      }),
    ).toBe(false);
  });
});
