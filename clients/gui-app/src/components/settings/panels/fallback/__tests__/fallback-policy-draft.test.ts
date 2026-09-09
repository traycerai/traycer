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
  fallbackMovableBoundary,
  fallbackPolicyDraftReducer,
  fallbackPolicyValuesEqual,
  fallbackSaveInFlight,
  moveFallbackRung,
  validateFallbackPolicyDraft,
  type FallbackPolicyDraftState,
  type FallbackSaveCarries,
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
    //
    // R5 rewrote this case. It used to move "profile" from movable index 0 to
    // movable index 2 and assert `["tier", "notify", "wait", "profile"]` - the
    // very outcome the boundary rule now forbids, since that lands an enabled
    // step below the terminal one. The behaviour it pinned was the defect, so
    // the case moves to a same-side reorder, which is what the fixed slot is
    // actually for; the crossing move is pinned as a refusal below.
    const displayOrder = ["profile", "notify", "tier", "wait"] as const;
    // Movable view is [profile, tier, wait], with the fixed slot between the
    // first and second. Move "tier" (movable index 1) past "wait" (movable
    // index 2) - both below the slot, so nothing crosses it.
    const next = moveFallbackRung(displayOrder, 1, 2);
    expect(next).toEqual(["profile", "notify", "wait", "tier"]);
    // notify never moved from its original slot (index 1). Distinguishing:
    // treating these as DISPLAY indices and splicing the whole array would
    // have produced `["profile", "tier", "notify", "wait"]` and moved it.
    expect(next[1]).toBe("notify");
  });

  it("R5: refuses a move whose two ends straddle the fixed slot, rather than carrying a step across the terminal one", () => {
    // The externally authored ladder from R5: `notify` second, so the movable
    // list is [profile, wait, tier] with the fixed slot after its first entry.
    const displayOrder = ["profile", "wait", "notify", "tier"] as const;

    // Falsification: delete
    // `if ((fromIndex < boundary) !== (toIndex < boundary)) return displayOrder;`
    // from `moveFallbackRung`. This first case then answers
    // `["wait", "tier", "notify", "profile"]` - the R5 sequence exactly, an
    // enabled step that ran a moment ago now below the step that terminates
    // the walk, from a gesture that mentioned neither.
    expect(moveFallbackRung(displayOrder, 0, 2)).toEqual(displayOrder);
    // And the other direction, which harms a row the gesture never named:
    // dragging `tier` to the top would shift `wait` down across the slot.
    expect(moveFallbackRung(displayOrder, 2, 0)).toEqual(displayOrder);

    // Same-side moves are untouched - the refusal is about the boundary, not
    // about this ladder being unusual. Only `profile` and `wait` are above the
    // slot, so swapping them is the one legal move here.
    expect(moveFallbackRung(displayOrder, 0, 1)).toEqual([
      "wait",
      "profile",
      "notify",
      "tier",
    ]);
  });

  it("has no boundary to enforce on a ladder this panel wrote, where notify is last", () => {
    // Guards against the boundary rule quietly disabling ordinary reordering:
    // with `notify` last every movable index is above the slot, so every move
    // is same-side and the refusal can never fire.
    const displayOrder = ["profile", "tier", "wait", "notify"] as const;
    expect(fallbackMovableBoundary(displayOrder)).toBe(3);
    expect(moveFallbackRung(displayOrder, 0, 2)).toEqual([
      "tier",
      "wait",
      "profile",
      "notify",
    ]);
    expect(moveFallbackRung(displayOrder, 2, 0)).toEqual([
      "wait",
      "profile",
      "tier",
      "notify",
    ]);
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
      carries: "reset",
    });
    expect(fallbackSaveInFlight(next)).toBe(true);
    expect(next.hostError).toBeNull();
    expect(next.activeField).toBe("danger");
    // `carries` is part of the record as of D347 - a reset's pending entry has
    // to remember that it sent DEFAULTS, because the notice's first arm asks.
    // This assertion seeing the new field is the shape pin working.
    expect(next.pendingSaves).toEqual([
      { requestId, revision: 0, carries: "reset" },
    ]);
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
      carries: "draft",
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
      carries: "draft",
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
      carries: "draft",
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
      carries: "draft",
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
      carries: "draft",
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
      carries: "draft",
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
      carries: "draft",
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
      carries: "draft",
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
      carries: "draft",
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
      carries: "draft",
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
    // `carries` travels from the pending record into the ticket as of D347:
    // the notice's first arm - "what's on screen IS the unanswered draft" - is
    // only true of a draft request, and a ticket that has forgotten what its
    // request sent cannot say. This assertion seeing the field is the shape pin
    // doing its job.
    expect(failed.unknownSave).toEqual({
      requestId,
      revision: started.revision,
      carries: "draft",
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
      carries: "draft",
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
      carries: "draft",
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
      carries: "draft",
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
      carries: "restore",
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
      carries: "draft",
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
      carries: "draft",
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

describe("fallbackPolicyDraftReducer - composition-table cells (U / R / S together)", () => {
  // Every finding left after three passes was a COMPOSITION of the same three
  // obligations - the unknown-save TICKET, the refusal MARKER, and the
  // stale-after-reset BANNER - and each pass pinned one sequence while the next
  // composition stayed invisible. These drive the reducer directly, because
  // several of these orderings cannot be produced through the panel at all.
  //
  // Two rules make a pin here non-vacuous, and both were learned by writing one
  // that was not: a reply naming a request already settled returns the state
  // untouched (`pendingSaveFor` is null), so "an older reply lands late" needs
  // that request still PENDING; and typing moves the revision without sending
  // anything, which is how a request comes to answer a draft nobody can see.

  function seeded(): FallbackPolicyDraftState {
    return createFallbackPolicyDraftState(
      policy({ enabled: false, graceWindowSeconds: 15 }),
    );
  }

  function edit(
    state: FallbackPolicyDraftState,
    next: FallbackPolicy,
  ): FallbackPolicyDraftState {
    return fallbackPolicyDraftReducer(state, {
      type: "edited",
      policy: next,
      field: "enabled",
      keyedTierGroups: null,
    });
  }

  /**
   * `carries` is REQUIRED here, with no default, deliberately.
   *
   * This helper passed `"draft"` for every composition it built, including the
   * reset ones - so the older sequences modelled a discriminator that did not
   * exist and could not have caught a no-draft request being described as the
   * display's. Making it a parameter is what puts those compositions back in
   * contact with the distinction (D347).
   */
  function start(
    state: FallbackPolicyDraftState,
    requestId: number,
    carries: FallbackSaveCarries,
  ): FallbackPolicyDraftState {
    return fallbackPolicyDraftReducer(state, {
      type: "save-started",
      field: "enabled",
      requestId,
      carries,
    });
  }

  function succeed(
    state: FallbackPolicyDraftState,
    requestId: number,
    policyValue: FallbackPolicy,
  ): FallbackPolicyDraftState {
    return fallbackPolicyDraftReducer(state, {
      type: "save-succeeded",
      requestId,
      policy: policyValue,
    });
  }

  function failUnknown(
    state: FallbackPolicyDraftState,
    requestId: number,
  ): FallbackPolicyDraftState {
    return fallbackPolicyDraftReducer(state, {
      type: "save-failed",
      requestId,
      message: "lost the connection",
      field: "enabled",
      outcome: "unknown",
    });
  }

  function refuse(
    state: FallbackPolicyDraftState,
    requestId: number,
  ): FallbackPolicyDraftState {
    return fallbackPolicyDraftReducer(state, {
      type: "save-failed",
      requestId,
      message: "policy is out of date",
      field: "enabled",
      outcome: "refused",
    });
  }

  function resetUnrefreshed(
    state: FallbackPolicyDraftState,
    requestId: number,
  ): FallbackPolicyDraftState {
    return fallbackPolicyDraftReducer(state, {
      type: "reset-unrefreshed",
      requestId,
      message:
        "The reset went through, but we couldn't load what's on the host.",
    });
  }

  /** A reset the host confirmed whose read-back failed: the S state below composes with. */
  function afterUnreadReset(
    state: FallbackPolicyDraftState,
  ): FallbackPolicyDraftState {
    const requestId = createFallbackSaveRequestId();
    return resetUnrefreshed(
      fallbackPolicyDraftReducer(state, {
        type: "save-started",
        field: "danger",
        requestId,
        carries: "reset",
      }),
      requestId,
    );
  }

  it("R8: an old success ADOPTED into the view clears the staleness banner, while an ordinary moved-on one keeps it", () => {
    // The split the walk's "already right" note missed. Both are old-revision
    // successes; only one replaces what the controls are showing.
    const base = afterUnreadReset(seeded());
    expect(base.unrefreshedReset).not.toBeNull();

    // B goes out, then C is typed and REFUSED, which rolls back and marks it.
    const bPolicy = policy({ enabled: true, graceWindowSeconds: 15 });
    const b = createFallbackSaveRequestId();
    const afterB = start(edit(base, bPolicy), b, "draft");
    const c = createFallbackSaveRequestId();
    const afterCRefused = refuse(
      start(
        edit(afterB, policy({ enabled: true, graceWindowSeconds: 11 })),
        c,
        "draft",
      ),
      c,
    );
    expect(afterCRefused.refusedDraft?.revision).toBe(afterCRefused.revision);
    // The rollback arm, so the values on screen were RESTORED (N1).
    expect(afterCRefused.refusedDraft?.restoredPersisted).toBe(true);

    // B lands last and outranks `persisted`: the correcting branch proves the
    // rollback stale and adopts B into the controls.
    const corrected = succeed(afterCRefused, b, bPolicy);
    expect(corrected.draft).toEqual(bPolicy);
    // Falsification: drop `unrefreshedReset: null` from the correcting-rollback
    // return in `applySaveSucceeded`. The controls then show exactly the policy
    // the host just confirmed while the banner beside them calls those values
    // pre-reset ones the host's settings haven't been re-read since. The
    // banner's wording was hedged in the sixth pass (D330) and this stays a
    // defect under either: the reset's result IS known here, because a later
    // write was confirmed.
    expect(corrected.unrefreshedReset).toBeNull();

    // The ordinary sibling: no refusal, so the draft is the user's own newer
    // edit and the host's row is NOT what is on screen. The banner stands.
    const base2 = afterUnreadReset(seeded());
    const b2 = createFallbackSaveRequestId();
    const movedOn = edit(
      start(edit(base2, bPolicy), b2, "draft"),
      policy({ enabled: true, graceWindowSeconds: 11 }),
    );
    const ordinary = succeed(movedOn, b2, bPolicy);
    // Admission evidence first: "S survives" and "the echo was never admitted"
    // are the same assertion otherwise, and `pendingSaveFor` returns the state
    // untouched for a request already settled.
    expect(ordinary.persisted).toEqual(bPolicy);
    expect(ordinary.unrefreshedReset).not.toBeNull();
  });

  it("R9: a newer success that discharges the ticket takes the unknown notice - and its retry - with it", () => {
    const a = createFallbackSaveRequestId();
    const afterA = start(edit(seeded(), policy({ enabled: true })), a, "draft");
    const b = createFallbackSaveRequestId();
    const bPolicy = policy({ enabled: true, graceWindowSeconds: 11 });
    const afterB = start(edit(afterA, bPolicy), b, "draft");
    // C is typed and left uncommitted, so B's echo answers a moved-on draft.
    const withC = edit(
      afterB,
      policy({ enabled: true, graceWindowSeconds: 13 }),
    );
    const aUnknown = failUnknown(withC, a);
    expect(aUnknown.unknownSave).not.toBeNull();
    expect(aUnknown.hostError?.outcome).toBe("unknown");

    const bWins = succeed(aUnknown, b, bPolicy);
    // Falsification: restore the bare
    // `return { ...state, ...persisted, pendingSaves, unknownSave };` on the
    // ordinary moved-on path of `applySaveSucceeded`. The ticket clears but its
    // notice stays on screen saying the save "may or may not have been saved",
    // carrying the only Check again there is - which now re-reads for a request
    // that is no longer outstanding and returns having settled nothing.
    expect(bWins.unknownSave).toBeNull();
    expect(bWins.hostError).toBeNull();
    // C is still what the user is looking at, untouched by any of it.
    expect(bWins.draft.graceWindowSeconds).toBe(13);
  });

  it("R9: a refusal carried while the ticket was open DOWNGRADES when a later success settles it, rather than vanishing", () => {
    const a = createFallbackSaveRequestId();
    const afterA = start(edit(seeded(), policy({ enabled: true })), a, "draft");
    const b = createFallbackSaveRequestId();
    const bPolicy = policy({ enabled: true, graceWindowSeconds: 11 });
    const aUnknown = failUnknown(start(edit(afterA, bPolicy), b, "draft"), a);
    // A third save is refused while A's ticket is open: `refused-unverified`,
    // which is a refusal AND an outstanding question at once.
    const c = createFallbackSaveRequestId();
    const cRefused = refuse(
      start(
        edit(aUnknown, policy({ enabled: true, graceWindowSeconds: 13 })),
        c,
        "draft",
      ),
      c,
    );
    expect(cRefused.hostError?.outcome).toBe("refused-unverified");

    const bWins = succeed(cRefused, b, bPolicy);
    // The host really did turn C down, and that stays said; only the
    // uncertainty half expires. Falsification: return `null` for every
    // discharged notice in `hostErrorAfterDischarge` instead of downgrading
    // this one - the refusal disappears with no record the host refused
    // anything, which is the other direction's version of the dead retry.
    expect(bWins.unknownSave).toBeNull();
    expect(bWins.hostError?.outcome).toBe("refused-kept");
    expect(bWins.hostError?.message).toBe("policy is out of date");
  });

  it("R8: a reset's late failed read raises no staleness banner over a write confirmed after it", () => {
    // The reset is dispatched FIRST and its read-back is slow. Only Reset and
    // Restore are disabled while it runs, so everything below is reachable from
    // the panel exactly as written.
    const resetId = createFallbackSaveRequestId();
    const resetStarted = fallbackPolicyDraftReducer(seeded(), {
      type: "save-started",
      field: "danger",
      requestId: resetId,
      carries: "reset",
    });
    // B goes out after the reset and SUCCEEDS: it establishes the row, and the
    // controls are showing exactly what it stored.
    const b = createFallbackSaveRequestId();
    const bPolicy = policy({ enabled: true, graceWindowSeconds: 11 });
    const bWon = succeed(
      start(edit(resetStarted, bPolicy), b, "draft"),
      b,
      bPolicy,
    );
    expect(bWon.lastConfirmedRequestId).toBe(b);

    // Falsification: drop the `supersededByLaterWrite` guard from the
    // `reset-unrefreshed` arm. The banner then tells the user the values on
    // screen predate the reset, about a policy confirmed into them a moment ago.
    const late = resetUnrefreshed(bWon, resetId);
    expect(late.unrefreshedReset).toBeNull();
    // The reset is still SETTLED - what is dropped is the staleness claim, not
    // the request, which must not sit under the danger zone saving forever.
    expect(fallbackSaveInFlight(late)).toBe(false);
  });

  it("R9: a reset's failed read does not discharge a ticket belonging to a write dispatched AFTER it", () => {
    const resetId = createFallbackSaveRequestId();
    const resetStarted = fallbackPolicyDraftReducer(seeded(), {
      type: "save-started",
      field: "danger",
      requestId: resetId,
      carries: "reset",
    });
    // B is dispatched after the reset and loses its reply: a NEWER ticket, and
    // one this reset is no evidence about.
    const b = createFallbackSaveRequestId();
    const bUnknown = failUnknown(
      start(edit(resetStarted, policy({ enabled: true })), b, "draft"),
      b,
    );
    expect(bUnknown.unknownSave?.requestId).toBe(b);

    const late = resetUnrefreshed(bUnknown, resetId);
    // Admission evidence: the arm really ran - it raised the banner and settled
    // the reset. Without this, "the ticket survived" is satisfied by the arm
    // never having been reached.
    expect(late.unrefreshedReset).not.toBeNull();
    expect(fallbackSaveInFlight(late)).toBe(false);
    // Falsification: restore the unconditional `unknownSave: null` in the
    // `reset-unrefreshed` arm. B's obligation is voided by a reset that went out
    // before B existed, leaving the uncertainty notice on screen with nothing
    // behind its retry.
    expect(late.unknownSave?.requestId).toBe(b);
  });

  it("CONTROL: a reset's failed read DOES discharge an OLDER ticket, and does raise the banner", () => {
    // The positive control for both guards above: without it, a reducer that
    // never discharged and never raised would satisfy the two pins trivially.
    const a = createFallbackSaveRequestId();
    const aUnknown = failUnknown(
      start(edit(seeded(), policy({ enabled: true })), a, "draft"),
      a,
    );
    const afterReset = afterUnreadReset(aUnknown);
    expect(afterReset.unknownSave).toBeNull();
    expect(afterReset.unrefreshedReset).not.toBeNull();
  });

  it("R10: a failure judging an older draft does not erase the validation error belonging to what is on screen now", () => {
    const a = createFallbackSaveRequestId();
    const afterA = start(edit(seeded(), policy({ enabled: true })), a, "draft");
    const b = createFallbackSaveRequestId();
    const afterB = start(
      edit(afterA, policy({ enabled: true, graceWindowSeconds: 11 })),
      b,
      "draft",
    );
    // C is typed and is INVALID - a model row with no family name - so it stays
    // on screen wearing its own error, and NOTHING was sent for it.
    const invalid = edit(
      afterB,
      policy({
        enabled: true,
        graceWindowSeconds: 11,
        tierGroups: [tierGroup("fast", [candidate("")])],
      }),
    );
    expect(invalid.localError).toBe("A model needs a family name.");

    // A's reply is lost while C is on screen: the `unknown` branch.
    const aUnknown = failUnknown(invalid, a);
    // Admission evidence for each branch, because "the error was preserved" is
    // what a reply that was never admitted also produces.
    expect(aUnknown.unknownSave?.requestId).toBe(a);
    expect(aUnknown.localError).toBe(invalid.localError);
    // B is then refused while A's ticket stands: the outstanding-ticket branch.
    // Falsification: restore the unconditional `localError: null` in either
    // branch of `applySaveFailed`. C's error disappears while C is still in the
    // field, so an invalid draft renders with nothing beside it and reads as
    // accepted - by a reply that judged a draft the user cannot see.
    const bRefused = refuse(aUnknown, b);
    expect(bRefused.hostError?.outcome).toBe("refused-unverified");
    expect(bRefused.localError).toBe(invalid.localError);
  });

  it("preserves an already-set refusal marker against a refusal that judged an older draft", () => {
    // The cell R2d cannot reach: its marker starts null, so it cannot tell
    // "preserve what is there" from "write the older request's revision".
    const u = createFallbackSaveRequestId();
    const afterU = start(edit(seeded(), policy({ enabled: true })), u, "draft");
    const a = createFallbackSaveRequestId();
    const afterA = start(
      edit(afterU, policy({ enabled: true, graceWindowSeconds: 11 })),
      a,
      "draft",
    );
    const b = createFallbackSaveRequestId();
    const afterB = start(
      edit(afterA, policy({ enabled: true, graceWindowSeconds: 13 })),
      b,
      "draft",
    );
    // U's reply is lost, so every refusal below takes the outstanding-ticket
    // branch - the one arm that writes the marker without reverting.
    const uUnknown = failUnknown(afterB, u);
    // B carried what is on screen, so the marker is about the visible draft.
    const bRefused = refuse(uUnknown, b);
    expect(bRefused.refusedDraft?.revision).toBe(bRefused.revision);
    // The outstanding-ticket arm reverts NOTHING, so the refused value itself is
    // what the controls are showing - the distinction N1 added.
    expect(bRefused.refusedDraft?.restoredPersisted).toBe(false);

    // A was dispatched EARLIER and is refused later, still pending all along.
    // It judged a draft two edits old and is no evidence about this one.
    const aLate = refuse(bRefused, a);
    // Admission evidence: A was still pending and this settled it. Everything
    // below asserts a value that did NOT move, which is exactly what an
    // already-settled request would also produce.
    expect(fallbackSaveInFlight(bRefused)).toBe(true);
    expect(fallbackSaveInFlight(aLate)).toBe(false);
    // Falsification: write `pending.revision` into `refusedDraft.revision` in
    // that branch instead of preserving `state.refusedDraft`. The marker moves to
    // a revision nobody is looking at, `draftIsRefused` goes false, and the
    // read-back that could correct a refused screen stops adopting.
    expect(aLate.refusedDraft).toEqual(bRefused.refusedDraft);
    expect(aLate.refusedDraft?.revision).toBe(aLate.revision);
  });

  it("clears a set refusal marker the moment the user types again", () => {
    const a = createFallbackSaveRequestId();
    const refused = refuse(
      start(edit(seeded(), policy({ enabled: true })), a, "draft"),
      a,
    );
    expect(refused.refusedDraft?.revision).toBe(refused.revision);
    // Typing is what makes the marker untrue - the refused value is no longer
    // what the controls are showing.
    const typed = edit(
      refused,
      policy({ enabled: true, graceWindowSeconds: 11 }),
    );
    expect(typed.refusedDraft).toBeNull();
  });

  it("a successful CURRENT save clears the staleness banner and an older ticket together", () => {
    const withReset = afterUnreadReset(seeded());
    const a = createFallbackSaveRequestId();
    const aUnknown = failUnknown(
      start(edit(withReset, policy({ enabled: true })), a, "draft"),
      a,
    );
    const b = createFallbackSaveRequestId();
    const bPolicy = policy({ enabled: true, graceWindowSeconds: 11 });
    const bWon = succeed(
      start(edit(aUnknown, bPolicy), b, "draft"),
      b,
      bPolicy,
    );
    // Every commit sends the whole policy, so on the matching path the host now
    // holds exactly what is displayed - which is the one thing that makes the
    // staleness banner false. Falsification: drop `unrefreshedReset: null` from
    // the matching return in `applySaveSucceeded`.
    expect(bWon.draft).toEqual(bPolicy);
    expect(bWon.unknownSave).toBeNull();
    expect(bWon.hostError).toBeNull();
    expect(bWon.unrefreshedReset).toBeNull();
  });

  it("a read-back keeps a moved-on draft AND still clears the staleness banner", () => {
    const withReset = afterUnreadReset(seeded());
    const a = createFallbackSaveRequestId();
    const aUnknown = failUnknown(
      start(edit(withReset, policy({ enabled: true })), a, "draft"),
      a,
    );
    const movedOn = edit(
      aUnknown,
      policy({ enabled: true, graceWindowSeconds: 13 }),
    );
    const hostPolicy = policy({ enabled: true, graceWindowSeconds: 15 });
    const reconciled = fallbackPolicyDraftReducer(movedOn, {
      type: "reconciled",
      requestId: a,
      policy: hostPolicy,
    });
    // The user's newer draft stands - a read never yanks a control out from
    // under someone mid-edit - and the banner goes, because the load it said
    // had never happened has now happened. Falsification: move
    // `unrefreshedReset: null` off the shared `reconciled` object onto the
    // adopting return only; this moved-on path then keeps a banner whose own
    // words have just become false.
    expect(reconciled.draft.graceWindowSeconds).toBe(13);
    expect(reconciled.persisted).toEqual(hostPolicy);
    expect(reconciled.unrefreshedReset).toBeNull();
  });
});

describe("fallbackPolicyValuesEqual", () => {
  // The predicate that replaced `revision === persistedRevision`. Its edges are
  // worth their own cases because the panel now says "what's on screen is in
  // force" on its word alone.
  it("treats an absent and an empty `reasonOverrides` as the same settings", () => {
    // They render identically and the user cannot tell them apart, so a
    // difference here would print "haven't been saved yet" over a policy the
    // host is holding verbatim.
    const absent = policy({ enabled: true });
    const empty = { ...policy({ enabled: true }), reasonOverrides: {} };
    expect(absent.reasonOverrides).toBeUndefined();
    expect(fallbackPolicyValuesEqual(absent, empty)).toBe(true);
  });

  it("is sensitive to ladder ORDER, not just membership", () => {
    // Order is the whole meaning of the ladder, and a set comparison would call
    // a reordered policy already saved.
    expect(
      fallbackPolicyValuesEqual(
        policy({ ladder: ["profile", "tier", "wait", "notify"] }),
        policy({ ladder: ["tier", "profile", "wait", "notify"] }),
      ),
    ).toBe(false);
  });

  it("is sensitive to a single candidate field inside a tier group", () => {
    // The R10 counterexample in miniature: `sonnet` confirmed, `opus` on
    // screen, everything else identical.
    expect(
      fallbackPolicyValuesEqual(
        policy({ tierGroups: [tierGroup("fast", [candidate("sonnet")])] }),
        policy({ tierGroups: [tierGroup("fast", [candidate("opus")])] }),
      ),
    ).toBe(false);
    expect(
      fallbackPolicyValuesEqual(
        policy({ tierGroups: [tierGroup("fast", [candidate("sonnet")])] }),
        policy({ tierGroups: [tierGroup("fast", [candidate("sonnet")])] }),
      ),
    ).toBe(true);
  });
});

describe("fallbackPolicyDraftReducer - fifth pass: what the state lets the page CLAIM", () => {
  function seeded(): FallbackPolicyDraftState {
    return createFallbackPolicyDraftState(
      policy({ enabled: false, graceWindowSeconds: 15 }),
    );
  }

  function edit(
    state: FallbackPolicyDraftState,
    next: FallbackPolicy,
  ): FallbackPolicyDraftState {
    return fallbackPolicyDraftReducer(state, {
      type: "edited",
      policy: next,
      field: "enabled",
      keyedTierGroups: null,
    });
  }

  function start(
    state: FallbackPolicyDraftState,
    requestId: number,
    field: "enabled" | "danger",
    carries: FallbackSaveCarries,
  ): FallbackPolicyDraftState {
    return fallbackPolicyDraftReducer(state, {
      type: "save-started",
      field,
      requestId,
      carries,
    });
  }

  function succeed(
    state: FallbackPolicyDraftState,
    requestId: number,
    policyValue: FallbackPolicy,
  ): FallbackPolicyDraftState {
    return fallbackPolicyDraftReducer(state, {
      type: "save-succeeded",
      requestId,
      policy: policyValue,
    });
  }

  function failUnknown(
    state: FallbackPolicyDraftState,
    requestId: number,
  ): FallbackPolicyDraftState {
    return fallbackPolicyDraftReducer(state, {
      type: "save-failed",
      requestId,
      message: "lost the connection",
      field: "enabled",
      outcome: "unknown",
    });
  }

  function refuse(
    state: FallbackPolicyDraftState,
    requestId: number,
  ): FallbackPolicyDraftState {
    return fallbackPolicyDraftReducer(state, {
      type: "save-failed",
      requestId,
      message: "policy is out of date",
      field: "enabled",
      outcome: "refused",
    });
  }

  function resetUnrefreshed(
    state: FallbackPolicyDraftState,
    requestId: number,
  ): FallbackPolicyDraftState {
    return fallbackPolicyDraftReducer(state, {
      type: "reset-unrefreshed",
      requestId,
      message:
        "The reset went through, but we couldn't load what's on the host.",
    });
  }

  it("R8: the staleness banner dates itself to the reset's DISPATCH, so a save submitted during its read is not called pre-reset", () => {
    // The read-back is a round trip and this panel disables only Reset and
    // Restore while it runs, so this window is ordinary usage, not a race the
    // user has to contrive.
    const resetId = createFallbackSaveRequestId();
    const resetStarted = start(seeded(), resetId, "danger", "reset");
    const atDispatch = resetStarted.revision;

    // B is submitted through an ordinary control BEFORE the reset's read comes
    // back. Nothing else happens - no second edit is needed.
    const b = createFallbackSaveRequestId();
    const withB = start(
      edit(resetStarted, policy({ enabled: true })),
      b,
      "enabled",
      "draft",
    );
    expect(withB.revision).not.toBe(atDispatch);

    const late = resetUnrefreshed(withB, resetId);
    // Falsification: restore `revision: state.revision` in the
    // `reset-unrefreshed` arm. The captured revision is then B's, the panel's
    // `showingPreResetValues` compares equal, and the banner tells the user
    // that B - authored after the reset, and possibly already stored - is "the
    // settings you had before the reset".
    expect(late.unrefreshedReset?.revision).toBe(atDispatch);
    expect(late.unrefreshedReset?.revision).not.toBe(late.revision);
    // And it remembers WHICH reset, so a later confirmed write can be ordered
    // against it.
    expect(late.unrefreshedReset?.requestId).toBe(resetId);
  });

  it("CONTROL: with nothing submitted during the read, the captured revision IS the current one", () => {
    // Without this, a reducer that captured some revision no edit could ever
    // equal would satisfy the pin above and silently retire the strong
    // sentence altogether.
    const resetId = createFallbackSaveRequestId();
    const late = resetUnrefreshed(
      start(seeded(), resetId, "danger", "reset"),
      resetId,
    );
    expect(late.unrefreshedReset?.revision).toBe(late.revision);
  });

  it("R10: a moved-on read-back makes the revisions compare EQUAL over two different policies", () => {
    // Counterexample one for `revision === persistedRevision`. The watermark
    // says confirmed; the values say the draft was never sent.
    const a = createFallbackSaveRequestId();
    const afterA = start(
      edit(seeded(), policy({ enabled: true })),
      a,
      "enabled",
      "draft",
    );
    const b = createFallbackSaveRequestId();
    const afterB = start(
      edit(afterA, policy({ enabled: true, graceWindowSeconds: 11 })),
      b,
      "enabled",
      "draft",
    );
    // C is typed and never committed.
    const withC = edit(
      afterB,
      policy({
        enabled: true,
        graceWindowSeconds: 11,
        tierGroups: [tierGroup("fast", [candidate("opus")])],
      }),
    );
    const aUnknown = failUnknown(withC, a);
    // A's read-back returns the host's row, which holds `sonnet`.
    const hostPolicy = policy({
      enabled: true,
      graceWindowSeconds: 11,
      tierGroups: [tierGroup("fast", [candidate("sonnet")])],
    });
    const reconciled = fallbackPolicyDraftReducer(aUnknown, {
      type: "reconciled",
      requestId: a,
      policy: hostPolicy,
    });

    // The watermark now says "the draft is confirmed"...
    expect(reconciled.revision).toBe(reconciled.persistedRevision);
    // ...over a draft holding `opus`, which has never been sent, against a
    // confirmed policy holding `sonnet`. Falsification: put
    // `draftConfirmed: revision === persistedRevision` back in
    // `FallbackSaveStatus`; a subsequent older refusal then prints "what's on
    // screen is in force" over the unsent edit.
    expect(
      fallbackPolicyValuesEqual(reconciled.draft, reconciled.persisted),
    ).toBe(false);
    expect(reconciled.draft.tierGroups[0]?.candidates[0]?.modelFamily).toBe(
      "opus",
    );
  });

  it("R10: the correcting rollback makes the revisions DIFFER over one identical policy", () => {
    // Counterexample two, in the opposite direction: the watermark says
    // unsaved, the values are the confirmed policy itself.
    const a = createFallbackSaveRequestId();
    const afterA = start(
      edit(seeded(), policy({ enabled: true })),
      a,
      "enabled",
      "draft",
    );
    const b = createFallbackSaveRequestId();
    const bPolicy = policy({ enabled: true, graceWindowSeconds: 11 });
    const aUnknown = failUnknown(
      start(edit(afterA, bPolicy), b, "enabled", "draft"),
      a,
    );
    const c = createFallbackSaveRequestId();
    const cRefused = refuse(
      start(
        edit(aUnknown, policy({ enabled: true, graceWindowSeconds: 13 })),
        c,
        "enabled",
        "draft",
      ),
      c,
    );
    const bWins = succeed(cRefused, b, bPolicy);

    expect(bWins.hostError?.outcome).toBe("refused-kept");
    // The watermark says the display is not confirmed...
    expect(bWins.revision).not.toBe(bWins.persistedRevision);
    // ...while `draft` and `persisted` are both exactly B. Falsification: the
    // same one - the old watermark then prints "haven't been saved yet" over a
    // policy the host confirmed and this reducer put on screen itself.
    expect(fallbackPolicyValuesEqual(bWins.draft, bWins.persisted)).toBe(true);
    expect(bWins.draft).toEqual(bPolicy);
    // Note for the render: C was refused and B succeeded, and B is the EARLIER
    // request. Any wording here claiming "a later change was saved" is wrong on
    // this sequence, which is why the sentence no longer says it.
    expect(b).toBeLessThan(c);
  });

  it("D330: a moved-on read-back stamps `persistedRevision` but records NO confirmed revision, because nothing was dispatched", () => {
    // The evidence separation the dispatch classifier rests on. `reconciled`
    // writes `persistedRevision = state.revision` over a draft that was never
    // sent, so reading THAT as "the display was confirmed" reports an
    // uncommitted edit as saved. `confirmedViewRevision` is written only where
    // the DISPLAYED values are known to be the host's row, and this arm - the
    // moved-on one - is not such a place: the user has typed past the draft the
    // read answers, so nothing on screen was ever dispatched.
    //
    // The field was `lastConfirmedRevision` (the revision a confirmed REQUEST
    // carried) when this was written, and the seventh pass re-keyed it to the
    // view. This arm's account is unchanged under either: nothing here was
    // dispatched, so neither reading records anything.
    const a = createFallbackSaveRequestId();
    const afterA = start(
      edit(seeded(), policy({ enabled: true })),
      a,
      "enabled",
      "draft",
    );
    const withC = edit(
      afterA,
      policy({ enabled: true, graceWindowSeconds: 13 }),
    );
    const aUnknown = failUnknown(withC, a);
    const reconciled = fallbackPolicyDraftReducer(aUnknown, {
      type: "reconciled",
      requestId: a,
      policy: policy({ enabled: true, graceWindowSeconds: 15 }),
    });

    // The watermark says the current revision is "persisted"...
    expect(reconciled.persistedRevision).toBe(reconciled.revision);
    // ...and nothing on screen is the host's row. Falsification: derive the
    // panel's `confirmed` dispatch state from `persistedRevision` instead of
    // this field, or make `applyReconciled` record a confirmation on BOTH arms
    // rather than only the adopting one; an uncommitted draft is then described
    // as one the host has saved.
    expect(reconciled.confirmedViewRevision).toBeNull();
  });

  it("D330: a save that succeeds DOES record the revision it carried", () => {
    // The positive control for the pin above: without it, a reducer that never
    // set `confirmedViewRevision` at all would satisfy it trivially.
    const b = createFallbackSaveRequestId();
    const bPolicy = policy({ enabled: true, graceWindowSeconds: 11 });
    const started = start(edit(seeded(), bPolicy), b, "enabled", "draft");
    const won = succeed(started, b, bPolicy);
    expect(won.confirmedViewRevision).toBe(won.revision);
    expect(won.lastConfirmedRequestId).toBe(b);
  });

  it("D339: a reset does not raise the dispatch high-water mark, because it sends defaults and not the screen", () => {
    // The evidence behind "hasn't been sent", and the reason `save-started`
    // carries `carries` at all. A reset IS dispatched and it DOES write the
    // host, so counting it here is tempting - but it sends server-chosen
    // defaults, not the values in the controls, and the claim this field backs
    // is about those values. Counting it would put "what's on screen was sent"
    // over a display the reset never carried.
    //
    // Pinned here rather than through the rendered notice, for a reachability
    // reason that holds in the CONFIRMED-reset-with-failed-read scenario only:
    // there `applyEdited` clears `hostError`, so a moved-on `unknown` notice
    // exists only when the edit precedes the lost reply, and a reset dispatched
    // after that edit discharges the ticket the notice belongs to
    // (`applyResetUnrefreshed` drops a lower-id `unknownSave`).
    //
    // A reset whose own RPC is lost DOES render reset, unsent display and
    // notice together - the eighth pass pins that one through the panel. The
    // scope was missing from this note when it was written.
    const edited = edit(seeded(), policy({ enabled: true }));
    const afterReset = fallbackPolicyDraftReducer(edited, {
      type: "save-started",
      field: "danger",
      requestId: createFallbackSaveRequestId(),
      carries: "reset",
    });
    // Falsification: stamp `lastDispatchedRevision` on every `save-started`
    // rather than only on `carries: "draft"`. The mark rises to a revision no
    // draft was ever sent at, and the panel's final arm stops being able to
    // prove anything unsent.
    expect(afterReset.lastDispatchedRevision).toBeNull();

    // The positive control: without it, a reducer that never set the field at
    // all would satisfy the pin above trivially.
    const afterSave = fallbackPolicyDraftReducer(edited, {
      type: "save-started",
      field: "enabled",
      requestId: createFallbackSaveRequestId(),
      carries: "draft",
    });
    expect(afterSave.lastDispatchedRevision).toBe(afterSave.revision);
  });

  it("R8: a rollback restoring a policy confirmed AFTER the reset is not a pre-reset rollback", () => {
    // The state half of the composition; the sentence itself is pinned in the
    // panel. What matters here is that the evidence is present and orderable.
    const resetId = createFallbackSaveRequestId();
    const afterReset = resetUnrefreshed(
      start(seeded(), resetId, "danger", "reset"),
      resetId,
    );
    expect(afterReset.unrefreshedReset?.requestId).toBe(resetId);

    // B goes out after the reset and succeeds while the draft has moved on.
    const b = createFallbackSaveRequestId();
    const bPolicy = policy({ enabled: true, graceWindowSeconds: 11 });
    const afterB = start(edit(afterReset, bPolicy), b, "enabled", "draft");
    const c = createFallbackSaveRequestId();
    const withC = start(
      edit(afterB, policy({ enabled: true, graceWindowSeconds: 13 })),
      c,
      "enabled",
      "draft",
    );
    const bWon = succeed(withC, b, bPolicy);
    // S deliberately survives: the screen holds C, not the host's row.
    expect(bWon.unrefreshedReset).not.toBeNull();

    // C is then refused on its own revision, so the revert restores B.
    const cRefused = refuse(bWon, c);
    expect(cRefused.hostError?.outcome).toBe("refused-reverted");
    expect(cRefused.draft).toEqual(bPolicy);
    // The evidence the panel needs: the confirmed write outranks the reset, so
    // what was just put back is post-reset and IS in force.
    expect(cRefused.lastConfirmedRequestId).toBe(b);
    expect(cRefused.lastConfirmedRequestId).toBeGreaterThan(
      cRefused.unrefreshedReset?.requestId ?? Number.MAX_SAFE_INTEGER,
    );
  });
});

describe("fallbackPolicyDraftReducer - tenth pass: the obligation outlives the notice (N2)", () => {
  function seeded(): FallbackPolicyDraftState {
    return createFallbackPolicyDraftState(
      policy({ enabled: false, graceWindowSeconds: 15 }),
    );
  }

  function edit(
    state: FallbackPolicyDraftState,
    next: FallbackPolicy,
  ): FallbackPolicyDraftState {
    return fallbackPolicyDraftReducer(state, {
      type: "edited",
      policy: next,
      field: "enabled",
      keyedTierGroups: null,
    });
  }

  function start(
    state: FallbackPolicyDraftState,
    requestId: number,
    field: "enabled" | "danger",
    carries: FallbackSaveCarries,
  ): FallbackPolicyDraftState {
    return fallbackPolicyDraftReducer(state, {
      type: "save-started",
      field,
      requestId,
      carries,
    });
  }

  function succeed(
    state: FallbackPolicyDraftState,
    requestId: number,
    policyValue: FallbackPolicy,
  ): FallbackPolicyDraftState {
    return fallbackPolicyDraftReducer(state, {
      type: "save-succeeded",
      requestId,
      policy: policyValue,
    });
  }

  function failUnknown(
    state: FallbackPolicyDraftState,
    requestId: number,
  ): FallbackPolicyDraftState {
    return fallbackPolicyDraftReducer(state, {
      type: "save-failed",
      requestId,
      message: "lost the connection",
      field: "enabled",
      outcome: "unknown",
    });
  }

  function reconcile(
    state: FallbackPolicyDraftState,
    requestId: number,
    policyValue: FallbackPolicy,
  ): FallbackPolicyDraftState {
    return fallbackPolicyDraftReducer(state, {
      type: "reconciled",
      requestId,
      policy: policyValue,
    });
  }

  it("N2: a reset's lost reply invalidates display authority, and the NEXT failure replacing the ticket does not give it back", () => {
    // The ninth pass put this obligation on the ticket, which is a slot the
    // next failure overwrites. The rule was right and its carrier was wrong.
    //
    // R is dispatched first and its reply is the LAST thing to arrive, which is
    // ordinary: a reset is a round trip and every other control stays live.
    const r = createFallbackSaveRequestId();
    const resetPending = start(seeded(), r, "danger", "reset");

    const aPolicy = policy({ enabled: true, graceWindowSeconds: 15 });
    const a = createFallbackSaveRequestId();
    const aPending = start(edit(resetPending, aPolicy), a, "enabled", "draft");

    const bPolicy = policy({ enabled: true, graceWindowSeconds: 11 });
    const b = createFallbackSaveRequestId();
    const bPending = start(edit(aPending, bPolicy), b, "enabled", "draft");

    // B is confirmed, so the DISPLAY is the host's row at this revision.
    const bDone = succeed(bPending, b, bPolicy);
    expect(bDone.confirmedViewRevision).toBe(bDone.revision);
    expect(bDone.unverifiedHostRow).toBeNull();

    // R's own reply is lost. The host may already hold defaults, and nothing
    // has re-read the row.
    const rLost = failUnknown(bDone, r);
    expect(rLost.unverifiedHostRow).toBe("reset");

    // A's reply is lost too, and its ticket REPLACES R's. Before this pass the
    // authority flag was read off that ticket, so it went null here - the page
    // went straight back to "what this host has saved" with an unanswered reset
    // still outstanding.
    //
    // Falsification: in `applySaveFailed`'s `unknown` arm, write
    // `unverifiedHostRow: pending.carries` unconditionally (or drop the field
    // and read `unknownSave.carries` again). A draft's ticket then lowers an
    // obligation only a reset raised.
    const aLost = failUnknown(rLost, a);
    expect(aLost.unknownSave?.carries).toBe("draft");
    expect(aLost.unverifiedHostRow).toBe("reset");
    // Still the confirmed display - which is exactly why the flag matters: this
    // is the state whose sentence claims the host's row.
    expect(aLost.confirmedViewRevision).toBe(aLost.revision);
  });

  it("N2: only evidence about the ROW discharges the obligation - a read-back does, a confirmed draft save does not", () => {
    const r = createFallbackSaveRequestId();
    const rLost = failUnknown(start(seeded(), r, "danger", "reset"), r);
    expect(rLost.unverifiedHostRow).toBe("reset");

    // A draft save that succeeds AFTER the lost reset still says nothing about
    // the row: request ids order DISPATCH, not the order the host applied
    // things, so the reset can have landed after this save's echo was written.
    const cPolicy = policy({ enabled: true, graceWindowSeconds: 15 });
    const c = createFallbackSaveRequestId();
    const cDone = succeed(
      start(edit(rLost, cPolicy), c, "enabled", "draft"),
      c,
      cPolicy,
    );
    expect(cDone.unverifiedHostRow).toBe("reset");

    // The read-back is the row itself, so it discharges it. This is the
    // "eventual confirming recovery" half: the obligation is not permanent, it
    // is waiting for one specific kind of evidence.
    //
    // Falsification: drop `unverifiedHostRow: null` from `applyReconciled`'s
    // `reconciled` object. The panel then refuses to claim the host's row for
    // the rest of the editor's life, including immediately after reading it.
    const dPolicy = policy({ enabled: true, graceWindowSeconds: 9 });
    const d = createFallbackSaveRequestId();
    const dLost = failUnknown(
      start(edit(cDone, dPolicy), d, "enabled", "draft"),
      d,
    );
    expect(dLost.unverifiedHostRow).toBe("reset");
    const read = reconcile(dLost, d, dPolicy);
    expect(read.unverifiedHostRow).toBeNull();
  });

  it("N2: a confirmed NON-DRAFT reply discharges it, because that reply names the row", () => {
    const r = createFallbackSaveRequestId();
    const rLost = failUnknown(start(seeded(), r, "danger", "reset"), r);
    expect(rLost.unverifiedHostRow).toBe("reset");

    // A confirmed non-draft reply, and its echo IS the host's row.
    //
    // Tagged `restore`, not `reset`, which is the tenth close-out's correction:
    // production `resetAll` never dispatches `save-succeeded` at all. On
    // success it re-reads and the panel REMOUNTS; on a failed read it
    // dispatches `reset-unrefreshed`. RESTORE is the one non-draft operation
    // whose success reaches this arm, so tagging this `reset` tested a shape
    // nothing produces. The reset's own recovery is the remount, which arrives
    // as a fresh initial state - asserted by the first N2 pin.
    //
    // Falsification: gate the clear on `outranksPersisted` instead of on
    // `pending.carries`, or drop it. A user who restores to recover is told the
    // row is still unread while holding the reply that named it.
    const restoredPolicy = policy({ enabled: false, graceWindowSeconds: 15 });
    const restoreId = createFallbackSaveRequestId();
    const restoreDone = succeed(
      start(rLost, restoreId, "danger", "restore"),
      restoreId,
      restoredPolicy,
    );
    expect(restoreDone.unverifiedHostRow).toBeNull();
  });
});
