import { describe, expect, it } from "vitest";
import type {
  TierCandidate,
  TierGroup,
} from "@traycer/protocol/host/fallback-policy";
import {
  keyedCandidate,
  moveKeyedCandidate,
  toKeyedGroups,
  toWireGroups,
  type KeyedCandidate,
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

  it("never lets the identity reach the projected wire objects", () => {
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
