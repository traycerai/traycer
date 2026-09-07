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

/** Session-only Worktrees settings selection. */
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
