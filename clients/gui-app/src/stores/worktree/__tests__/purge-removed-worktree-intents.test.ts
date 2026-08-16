import { beforeEach, describe, expect, it } from "vitest";
import type {
  WorktreeBindingSelectorRowV12,
  WorktreeFolderIntent,
} from "@traycer/protocol/host";
import {
  worktreeFolderIntentReferencesRemoved,
  type RemovedWorktreeRefs,
} from "@/lib/worktree/removed-worktree-refs";
import { withoutResolvedMissingRows } from "@/lib/worktree/worktree-row-resolved-missing";
import { useWorktreeIntentMemoryStore } from "@/stores/worktree/worktree-intent-memory-store";
import {
  useWorktreeIntentStagingStore,
  worktreeStagingKeyString,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";

const ACME = { owner: "acme", repo: "app" } as const;

// The host the sweep actually ran on, and a second enrolled host that happens
// to use the same local paths and branch names.
const SWEPT_HOST = "host-swept";
const OTHER_HOST = "host-other";

const REMOVED: RemovedWorktreeRefs = {
  worktreePaths: new Set(["/wt/gone"]),
  branches: [{ repoIdentifier: ACME, branch: "traycer/gone-branch" }],
};

function existingBranchIntent(branchName: string): WorktreeFolderIntent {
  return {
    kind: "worktree",
    workspacePath: "/repo",
    repoIdentifier: ACME,
    isPrimary: true,
    branch: { type: "existing", name: branchName },
    scripts: null,
  };
}

/** Same branch NAME, a different repository - must survive the purge. */
function otherRepoBranchIntent(branchName: string): WorktreeFolderIntent {
  return {
    kind: "worktree",
    workspacePath: "/other-repo",
    repoIdentifier: { owner: "acme", repo: "other" },
    isPrimary: true,
    branch: { type: "existing", name: branchName },
    scripts: null,
  };
}

function importIntent(worktreePath: string): WorktreeFolderIntent {
  return {
    kind: "import",
    workspacePath: "/repo",
    repoIdentifier: { owner: "acme", repo: "app" },
    isPrimary: true,
    worktreePath,
  };
}

describe("worktreeFolderIntentReferencesRemoved", () => {
  it("matches deleted existing-branch checkouts, fork sources, and imports", () => {
    expect(
      worktreeFolderIntentReferencesRemoved(
        existingBranchIntent("traycer/gone-branch"),
        REMOVED,
      ),
    ).toBe(true);
    expect(
      worktreeFolderIntentReferencesRemoved(
        {
          ...existingBranchIntent("x"),
          kind: "worktree",
          branch: {
            type: "new",
            name: "fresh",
            source: "traycer/gone-branch",
            carryUncommittedChanges: false,
          },
          scripts: null,
        },
        REMOVED,
      ),
    ).toBe(true);
    expect(
      worktreeFolderIntentReferencesRemoved(importIntent("/wt/gone"), REMOVED),
    ).toBe(true);
  });

  it("qualifies branches by repository so a same-named branch elsewhere survives", () => {
    expect(
      worktreeFolderIntentReferencesRemoved(
        otherRepoBranchIntent("traycer/gone-branch"),
        REMOVED,
      ),
    ).toBe(false);
    // One side identified, the other not: NOT a match. Guessing here would
    // destroy a valid selection in a repo we cannot show is the same one.
    expect(
      worktreeFolderIntentReferencesRemoved(
        {
          ...otherRepoBranchIntent("traycer/gone-branch"),
          repoIdentifier: null,
        },
        REMOVED,
      ),
    ).toBe(false);
  });

  // Both sides unidentifiable is the local-repo-with-no-origin case: the
  // branch name is all either side has, and this is exactly the shape that
  // must still purge - otherwise the swept worktree keeps being offered as an
  // "existing worktree" in new chats, which is the bug the purge exists for.
  it("purges on branch name alone when NEITHER side can identify its repo", () => {
    const removedUnidentified: RemovedWorktreeRefs = {
      worktreePaths: new Set(),
      branches: [{ repoIdentifier: null, branch: "traycer/gone-branch" }],
    };
    expect(
      worktreeFolderIntentReferencesRemoved(
        {
          ...otherRepoBranchIntent("traycer/gone-branch"),
          repoIdentifier: null,
        },
        removedUnidentified,
      ),
    ).toBe(true);
    // ...but an identified intent is still safe from an unidentified removal.
    expect(
      worktreeFolderIntentReferencesRemoved(
        existingBranchIntent("traycer/gone-branch"),
        removedUnidentified,
      ),
    ).toBe(false);
  });

  it("keeps live branches, live imports, new-branch forks, and local intents", () => {
    expect(
      worktreeFolderIntentReferencesRemoved(
        existingBranchIntent("main"),
        REMOVED,
      ),
    ).toBe(false);
    expect(
      worktreeFolderIntentReferencesRemoved(importIntent("/wt/live"), REMOVED),
    ).toBe(false);
    // A NEW branch named like the deleted one recreates it - not stale.
    expect(
      worktreeFolderIntentReferencesRemoved(
        {
          ...existingBranchIntent("x"),
          kind: "worktree",
          branch: {
            type: "new",
            name: "traycer/gone-branch",
            source: "main",
            carryUncommittedChanges: false,
          },
          scripts: null,
        },
        REMOVED,
      ),
    ).toBe(false);
    expect(
      worktreeFolderIntentReferencesRemoved(
        {
          kind: "local",
          workspacePath: "/repo",
          repoIdentifier: null,
          isPrimary: true,
        },
        REMOVED,
      ),
    ).toBe(false);
  });
});

describe("worktree intent purge on sweep completion", () => {
  beforeEach(() => {
    useWorktreeIntentMemoryStore.getState().resetForTests();
    useWorktreeIntentStagingStore.getState().resetForTests();
  });

  it("drops stale per-folder memory and filters per-epic memory entries", () => {
    const memory = useWorktreeIntentMemoryStore.getState();
    memory.setFolderIntent(
      SWEPT_HOST,
      existingBranchIntent("traycer/gone-branch"),
      1,
    );
    memory.setEpicIntent(
      "epic-1",
      SWEPT_HOST,
      {
        entries: [
          existingBranchIntent("traycer/gone-branch"),
          existingBranchIntent("main"),
        ],
      },
      2,
    );
    memory.setEpicIntent(
      "epic-2",
      SWEPT_HOST,
      { entries: [importIntent("/wt/gone")] },
      3,
    );

    useWorktreeIntentMemoryStore
      .getState()
      .purgeRemovedWorktreeIntents(SWEPT_HOST, REMOVED);

    const next = useWorktreeIntentMemoryStore.getState();
    expect(next.getFolderIntent(SWEPT_HOST, "/repo")).toBeNull();
    // The still-valid entry survives; the stale one is filtered out.
    expect(next.getEpicIntent("epic-1", SWEPT_HOST)).toEqual({
      entries: [existingBranchIntent("main")],
    });
    // An epic intent left empty is dropped wholesale.
    expect(next.getEpicIntent("epic-2", SWEPT_HOST)).toBeNull();
  });

  // A sweep is one machine's filesystem event. The identically-named path and
  // branch on another host still materialize there, so purging them would
  // destroy a selection that is perfectly valid.
  it("leaves ANOTHER host's identically-named path and branch untouched", () => {
    const memory = useWorktreeIntentMemoryStore.getState();
    for (const hostId of [SWEPT_HOST, OTHER_HOST]) {
      memory.setFolderIntent(
        hostId,
        existingBranchIntent("traycer/gone-branch"),
        1,
      );
      memory.setEpicIntent(
        "epic-1",
        hostId,
        { entries: [importIntent("/wt/gone")] },
        2,
      );
    }

    useWorktreeIntentMemoryStore
      .getState()
      .purgeRemovedWorktreeIntents(SWEPT_HOST, REMOVED);

    const next = useWorktreeIntentMemoryStore.getState();
    expect(next.getFolderIntent(SWEPT_HOST, "/repo")).toBeNull();
    expect(next.getEpicIntent("epic-1", SWEPT_HOST)).toBeNull();
    expect(next.getFolderIntent(OTHER_HOST, "/repo")).not.toBeNull();
    expect(next.getEpicIntent("epic-1", OTHER_HOST)).not.toBeNull();
  });

  it("does not mint a bucket for a host that remembered nothing", () => {
    useWorktreeIntentMemoryStore
      .getState()
      .purgeRemovedWorktreeIntents(SWEPT_HOST, REMOVED);
    expect(useWorktreeIntentMemoryStore.getState().byHost).toEqual({});
  });

  it("filters staged entries across slots, clearing emptied slots and bumping revisions", () => {
    const staging = useWorktreeIntentStagingStore.getState();
    const staleKey: WorktreeStagingKey = {
      surface: "landing",
      hostId: SWEPT_HOST,
      draftId: null,
    };
    const staleId = worktreeStagingKeyString(staleKey);
    staging.setIntent(staleKey, {
      entries: [existingBranchIntent("traycer/gone-branch")],
    });
    const mixedKey: WorktreeStagingKey = {
      surface: "landing",
      hostId: SWEPT_HOST,
      draftId: "draft-1",
    };
    staging.setIntent(mixedKey, {
      entries: [importIntent("/wt/gone"), existingBranchIntent("main")],
    });
    const revisionBefore =
      useWorktreeIntentStagingStore.getState().revisionByKey[staleId] ?? 0;

    useWorktreeIntentStagingStore
      .getState()
      .purgeRemovedWorktreeIntents(SWEPT_HOST, REMOVED);

    const next = useWorktreeIntentStagingStore.getState();
    // Fully-stale slot cleared like setIntent(null)...
    expect(next.intentByKey[staleId]).toBeUndefined();
    // ...and its revision bumped so a rejected in-flight action can't restore
    // the purged selection.
    expect(next.revisionByKey[staleId] ?? 0).toBeGreaterThan(revisionBefore);
    // Mixed slot keeps only the live entry.
    expect(next.intentByKey[worktreeStagingKeyString(mixedKey)]).toEqual({
      entries: [existingBranchIntent("main")],
    });
  });

  // The staged tier is deliberately never re-validated by the seeding tiers, so
  // an over-broad purge here silently destroys a pick the other machine can
  // still execute.
  it("leaves ANOTHER host's staged slot alone", () => {
    const staging = useWorktreeIntentStagingStore.getState();
    const sweptKey: WorktreeStagingKey = {
      surface: "landing",
      hostId: SWEPT_HOST,
      draftId: null,
    };
    const otherKey: WorktreeStagingKey = {
      surface: "landing",
      hostId: OTHER_HOST,
      draftId: null,
    };
    for (const key of [sweptKey, otherKey]) {
      staging.setIntent(key, {
        entries: [existingBranchIntent("traycer/gone-branch")],
      });
    }

    useWorktreeIntentStagingStore
      .getState()
      .purgeRemovedWorktreeIntents(SWEPT_HOST, REMOVED);

    const next = useWorktreeIntentStagingStore.getState();
    expect(
      next.intentByKey[worktreeStagingKeyString(sweptKey)],
    ).toBeUndefined();
    expect(next.intentByKey[worktreeStagingKeyString(otherKey)]).toEqual({
      entries: [existingBranchIntent("traycer/gone-branch")],
    });
  });

  // The other half of that filter. Pinned separately, because a later
  // tightening to an exact host match would leave a `hostId: null` slot
  // offering a deleted worktree with nothing failing.
  it("purges the unresolved-host staged bucket with the swept host", () => {
    const unresolvedKey: WorktreeStagingKey = {
      surface: "landing",
      hostId: null,
      draftId: null,
    };
    useWorktreeIntentStagingStore.getState().setIntent(unresolvedKey, {
      entries: [existingBranchIntent("traycer/gone-branch")],
    });

    useWorktreeIntentStagingStore
      .getState()
      .purgeRemovedWorktreeIntents(SWEPT_HOST, REMOVED);

    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(unresolvedKey)
      ],
    ).toBeUndefined();
  });
});

