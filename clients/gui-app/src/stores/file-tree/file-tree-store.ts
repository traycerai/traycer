/**
 * Standalone zustand store for the file-tree panel. Owns the per-epic +
 * per-host "selected workspace root" so multi-host users keep distinct
 * selections per host (a feature the previous slice in
 * `left-panel-store` could not represent - it was keyed by epicId alone).
 *
 * Shape is intentionally minimal: just selection today. Future file-tree
 * state (expanded path set, last-opened file, etc.) can be added here
 * keyed by `[epicId, hostId]` without growing other stores.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";

const PERSIST_KEY = persistKey(STORE_KEYS.fileTree);

type SelectedWorkspaceByEpicAndHost = Readonly<
  Partial<Record<string, Readonly<Partial<Record<string, string>>>>>
>;

interface FileTreeStore {
  /** `epicId -> hostId -> workspacePath`. */
  readonly selectedWorkspaceByEpicAndHost: SelectedWorkspaceByEpicAndHost;

  readonly setSelectedWorkspace: (
    epicId: string,
    hostId: string,
    workspacePath: string | null,
  ) => void;
}

export const useFileTreeStore = create<FileTreeStore>()(
  persist(
    (set) => ({
      selectedWorkspaceByEpicAndHost: {},

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
    }),
    {
      ...basePersistOptions(PERSIST_KEY),
      storage: createJSONStorage(() => window.localStorage),
      partialize: (state) => ({
        selectedWorkspaceByEpicAndHost: state.selectedWorkspaceByEpicAndHost,
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
