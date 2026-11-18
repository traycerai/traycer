import { describe, expect, it, vi } from "vitest";
import type { WorkspaceFolderInfo } from "@/stores/workspace/workspace-folders-store";
import { replaceAbsentWorkspaceFolder } from "../use-pick-and-add-folders";

const ABSENT = "/old/absent";
const PICKED: WorkspaceFolderInfo = {
  path: "/new/repo",
  name: "repo",
  repoIdentifier: { owner: "acme", repo: "app" },
  hostId: "host-1",
};

describe("replaceAbsentWorkspaceFolder", () => {
  it("removes the absent path then adds the picked folders", () => {
    const removed: string[] = [];
    const added: WorkspaceFolderInfo[][] = [];
    const ok = replaceAbsentWorkspaceFolder({
      workspaceSource: {
        removeFolder: (path) => {
          removed.push(path);
          return { primaryChanged: false, newPrimaryName: null };
        },
        addResolvedFolders: (folders) => {
          added.push([...folders]);
        },
      },
      absentPath: ABSENT,
      folders: [PICKED],
    });

    expect(ok).toBe(true);
    // Order matters: remove first so the dead path cannot keep blocking
    // readiness even when the add is a no-op for a duplicate.
    expect(removed).toEqual([ABSENT]);
    expect(added).toEqual([[PICKED]]);
  });

  it("changes nothing when the pick is empty", () => {
    const removeFolder = vi.fn();
    const addResolvedFolders = vi.fn();
    const ok = replaceAbsentWorkspaceFolder({
      workspaceSource: { removeFolder, addResolvedFolders },
      absentPath: ABSENT,
      folders: [],
    });
    expect(ok).toBe(false);
    expect(removeFolder).not.toHaveBeenCalled();
    expect(addResolvedFolders).not.toHaveBeenCalled();
  });
});
