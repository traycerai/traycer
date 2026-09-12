import { describe, expect, it } from "vitest";
import { createDefaultFallbackPolicy } from "@traycer/protocol/host/fallback-policy";
import type {
  TierCandidate,
  TierGroup,
} from "@traycer/protocol/host/fallback-policy";
import {
  applyGroupsInverse,
  keyedCandidate,
  keyedGroup,
  moveKeyedCandidate,
  revertKeyedGroups,
  tierGroupIdentityGeneration,
  toKeyedGroups,
  toWireGroups,
  withTierGroups,
  type FallbackGroupsInverse,
  type KeyedCandidate,
  type KeyedGroup,
} from "@/components/settings/panels/fallback/fallback-tier-group-keys";

function candidate(modelFamily: string): TierCandidate {
  return { harnessId: "claude", modelFamily, reasoningEffort: null };
}

function tierGroup(
  id: string,
  candidates: readonly TierCandidate[],
): TierGroup {
  return { id, candidates: [...candidates] };
}

describe("toKeyedGroups / toWireGroups round trip", () => {
  it("projects back to exactly the input groups", () => {
    const groups: readonly TierGroup[] = [
      tierGroup("fast", [candidate("opus"), candidate("sonnet")]),
      tierGroup("cheap", [candidate("haiku")]),
    ];
    expect(toWireGroups(toKeyedGroups(groups))).toEqual(groups);
  });

  it("never lets the candidate identity reach the projected wire objects", () => {
    const groups: readonly TierGroup[] = [
      tierGroup("fast", [candidate("opus")]),
    ];
    const wire = toWireGroups(toKeyedGroups(groups));
    // Checked on the candidate objects themselves, not on a JSON round-trip
    // (which would hide a `key` property behind `undefined` serialising away
    // and pass even if `toWireGroups` forgot to strip it).
    for (const group of wire) {
      for (const candidateRow of group.candidates) {
        expect(Object.hasOwn(candidateRow, "key")).toBe(false);
      }
    }
  });

  it("never lets the group's draftKey reach the projected wire objects (F16)", () => {
    const groups: readonly TierGroup[] = [
      tierGroup("fast", [candidate("opus")]),
    ];
    const wire = toWireGroups(toKeyedGroups(groups));
    // Falsification: have `toWireGroups` spread `group` instead of picking
    // `id`/`candidates` explicitly (`fallback-tier-group-keys.ts`) - this
    // would then find `draftKey` on the wire object.
    for (const group of wire) {
      expect(Object.hasOwn(group, "draftKey")).toBe(false);
    }
  });

  it("F16: toKeyedGroups mints DISTINCT draftKeys for two groups", () => {
    const groups: readonly TierGroup[] = [
      tierGroup("fast", []),
      tierGroup("cheap", []),
    ];
    const [first, second] = toKeyedGroups(groups);
    expect(first.draftKey).not.toBe(second.draftKey);
  });
});

describe("keyedGroup", () => {
  it("mints a fresh draftKey and keys every candidate row", () => {
    const group = keyedGroup(tierGroup("fast", [candidate("opus")]));
    expect(group.draftKey.length).toBeGreaterThan(0);
    expect(group.candidates[0].key.length).toBeGreaterThan(0);
    expect(group.id).toBe("fast");
  });
});

describe("withTierGroups", () => {
  it("replaces tierGroups on the policy and nothing else", () => {
    const base = { ...createDefaultFallbackPolicy(), enabled: true };
    const groups = toKeyedGroups([tierGroup("fast", [candidate("opus")])]);
    const next = withTierGroups(base, groups);
    expect(next.enabled).toBe(true);
    expect(next.tierGroups).toEqual([tierGroup("fast", [candidate("opus")])]);
  });
});

