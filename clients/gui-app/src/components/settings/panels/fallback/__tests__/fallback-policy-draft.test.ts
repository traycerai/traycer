import { describe, expect, it } from "vitest";
import {
  createDefaultFallbackPolicy,
  type FallbackPolicy,
  type TierCandidate,
  type TierGroup,
} from "@traycer/protocol/host/fallback-policy";
import {
  createFallbackPolicyDraftState,
  createFallbackSaveRequestId,
  fallbackDisplayOrder,
  fallbackDisplayOrderFor,
  fallbackLadderFrom,
  fallbackPolicyDraftReducer,
  fallbackSaveInFlight,
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
  // F15 REVERSES this test's original proposition, deliberately.
  //
  // It used to assert `["notify", "tier"]` -> `["notify", "tier", "profile",
  // "wait"]`: disabled steps appended at the END. That is the behaviour F15
  // removes, because a step sitting below `notify` cannot run if the user turns
  // it back on - the panel would be drawing a position it will not honour. The
  // disabled block now lands immediately before the notify SLOT wherever notify
  // sits, which for this notify-first ladder is the very front of the list.
  //
  // What is unchanged, and is what this case still pins that the two F15 cases
  // below do not: with notify FIRST there is no room before it in the enabled
  // part at all, so this is the boundary where "before the slot" and "at the
  // end" are maximally different.
  it("F15: with notify FIRST, the disabled block lands ahead of everything rather than appended past it", () => {
    const order = fallbackDisplayOrder(["notify", "tier"]);
    expect(order).toEqual(["profile", "wait", "notify", "tier"]);
    expect(order.indexOf("profile")).toBeLessThan(order.indexOf("notify"));
    expect(order.indexOf("wait")).toBeLessThan(order.indexOf("notify"));
  });

  it("is the identity on a full ladder", () => {
    const order = fallbackDisplayOrder(["wait", "profile", "notify", "tier"]);
    expect(order).toEqual(["wait", "profile", "notify", "tier"]);
  });

  it("F15: inserts a disabled step immediately before a TERMINAL notify, not appended past it", () => {
    // "wait" is turned off; notify is last, as it ordinarily is.
    const order = fallbackDisplayOrder(["profile", "tier", "notify"]);
    // Falsification: replace `ladder.slice(0, notifyAt)` /
    // `ladder.slice(notifyAt)` in fallback-policy-draft.ts's
    // `fallbackDisplayOrder` with a plain `[...ladder, ...disabled]` (the old
    // append-at-the-end behaviour) and this reddens - "wait" would land AFTER
    // notify instead of before it.
    expect(order).toEqual(["profile", "tier", "wait", "notify"]);
    expect(order.indexOf("wait")).toBeLessThan(order.indexOf("notify"));
  });

  it("F15: inserts a disabled step before an EARLY notify's slot too, not at the array's end", () => {
    // notify sits second, not last - an externally authored ladder.
    const order = fallbackDisplayOrder(["profile", "notify", "tier"]);
    // "wait" is disabled and must land before the early notify slot, and the
    // enabled steps either side of notify keep their own relative order.
    expect(order).toEqual(["profile", "wait", "notify", "tier"]);
  });
});

