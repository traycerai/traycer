/** Standalone zustand store for the file-tree panel. */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import { isWithinDirectory } from "@/lib/workspace/workspace-file-list-tree";

const PERSIST_KEY = persistKey(STORE_KEYS.fileTree);

/** Unambiguous separator for the expansion scope key parts. */
const SCOPE_KEY_SEPARATOR = "\u0000";

const EMPTY_EXPANDED_PATHS: ReadonlyArray<string> = Object.freeze([]);

type SelectedWorkspaceByEpicAndHost = Readonly<
  Partial<Record<string, Readonly<Partial<Record<string, string>>>>>
>;

type ExpandedPathsByScope = Readonly<
  Partial<Record<string, ReadonlyArray<string>>>
>;

/** Flat key for the `[epicId, hostId, workspacePath]` expansion scope. */
export function fileTreeExpansionScopeKey(
  epicId: string,
  hostId: string,
  workspacePath: string,
): string {
  return [epicId, hostId, workspacePath].join(SCOPE_KEY_SEPARATOR);
}

interface FileTreeStore {
  /** `epicId -> hostId -> workspacePath`. */
  readonly selectedWorkspaceByEpicAndHost: SelectedWorkspaceByEpicAndHost;

  /** `fileTreeExpansionScopeKey(...) -> expanded directory tokens`. */
  readonly expandedPathsByScope: ExpandedPathsByScope;

  readonly setSelectedWorkspace: (
    epicId: string,
    hostId: string,
    workspacePath: string | null,
  ) => void;

  readonly setExpandedPaths: (
    epicId: string,
    hostId: string,
    workspacePath: string,
    expandedPaths: ReadonlyArray<string>,
  ) => void;

  readonly pruneExpandedPaths: (
    epicId: string,
    hostId: string,
    workspacePath: string,
    prunedPaths: ReadonlyArray<string>,
  ) => void;
}

function normalizeExpandedPaths(
  expandedPaths: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return [...new Set(expandedPaths)].toSorted((left, right) =>
    left.localeCompare(right),
  );
}

function areStringArraysEqual(
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function writeExpandedPaths(
  state: FileTreeStore,
  scopeKey: string,
  nextPaths: ReadonlyArray<string>,
): Pick<FileTreeStore, "expandedPathsByScope"> | null {
  const current = state.expandedPathsByScope[scopeKey] ?? EMPTY_EXPANDED_PATHS;
  if (areStringArraysEqual(current, nextPaths)) return null;
  const nextByScope = { ...state.expandedPathsByScope };
  if (nextPaths.length === 0) {
    delete nextByScope[scopeKey];
  } else {
    nextByScope[scopeKey] = nextPaths;
  }
  return { expandedPathsByScope: nextByScope };
}

export const useFileTreeStore = create<FileTreeStore>()(
  persist(
    (set) => ({
      selectedWorkspaceByEpicAndHost: {},
      expandedPathsByScope: {},

      setSelectedWorkspace: (epicId, hostId, workspacePath) => {
        set((state) => {
          const current =
            state.selectedWorkspaceByEpicAndHost[epicId]?.[hostId] ?? null;
          if (current === workspacePath) return state;

          const epicEntry = {
            ...state.selectedWorkspaceByEpicAndHost[epicId],
          };
          if (workspacePath === null) {
            delete epicEntry[hostId];
          } else {
            epicEntry[hostId] = workspacePath;
          }

          const nextByEpic = {
            ...state.selectedWorkspaceByEpicAndHost,
          };
          if (Object.keys(epicEntry).length === 0) {
            delete nextByEpic[epicId];
          } else {
            nextByEpic[epicId] = epicEntry;
          }

          return { selectedWorkspaceByEpicAndHost: nextByEpic };
        });
      },

      setExpandedPaths: (epicId, hostId, workspacePath, expandedPaths) => {
        const scopeKey = fileTreeExpansionScopeKey(
          epicId,
          hostId,
          workspacePath,
        );
        const nextPaths = normalizeExpandedPaths(expandedPaths);
        set((state) => writeExpandedPaths(state, scopeKey, nextPaths) ?? state);
      },

      pruneExpandedPaths: (epicId, hostId, workspacePath, prunedPaths) => {
        if (prunedPaths.length === 0) return;
        const scopeKey = fileTreeExpansionScopeKey(
          epicId,
          hostId,
          workspacePath,
        );
        set((state) => {
          const current =
            state.expandedPathsByScope[scopeKey] ?? EMPTY_EXPANDED_PATHS;
          const nextPaths = current.filter(
            (path) =>
              !prunedPaths.some((prunedPath) =>
                isWithinDirectory(path, prunedPath),
              ),
          );
          return writeExpandedPaths(state, scopeKey, nextPaths) ?? state;
        });
      },
    }),
    {
      ...basePersistOptions(PERSIST_KEY),
      storage: createJSONStorage(() => window.localStorage),
      partialize: (state) => ({
        selectedWorkspaceByEpicAndHost: state.selectedWorkspaceByEpicAndHost,
        expandedPathsByScope: state.expandedPathsByScope,
      }),
    },
  ),
);

export function useSelectedFileTreeWorkspace(
  epicId: string,
  hostId: string | null,
): string | null {
  return useFileTreeStore((s) =>
    hostId === null
      ? null
      : (s.selectedWorkspaceByEpicAndHost[epicId]?.[hostId] ?? null),
  );
}

/** The expanded directory tokens for one file-tree scope. */
export function useFileTreeExpandedPaths(
  epicId: string,
  hostId: string | null,
  workspacePath: string | null,
): ReadonlyArray<string> {
  return useFileTreeStore((s) =>
    hostId === null || workspacePath === null
      ? EMPTY_EXPANDED_PATHS
      : (s.expandedPathsByScope[
          fileTreeExpansionScopeKey(epicId, hostId, workspacePath)
        ] ?? EMPTY_EXPANDED_PATHS),
  );
}
