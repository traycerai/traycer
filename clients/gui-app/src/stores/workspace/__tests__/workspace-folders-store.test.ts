import "../../../../__tests__/test-browser-apis";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { persistKey, STORE_KEYS } from "@/lib/persist";
import type { WorkspaceFolderInfo } from "@/stores/workspace/workspace-folders-store";

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

// Isolation flips a one-way, module-level persistence switch, so each test gets
// a freshly-imported store module — that resets the switch (and the singleton
// store) in setup, keeping every test independent of run order.
type WorkspaceFoldersModule =
  typeof import("@/stores/workspace/workspace-folders-store");

describe("useWorkspaceFoldersStore", () => {
  let store: WorkspaceFoldersModule;

  beforeEach(async () => {
    vi.resetModules();
    window.localStorage.clear();
    store = await import("@/stores/workspace/workspace-folders-store");
  });

  it("persists added folders to localStorage by default (web)", () => {
    store.useWorkspaceFoldersStore.getState().addResolvedFolders([FOLDER_A]);

    expect(store.useWorkspaceFoldersStore.getState().folders).toEqual([
      FOLDER_A.path,
    ]);
    expect(persistedFolders()).toEqual([FOLDER_A.path]);
  });

  it("isolates the store per desktop window — clears it and stops persisting", () => {
    store.useWorkspaceFoldersStore.getState().addResolvedFolders([FOLDER_A]);
    expect(persistedFolders()).toEqual([FOLDER_A.path]);

    // A second window installing the desktop bridge must not inherit the first
    // window's folder, and its own edits must not leak back to shared storage.
    store.isolateWorkspaceFoldersForDesktopWindow();
    expect(store.useWorkspaceFoldersStore.getState().folders).toEqual([]);

    store.useWorkspaceFoldersStore.getState().addResolvedFolders([FOLDER_B]);
    expect(store.useWorkspaceFoldersStore.getState().folders).toEqual([
      FOLDER_B.path,
    ]);
    // localStorage still holds only the pre-isolation value — the post-isolation
    // add stayed in memory.
    expect(persistedFolders()).toEqual([FOLDER_A.path]);
  });

  it("isolation is idempotent — a re-install keeps the window's folders", () => {
    store.isolateWorkspaceFoldersForDesktopWindow();
    store.useWorkspaceFoldersStore.getState().addResolvedFolders([FOLDER_B]);

    // A bridge teardown/re-install in the same window calls isolate again; it
    // must not wipe the folders the user added after the first isolation.
    store.isolateWorkspaceFoldersForDesktopWindow();
    expect(store.useWorkspaceFoldersStore.getState().folders).toEqual([
      FOLDER_B.path,
    ]);
  });
});
