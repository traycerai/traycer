import { create } from "zustand";
import type { LandingDraftWorkspaceSnapshot } from "@/stores/home/landing-draft-store";
import {
  worktreeStagingKeyString,
  type WorktreeStagingKey,
} from "./worktree-intent-staging-store";

/**
 * The LIVE seeded-workspace snapshot (folders + primaryPath) for a not-yet-created seeded picker
 * (chat fork, terminal-agent fork, the terminal-agent launcher) - mirrors
 */
interface SeededWorkspaceSnapshotStore {
  readonly snapshotByKey: Readonly<
    Record<string, LandingDraftWorkspaceSnapshot | undefined>
  >;
  readonly setSnapshot: (
    key: WorktreeStagingKey,
    snapshot: LandingDraftWorkspaceSnapshot,
  ) => void;
  readonly clear: (key: WorktreeStagingKey) => void;
  readonly resetForTests: () => void;
}

export const useSeededWorkspaceSnapshotStore =
  create<SeededWorkspaceSnapshotStore>()((set) => ({
    snapshotByKey: {},
    setSnapshot: (key, snapshot) =>
      set((state) => ({
        snapshotByKey: {
          ...state.snapshotByKey,
          [worktreeStagingKeyString(key)]: snapshot,
        },
      })),
    clear: (key) =>
      set((state) => {
        const id = worktreeStagingKeyString(key);
        if (!(id in state.snapshotByKey)) return state;
        const next = { ...state.snapshotByKey };
        delete next[id];
        return { snapshotByKey: next };
      }),
    resetForTests: () => set({ snapshotByKey: {} }),
  }));

/** The serialized staging keys this store currently holds a snapshot for. */
export function seededWorkspaceSnapshotKeyIds(): readonly string[] {
  return Object.keys(useSeededWorkspaceSnapshotStore.getState().snapshotByKey);
}

/** Non-hook read for imperative (submit-time) callers. */
export function readSeededWorkspaceSnapshot(
  key: WorktreeStagingKey,
): LandingDraftWorkspaceSnapshot | null {
  return (
    useSeededWorkspaceSnapshotStore.getState().snapshotByKey[
      worktreeStagingKeyString(key)
    ] ?? null
  );
}
