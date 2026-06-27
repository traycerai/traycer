import "../../../../__tests__/test-browser-apis";
import { beforeEach, describe, expect, it } from "vitest";
import { persistKey, STORE_KEYS } from "@/lib/persist";
import {
  isolateWorkspaceFoldersForDesktopWindow,
  useWorkspaceFoldersStore,
  type WorkspaceFolderInfo,
} from "@/stores/workspace/workspace-folders-store";

const PERSIST_KEY = persistKey(STORE_KEYS.workspaceFolders);

const FOLDER_A: WorkspaceFolderInfo = {
  path: "/tmp/project-a",
  name: "project-a",
  repoIdentifier: null,
};
const FOLDER_B: WorkspaceFolderInfo = {
  path: "/tmp/project-b",
  name: "project-b",
  repoIdentifier: null,
};

function persistedFolders(): ReadonlyArray<string> {
  const raw = window.localStorage.getItem(PERSIST_KEY);
  if (raw === null) return [];
  const parsed = JSON.parse(raw) as { state?: { folders?: string[] } };
  return parsed.state?.folders ?? [];
}

describe("useWorkspaceFoldersStore", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useWorkspaceFoldersStore.setState({ folders: [], folderInfoByPath: {} });
  });

  it("persists added folders to localStorage by default (web)", () => {
    useWorkspaceFoldersStore.getState().addResolvedFolders([FOLDER_A]);

    expect(useWorkspaceFoldersStore.getState().folders).toEqual([
      FOLDER_A.path,
    ]);
    expect(persistedFolders()).toEqual([FOLDER_A.path]);
  });

  // Keep last: isolation flips a one-way, module-level persistence switch.
  it("isolates the store per desktop window — clears it and stops persisting", () => {
    useWorkspaceFoldersStore.getState().addResolvedFolders([FOLDER_A]);
    expect(persistedFolders()).toEqual([FOLDER_A.path]);

    // A second window installing the desktop bridge must not inherit the first
    // window's folder, and its own edits must not leak back to shared storage.
    isolateWorkspaceFoldersForDesktopWindow();
    expect(useWorkspaceFoldersStore.getState().folders).toEqual([]);

    useWorkspaceFoldersStore.getState().addResolvedFolders([FOLDER_B]);
    expect(useWorkspaceFoldersStore.getState().folders).toEqual([
      FOLDER_B.path,
    ]);
    // localStorage still holds only the pre-isolation value — the post-isolation
    // add stayed in memory.
    expect(persistedFolders()).toEqual([FOLDER_A.path]);
  });
});