describe("moveKeyedCandidate", () => {
  it("carries each row's key together with its value", () => {
    const rows: readonly KeyedCandidate[] = [
      { key: "k1", value: candidate("opus") },
      { key: "k2", value: candidate("sonnet") },
      { key: "k3", value: candidate("haiku") },
    ];
    const next = moveKeyedCandidate(rows, 0, 2);
    expect(next.map((row) => row.key)).toEqual(["k2", "k3", "k1"]);
    expect(next.map((row) => row.value.modelFamily)).toEqual([
      "sonnet",
      "haiku",
      "opus",
    ]);
  });

  it("returns the SAME array reference on a same-index move", () => {
    const rows: readonly KeyedCandidate[] = [
      { key: "k1", value: candidate("opus") },
    ];
    expect(moveKeyedCandidate(rows, 0, 0)).toBe(rows);
  });

  it("returns the SAME array reference on an out-of-range move rather than throwing or truncating", () => {
    const rows: readonly KeyedCandidate[] = [
      { key: "k1", value: candidate("opus") },
      { key: "k2", value: candidate("sonnet") },
    ];
    expect(moveKeyedCandidate(rows, 0, 99)).toBe(rows);
    expect(moveKeyedCandidate(rows, -1, 1)).toBe(rows);
  });
});

describe("keyedCandidate", () => {
  it("mints a fresh key on every call, even for identical values", () => {
    const value = candidate("opus");
    const first = keyedCandidate(value);
    const second = keyedCandidate(value);
    expect(first.key).not.toBe(second.key);
    expect(first.value).toEqual(second.value);
  });
});

describe("revertKeyedGroups (F24) - the function's own table", () => {
  it("shape-equal: keeps every key, restores the incoming VALUE", () => {
    const existing: readonly KeyedGroup[] = [
      {
        draftKey: "g1",
        id: "fast",
        candidates: [{ key: "c1", value: candidate("sonnet") }],
      },
    ];
    const restored: readonly TierGroup[] = [
      tierGroup("fast", [candidate("opus")]),
    ];
    const next = revertKeyedGroups(existing, restored);
    expect(next[0].draftKey).toBe("g1");
    expect(next[0].candidates[0].key).toBe("c1");
    expect(next[0].candidates[0].value.modelFamily).toBe("opus");
  });

  it("shape-equal AND value-equal: returns the SAME reference, no re-render", () => {
    const existing: readonly KeyedGroup[] = [
      {
        draftKey: "g1",
        id: "fast",
        candidates: [{ key: "c1", value: candidate("opus") }],
      },
    ];
    const unchanged: readonly TierGroup[] = [
      tierGroup("fast", [candidate("opus")]),
    ];
    // Falsification: delete the `keyedGroupsMatch(existing, groups)` early
    // return in `revertKeyedGroups` - this would then rebuild the array
    // (a NEW reference with equal-looking content) even when nothing changed.
    expect(revertKeyedGroups(existing, unchanged)).toBe(existing);
  });

  it("shape-different (a row was added): mints an entirely fresh list", () => {
    const existing: readonly KeyedGroup[] = [
      {
        draftKey: "g1",
        id: "fast",
        candidates: [{ key: "c1", value: candidate("opus") }],
      },
    ];
    const grown: readonly TierGroup[] = [
      tierGroup("fast", [candidate("opus"), candidate("sonnet")]),
    ];
    const next = revertKeyedGroups(existing, grown);
    expect(next).not.toBe(existing);
    expect(next[0].draftKey).not.toBe("g1");
    expect(next[0].candidates[0].key).not.toBe("c1");
    expect(next[0].candidates).toHaveLength(2);
  });

  it("shape-different (a group was removed): mints fresh identities for the survivor too", () => {
    const existing: readonly KeyedGroup[] = [
      { draftKey: "g1", id: "fast", candidates: [] },
      { draftKey: "g2", id: "cheap", candidates: [] },
    ];
    const shrunk: readonly TierGroup[] = [tierGroup("fast", [])];
    const next = revertKeyedGroups(existing, shrunk);
    expect(next).toHaveLength(1);
    expect(next[0].draftKey).not.toBe("g1");
  });
});

