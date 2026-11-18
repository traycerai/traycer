/**
 * Per-`(epicId, artifactId)` cache of `threadAnchor` mark positions in the
 * Tiptap document. Written by the active tile body whenever the editor
 * transactions fire, read by the comment sidebar to (a) sort threads by
 * document order and (b) flag orphans whose anchor mark has been deleted.
 *
 * This split exists because the epic left panel mounts the comment surface but
 * does NOT own the editor - that lives in the tile canvas. A small Zustand
 * pipe is the cheapest way to bridge the two without prop-drilling through
 * the canvas tree, while keeping the `AnchorPositionMap` out of TanStack
 * Query (it's purely-derived UI state, not server state).
 *
 * Not persisted - pure ephemeral.
 */
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
      // Skip writes whose positions match the prior snapshot - the tile
      // body recomputes on every editor transaction, but most of those
      // don't touch any threadAnchor mark, so structural equality saves
      // every consumer a re-render. `Object.hasOwn` (vs an index check) is
      // needed because tsconfig leaves `noUncheckedIndexedAccess` off and
      // `Record<string, T>[key]` therefore narrows to `T` directly.
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
