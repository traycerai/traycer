import { describe, expect, it } from "vitest";
import {
  createDefaultFallbackPolicy,
  type FallbackPolicy,
  type TierCandidate,
  type TierGroup,
} from "@traycer/protocol/host/fallback-policy";
import {
  createFallbackPolicyDraftState,
  fallbackDisplayOrder,
  fallbackLadderFrom,
  fallbackPolicyDraftReducer,
  moveFallbackRung,
  validateFallbackPolicyDraft,
  type FallbackPolicyDraftState,
} from "@/components/settings/panels/fallback/fallback-policy-draft";
import { toKeyedGroups } from "@/components/settings/panels/fallback/fallback-tier-group-keys";

function policy(overrides: Partial<FallbackPolicy>): FallbackPolicy {
  return { ...createDefaultFallbackPolicy(), ...overrides };
}

function candidate(modelFamily: string): TierCandidate {
  return { harnessId: "claude", modelFamily, reasoningEffort: null };
}

function tierGroup(
  id: string,
  candidates: readonly TierCandidate[],
): TierGroup {
  return { id, candidates: [...candidates] };
}

describe("fallbackDisplayOrder", () => {
  it("puts a disabled step at the end rather than dropping its stored position - the reload cost the panel's own copy states", () => {
    // "profile" and "wait" are missing from the stored ladder (turned off);
    // the enabled two keep the ladder's order, and the two disabled ones are
    // appended in the CANONICAL (FALLBACK_RUNG_KINDS) order, not stored order.
    const order = fallbackDisplayOrder(["notify", "tier"]);
    expect(order).toEqual(["notify", "tier", "profile", "wait"]);
  });

  it("is the identity on a full ladder", () => {
    const order = fallbackDisplayOrder(["wait", "profile", "notify", "tier"]);
    expect(order).toEqual(["wait", "profile", "notify", "tier"]);
  });
});

describe("fallbackLadderFrom", () => {
  it("keeps a step's position when it is turned off - order and enablement are independent axes", () => {
    const displayOrder = ["profile", "tier", "wait", "notify"] as const;
    // Turning "tier" off must not move "wait" or "notify" forward: the wire
    // ladder is the display order filtered down, never re-packed.
    const enabled = new Set<(typeof displayOrder)[number]>([
      "profile",
      "wait",
      "notify",
    ]);
    expect(fallbackLadderFrom(displayOrder, enabled)).toEqual([
      "profile",
      "wait",
      "notify",
    ]);
  });

  it("produces an empty ladder when nothing is enabled", () => {
    expect(fallbackLadderFrom(["profile", "tier"], new Set())).toEqual([]);
  });
});

describe("moveFallbackRung", () => {
  it("reorders the movable steps around a `notify` slot that is NOT last, leaving notify's own position untouched", () => {
    // This is the case the fixed-slot logic exists for: a stored ladder whose
    // `notify` sits in the middle rather than at the end.
    const displayOrder = ["profile", "notify", "tier", "wait"] as const;
    // Movable view is [profile, tier, wait]; move "profile" (movable index 0)
    // to the end of the movable steps (movable index 2).
    const next = moveFallbackRung(displayOrder, 0, 2);
    expect(next).toEqual(["tier", "notify", "wait", "profile"]);
    // notify never moved from its original slot (index 1).
    expect(next[1]).toBe("notify");
  });

  it("is a plain array move when notify is already last, the ordinary case", () => {
    const displayOrder = ["profile", "tier", "wait", "notify"] as const;
    const next = moveFallbackRung(displayOrder, 0, 1);
    expect(next).toEqual(["tier", "profile", "wait", "notify"]);
  });

  it("is a no-op on an out-of-range index rather than throwing or truncating", () => {
    const displayOrder = ["profile", "tier", "wait", "notify"] as const;
    expect(moveFallbackRung(displayOrder, 0, 99)).toEqual(displayOrder);
    expect(moveFallbackRung(displayOrder, -1, 1)).toEqual(displayOrder);
    expect(moveFallbackRung(displayOrder, 1, 1)).toEqual(displayOrder);
  });
});

