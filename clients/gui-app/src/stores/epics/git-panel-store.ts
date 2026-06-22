import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";

export interface GitPanelEpicState {
  readonly selectedWorktree: GitPanelSelectedWorktree | null;
  readonly listLayout: "sections" | "tree";
  readonly mergeSectionCollapsed: boolean;
  readonly stagedSectionCollapsed: boolean;
  readonly changesSectionCollapsed: boolean;
}

export interface GitPanelSelectedWorktree {
  readonly hostId: string;
  readonly runningDir: string;
}

export interface GitPanelStore {
  readonly stateByEpicId: Record<string, GitPanelEpicState>;
  readonly setSelectedWorktree: (
    epicId: string,
    worktree: GitPanelSelectedWorktree | null,
  ) => void;
  readonly setListLayout: (epicId: string, layout: "sections" | "tree") => void;
  readonly toggleSection: (
    epicId: string,
    section: "merge" | "staged" | "changes",
  ) => void;
}

export type GitPanelSection = "merge" | "staged" | "changes";
type GitPanelSectionCollapseKey =
  | "mergeSectionCollapsed"
  | "stagedSectionCollapsed"
  | "changesSectionCollapsed";

export const defaultEpicState: GitPanelEpicState = {
  selectedWorktree: null,
  listLayout: "sections",
  mergeSectionCollapsed: false,
  stagedSectionCollapsed: false,
  changesSectionCollapsed: false,
};

const PERSIST_KEY = persistKey(STORE_KEYS.gitPanel);

function serializeEpicState(state: GitPanelEpicState): unknown {
  return {
    selectedWorktree: state.selectedWorktree,
    listLayout: state.listLayout,
    mergeSectionCollapsed: state.mergeSectionCollapsed,
    stagedSectionCollapsed: state.stagedSectionCollapsed,
    changesSectionCollapsed: state.changesSectionCollapsed,
  };
}

export const useGitPanelStore = create<GitPanelStore>()(
  persist(
    (set) => ({
      stateByEpicId: {},

      setSelectedWorktree: (epicId, worktree) => {
        set((state) => {
          const current = state.stateByEpicId[epicId] ?? defaultEpicState;
          if (selectedWorktreesEqual(current.selectedWorktree, worktree)) {
            return state;
          }
          return {
            stateByEpicId: {
              ...state.stateByEpicId,
              [epicId]: {
                ...current,
                selectedWorktree: worktree,
              },
            },
          };
        });
      },

      setListLayout: (epicId, layout) => {
        set((state) => {
          const current = state.stateByEpicId[epicId] ?? defaultEpicState;
          if (current.listLayout === layout) return state;
          return {
            stateByEpicId: {
              ...state.stateByEpicId,
              [epicId]: {
                ...current,
                listLayout: layout,
              },
            },
          };
        });
      },

      toggleSection: (epicId, section) => {
        set((state) => {
          const current = state.stateByEpicId[epicId] ?? defaultEpicState;
          const key = sectionCollapseKey(section);
          const nextValue = !current[key];
          return {
            stateByEpicId: {
              ...state.stateByEpicId,
              [epicId]: {
                ...current,
                [key]: nextValue,
              },
            },
          };
        });
      },
    }),
    {
      ...basePersistOptions(PERSIST_KEY),
      storage: createJSONStorage(() => window.localStorage),
      partialize: (state) => ({
        stateByEpicId: Object.entries(state.stateByEpicId).reduce<
          Record<string, unknown>
        >((acc, [epicId, epicState]) => {
          acc[epicId] = serializeEpicState(epicState);
          return acc;
        }, {}),
      }),
    },
  ),
);

function sectionCollapseKey(
  section: GitPanelSection,
): GitPanelSectionCollapseKey {
  if (section === "merge") return "mergeSectionCollapsed";
  if (section === "staged") return "stagedSectionCollapsed";
  return "changesSectionCollapsed";
}

export function selectGitPanelEpicState(epicId: string) {
  return (s: GitPanelStore): GitPanelEpicState =>
    s.stateByEpicId[epicId] ?? defaultEpicState;
}

export function selectGitPanelSectionCollapsed(
  epicId: string,
  section: GitPanelSection,
) {
  return (s: GitPanelStore): boolean =>
    selectGitPanelEpicState(epicId)(s)[sectionCollapseKey(section)];
}

function selectedWorktreesEqual(
  left: GitPanelSelectedWorktree | null,
  right: GitPanelSelectedWorktree | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.hostId === right.hostId && left.runningDir === right.runningDir;
}