describe("applyGroupsInverse (F18) - the function's own table", () => {
  it("refuses an inverse minted before the identities were re-seeded, even when nothing else about it matches", () => {
    // The six cells below all stamp `generation: tierGroupIdentityGeneration()`
    // AT THE MOMENT the inverse is built, over a hand-written `current` array
    // that never itself goes through `toKeyedGroups` - so none of them can
    // ever observe the guard refuse anything: the stamp always agrees with
    // whatever `identityGeneration` already is. This cell is the one that
    // forces a REAL re-seed between the stamp and the apply, which is the only
    // way to see the guard actually fire.
    const hydrated = toKeyedGroups([tierGroup("cheap", [])]);
    const stale = tierGroupIdentityGeneration();
    // The re-seed: hydrating again bumps `identityGeneration`, exactly as a
    // revert whose shape changed would.
    const current = toKeyedGroups([tierGroup("fast", [])]);
    expect(tierGroupIdentityGeneration()).not.toBe(stale);

    // An inverse minted against the PRE-re-seed list, naming a group that
    // matches nothing in `current` by id OR by draftKey.
    const inverse: FallbackGroupsInverse = {
      kind: "group",
      group: hydrated[0],
      index: 0,
      generation: stale,
      // Compile-fix site only - this cell is about the generation guard, not
      // about the default marker, so a semantically neutral value is fine.
      wasDefault: false,
    };
    // Falsification: delete the `if (inverse.generation !== identityGeneration)
    // return groups;` guard at the top of `applyGroupsInverse`. Neither the
    // `draftKey` nor the `id` check below it can catch this case - "cheap"
    // matches nothing in `current` - so the stale inverse would insert.
    expect(applyGroupsInverse(current, inverse)).toBe(current);

    // Positive control: the identical inverse, restamped with the CURRENT
    // generation, does insert - proving the cell above is a refusal and not
    // `applyGroupsInverse` being broken to always return its input.
    const fresh: FallbackGroupsInverse = {
      ...inverse,
      generation: tierGroupIdentityGeneration(),
    };
    const inserted = applyGroupsInverse(current, fresh);
    expect(inserted).not.toBe(current);
    expect(inserted.map((group) => group.id)).toEqual(["cheap", "fast"]);
  });

  it("re-inserts a group at its index into a list that has CHANGED since the removal", () => {
    const removedGroup: KeyedGroup = {
      draftKey: "g2",
      id: "cheap",
      candidates: [],
    };
    // The list has grown a new group in the meantime - inserting must not
    // clobber it or assume the list is exactly what it was at removal time.
    const current: readonly KeyedGroup[] = [
      { draftKey: "g1", id: "fast", candidates: [] },
      { draftKey: "g3", id: "new", candidates: [] },
    ];
    const generation = tierGroupIdentityGeneration();
    const inverse: FallbackGroupsInverse = {
      kind: "group",
      group: removedGroup,
      index: 1,
      generation,
      // Compile-fix site only - this cell is about re-insertion into a
      // changed list, not about the default marker.
      wasDefault: false,
    };
    const next = applyGroupsInverse(current, inverse);
    expect(next.map((group) => group.draftKey)).toEqual(["g1", "g2", "g3"]);
  });

  it("clamps an index past the end of the (shrunk) list rather than producing a sparse array", () => {
    const removedGroup: KeyedGroup = {
      draftKey: "g2",
      id: "cheap",
      candidates: [],
    };
    const current: readonly KeyedGroup[] = [
      { draftKey: "g1", id: "fast", candidates: [] },
    ];
    const generation = tierGroupIdentityGeneration();
    const inverse: FallbackGroupsInverse = {
      kind: "group",
      group: removedGroup,
      // Wildly past the end - the list this index was captured against no
      // longer exists in that shape.
      index: 99,
      generation,
      // Compile-fix site only - this cell is about index clamping, not about
      // the default marker.
      wasDefault: false,
    };
    const next = applyGroupsInverse(current, inverse);
    expect(next.map((group) => group.draftKey)).toEqual(["g1", "g2"]);
  });

  it("is a no-op (SAME reference) when the group is already present - Undo pressed twice", () => {
    const already: readonly KeyedGroup[] = [
      { draftKey: "g1", id: "fast", candidates: [] },
    ];
    const generation = tierGroupIdentityGeneration();
    const inverse: FallbackGroupsInverse = {
      kind: "group",
      group: already[0],
      index: 0,
      generation,
      // Compile-fix site only - this cell is about the already-present no-op,
      // not about the default marker.
      wasDefault: false,
    };
    expect(applyGroupsInverse(already, inverse)).toBe(already);
  });

  it("is a no-op (SAME reference) when the candidate's own group has since been deleted", () => {
    const current: readonly KeyedGroup[] = [
      { draftKey: "g1", id: "fast", candidates: [] },
    ];
    const generation = tierGroupIdentityGeneration();
    const inverse: FallbackGroupsInverse = {
      kind: "candidate",
      groupDraftKey: "gone",
      candidate: { key: "c1", value: candidate("opus") },
      index: 0,
      generation,
    };
    expect(applyGroupsInverse(current, inverse)).toBe(current);
  });

  it("re-inserts a candidate at its index within its group, clamped to the group's current length", () => {
    const current: readonly KeyedGroup[] = [
      {
        draftKey: "g1",
        id: "fast",
        candidates: [{ key: "c1", value: candidate("opus") }],
      },
    ];
    const removedCandidate: KeyedCandidate = {
      key: "c2",
      value: candidate("sonnet"),
    };
    const generation = tierGroupIdentityGeneration();
    const inverse: FallbackGroupsInverse = {
      kind: "candidate",
      groupDraftKey: "g1",
      candidate: removedCandidate,
      index: 50,
      generation,
    };
    const next = applyGroupsInverse(current, inverse);
    expect(next[0].candidates.map((row) => row.key)).toEqual(["c1", "c2"]);
  });

  it("is a no-op (SAME reference) when the candidate is already present in its group", () => {
    const current: readonly KeyedGroup[] = [
      {
        draftKey: "g1",
        id: "fast",
        candidates: [{ key: "c1", value: candidate("opus") }],
      },
    ];
    const generation = tierGroupIdentityGeneration();
    const inverse: FallbackGroupsInverse = {
      kind: "candidate",
      groupDraftKey: "g1",
      candidate: current[0].candidates[0],
      index: 0,
      generation,
    };
    expect(applyGroupsInverse(current, inverse)).toBe(current);
  });
});

