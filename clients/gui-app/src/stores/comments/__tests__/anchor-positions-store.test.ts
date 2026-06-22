import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EMPTY_ANCHOR_POSITION_MAP,
  useAnchorPositionsStore,
} from "@/stores/comments/anchor-positions-store";
import type { AnchorPositionMap } from "@/lib/comments/comment-filter-utils";

function resetStore(): void {
  useAnchorPositionsStore.setState({ mapByKey: {} });
}

function makeMap(
  entries: ReadonlyArray<readonly [string, number]>,
): AnchorPositionMap {
  return { positions: new Map(entries) };
}

describe("useAnchorPositionsStore", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  it("defaults to EMPTY_ANCHOR_POSITION_MAP for unknown keys", () => {
    const empty = useAnchorPositionsStore.getState().mapByKey["epic-a::art-1"];
    expect(empty).toBeUndefined();
    expect(EMPTY_ANCHOR_POSITION_MAP.positions.size).toBe(0);
  });

  it("stores positions per (epicId, artifactId)", () => {
    const positions = makeMap([
      ["t1", 12],
      ["t2", 40],
    ]);
    useAnchorPositionsStore
      .getState()
      .setForArtifact("epic-a", "art-1", positions);
    const stored = useAnchorPositionsStore.getState().mapByKey["epic-a::art-1"];
    expect(stored.positions.get("t1")).toBe(12);
    expect(stored.positions.get("t2")).toBe(40);
  });

  it("dedupes structurally-equal writes (same map identity reference)", () => {
    const positions = makeMap([["t1", 5]]);
    useAnchorPositionsStore
      .getState()
      .setForArtifact("epic-a", "art-1", positions);
    const beforeSlice = useAnchorPositionsStore.getState().mapByKey;
    useAnchorPositionsStore
      .getState()
      .setForArtifact("epic-a", "art-1", makeMap([["t1", 5]]));
    expect(useAnchorPositionsStore.getState().mapByKey).toBe(beforeSlice);
  });

  it("commits writes that change a thread's position", () => {
    useAnchorPositionsStore
      .getState()
      .setForArtifact("epic-a", "art-1", makeMap([["t1", 5]]));
    useAnchorPositionsStore
      .getState()
      .setForArtifact("epic-a", "art-1", makeMap([["t1", 9]]));
    expect(
      useAnchorPositionsStore
        .getState()
        .mapByKey["epic-a::art-1"].positions.get("t1"),
    ).toBe(9);
  });

  it("clearForArtifact removes the entry only for the matching key", () => {
    useAnchorPositionsStore
      .getState()
      .setForArtifact("epic-a", "art-1", makeMap([["t1", 5]]));
    useAnchorPositionsStore
      .getState()
      .setForArtifact("epic-a", "art-2", makeMap([["t2", 8]]));

    useAnchorPositionsStore.getState().clearForArtifact("epic-a", "art-1");
    expect(
      useAnchorPositionsStore.getState().mapByKey["epic-a::art-1"],
    ).toBeUndefined();
    expect(
      useAnchorPositionsStore
        .getState()
        .mapByKey["epic-a::art-2"].positions.get("t2"),
    ).toBe(8);
  });

  it("clearForArtifact on a missing key is a no-op", () => {
    const beforeSlice = useAnchorPositionsStore.getState().mapByKey;
    useAnchorPositionsStore.getState().clearForArtifact("epic-a", "missing");
    expect(useAnchorPositionsStore.getState().mapByKey).toBe(beforeSlice);
  });
});
