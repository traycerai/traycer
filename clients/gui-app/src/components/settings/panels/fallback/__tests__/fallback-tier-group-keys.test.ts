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
    const inverse: FallbackGroupsInverse = {
      kind: "group",
      group: removedGroup,
      index: 1,
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
    const inverse: FallbackGroupsInverse = {
      kind: "group",
      group: removedGroup,
      // Wildly past the end - the list this index was captured against no
      // longer exists in that shape.
      index: 99,
    };
    const next = applyGroupsInverse(current, inverse);
    expect(next.map((group) => group.draftKey)).toEqual(["g1", "g2"]);
  });

  it("is a no-op (SAME reference) when the group is already present - Undo pressed twice", () => {
    const already: readonly KeyedGroup[] = [
      { draftKey: "g1", id: "fast", candidates: [] },
    ];
    const inverse: FallbackGroupsInverse = {
      kind: "group",
      group: already[0],
      index: 0,
    };
    expect(applyGroupsInverse(already, inverse)).toBe(already);
  });

  it("is a no-op (SAME reference) when the candidate's own group has since been deleted", () => {
    const current: readonly KeyedGroup[] = [
      { draftKey: "g1", id: "fast", candidates: [] },
    ];
    const inverse: FallbackGroupsInverse = {
      kind: "candidate",
      groupDraftKey: "gone",
      candidate: { key: "c1", value: candidate("opus") },
      index: 0,
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
    const inverse: FallbackGroupsInverse = {
      kind: "candidate",
      groupDraftKey: "g1",
      candidate: removedCandidate,
      index: 50,
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
    const inverse: FallbackGroupsInverse = {
      kind: "candidate",
      groupDraftKey: "g1",
      candidate: current[0].candidates[0],
      index: 0,
    };
    expect(applyGroupsInverse(current, inverse)).toBe(current);
  });
});