describe("validateFallbackPolicyDraft", () => {
  it("accepts the default policy", () => {
    expect(validateFallbackPolicyDraft(createDefaultFallbackPolicy())).toEqual({
      kind: "valid",
    });
  });

  it("rejects a duplicated ladder step with a step-scoped sentence, not zod's field-vocabulary message", () => {
    const result = validateFallbackPolicyDraft(
      policy({ ladder: ["profile", "profile"] }),
    );
    expect(result).toEqual({
      kind: "invalid",
      message: "Each step can be listed only once.",
    });
  });

  it("rejects a maxWaitMinutes outside the wire schema's own range", () => {
    const result = validateFallbackPolicyDraft(
      policy({ maxWaitMinutes: 999_999 }),
    );
    expect(result.kind).toBe("invalid");
  });
});

describe("fallbackPolicyDraftReducer", () => {
  it("an invalid edit sets localError, clears hostError, and does not touch persisted", () => {
    const state = createFallbackPolicyDraftState(createDefaultFallbackPolicy());
    const invalid = policy({ ladder: ["wait", "wait"] });
    const next = fallbackPolicyDraftReducer(state, {
      type: "edited",
      policy: invalid,
      field: "ladder",
      keyedTierGroups: null,
    });
    expect(next.draft).toEqual(invalid);
    expect(next.localError).toBe("Each step can be listed only once.");
    expect(next.hostError).toBeNull();
    expect(next.activeField).toBe("ladder");
    expect(next.persisted).toEqual(createDefaultFallbackPolicy());
  });

  it("a valid edit clears both error slots", () => {
    const state: FallbackPolicyDraftState = {
      ...createFallbackPolicyDraftState(createDefaultFallbackPolicy()),
      localError: "stale error",
      hostError: "stale host error",
    };
    const valid = policy({ graceWindowSeconds: 12 });
    const next = fallbackPolicyDraftReducer(state, {
      type: "edited",
      policy: valid,
      field: "behavior",
      keyedTierGroups: null,
    });
    expect(next.localError).toBeNull();
    expect(next.hostError).toBeNull();
    expect(next.draft).toEqual(valid);
  });

  it("save-failed reverts the draft AND the display order to what was persisted, keeping the rejection's field", () => {
    const persisted = createDefaultFallbackPolicy();
    const state = createFallbackPolicyDraftState(persisted);
    const edited = fallbackPolicyDraftReducer(state, {
      type: "edited",
      policy: policy({ enabled: true }),
      field: "enabled",
      keyedTierGroups: null,
    });
    const failed = fallbackPolicyDraftReducer(edited, {
      type: "save-failed",
      message: "The host refused this value.",
      field: "enabled",
    });
    expect(failed.draft).toEqual(persisted);
    expect(failed.displayOrder).toEqual(fallbackDisplayOrder(persisted.ladder));
    expect(failed.hostError).toBe("The host refused this value.");
    expect(failed.localError).toBeNull();
    expect(failed.activeField).toBe("enabled");
    expect(failed.saveInFlight).toBe(false);
  });

  it("save-succeeded adopts the response as both draft and persisted, and clears the active field", () => {
    const state = createFallbackPolicyDraftState(createDefaultFallbackPolicy());
    const response = policy({ enabled: true, ladder: ["notify"] });
    const next = fallbackPolicyDraftReducer(state, {
      type: "save-succeeded",
      policy: response,
    });
    expect(next.persisted).toEqual(response);
    expect(next.draft).toEqual(response);
    expect(next.displayOrder).toEqual(fallbackDisplayOrder(response.ladder));
    expect(next.activeField).toBeNull();
    expect(next.saveInFlight).toBe(false);
  });

  it("reordered updates only displayOrder, leaving the draft policy (and therefore the wire ladder) untouched until a commit follows", () => {
    const state = createFallbackPolicyDraftState(createDefaultFallbackPolicy());
    const nextOrder = ["tier", "profile", "wait", "notify"] as const;
    const next = fallbackPolicyDraftReducer(state, {
      type: "reordered",
      displayOrder: nextOrder,
    });
    expect(next.displayOrder).toEqual(nextOrder);
    expect(next.draft).toEqual(state.draft);
  });

  it("save-started sets the field-scoped spinner and clears a stale hostError under that field", () => {
    const state = createFallbackPolicyDraftState(createDefaultFallbackPolicy());
    const next = fallbackPolicyDraftReducer(state, {
      type: "save-started",
      field: "danger",
    });
    expect(next.saveInFlight).toBe(true);
    expect(next.hostError).toBeNull();
    expect(next.activeField).toBe("danger");
  });
});