describe("P2: the generation guard is NARROW - it refuses only across a re-seed, not across any revert", () => {
  it("a rejected FAMILY EDIT (same shape, value differs) does not bump the generation, so a pending candidate-removal Undo still applies", () => {
    // Hydrate two groups, "fast" with two candidates.
    const hydrated = toKeyedGroups([
      tierGroup("fast", [candidate("opus"), candidate("sonnet")]),
      tierGroup("cheap", [candidate("haiku")]),
    ]);
    const [fast, cheap] = hydrated;
    const removedCandidate = fast.candidates[1];
    const generation = tierGroupIdentityGeneration();

    // The user deletes "sonnet" (candidate index 1 of "fast"). The toast's
    // inverse is stamped with the CURRENT generation, exactly as the
    // production removal handler does.
    const afterRemoval: readonly KeyedGroup[] = [
      { ...fast, candidates: fast.candidates.slice(0, 1) },
      cheap,
    ];
    const inverse: FallbackGroupsInverse = {
      kind: "candidate",
      groupDraftKey: fast.draftKey,
      candidate: removedCandidate,
      index: 1,
      generation,
    };

    // Before the Undo is pressed, a DIFFERENT edit is refused by the host: a
    // rejected family-name change on the surviving candidate. The revert
    // restores the pre-edit VALUE through `revertKeyedGroups`, which is
    // SHAPE-preserving (same group count, same candidate counts per group) -
    // exactly the case that must NOT re-seed.
    const rejectedEditWireGroups = [
      { id: "fast", candidates: [candidate("claude-opus")] },
      { id: "cheap", candidates: [candidate("haiku")] },
    ];
    const reverted = revertKeyedGroups(afterRemoval, rejectedEditWireGroups);
    // Admission evidence: the revert really is the shape-preserving path -
    // keys survive it - which is what the falsifier below would break.
    expect(reverted[0].draftKey).toBe(fast.draftKey);
    expect(reverted[0].candidates[0].key).toBe(fast.candidates[0].key);
    expect(tierGroupIdentityGeneration()).toBe(generation);

    // Falsification: make `revertKeyedGroups` re-seed on every call (drop
    // its `sameGroupShape` early-return and always take the
    // `toKeyedGroups(groups)` branch). The generation above would then have
    // moved, and the Undo below would silently no-op instead of restoring
    // "sonnet".
    const undone = applyGroupsInverse(reverted, inverse);
    expect(undone[0].candidates.map((row) => row.value.modelFamily)).toEqual([
      "claude-opus",
      "sonnet",
    ]);
  });
});
