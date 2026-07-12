import { create } from "zustand";
import type { LandingDraftWorkspaceSnapshot } from "@/stores/home/landing-draft-store";
import {
  worktreeStagingKeyString,
  type WorktreeStagingKey,
} from "./worktree-intent-staging-store";

/**
 * The LIVE seeded-workspace snapshot (folders + primaryPath) for a
 * not-yet-created seeded picker (chat fork, terminal-agent fork, the
 * terminal-agent launcher) - mirrors `useHomeWorkspaceSource`'s
 * component-local `seededWorkspaceState` into an externally-readable slot,
 * keyed by the SAME `WorktreeStagingKey` the staged intent uses.
 *
 * The picker's `workspaceSeed` prop is a static snapshot from when the
 * dialog opened; edits (add/remove/"Make primary") only ever updated that
 * component-local state, invisible to the dialog's own submit handler -
 * which read `readStagedWorktreeIntent(stagingKey) ?? props.workspaceSeed`
 * directly, missing any edit to a folder that never got a STAGED intent
 * entry (a non-git folder, never auto-seeded). Reading this snapshot at
 * submit closes that gap without ever writing a synthetic staged entry
 * merely to carry the primary flag.
 *
 * Transient (never persisted) - matches the staging store's own scratch
 * slots for these same keys (see `isTransientStagingOwnerId`).
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
