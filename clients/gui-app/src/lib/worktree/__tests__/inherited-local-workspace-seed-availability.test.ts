import { describe, expect, it } from "vitest";
import type { WorktreeBinding } from "@traycer/protocol/host/worktree-schemas";
import { projectWorkspaceFolderForHost } from "@/hooks/workspace/use-resolved-workspace-folders-query";
import {
  deriveFolderlessAllowedWorkspaceAvailability,
  UNRESOLVED_WORKSPACE_FOLDER_HINT,
} from "@/lib/composer/workspace-composer-availability";
import {
  buildForkWorkspaceSeed,
  type ForkWorkspaceSeed,
} from "@/lib/worktree/fork-workspace-seed";

const EMPTY_RESOLVED_BY_KEY = new Map<string, ReadonlySet<string>>();
const SOURCE_HOST_ID = "host-source";
const OTHER_HOST_ID = "host-other";
const WORKSPACE_PATH = "/Users/me/projects/scratch";

function localBindingWithoutRepoIdentifier(): WorktreeBinding {
  return {
    entries: [
      {
        workspacePath: WORKSPACE_PATH,
        mode: "local",
        repoIdentifier: null,
        worktreePath: null,
        branch: "main",
        isPrimary: true,
        isImported: false,
        setupState: "not_required",
        setupTerminalSessionId: null,
        setupExitCode: null,
        setupFailedAt: null,
        createdAt: 0,
        ownedSubmodules: [],
      },
    ],
  };
}

function projectSeedForHost(seed: ForkWorkspaceSeed, boundHostId: string) {
  const folders = seed.workspace.folders.flatMap((path) => {
    if (!Object.hasOwn(seed.workspace.folderInfoByPath, path)) {
      return [];
    }
    return [
      projectWorkspaceFolderForHost(
        seed.workspace.folderInfoByPath[path],
        EMPTY_RESOLVED_BY_KEY,
        boundHostId,
      ),
    ];
  });
  return {
    folders,
    availability: deriveFolderlessAllowedWorkspaceAvailability(
      folders,
      false,
      false,
    ),
  };
}

describe("inherited local workspace seed availability", () => {
  it("is ready on the stamped source host and unresolved on a foreign host or when unstamped", () => {
    const binding = localBindingWithoutRepoIdentifier();

    const knownHostSeed = buildForkWorkspaceSeed({
      binding,
      stagedIntent: null,
      hostId: SOURCE_HOST_ID,
    });
    const onSource = projectSeedForHost(knownHostSeed, SOURCE_HOST_ID);
    expect(onSource.folders.map((folder) => folder.kind)).toEqual([
      "local-only",
    ]);
    expect(onSource.availability).toEqual({
      status: "ready",
      disabledHint: null,
    });

    const onOther = projectSeedForHost(knownHostSeed, OTHER_HOST_ID);
    expect(onOther.folders.map((folder) => folder.kind)).toEqual([
      "unresolved",
    ]);
    expect(onOther.availability).toEqual({
      status: "blocked",
      disabledHint: UNRESOLVED_WORKSPACE_FOLDER_HINT,
    });

    // B6: a producer that does not know the source host must not mint a
    // local-only row. Null is "unstamped", never "this host".
    const unstampedSeed = buildForkWorkspaceSeed({
      binding,
      stagedIntent: null,
      hostId: null,
    });
    const unstampedOnSource = projectSeedForHost(unstampedSeed, SOURCE_HOST_ID);
    expect(unstampedOnSource.folders.map((folder) => folder.kind)).toEqual([
      "unresolved",
    ]);
    expect(unstampedOnSource.availability).toEqual({
      status: "blocked",
      disabledHint: UNRESOLVED_WORKSPACE_FOLDER_HINT,
    });
  });
});