describe("keyedTierGroups identity (D174)", () => {
  it("gives two content-identical candidates in the same group distinct keys at hydration", () => {
    // A content-derived key would collide here: same harness, same family,
    // same effort. This is exactly the pair a React key must still tell apart.
    const same = candidate("opus");
    const state = createFallbackPolicyDraftState(
      policy({ tierGroups: [tierGroup("g1", [same, same])] }),
    );
    const keys = state.keyedTierGroups[0].candidates.map((row) => row.key);
    expect(keys[0]).not.toBe(keys[1]);
    expect(new Set(keys).size).toBe(2);
  });

  it("edited with keyedTierGroups: null leaves the SAME identities in place, not equal-looking new ones", () => {
    const state = createFallbackPolicyDraftState(
      policy({ tierGroups: [tierGroup("g1", [candidate("opus")])] }),
    );
    const next = fallbackPolicyDraftReducer(state, {
      type: "edited",
      policy: policy({ enabled: true, tierGroups: state.draft.tierGroups }),
      field: "enabled",
      keyedTierGroups: null,
    });
    // Reference equality, not `toEqual`: a control outside the groups editor
    // must not touch identity at all, and a re-minted-but-equal-looking list
    // would still remount every candidate row.
    expect(next.keyedTierGroups).toBe(state.keyedTierGroups);
  });

  it("save-succeeded keeps existing keys when the response's tierGroups is a freshly-built but structurally equal list (a host echo)", () => {
    const state = createFallbackPolicyDraftState(
      policy({ tierGroups: [tierGroup("g1", [candidate("opus")])] }),
    );
    // A NEW array/object graph, not the same reference as `state`'s policy -
    // exactly what an echoed RPC response is.
    const echoed = policy({
      tierGroups: [tierGroup("g1", [candidate("opus")])],
    });
    const next = fallbackPolicyDraftReducer(state, {
      type: "save-succeeded",
      policy: echoed,
    });
    expect(next.keyedTierGroups).toBe(state.keyedTierGroups);
  });

  it("save-succeeded mints fresh keys when the response's tierGroups actually differs (a restore)", () => {
    const state = createFallbackPolicyDraftState(
      policy({ tierGroups: [tierGroup("g1", [candidate("opus")])] }),
    );
    const restored = policy({
      tierGroups: [tierGroup("g1", [candidate("sonnet")])],
    });
    const next = fallbackPolicyDraftReducer(state, {
      type: "save-succeeded",
      policy: restored,
    });
    expect(next.keyedTierGroups).not.toBe(state.keyedTierGroups);
    expect(next.keyedTierGroups[0].candidates[0].key).not.toBe(
      state.keyedTierGroups[0].candidates[0].key,
    );
    expect(next.keyedTierGroups[0].candidates[0].value.modelFamily).toBe(
      "sonnet",
    );
  });

  it("save-failed mints fresh keys when it reverts to a persisted whose groups differ from the (rejected) draft's", () => {
    const persistedGroups = [tierGroup("g1", [candidate("opus")])];
    const seedState = createFallbackPolicyDraftState(
      policy({ tierGroups: persistedGroups }),
    );
    // Simulate the groups editor having produced its own keyed list for an
    // edit that changes the family - the only way `edited` ever receives a
    // non-null `keyedTierGroups`.
    const editedGroups = [tierGroup("g1", [candidate("sonnet")])];
    const editedKeyed = toKeyedGroups(editedGroups);
    const editedState = fallbackPolicyDraftReducer(seedState, {
      type: "edited",
      policy: policy({ tierGroups: editedGroups }),
      field: "tierGroups",
      keyedTierGroups: editedKeyed,
    });

    const failed = fallbackPolicyDraftReducer(editedState, {
      type: "save-failed",
      message: "The host refused this value.",
      field: "tierGroups",
    });

    // Reverts to the PERSISTED groups (opus), not the rejected draft's
    // (sonnet) - and since that differs from what `editedKeyed` held
    // identities for, the revert cannot reuse them.
    expect(failed.keyedTierGroups[0].candidates[0].value.modelFamily).toBe(
      "opus",
    );
    expect(failed.keyedTierGroups).not.toBe(editedKeyed);
    expect(failed.keyedTierGroups[0].candidates[0].key).not.toBe(
      editedKeyed[0].candidates[0].key,
    );
  });
});

