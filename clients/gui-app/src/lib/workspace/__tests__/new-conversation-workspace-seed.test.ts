import { describe, expect, it } from "vitest";
import type { ResolvedWorkspaceFolder } from "@traycer/protocol/host/epic/snapshot-meta";
import { resolveNewConversationWorkspaceSeed } from "../new-conversation-workspace-seed";
import type { LandingDraftWorkspaceSnapshot } from "@/stores/home/landing-draft-store";
import type { WorkspaceFolderInfo } from "@/stores/workspace/workspace-folders-store";

const HOST_A = "host-a";
const HOST_B = "host-b";

function epicFolder(
  workspacePath: string,
  hostId: string,
): ResolvedWorkspaceFolder {
  return {
    workspacePath,
    hostId,
    repoIdentifier: null,
    lastSyncedAt: null,
  };
}

const LATEST_WORKSPACE: LandingDraftWorkspaceSnapshot = {
  folders: ["/work/.traycer/worktrees/crm/feature-x"],
  folderInfoByPath: {
    "/work/.traycer/worktrees/crm/feature-x": {
      path: "/work/.traycer/worktrees/crm/feature-x",
      name: "feature-x",
      repoIdentifier: { owner: "g", repo: "crm" },
      hostId: HOST_A,
    } satisfies WorkspaceFolderInfo,
  },
  primaryPath: "/work/.traycer/worktrees/crm/feature-x",
};

describe("resolveNewConversationWorkspaceSeed", () => {
  it("prefers the latest conversation's workspace verbatim when present", () => {
    const result = resolveNewConversationWorkspaceSeed({
      latestWorkspace: LATEST_WORKSPACE,
      epicWorkspaceFolders: [epicFolder("/work/crm", HOST_A)],
      hostId: HOST_A,
    });
    expect(result).toBe(LATEST_WORKSPACE);
  });

  it("seeds the epic's own stored folders on the create host when no conversation seed exists", () => {
    const result = resolveNewConversationWorkspaceSeed({
      latestWorkspace: null,
      epicWorkspaceFolders: [
        epicFolder("/work/crm", HOST_A),
        {
          workspacePath: "/work/crm-api",
          hostId: HOST_A,
          repoIdentifier: { owner: "g", repo: "crm-api" },
          lastSyncedAt: null,
        },
      ],
      hostId: HOST_A,
    });
    expect(result.folders).toEqual(["/work/crm", "/work/crm-api"]);
    expect(result.primaryPath).toBe("/work/crm");
    expect(result.folderInfoByPath["/work/crm"]).toEqual({
      path: "/work/crm",
      name: "crm",
      repoIdentifier: null,
      hostId: HOST_A,
    });
    // The stored repo link survives into the folder info so picker chips and
    // the synthesized local intent keep it.
    expect(result.folderInfoByPath["/work/crm-api"].repoIdentifier).toEqual({
      owner: "g",
      repo: "crm-api",
    });
  });

  it("ignores the epic's folders that live on another host", () => {
    const result = resolveNewConversationWorkspaceSeed({
      latestWorkspace: null,
      epicWorkspaceFolders: [
        epicFolder("/work/crm", HOST_A),
        epicFolder("/other/crm", HOST_B),
      ],
      hostId: HOST_B,
    });
    expect(result.folders).toEqual(["/other/crm"]);
    expect(result.primaryPath).toBe("/other/crm");
  });

  it("falls back to empty folders when the epic has no stored folders - never the overlay", () => {
    const result = resolveNewConversationWorkspaceSeed({
      latestWorkspace: null,
      epicWorkspaceFolders: [],
      hostId: HOST_A,
    });
    expect(result).toEqual({
      folders: [],
      folderInfoByPath: {},
      primaryPath: null,
    });
  });

  it("falls back to empty folders when none of the epic's folders live on the create host", () => {
    const result = resolveNewConversationWorkspaceSeed({
      latestWorkspace: null,
      epicWorkspaceFolders: [epicFolder("/work/crm", HOST_A)],
      hostId: HOST_B,
    });
    expect(result.folders).toEqual([]);
    expect(result.primaryPath).toBeNull();
  });

  it("matches no folders before a create host is known", () => {
    const result = resolveNewConversationWorkspaceSeed({
      latestWorkspace: null,
      epicWorkspaceFolders: [epicFolder("/work/crm", HOST_A)],
      hostId: null,
    });
    expect(result.folders).toEqual([]);
  });

  it("still prefers an explicitly empty latest seed over the epic's folders", () => {
    // A resolved-but-empty latest seed (e.g. the source conversation's binding
    // resolved folderless) is an answer, not an absence: do not re-fill it
    // from the epic's stored set.
    const emptyLatest: LandingDraftWorkspaceSnapshot = {
      folders: [],
      folderInfoByPath: {},
      primaryPath: null,
    };
    const result = resolveNewConversationWorkspaceSeed({
      latestWorkspace: emptyLatest,
      epicWorkspaceFolders: [epicFolder("/work/crm", HOST_A)],
      hostId: HOST_A,
    });
    expect(result).toBe(emptyLatest);
  });
});
