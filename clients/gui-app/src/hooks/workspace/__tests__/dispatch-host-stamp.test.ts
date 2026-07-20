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
 * Regression for the B6 host-stamp race: callers must use the hostId returned
 * from pickAndPrepareFolders (dispatch-time), never the client's host id at
 * completion time. These pure helpers are what production maps through.
 */
describe("dispatch-time host stamp (B6 race)", () => {
  it("stamps with dispatch host even if a different host is 'current' conceptually", () => {
    const dispatchHostId = "host-A";
    // Simulates completion-time client reading host-B — we must ignore it.
    const completionTimeHostId = "host-B";
    void completionTimeHostId;

    const stamped = stampPreparedFoldersWithDispatchHost(
      [PREPARED],
      dispatchHostId,
    );
    expect(stamped).toHaveLength(1);
    expect(stamped[0]?.hostId).toBe("host-A");
    expect(stamped[0]?.path).toBe("/Users/a/scratch");
  });

  it("never uses a post-await client host when mapping a single folder", () => {
    const fromDispatch = preparedWorkspaceFolderToWorkspaceFolderInfo(
      PREPARED,
      "host-A",
    );
    const wronglyFromCompletion = preparedWorkspaceFolderToWorkspaceFolderInfo(
      PREPARED,
      "host-B",
    );
    // Production code paths only pass result.hostId (dispatch). This asserts
    // the mapping is a pure function of the hostId argument.
    expect(fromDispatch.hostId).toBe("host-A");
    expect(wronglyFromCompletion.hostId).toBe("host-B");
    expect(fromDispatch.hostId).not.toBe(wronglyFromCompletion.hostId);
  });
});
