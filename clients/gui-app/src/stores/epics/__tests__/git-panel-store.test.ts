import { beforeEach, describe, expect, it } from "vitest";
import {
  GIT_PANEL_PERSIST_KEY,
  migrateGitPanelPersistedState,
  selectGitPanelEpicState,
  useGitPanelStore,
  defaultEpicState,
  type GitPanelStore,
  type GitPanelEpicState,
  type GitPanelSelectedRepo,
} from "../git-panel-store";

const EPIC_ID = "epic-1" as const;
const EPIC_ID_2 = "epic-2" as const;
const REPO_1: GitPanelSelectedRepo = {
  hostId: "host-1",
  rootRunningDir: "/path/1",
  repoRoot: "/path/1",
};
const REPO_2: GitPanelSelectedRepo = {
  hostId: "host-2",
  rootRunningDir: "/path/1",
  repoRoot: "/path/1/traycer",
};

function getEpicState(epicId: string): GitPanelEpicState {
  const stateByEpicId: Partial<Record<string, GitPanelEpicState>> =
    useGitPanelStore.getState().stateByEpicId;
  const state = stateByEpicId[epicId] ?? null;
  if (state === null) {
    throw new Error(`Epic ${epicId} not found in store`);
  }
  return state;
}

describe("git-panel-store", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useGitPanelStore.setState({ stateByEpicId: {} });
  });

  it("initializes with empty store", () => {
    const store = useGitPanelStore;
    expect(store.getState().stateByEpicId).toEqual({});
  });

  it("isolates state per epic", () => {
    const store = useGitPanelStore;
    store.getState().setSelectedRepo(EPIC_ID, REPO_1);
    store.getState().setSelectedRepo(EPIC_ID_2, REPO_2);

    const epic1State = getEpicState(EPIC_ID);
    const epic2State = getEpicState(EPIC_ID_2);

    expect(epic1State.selectedRepo).toEqual(REPO_1);
    expect(epic2State.selectedRepo).toEqual(REPO_2);
  });

  it("set/get round-trip for selectedRepo", () => {
    const store = useGitPanelStore;
    store.getState().setSelectedRepo(EPIC_ID, REPO_1);
    expect(getEpicState(EPIC_ID).selectedRepo).toEqual(REPO_1);
    store.getState().setSelectedRepo(EPIC_ID, null);
    expect(getEpicState(EPIC_ID).selectedRepo).toBeNull();
  });

  it("distinguishes a submodule selection from its root", () => {
    const store = useGitPanelStore;
    const rootSelection: GitPanelSelectedRepo = {
      hostId: "host-1",
      rootRunningDir: "/path/1",
      repoRoot: "/path/1",
    };
    const submoduleSelection: GitPanelSelectedRepo = {
      hostId: "host-1",
      rootRunningDir: "/path/1",
      repoRoot: "/path/1/traycer",
    };
    store.getState().setSelectedRepo(EPIC_ID, rootSelection);
    const before = store.getState().stateByEpicId;
    store.getState().setSelectedRepo(EPIC_ID, submoduleSelection);
    const after = store.getState().stateByEpicId;
    // Same root, different repoRoot: this is a real selection change.
    expect(before === after).toBe(false);
    expect(getEpicState(EPIC_ID).selectedRepo).toEqual(submoduleSelection);
  });

  it("set/get round-trip for listLayout", () => {
    const store = useGitPanelStore;
    store.getState().setListLayout(EPIC_ID, "tree");
    expect(getEpicState(EPIC_ID).listLayout).toBe("tree");
    store.getState().setListLayout(EPIC_ID, "sections");
    expect(getEpicState(EPIC_ID).listLayout).toBe("sections");
  });

  it("toggleSection mutates immutably", () => {
    const store = useGitPanelStore;
    const before = store.getState().stateByEpicId;
    store.getState().toggleSection(EPIC_ID, "staged");
    const after = store.getState().stateByEpicId;
    expect(before === after).toBe(false);
    expect(getEpicState(EPIC_ID).stagedSectionCollapsed).toBe(true);
  });

  it("toggleSection toggles back", () => {
    const store = useGitPanelStore;
    store.getState().toggleSection(EPIC_ID, "staged");
    expect(getEpicState(EPIC_ID).stagedSectionCollapsed).toBe(true);
    store.getState().toggleSection(EPIC_ID, "staged");
    expect(getEpicState(EPIC_ID).stagedSectionCollapsed).toBe(false);
  });

  it("toggleSection supports merge changes", () => {
    const store = useGitPanelStore;
    store.getState().toggleSection(EPIC_ID, "merge");
    expect(getEpicState(EPIC_ID).mergeSectionCollapsed).toBe(true);
  });

  it("uses defaultEpicState for missing epic", () => {
    const store = useGitPanelStore;
    const state = store.getState();
    const epicState = state.stateByEpicId["nonexistent"];
    expect(epicState).toBeUndefined();

    const selector = (s: GitPanelStore) =>
      s.stateByEpicId["nonexistent"] ?? defaultEpicState;
    const result = selector(state);
    expect(result).toEqual(defaultEpicState);
  });

  it("does not mutate state on idempotent calls", () => {
    const store = useGitPanelStore;
    store.getState().setSelectedRepo(EPIC_ID, REPO_1);
    const before = store.getState().stateByEpicId;
    store.getState().setSelectedRepo(EPIC_ID, { ...REPO_1 });
    const after = store.getState().stateByEpicId;
    expect(before === after).toBe(true);
  });

  describe("v1 -> v2 persisted-state migration", () => {
    const LEGACY_V1_ENTRY = {
      selectedWorktree: { hostId: "host-1", runningDir: "/path/1" },
      listLayout: "tree",
      mergeSectionCollapsed: true,
      stagedSectionCollapsed: false,
      changesSectionCollapsed: false,
    };

    it("drops legacy selectedWorktree and resets selectedRepo to null", () => {
      const migrated = migrateGitPanelPersistedState({
        stateByEpicId: { [EPIC_ID]: LEGACY_V1_ENTRY },
      });
      const entry = migrated.stateByEpicId[EPIC_ID];
      expect(entry).toEqual({
        selectedRepo: null,
        listLayout: "tree",
        mergeSectionCollapsed: true,
        stagedSectionCollapsed: false,
        changesSectionCollapsed: false,
      });
      expect(Object.hasOwn(entry, "selectedWorktree")).toBe(false);
    });

    it("tolerates a corrupt or missing persisted blob", () => {
      expect(migrateGitPanelPersistedState(null)).toEqual({
        stateByEpicId: {},
      });
      expect(migrateGitPanelPersistedState({})).toEqual({ stateByEpicId: {} });
      expect(migrateGitPanelPersistedState({ stateByEpicId: 42 })).toEqual({
        stateByEpicId: {},
      });
    });

    it("rehydrates a v1 blob without crashing the selector", async () => {
      window.localStorage.setItem(
        GIT_PANEL_PERSIST_KEY,
        JSON.stringify({
          state: { stateByEpicId: { [EPIC_ID]: LEGACY_V1_ENTRY } },
          version: 1,
        }),
      );
      await useGitPanelStore.persist.rehydrate();

      const epicState = selectGitPanelEpicState(EPIC_ID)(
        useGitPanelStore.getState(),
      );
      expect(epicState.selectedRepo).toBeNull();
      expect(epicState.listLayout).toBe("tree");
      expect(Object.hasOwn(getEpicState(EPIC_ID), "selectedWorktree")).toBe(
        false,
      );
    });

    it("selectGitPanelEpicState fills defaults for a missing epic", () => {
      const result = selectGitPanelEpicState("nonexistent")(
        useGitPanelStore.getState(),
      );
      expect(result).toEqual(defaultEpicState);
      expect(result.selectedRepo).toBeNull();
    });
  });
});