describe("revision / savingRevision - a save's echo cannot clobber a newer draft (D181)", () => {
  it("CONTROL: applies the echo when nothing was edited while the save was in flight", () => {
    // Positive control for the pin below: without it, a reducer that ignored
    // every `save-succeeded` (or one that always kept the draft, defeating the
    // race fix entirely) would pass the pin trivially. This sequence has no
    // `edited` between `save-started` and `save-succeeded`, so the echo is the
    // only newer information there is, and it MUST be applied.
    const state = createFallbackPolicyDraftState(createDefaultFallbackPolicy());
    const sent = policy({ enabled: true });
    const edited = fallbackPolicyDraftReducer(state, {
      type: "edited",
      policy: sent,
      field: "enabled",
      keyedTierGroups: null,
    });
    const started = fallbackPolicyDraftReducer(edited, {
      type: "save-started",
      field: "enabled",
    });
    const succeeded = fallbackPolicyDraftReducer(started, {
      type: "save-succeeded",
      policy: sent,
    });
    expect(succeeded.draft).toEqual(sent);
    expect(succeeded.persisted).toEqual(sent);
    expect(succeeded.saveInFlight).toBe(false);
  });

  it("a value typed while a save is in flight survives that save's own echo", () => {
    const state = createFallbackPolicyDraftState(createDefaultFallbackPolicy());
    // The value that gets sent...
    const sent = policy({ enabled: true, graceWindowSeconds: 11 });
    const edited = fallbackPolicyDraftReducer(state, {
      type: "edited",
      policy: sent,
      field: "behavior",
      keyedTierGroups: null,
    });
    const started = fallbackPolicyDraftReducer(edited, {
      type: "save-started",
      field: "behavior",
    });
    // ...and the character typed while that save is in flight.
    const typedWhileInFlight = policy({
      enabled: true,
      graceWindowSeconds: 12,
    });
    const editedAgain = fallbackPolicyDraftReducer(started, {
      type: "edited",
      policy: typedWhileInFlight,
      field: "behavior",
      keyedTierGroups: null,
    });
    // The echo answering the FIRST (already-superseded) policy arrives now.
    const succeeded = fallbackPolicyDraftReducer(editedAgain, {
      type: "save-succeeded",
      policy: sent,
    });
    // The draft is still what the user has typed since - not overwritten by
    // an answer to a question that is no longer being asked.
    expect(succeeded.draft).toEqual(typedWhileInFlight);
    // The host really did store `sent` - that fact is not lost, it just does
    // not get to overwrite `draft`.
    expect(succeeded.persisted).toEqual(sent);
    expect(succeeded.saveInFlight).toBe(false);
  });
});
