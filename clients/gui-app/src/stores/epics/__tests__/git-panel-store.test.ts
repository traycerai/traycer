import { beforeEach, describe, expect, it } from "vitest";
import {
  useGitPanelStore,
  defaultEpicState,
  type GitPanelStore,
  type GitPanelEpicState,
  type GitPanelSelectedWorktree,
} from "../git-panel-store";

const EPIC_ID = "epic-1" as const;
const EPIC_ID_2 = "epic-2" as const;
const WORKTREE_1: GitPanelSelectedWorktree = {
  hostId: "host-1",
  runningDir: "/path/1",
};
const WORKTREE_2: GitPanelSelectedWorktree = {
  hostId: "host-2",
  runningDir: "/path/1",
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
    useGitPanelStore.setState({ stateByEpicId: {} });
  });

  it("initializes with empty store", () => {
    const store = useGitPanelStore;
    expect(store.getState().stateByEpicId).toEqual({});
  });

  it("isolates state per epic", () => {
    const store = useGitPanelStore;
    store.getState().setSelectedWorktree(EPIC_ID, WORKTREE_1);
    store.getState().setSelectedWorktree(EPIC_ID_2, WORKTREE_2);

    const epic1State = getEpicState(EPIC_ID);
    const epic2State = getEpicState(EPIC_ID_2);

    expect(epic1State.selectedWorktree).toEqual(WORKTREE_1);
    expect(epic2State.selectedWorktree).toEqual(WORKTREE_2);
  });

  it("set/get round-trip for selectedWorktree", () => {
    const store = useGitPanelStore;
    store.getState().setSelectedWorktree(EPIC_ID, WORKTREE_1);
    expect(getEpicState(EPIC_ID).selectedWorktree).toEqual(WORKTREE_1);
    store.getState().setSelectedWorktree(EPIC_ID, null);
    expect(getEpicState(EPIC_ID).selectedWorktree).toBeNull();
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
    store.getState().setSelectedWorktree(EPIC_ID, WORKTREE_1);
    const before = store.getState().stateByEpicId;
    store.getState().setSelectedWorktree(EPIC_ID, { ...WORKTREE_1 });
    const after = store.getState().stateByEpicId;
    expect(before === after).toBe(true);
  });
});
