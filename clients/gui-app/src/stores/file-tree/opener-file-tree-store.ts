import { create } from "zustand";
import { isWithinDirectory } from "@/lib/workspace/workspace-file-list-tree";

interface OpenerFileTreeState {
  readonly expandedPathsByTree: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly toggle: (treeId: string, directoryPath: string) => void;
  readonly prune: (
    treeId: string,
    directoryPaths: ReadonlyArray<string>,
  ) => void;
}

const EMPTY_EXPANDED_PATHS: ReadonlyArray<string> = Object.freeze([]);

export const useOpenerFileTreeStore = create<OpenerFileTreeState>()((set) => ({
  expandedPathsByTree: {},
  toggle: (treeId, directoryPath) => {
    set((state) => {
      const current = state.expandedPathsByTree[treeId] ?? [];
      const next = current.includes(directoryPath)
        ? current.filter((path) => path !== directoryPath)
        : [...current, directoryPath];
      return {
        expandedPathsByTree: {
          ...state.expandedPathsByTree,
          [treeId]: next,
        },
      };
    });
  },
  prune: (treeId, directoryPaths) => {
    if (directoryPaths.length === 0) return;
    set((state) => {
      const current = state.expandedPathsByTree[treeId] ?? [];
      return {
        expandedPathsByTree: {
          ...state.expandedPathsByTree,
          [treeId]: current.filter(
            (path) =>
              !directoryPaths.some((directoryPath) =>
                isWithinDirectory(path, directoryPath),
              ),
          ),
        },
      };
    });
  },
}));

export function useOpenerFileTreeExpandedPaths(
  treeId: string,
): ReadonlyArray<string> {
  return useOpenerFileTreeStore(
    (state) => state.expandedPathsByTree[treeId] ?? EMPTY_EXPANDED_PATHS,
  );
}
