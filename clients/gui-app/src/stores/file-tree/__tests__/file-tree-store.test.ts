import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useFileTreeStore } from "../file-tree-store";

const PERSIST_KEY = "traycer-gui-app:file-tree";

interface PersistedFileTreeState {
  readonly state: {
    readonly selectedWorkspaceByEpicAndHost: Readonly<
      Record<string, Readonly<Record<string, string>>>
    >;
  };
  readonly version: number;
}

function readPersistedState(): PersistedFileTreeState {
  const raw = window.localStorage.getItem(PERSIST_KEY) ?? "{}";
  return JSON.parse(raw) as PersistedFileTreeState;
}

function resetStore(): void {
  window.localStorage.clear();
  useFileTreeStore.setState({ selectedWorkspaceByEpicAndHost: {} });
}

describe("useFileTreeStore", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  it("stores selection keyed by (epicId, hostId)", () => {
    useFileTreeStore
      .getState()
      .setSelectedWorkspace("epic-a", "host-A", "/work/repo");
    useFileTreeStore
      .getState()
      .setSelectedWorkspace("epic-a", "host-B", "/other/repo");

    expect(useFileTreeStore.getState().selectedWorkspaceByEpicAndHost).toEqual({
      "epic-a": {
        "host-A": "/work/repo",
        "host-B": "/other/repo",
      },
    });
  });

  it("persists selection across hosts and epics to localStorage", () => {
    useFileTreeStore
      .getState()
      .setSelectedWorkspace("epic-a", "host-A", "/work/repo");
    useFileTreeStore
      .getState()
      .setSelectedWorkspace("epic-b", "host-A", "/work/other");

    expect(readPersistedState().state.selectedWorkspaceByEpicAndHost).toEqual({
      "epic-a": { "host-A": "/work/repo" },
      "epic-b": { "host-A": "/work/other" },
    });
  });

  it("restores selection from a prior persisted state", async () => {
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: {
          selectedWorkspaceByEpicAndHost: {
            "epic-a": { "host-A": "/work/repo" },
            "epic-b": { "host-B": "/work/other" },
          },
        },
        version: 1,
      }),
    );

    await useFileTreeStore.persist.rehydrate();
    expect(useFileTreeStore.getState().selectedWorkspaceByEpicAndHost).toEqual({
      "epic-a": { "host-A": "/work/repo" },
      "epic-b": { "host-B": "/work/other" },
    });
  });

  it("clears a per-host selection when set to null", () => {
    useFileTreeStore
      .getState()
      .setSelectedWorkspace("epic-a", "host-A", "/work/repo");
    useFileTreeStore
      .getState()
      .setSelectedWorkspace("epic-a", "host-B", "/other");
    useFileTreeStore.getState().setSelectedWorkspace("epic-a", "host-A", null);

    expect(
      useFileTreeStore.getState().selectedWorkspaceByEpicAndHost["epic-a"],
    ).toEqual({ "host-B": "/other" });
  });

  it("removes the epic entry when its last host selection is cleared", () => {
    useFileTreeStore
      .getState()
      .setSelectedWorkspace("epic-a", "host-A", "/work/repo");
    useFileTreeStore.getState().setSelectedWorkspace("epic-a", "host-A", null);

    expect(
      useFileTreeStore.getState().selectedWorkspaceByEpicAndHost["epic-a"],
    ).toBeUndefined();
  });
});