describe("fallbackDisplayOrderFor", () => {
  it("keeps the local display order when the incoming ladder is what that order already produces for the enabled set", () => {
    // Local order has "wait" sitting before "profile" among the disabled
    // placeholders - information the wire ladder itself cannot carry.
    const displayOrder = ["tier", "wait", "profile", "notify"] as const;
    const enabled = new Set<(typeof displayOrder)[number]>(["tier", "notify"]);
    const ladder = fallbackLadderFrom(displayOrder, enabled);
    // Falsification: change the call site in `fallbackPolicyDraftReducer`'s
    // `save-succeeded` branch (or here) to always
    // `fallbackDisplayOrder(ladder)` instead of consulting the local order -
    // this assertion would then see "profile" moved ahead of "wait" (the
    // CANONICAL order for the disabled pair), losing where the user had put it.
    expect(fallbackDisplayOrderFor(displayOrder, ladder)).toBe(displayOrder);
  });

  it("re-derives when the incoming ladder is a genuine reorder the local display order does not agree with", () => {
    const displayOrder = ["tier", "wait", "profile", "notify"] as const;
    // A ladder that could not have come from filtering `displayOrder`: "wait"
    // appears before "tier" here, the opposite of the local order.
    const reordered: readonly (typeof displayOrder)[number][] = [
      "wait",
      "tier",
      "notify",
    ];
    expect(fallbackDisplayOrderFor(displayOrder, reordered)).toEqual(
      fallbackDisplayOrder(reordered),
    );
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

describe("fallbackPolicyDraftReducer - edited", () => {
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
      hostError: { message: "stale host error", outcome: "refused-reverted" },
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
});

describe("fallbackPolicyDraftReducer - save-started / save-failed / save-succeeded, single save (F17 control)", () => {
  it("save-started sets the field-scoped spinner and clears a stale hostError, recording the pending save", () => {
    const state: FallbackPolicyDraftState = {
      ...createFallbackPolicyDraftState(createDefaultFallbackPolicy()),
      hostError: { message: "stale", outcome: "refused-reverted" },
    };
    const requestId = createFallbackSaveRequestId();
    const next = fallbackPolicyDraftReducer(state, {
      type: "save-started",
      field: "danger",
      requestId,
    });
    expect(fallbackSaveInFlight(next)).toBe(true);
    expect(next.hostError).toBeNull();
    expect(next.activeField).toBe("danger");
    expect(next.pendingSaves).toEqual([{ requestId, revision: 0 }]);
  });

  it("save-succeeded adopts the response as both draft and persisted, and clears the active field", () => {
    const state = createFallbackPolicyDraftState(createDefaultFallbackPolicy());
    const requestId = createFallbackSaveRequestId();
    const sent = policy({ enabled: true, ladder: ["notify"] });
    const edited = fallbackPolicyDraftReducer(state, {
      type: "edited",
      policy: sent,
      field: "enabled",
      keyedTierGroups: null,
    });
    const started = fallbackPolicyDraftReducer(edited, {
      type: "save-started",
      field: "enabled",
      requestId,
    });
    const response = sent;
    const next = fallbackPolicyDraftReducer(started, {
      type: "save-succeeded",
      requestId,
      policy: response,
    });
    expect(next.persisted).toEqual(response);
    expect(next.draft).toEqual(response);
    expect(next.displayOrder).toEqual(
      fallbackDisplayOrderFor(started.displayOrder, response.ladder),
    );
    expect(next.activeField).toBeNull();
    expect(fallbackSaveInFlight(next)).toBe(false);
    expect(next.pendingSaves).toEqual([]);
  });

  it("save-failed (refused) reverts the draft AND the display order to what was persisted, keeping the rejection's field", () => {
    const persisted = createDefaultFallbackPolicy();
    const state = createFallbackPolicyDraftState(persisted);
    const requestId = createFallbackSaveRequestId();
    const edited = fallbackPolicyDraftReducer(state, {
      type: "edited",
      policy: policy({ enabled: true }),
      field: "enabled",
      keyedTierGroups: null,
    });
    const started = fallbackPolicyDraftReducer(edited, {
      type: "save-started",
      field: "enabled",
      requestId,
    });
    const failed = fallbackPolicyDraftReducer(started, {
      type: "save-failed",
      requestId,
      message: "The host refused this value.",
      field: "enabled",
      outcome: "refused",
    });
    expect(failed.draft).toEqual(persisted);
    expect(failed.displayOrder).toEqual(fallbackDisplayOrder(persisted.ladder));
    expect(failed.hostError).toEqual({
      message: "The host refused this value.",
      outcome: "refused-reverted",
    });
    expect(failed.localError).toBeNull();
    expect(failed.activeField).toBe("enabled");
    expect(fallbackSaveInFlight(failed)).toBe(false);
  });

  it("a reply naming an unknown requestId returns the SAME state object - it cannot say which draft it answers", () => {
    const state = createFallbackPolicyDraftState(createDefaultFallbackPolicy());
    const succeeded = fallbackPolicyDraftReducer(state, {
      type: "save-succeeded",
      requestId: 999_999,
      policy: policy({ enabled: true }),
    });
    expect(succeeded).toBe(state);
    const failed = fallbackPolicyDraftReducer(state, {
      type: "save-failed",
      requestId: 999_999,
      message: "x",
      field: "enabled",
      outcome: "refused",
    });
    expect(failed).toBe(state);
  });
});

describe("fallbackPolicyDraftReducer - F17 concurrent saves (FC3)", () => {
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
    const requestId = createFallbackSaveRequestId();
    const started = fallbackPolicyDraftReducer(edited, {
      type: "save-started",
      field: "enabled",
      requestId,
    });
    const succeeded = fallbackPolicyDraftReducer(started, {
      type: "save-succeeded",
      requestId,
      policy: sent,
    });
    expect(succeeded.draft).toEqual(sent);
    expect(succeeded.persisted).toEqual(sent);
    expect(fallbackSaveInFlight(succeeded)).toBe(false);
  });

  it("a value typed while a save is in flight survives that save's own echo", () => {
    const state = createFallbackPolicyDraftState(createDefaultFallbackPolicy());
    const sent = policy({ enabled: true, graceWindowSeconds: 11 });
    const edited = fallbackPolicyDraftReducer(state, {
      type: "edited",
      policy: sent,
      field: "behavior",
      keyedTierGroups: null,
    });
    const requestId = createFallbackSaveRequestId();
    const started = fallbackPolicyDraftReducer(edited, {
      type: "save-started",
      field: "behavior",
      requestId,
    });
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
    const succeeded = fallbackPolicyDraftReducer(editedAgain, {
      type: "save-succeeded",
      requestId,
      policy: sent,
    });
    expect(succeeded.draft).toEqual(typedWhileInFlight);
    expect(succeeded.persisted).toEqual(sent);
    expect(fallbackSaveInFlight(succeeded)).toBe(false);
  });

  it("two saves in flight: A's echo lands first, then B's - the draft ends up as B's, persisted as B's too, then a third edit and B's own echo land correctly", () => {
    // edit -> save-started(A) -> edit -> save-started(B) -> save-succeeded(A)
    //   => draft is B's value, persisted is A's
    // then a third edit
    // then save-succeeded(B)
    //   => draft is the third edit's value, persisted is B's
    const state = createFallbackPolicyDraftState(createDefaultFallbackPolicy());
    const valueA = policy({ enabled: true, graceWindowSeconds: 20 });
    const editedA = fallbackPolicyDraftReducer(state, {
      type: "edited",
      policy: valueA,
      field: "behavior",
      keyedTierGroups: null,
    });
    const requestA = createFallbackSaveRequestId();
    const startedA = fallbackPolicyDraftReducer(editedA, {
      type: "save-started",
      field: "behavior",
      requestId: requestA,
    });
    const valueB = policy({ enabled: true, graceWindowSeconds: 25 });
    const editedB = fallbackPolicyDraftReducer(startedA, {
      type: "edited",
      policy: valueB,
      field: "behavior",
      keyedTierGroups: null,
    });
    const requestB = createFallbackSaveRequestId();
    const startedB = fallbackPolicyDraftReducer(editedB, {
      type: "save-started",
      field: "behavior",
      requestId: requestB,
    });
    const afterA = fallbackPolicyDraftReducer(startedB, {
      type: "save-succeeded",
      requestId: requestA,
      policy: valueA,
    });
    // Draft is still B's value (A's echo answers a superseded draft);
    // persisted follows A's reply because it is the most recent SETTLED save.
    expect(afterA.draft).toEqual(valueB);
    expect(afterA.persisted).toEqual(valueA);
    expect(fallbackSaveInFlight(afterA)).toBe(true);

    const thirdEdit = policy({ enabled: true, graceWindowSeconds: 30 });
    const editedThird = fallbackPolicyDraftReducer(afterA, {
      type: "edited",
      policy: thirdEdit,
      field: "behavior",
      keyedTierGroups: null,
    });
    const afterB = fallbackPolicyDraftReducer(editedThird, {
      type: "save-succeeded",
      requestId: requestB,
      policy: valueB,
    });
    // B's echo answers the draft as it stood when B was sent (valueB), which
    // has since moved on again (the third edit) - so the draft stays the
    // third edit's value, and persisted follows B's (newer than A's) reply.
    expect(afterB.draft).toEqual(thirdEdit);
    expect(afterB.persisted).toEqual(valueB);
    expect(fallbackSaveInFlight(afterB)).toBe(false);
  });

  it("an older reply's refusal is reported but NOT reverted once the draft has moved on (refused-kept)", () => {
    const persisted = createDefaultFallbackPolicy();
    const state = createFallbackPolicyDraftState(persisted);
    const valueA = policy({ enabled: true });
    const editedA = fallbackPolicyDraftReducer(state, {
      type: "edited",
      policy: valueA,
      field: "enabled",
      keyedTierGroups: null,
    });
    const requestA = createFallbackSaveRequestId();
    const startedA = fallbackPolicyDraftReducer(editedA, {
      type: "save-started",
      field: "enabled",
      requestId: requestA,
    });
    // The user keeps editing while A is in flight - the revision moves on.
    const valueB = policy({ enabled: true, graceWindowSeconds: 40 });
    const editedB = fallbackPolicyDraftReducer(startedA, {
      type: "edited",
      policy: valueB,
      field: "behavior",
      keyedTierGroups: null,
    });
    const failedA = fallbackPolicyDraftReducer(editedB, {
      type: "save-failed",
      requestId: requestA,
      message: "The host refused this value.",
      field: "enabled",
      outcome: "refused",
    });
    // Falsification: delete the `pending.revision !== state.revision` branch
    // in `save-failed` (fallback-policy-draft.ts) so every refusal reverts -
    // this would then see `failedA.draft` equal `persisted` instead of `valueB`.
    expect(failedA.draft).toEqual(valueB);
    expect(failedA.hostError).toEqual({
      message: "The host refused this value.",
      outcome: "refused-kept",
    });
  });

  it("out-of-order success replies: B's echo lands before A's - persisted stays B's, the newer of the two", () => {
    const state = createFallbackPolicyDraftState(createDefaultFallbackPolicy());
    const valueA = policy({ enabled: true, graceWindowSeconds: 20 });
    const editedA = fallbackPolicyDraftReducer(state, {
      type: "edited",
      policy: valueA,
      field: "behavior",
      keyedTierGroups: null,
    });
    const requestA = createFallbackSaveRequestId();
    const startedA = fallbackPolicyDraftReducer(editedA, {
      type: "save-started",
      field: "behavior",
      requestId: requestA,
    });
    const valueB = policy({ enabled: true, graceWindowSeconds: 25 });
    const editedB = fallbackPolicyDraftReducer(startedA, {
      type: "edited",
      policy: valueB,
      field: "behavior",
      keyedTierGroups: null,
    });
    const requestB = createFallbackSaveRequestId();
    const startedB = fallbackPolicyDraftReducer(editedB, {
      type: "save-started",
      field: "behavior",
      requestId: requestB,
    });
    // B answers FIRST.
    const afterB = fallbackPolicyDraftReducer(startedB, {
      type: "save-succeeded",
      requestId: requestB,
      policy: valueB,
    });
    // A answers SECOND, with an OLDER value.
    const afterA = fallbackPolicyDraftReducer(afterB, {
      type: "save-succeeded",
      requestId: requestA,
      policy: valueA,
    });
    // Falsification: drop the `pending.revision >= state.persistedRevision`
    // guard in `save-succeeded` (fallback-policy-draft.ts) and unconditionally
    // adopt every reply's policy into `persisted` - this would then see
    // `afterA.persisted` equal `valueA`, the OLDER value, overwriting the
    // newer one B's reply had already settled.
    expect(afterA.persisted).toEqual(valueB);
    expect(fallbackSaveInFlight(afterA)).toBe(false);
  });
});

describe("fallbackPolicyDraftReducer - F21 unknown outcome + reconciled", () => {
  it("save-failed (unknown) leaves the draft untouched and records the unresolved save", () => {
    const state = createFallbackPolicyDraftState(createDefaultFallbackPolicy());
    const sent = policy({ enabled: true });
    const edited = fallbackPolicyDraftReducer(state, {
      type: "edited",
      policy: sent,
      field: "enabled",
      keyedTierGroups: null,
    });
    const requestId = createFallbackSaveRequestId();
    const started = fallbackPolicyDraftReducer(edited, {
      type: "save-started",
      field: "enabled",
      requestId,
    });
    const failed = fallbackPolicyDraftReducer(started, {
      type: "save-failed",
      requestId,
      message: "Lost contact with this host before it answered.",
      field: "enabled",
      outcome: "unknown",
    });
    // The draft is UNTOUCHED - it may BE what was committed.
    expect(failed.draft).toEqual(sent);
    expect(failed.hostError).toEqual({
      message: "Lost contact with this host before it answered.",
      outcome: "unknown",
    });
    expect(failed.unknownSave).toEqual({
      requestId,
      revision: started.revision,
    });
  });

  it("reconciled with a STALE unknownSave.revision does not clobber a newer draft, and clears the notice", () => {
    const state = createFallbackPolicyDraftState(createDefaultFallbackPolicy());
    const sent = policy({ enabled: true });
    const edited = fallbackPolicyDraftReducer(state, {
      type: "edited",
      policy: sent,
      field: "enabled",
      keyedTierGroups: null,
    });
    const requestId = createFallbackSaveRequestId();
    const started = fallbackPolicyDraftReducer(edited, {
      type: "save-started",
      field: "enabled",
      requestId,
    });
    const failed = fallbackPolicyDraftReducer(started, {
      type: "save-failed",
      requestId,
      message: "unknown",
      field: "enabled",
      outcome: "unknown",
    });
    // The user edits AGAIN before the read-back arrives.
    const newerEdit = policy({ enabled: true, graceWindowSeconds: 50 });
    const editedAgain = fallbackPolicyDraftReducer(failed, {
      type: "edited",
      policy: newerEdit,
      field: "behavior",
      keyedTierGroups: null,
    });
    const readBack = policy({ enabled: true });
    const reconciled = fallbackPolicyDraftReducer(editedAgain, {
      type: "reconciled",
      requestId,
      policy: readBack,
    });
    // Falsification: drop the `state.revision !== state.unknownSave.revision`
    // check in `reconciled` (fallback-policy-draft.ts) and unconditionally
    // write `action.policy` into `draft` - this would then overwrite
    // `newerEdit` with `readBack`, discarding an edit the read-back knows
    // nothing about.
    expect(reconciled.draft).toEqual(newerEdit);
    expect(reconciled.persisted).toEqual(readBack);
    expect(reconciled.hostError).toBeNull();
    expect(reconciled.unknownSave).toBeNull();
  });

  it("reconciled while the draft has NOT moved since the unknown outcome adopts the read-back into the draft too", () => {
    const state = createFallbackPolicyDraftState(createDefaultFallbackPolicy());
    const sent = policy({ enabled: true });
    const edited = fallbackPolicyDraftReducer(state, {
      type: "edited",
      policy: sent,
      field: "enabled",
      keyedTierGroups: null,
    });
    const requestId = createFallbackSaveRequestId();
    const started = fallbackPolicyDraftReducer(edited, {
      type: "save-started",
      field: "enabled",
      requestId,
    });
    const failed = fallbackPolicyDraftReducer(started, {
      type: "save-failed",
      requestId,
      message: "unknown",
      field: "enabled",
      outcome: "unknown",
    });
    const readBack = policy({ enabled: false });
    const reconciled = fallbackPolicyDraftReducer(failed, {
      type: "reconciled",
      requestId,
      policy: readBack,
    });
    expect(reconciled.draft).toEqual(readBack);
    expect(reconciled.persisted).toEqual(readBack);
    expect(reconciled.hostError).toBeNull();
    expect(reconciled.unknownSave).toBeNull();
  });

  it("a reconciled naming a superseded requestId is dropped", () => {
    const state = createFallbackPolicyDraftState(createDefaultFallbackPolicy());
    const reconciled = fallbackPolicyDraftReducer(state, {
      type: "reconciled",
      requestId: 12345,
      policy: policy({ enabled: true }),
    });
    expect(reconciled).toBe(state);
  });
});

describe("keyedTierGroups identity at the reducer boundary (D174)", () => {
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

  it("save-succeeded routes a same-shape echo through `reconcileKeyedGroups`: keeps existing keys", () => {
    const state = createFallbackPolicyDraftState(
      policy({ tierGroups: [tierGroup("g1", [candidate("opus")])] }),
    );
    // A NEW array/object graph, not the same reference as `state`'s policy -
    // exactly what an echoed RPC response is.
    const echoed = policy({
      tierGroups: [tierGroup("g1", [candidate("opus")])],
    });
    const requestId = createFallbackSaveRequestId();
    const started = fallbackPolicyDraftReducer(state, {
      type: "save-started",
      field: "tierGroups",
      requestId,
    });
    const next = fallbackPolicyDraftReducer(started, {
      type: "save-succeeded",
      requestId,
      policy: echoed,
    });
    expect(next.keyedTierGroups).toBe(state.keyedTierGroups);
  });

  it("save-succeeded routes a genuinely different response (a restore) through `reconcileKeyedGroups`: mints fresh keys", () => {
    const state = createFallbackPolicyDraftState(
      policy({ tierGroups: [tierGroup("g1", [candidate("opus")])] }),
    );
    const restored = policy({
      tierGroups: [tierGroup("g1", [candidate("sonnet")])],
    });
    const requestId = createFallbackSaveRequestId();
    const started = fallbackPolicyDraftReducer(state, {
      type: "save-started",
      field: "tierGroups",
      requestId,
    });
    const next = fallbackPolicyDraftReducer(started, {
      type: "save-succeeded",
      requestId,
      policy: restored,
    });
    // Proves `save-succeeded` did NOT get merged onto the weaker
    // `revertKeyedGroups` path (F24): a restore changes the candidate's
    // VALUE while keeping the group shape, which `revertKeyedGroups` would
    // treat as "same rows, put the value back" and keep the old key. Only
    // `reconcileKeyedGroups`'s stricter value-equality check re-seeds here.
    expect(next.keyedTierGroups).not.toBe(state.keyedTierGroups);
    expect(next.keyedTierGroups[0].candidates[0].key).not.toBe(
      state.keyedTierGroups[0].candidates[0].key,
    );
    expect(next.keyedTierGroups[0].candidates[0].value.modelFamily).toBe(
      "sonnet",
    );
  });

  it("F24: save-failed's revert routes a SHAPE-EQUAL revert through `revertKeyedGroups` - keeps every key, restores the persisted VALUE", () => {
    const persistedGroups = [tierGroup("g1", [candidate("opus")])];
    const seedState = createFallbackPolicyDraftState(
      policy({ tierGroups: persistedGroups }),
    );
    // Same shape as the seed (one group, one candidate) - only the value
    // changes, which is what a rejected rename/family-correction/effort-change
    // looks like.
    const editedGroups = [tierGroup("g1", [candidate("sonnet")])];
    const editedKeyed = toKeyedGroups(editedGroups);
    const editedState = fallbackPolicyDraftReducer(seedState, {
      type: "edited",
      policy: policy({ tierGroups: editedGroups }),
      field: "tierGroups",
      keyedTierGroups: editedKeyed,
    });
    const requestId = createFallbackSaveRequestId();
    const started = fallbackPolicyDraftReducer(editedState, {
      type: "save-started",
      field: "tierGroups",
      requestId,
    });
    const failed = fallbackPolicyDraftReducer(started, {
      type: "save-failed",
      requestId,
      message: "The host refused this value.",
      field: "tierGroups",
      outcome: "refused",
    });

    // Falsification: swap `revertKeyedGroups` for `reconcileKeyedGroups` in
    // `save-failed` (fallback-policy-draft.ts) - this would then mint fresh
    // keys here too, remounting the field the user was typing in.
    expect(failed.keyedTierGroups[0].draftKey).toBe(editedKeyed[0].draftKey);
    expect(failed.keyedTierGroups[0].candidates[0].key).toBe(
      editedKeyed[0].candidates[0].key,
    );
    // The VALUE reverts to the persisted one (opus), not the rejected draft's
    // (sonnet).
    expect(failed.keyedTierGroups[0].candidates[0].value.modelFamily).toBe(
      "opus",
    );
  });

  it("F24 negative half: a SHAPE-DIFFERENT revert (the draft added a row) still mints fresh keys", () => {
    const persistedGroups = [tierGroup("g1", [candidate("opus")])];
    const seedState = createFallbackPolicyDraftState(
      policy({ tierGroups: persistedGroups }),
    );
    // The rejected edit ADDED a second candidate - a shape change, not a
    // value-only edit.
    const editedGroups = [
      tierGroup("g1", [candidate("opus"), candidate("sonnet")]),
    ];
    const editedKeyed = toKeyedGroups(editedGroups);
    const editedState = fallbackPolicyDraftReducer(seedState, {
      type: "edited",
      policy: policy({ tierGroups: editedGroups }),
      field: "tierGroups",
      keyedTierGroups: editedKeyed,
    });
    const requestId = createFallbackSaveRequestId();
    const started = fallbackPolicyDraftReducer(editedState, {
      type: "save-started",
      field: "tierGroups",
      requestId,
    });
    const failed = fallbackPolicyDraftReducer(started, {
      type: "save-failed",
      requestId,
      message: "The host refused this value.",
      field: "tierGroups",
      outcome: "refused",
    });

    expect(failed.keyedTierGroups).toHaveLength(1);
    expect(failed.keyedTierGroups[0].candidates).toHaveLength(1);
    expect(failed.keyedTierGroups[0].candidates[0].key).not.toBe(
      editedKeyed[0].candidates[0].key,
    );
    expect(failed.keyedTierGroups[0].candidates[0].value.modelFamily).toBe(
      "opus",
    );
  });
});
