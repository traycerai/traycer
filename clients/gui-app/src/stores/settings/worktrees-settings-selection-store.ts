import { create } from "zustand";

export const EMPTY_SELECTED_WORKTREE_PATHS: ReadonlySet<string> = new Set();

export type SelectedWorktreePathsUpdate =
  | ReadonlySet<string>
  | ((selectedPaths: ReadonlySet<string>) => ReadonlySet<string>);

interface WorktreesSettingsSelectionStoreState {
  readonly selectedPathsByHost: ReadonlyMap<string, ReadonlySet<string>>;
  readonly setSelectedPaths: (
    hostId: string,
    update: SelectedWorktreePathsUpdate,
  ) => void;
}

/**
 * Session-only Worktrees settings selection. This survives the panel being
 * unmounted while the user visits another Settings section or closes and
 * reopens Settings, but deliberately is not persisted across app restarts.
 * Selections are host-scoped so changing the managed host cannot leak paths
 * into another host's list.
 */
export const useWorktreesSettingsSelectionStore =
  create<WorktreesSettingsSelectionStoreState>()((set, get) => ({
    selectedPathsByHost: new Map(),
    setSelectedPaths: (hostId, update) => {
      const current =
        get().selectedPathsByHost.get(hostId) ?? EMPTY_SELECTED_WORKTREE_PATHS;
      const next = typeof update === "function" ? update(current) : update;
      if (next === current) return;

      const selectedPathsByHost = new Map(get().selectedPathsByHost);
      if (next.size === 0) selectedPathsByHost.delete(hostId);
      else selectedPathsByHost.set(hostId, next);
      set({ selectedPathsByHost });
    },
  }));