describe("withoutResolvedMissingRows", () => {
  function row(
    over: Partial<WorktreeBindingSelectorRowV12> & { runningDir: string },
  ): WorktreeBindingSelectorRowV12 {
    return {
      hostId: "host-1",
      workspacePath: "/repo",
      worktreePath: over.runningDir,
      mode: "worktree",
      isGitRepo: true,
      repoIdentifier: { owner: "acme", repo: "app" },
      branch: "feat/x",
      isPrimary: false,
      isImported: false,
      setupState: "succeeded",
      disabledReason: null,
      sources: [],
      isGitResolvePending: false,
      ...over,
    };
  }

  it("hides host-proven-missing rows but keeps pending and live rows", () => {
    const live = row({ runningDir: "/wt/live" });
    const missing = row({
      runningDir: "/wt/gone",
      disabledReason: "missing_worktree_path",
    });
    const stillChecking = row({
      runningDir: "/wt/checking",
      disabledReason: "missing_worktree_path",
      isGitResolvePending: true,
    });
    expect(
      withoutResolvedMissingRows([live, missing, stillChecking], null),
    ).toEqual([live, stillChecking]);
  });

  it("keeps a resolved-missing row that is the surface's current selection", () => {
    const missing = row({
      runningDir: "/wt/gone",
      disabledReason: "missing_worktree_path",
    });
    expect(
      withoutResolvedMissingRows([missing], {
        hostId: "host-1",
        runningDir: "/wt/gone",
      }),
    ).toEqual([missing]);
  });

  // Rows are keyed by host AND path, so a path-only exemption would keep a
  // dead row from a DIFFERENT host visible alongside the selected one.
  it("exempts only the selected host's row when two hosts share a runningDir", () => {
    const selectedHostRow = row({
      runningDir: "/wt/shared-path",
      disabledReason: "missing_worktree_path",
    });
    const otherHostRow = row({
      hostId: "host-2",
      runningDir: "/wt/shared-path",
      disabledReason: "missing_worktree_path",
    });
    expect(
      withoutResolvedMissingRows([selectedHostRow, otherHostRow], {
        hostId: "host-1",
        runningDir: "/wt/shared-path",
      }),
    ).toEqual([selectedHostRow]);
  });
});
