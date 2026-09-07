/** Per-`(epicId, artifactId)` cache of `threadAnchor` mark positions in the Tiptap document. */
import { create } from "zustand";
import type { AnchorPositionMap } from "@/lib/comments/comment-filter-utils";

export const EMPTY_ANCHOR_POSITION_MAP: AnchorPositionMap = {
  positions: new Map(),
};

function compositeKey(epicId: string, artifactId: string): string {
  return `${epicId}::${artifactId}`;
}

interface AnchorPositionsStore {
  readonly mapByKey: Readonly<Record<string, AnchorPositionMap>>;
  readonly setForArtifact: (
    epicId: string,
    artifactId: string,
    positions: AnchorPositionMap,
  ) => void;
  readonly clearForArtifact: (epicId: string, artifactId: string) => void;
}

export const useAnchorPositionsStore = create<AnchorPositionsStore>((set) => ({
  mapByKey: {},

  setForArtifact: (epicId, artifactId, positions) => {
    set((state) => {
      const key = compositeKey(epicId, artifactId);
      // Skip writes whose positions match the prior snapshot - the tile body recomputes on every editor
      // transaction, but most of those don't touch any threadAnchor mark, so structural equality saves
      if (
        Object.hasOwn(state.mapByKey, key) &&
        positionsEqual(state.mapByKey[key], positions)
      ) {
        return {};
      }
      return { mapByKey: { ...state.mapByKey, [key]: positions } };
    });
  },

  clearForArtifact: (epicId, artifactId) => {
    set((state) => {
      const key = compositeKey(epicId, artifactId);
      if (!Object.hasOwn(state.mapByKey, key)) return {};
      const next = { ...state.mapByKey };
      delete next[key];
      return { mapByKey: next };
    });
  },
}));

export function useArtifactAnchorPositions(
  epicId: string,
  artifactId: string,
): AnchorPositionMap {
  return useAnchorPositionsStore(
    (s) =>
      s.mapByKey[compositeKey(epicId, artifactId)] ?? EMPTY_ANCHOR_POSITION_MAP,
  );
}

function positionsEqual(a: AnchorPositionMap, b: AnchorPositionMap): boolean {
  if (a.positions === b.positions) return true;
  if (a.positions.size !== b.positions.size) return false;
  for (const [threadId, pos] of a.positions) {
    if (b.positions.get(threadId) !== pos) return false;
  }
  return true;
}
