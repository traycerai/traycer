import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";

export interface GitPanelEpicState {
  readonly selectedRepo: GitPanelSelectedRepo | null;
  readonly listLayout: "sections" | "tree";
  readonly mergeSectionCollapsed: boolean;
  readonly stagedSectionCollapsed: boolean;
  readonly changesSectionCollapsed: boolean;
}

/**
 * The workspace currently selected in the Git Diff panel. `rootRunningDir` is
 * the bound workspace/root repo and the only root whose nested
 * `git.listChangedFiles@1.1` snapshot is fetched. `repoRoot` is retained for
 * persisted v2 compatibility; current UI writes it equal to `rootRunningDir`,
 * and legacy submodule values are normalized back to the workspace root.
 */
export interface GitPanelSelectedRepo {
  readonly hostId: string;
  readonly rootRunningDir: string;
  readonly repoRoot: string;
}

export interface GitPanelStore {
  readonly stateByEpicId: Record<string, GitPanelEpicState>;
  readonly setSelectedRepo: (
    epicId: string,
    repo: GitPanelSelectedRepo | null,
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
  selectedRepo: null,
  listLayout: "sections",
  mergeSectionCollapsed: false,
  stagedSectionCollapsed: false,
  changesSectionCollapsed: false,
};

export const GIT_PANEL_PERSIST_KEY = persistKey(STORE_KEYS.gitPanel);

function serializeEpicState(state: GitPanelEpicState): unknown {
  return {
    selectedRepo: state.selectedRepo,
    listLayout: state.listLayout,
    mergeSectionCollapsed: state.mergeSectionCollapsed,
    stagedSectionCollapsed: state.stagedSectionCollapsed,
    changesSectionCollapsed: state.changesSectionCollapsed,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePersistedSelectedRepo(
  value: unknown,
): GitPanelSelectedRepo | null {
  if (!isRecord(value)) return null;
  const { hostId, rootRunningDir, repoRoot } = value;
  if (
    typeof hostId === "string" &&
    typeof rootRunningDir === "string" &&
    typeof repoRoot === "string"
  ) {
    return { hostId, rootRunningDir, repoRoot };
  }
  return null;
}

function parsePersistedListLayout(value: unknown): "sections" | "tree" {
  return value === "tree" ? "tree" : "sections";
}

function parsePersistedBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

// Rebuild one epic's persisted entry into the current shape. The v1 blob carried
// `selectedWorktree` (a `{ hostId, runningDir }` that no longer maps to a
// persisted `selectedRepo` workspace shape); it is dropped - `selectedRepo`
// resets to null and the panel re-picks a default root. Every other field is
// kept when valid, else defaulted, so the result can never surface an
// `undefined` field.
function migratePersistedEpicState(value: unknown): GitPanelEpicState {
  if (!isRecord(value)) return defaultEpicState;
  return {
    selectedRepo: parsePersistedSelectedRepo(value.selectedRepo),
    listLayout: parsePersistedListLayout(value.listLayout),
    mergeSectionCollapsed: parsePersistedBoolean(
      value.mergeSectionCollapsed,
      defaultEpicState.mergeSectionCollapsed,
    ),
    stagedSectionCollapsed: parsePersistedBoolean(
      value.stagedSectionCollapsed,
      defaultEpicState.stagedSectionCollapsed,
    ),
    changesSectionCollapsed: parsePersistedBoolean(
      value.changesSectionCollapsed,
      defaultEpicState.changesSectionCollapsed,
    ),
  };
}

interface GitPanelPersistedState {
  readonly stateByEpicId: Record<string, GitPanelEpicState>;
}

/**
 * v1 -> v2 migration. v1 persisted the per-epic selection as `selectedWorktree`
 * (`{ hostId, runningDir }`); v2 renamed it to `selectedRepo`
 * (`{ hostId, rootRunningDir, repoRoot }`). A v1 blob therefore has no
 * `selectedRepo` key, so without this a legacy per-epic object rehydrates with
 * `selectedRepo === undefined`, defeating the panel's `selectedRepo !== null`
 * guard (`undefined !== null`) and throwing on `selectedRepo.hostId`. Every
 * entry is rebuilt into the current shape and the dead `selectedWorktree` is
 * dropped.
 */
export function migrateGitPanelPersistedState(
  persisted: unknown,
): GitPanelPersistedState {
  if (!isRecord(persisted) || !isRecord(persisted.stateByEpicId)) {
    return { stateByEpicId: {} };
  }
  return {
    stateByEpicId: Object.fromEntries(
      Object.entries(persisted.stateByEpicId).map(([epicId, value]) => [
        epicId,
        migratePersistedEpicState(value),
      ]),
    ),
  };
}

export const useGitPanelStore = create<GitPanelStore>()(
  persist(
    (set) => ({
      stateByEpicId: {},

      setSelectedRepo: (epicId, repo) => {
        set((state) => {
          const current = state.stateByEpicId[epicId] ?? defaultEpicState;
          if (selectedReposEqual(current.selectedRepo, repo)) {
            return state;
          }
          return {
            stateByEpicId: {
              ...state.stateByEpicId,
              [epicId]: {
                ...current,
                selectedRepo: repo,
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
      ...basePersistOptions(GIT_PANEL_PERSIST_KEY),
      // v2 renamed the persisted per-epic selection `selectedWorktree` ->
      // `selectedRepo` (and retyped it); bump + migrate so a v1 blob is rebuilt
      // rather than rehydrating an entry whose `selectedRepo` is `undefined`.
      version: 2,
      storage: createJSONStorage(() => window.localStorage),
      partialize: (state) => ({
        stateByEpicId: Object.entries(state.stateByEpicId).reduce<
          Record<string, unknown>
        >((acc, [epicId, epicState]) => {
          acc[epicId] = serializeEpicState(epicState);
          return acc;
        }, {}),
      }),
      migrate: (persisted) => migrateGitPanelPersistedState(persisted),
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
  // Spread over `defaultEpicState` (not `?? defaultEpicState`) so a persisted
  // entry that predates a field - e.g. a legacy blob with no `selectedRepo` -
  // can never surface an `undefined` field to a `!== null` consumer guard.
  return (s: GitPanelStore): GitPanelEpicState => ({
    ...defaultEpicState,
    ...s.stateByEpicId[epicId],
  });
}

export function selectGitPanelSectionCollapsed(
  epicId: string,
  section: GitPanelSection,
) {
  return (s: GitPanelStore): boolean =>
    selectGitPanelEpicState(epicId)(s)[sectionCollapseKey(section)];
}

function selectedReposEqual(
  left: GitPanelSelectedRepo | null,
  right: GitPanelSelectedRepo | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.hostId === right.hostId &&
    left.rootRunningDir === right.rootRunningDir &&
    left.repoRoot === right.repoRoot
  );
}
