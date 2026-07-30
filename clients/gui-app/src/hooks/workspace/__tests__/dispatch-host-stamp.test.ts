import { describe, expect, it } from "vitest";
import {
  preparedWorkspaceFolderToWorkspaceFolderInfo,
  stampPreparedFoldersWithDispatchHost,
} from "@/hooks/workspace/use-workspace-folder-actions";
import type { PreparedWorkspaceFolder } from "@traycer/protocol/host/epic/unary-schemas";

const PREPARED: PreparedWorkspaceFolder = {
  workspacePath: "/Users/a/scratch",
  workspaceName: "scratch",
  repoIdentifier: null,
  repoUrl: null,
};

/**
 * Contract of the two pure mappers `pickAndPrepareFolders` stamps results
 * through: each takes the host id as an argument and applies it verbatim to
 * every folder, adding no host lookup of its own.
 *
 * Scope note, so this file is not mistaken for more than it is: the B6 race
 * lives in the CALLER, which captures the host at dispatch and re-checks
 * `hostStillBound` after both awaits before returning. Nothing here can
 * observe that — these mappers are only reachable with whatever id the caller
 * hands them, so a caller that passed a completion-time host would still
 * satisfy every assertion below. Proving the race needs
 * `useWorkspaceFolderActionsForClient` driven with a client whose active host
 * changes across `pickFolders`, asserting it refuses (returns null) instead of
 * stamping; that harness does not exist yet.
 */
describe("prepared-folder host stamping (pure mappers)", () => {
  it("applies the given host id to every folder it stamps", () => {
    const stamped = stampPreparedFoldersWithDispatchHost([PREPARED], "host-A");
    expect(stamped).toHaveLength(1);
    expect(stamped[0]?.hostId).toBe("host-A");
    expect(stamped[0]?.path).toBe("/Users/a/scratch");
  });

  it("takes the host id only from its argument when mapping one folder", () => {
    expect(
      preparedWorkspaceFolderToWorkspaceFolderInfo(PREPARED, "host-A").hostId,
    ).toBe("host-A");
    expect(
      preparedWorkspaceFolderToWorkspaceFolderInfo(PREPARED, "host-B").hostId,
    ).toBe("host-B");
  });
});
