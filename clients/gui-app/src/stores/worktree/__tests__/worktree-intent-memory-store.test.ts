import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  WorktreeFolderIntent,
  WorktreeIntent,
} from "@traycer/protocol/host/worktree-schemas";
import {
  WORKTREE_INTENT_MEMORY_EPIC_CAP,
  WORKTREE_INTENT_MEMORY_FOLDER_CAP,
  migrateWorktreeIntentMemoryPersistedState,
  selectWorktreeIntentMemoryBucket,
  useWorktreeIntentMemoryStore,
} from "@/stores/worktree/worktree-intent-memory-store";
import { worktreeIntentMemoryKey } from "@/lib/persist";

const HOST_A = "host-a";
const HOST_B = "host-b";

function localIntent(workspacePath: string): WorktreeIntent {
  return {
    entries: [
      { kind: "local", workspacePath, repoIdentifier: null, isPrimary: true },
    ],
  };
}

function localFolder(workspacePath: string): WorktreeFolderIntent {
  return {
    kind: "local",
    workspacePath,
    repoIdentifier: null,
    isPrimary: true,
  };
}

function newWorktreeFolder(
  workspacePath: string,
  source: string,
): WorktreeFolderIntent {
  return {
    kind: "worktree",
    scripts: null,
    workspacePath,
    repoIdentifier: null,
    isPrimary: true,
    branch: {
      type: "new",
      name: "feat/x",
      source,
      carryUncommittedChanges: false,
    },
  };
}

function folderEntriesFor(
  hostId: string,
): Readonly<Record<string, { readonly updatedAt: number }>> {
  return selectWorktreeIntentMemoryBucket(
    useWorktreeIntentMemoryStore.getState(),
    hostId,
  ).folderIntentByPath;
}

function epicEntriesFor(
  hostId: string,
): Readonly<Record<string, { readonly updatedAt: number }>> {
  return selectWorktreeIntentMemoryBucket(
    useWorktreeIntentMemoryStore.getState(),
    hostId,
  ).epicIntentByEpicId;
}

describe("useWorktreeIntentMemoryStore", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useWorktreeIntentMemoryStore.getState().resetForTests();
  });

  afterEach(() => {
    useWorktreeIntentMemoryStore.getState().resetForTests();
    window.localStorage.clear();
  });

  it("stores and reads per-folder intent keyed by workspace path", () => {
    const store = useWorktreeIntentMemoryStore.getState();
    store.setFolderIntent(HOST_A, localFolder("/a"), 1);
    expect(
      useWorktreeIntentMemoryStore.getState().getFolderIntent(HOST_A, "/a"),
    ).toEqual(localFolder("/a"));
    expect(
      useWorktreeIntentMemoryStore
        .getState()
        .getFolderIntent(HOST_A, "/missing"),
    ).toBeNull();
  });

  it("keeps the SAME path's folder intent separate per host", () => {
    const store = useWorktreeIntentMemoryStore.getState();
    // `/repo` names a different directory on each machine - the collision the
    // buckets exist to prevent.
    store.setFolderIntent(HOST_A, newWorktreeFolder("/repo", "main"), 1);
    store.setFolderIntent(HOST_B, localFolder("/repo"), 2);

    const next = useWorktreeIntentMemoryStore.getState();
    expect(next.getFolderIntent(HOST_A, "/repo")?.kind).toBe("worktree");
    expect(next.getFolderIntent(HOST_B, "/repo")?.kind).toBe("local");
  });

  it("keeps the SAME epic's intent separate per host", () => {
    const store = useWorktreeIntentMemoryStore.getState();
    // One epic's conversations can live on two hosts; the second write must
    // not overwrite the first host's remembered branches.
    store.setEpicIntent("epic-a", HOST_A, localIntent("/a"), 1);
    store.setEpicIntent("epic-a", HOST_B, localIntent("/b"), 2);

    const next = useWorktreeIntentMemoryStore.getState();
    expect(next.getEpicIntent("epic-a", HOST_A)).toEqual(localIntent("/a"));
    expect(next.getEpicIntent("epic-a", HOST_B)).toEqual(localIntent("/b"));
  });

  it("drops a write with no resolved host and reads nothing back for it", () => {
    const store = useWorktreeIntentMemoryStore.getState();
    store.setFolderIntent(null, localFolder("/a"), 1);
    store.setEpicIntent("epic-a", null, localIntent("/a"), 1);

    const next = useWorktreeIntentMemoryStore.getState();
    expect(next.byHost).toEqual({});
    expect(next.getFolderIntent(null, "/a")).toBeNull();
    expect(next.getEpicIntent("epic-a", null)).toBeNull();
  });

  it("strips the scripts override from a remembered worktree folder", () => {
    const withScripts: WorktreeFolderIntent = {
      kind: "worktree",
      workspacePath: "/a",
      repoIdentifier: null,
      isPrimary: true,
      branch: {
        type: "new",
        name: "feat/x",
        source: "main",
        carryUncommittedChanges: false,
      },
      scripts: {
        setup: { default: "echo hi", macos: null, windows: null, linux: null },
        teardown: { default: "", macos: null, windows: null, linux: null },
      },
    };
    useWorktreeIntentMemoryStore
      .getState()
      .setFolderIntent(HOST_A, withScripts, 1);
    const remembered = useWorktreeIntentMemoryStore
      .getState()
      .getFolderIntent(HOST_A, "/a");
    expect(remembered?.kind).toBe("worktree");
    if (remembered?.kind === "worktree") {
      expect(remembered.scripts).toBeNull();
    }
  });

  it("strips the scripts override from a remembered per-epic worktree entry", () => {
    const withScripts: WorktreeFolderIntent = {
      kind: "worktree",
      workspacePath: "/a",
      repoIdentifier: null,
      isPrimary: true,
      branch: {
        type: "new",
        name: "feat/x",
        source: "main",
        carryUncommittedChanges: false,
      },
      scripts: {
        setup: { default: "echo hi", macos: null, windows: null, linux: null },
        teardown: { default: "", macos: null, windows: null, linux: null },
      },
    };
    useWorktreeIntentMemoryStore
      .getState()
      .setEpicIntent("epic-a", HOST_A, { entries: [withScripts] }, 1);
    const remembered = useWorktreeIntentMemoryStore
      .getState()
      .getEpicIntent("epic-a", HOST_A);
    const entry = remembered?.entries[0];
    expect(entry?.kind).toBe("worktree");
    if (entry?.kind === "worktree") {
      expect(entry.scripts).toBeNull();
    }
  });

  it("evicts the least-recently-updated folder beyond the cap", () => {
    const store = useWorktreeIntentMemoryStore.getState();
    for (
      let index = 0;
      index <= WORKTREE_INTENT_MEMORY_FOLDER_CAP;
      index += 1
    ) {
      store.setFolderIntent(HOST_A, localFolder(`/ws-${index}`), index);
    }
    const entries = folderEntriesFor(HOST_A);
    expect(Object.keys(entries)).toHaveLength(
      WORKTREE_INTENT_MEMORY_FOLDER_CAP,
    );
    expect(Object.hasOwn(entries, "/ws-0")).toBe(false);
    expect(
      Object.hasOwn(entries, `/ws-${WORKTREE_INTENT_MEMORY_FOLDER_CAP}`),
    ).toBe(true);
  });

  it("refreshes folder recency on re-write so a touched folder is not evicted", () => {
    const store = useWorktreeIntentMemoryStore.getState();
    store.setFolderIntent(HOST_A, localFolder("/old"), 0);
    for (let index = 1; index < WORKTREE_INTENT_MEMORY_FOLDER_CAP; index += 1) {
      store.setFolderIntent(HOST_A, localFolder(`/ws-${index}`), index);
    }
    store.setFolderIntent(HOST_A, localFolder("/old"), 10_000);
    store.setFolderIntent(HOST_A, localFolder("/overflow"), 1);
    const entries = folderEntriesFor(HOST_A);
    expect(Object.keys(entries)).toHaveLength(
      WORKTREE_INTENT_MEMORY_FOLDER_CAP,
    );
    expect(Object.hasOwn(entries, "/old")).toBe(true);
  });

  it("gives each host its OWN folder budget instead of sharing one", () => {
    // Guards the defect a flat (path, host) map would reintroduce: filling
    // host A to the cap must not evict anything on host B.
    const store = useWorktreeIntentMemoryStore.getState();
    store.setFolderIntent(HOST_B, localFolder("/b-only"), 1);
    for (
      let index = 0;
      index <= WORKTREE_INTENT_MEMORY_FOLDER_CAP;
      index += 1
    ) {
      store.setFolderIntent(HOST_A, localFolder(`/ws-${index}`), index + 100);
    }
    expect(Object.keys(folderEntriesFor(HOST_A))).toHaveLength(
      WORKTREE_INTENT_MEMORY_FOLDER_CAP,
    );
    expect(Object.keys(folderEntriesFor(HOST_B))).toEqual(["/b-only"]);
  });

  it("gives each host its OWN epic budget instead of sharing one", () => {
    const store = useWorktreeIntentMemoryStore.getState();
    store.setEpicIntent("epic-b-only", HOST_B, localIntent("/b"), 1);
    for (let index = 0; index <= WORKTREE_INTENT_MEMORY_EPIC_CAP; index += 1) {
      store.setEpicIntent(
        `epic-${index}`,
        HOST_A,
        localIntent(`/ws-${index}`),
        index + 100,
      );
    }
    expect(Object.keys(epicEntriesFor(HOST_A))).toHaveLength(
      WORKTREE_INTENT_MEMORY_EPIC_CAP,
    );
    expect(Object.keys(epicEntriesFor(HOST_B))).toEqual(["epic-b-only"]);
  });

  it("stores and reads per-epic intent", () => {
    useWorktreeIntentMemoryStore
      .getState()
      .setEpicIntent("epic-a", HOST_A, localIntent("/a"), 1);
    expect(
      useWorktreeIntentMemoryStore.getState().getEpicIntent("epic-a", HOST_A),
    ).toEqual(localIntent("/a"));
    expect(
      useWorktreeIntentMemoryStore.getState().getEpicIntent("missing", HOST_A),
    ).toBeNull();
  });

  it("evicts the least-recently-updated epic beyond the cap", () => {
    const store = useWorktreeIntentMemoryStore.getState();
    for (let index = 0; index <= WORKTREE_INTENT_MEMORY_EPIC_CAP; index += 1) {
      store.setEpicIntent(
        `epic-${index}`,
        HOST_A,
        localIntent(`/ws-${index}`),
        index,
      );
    }
    const entries = epicEntriesFor(HOST_A);
    expect(Object.keys(entries)).toHaveLength(WORKTREE_INTENT_MEMORY_EPIC_CAP);
    expect(Object.hasOwn(entries, "epic-0")).toBe(false);
    expect(
      Object.hasOwn(entries, `epic-${WORKTREE_INTENT_MEMORY_EPIC_CAP}`),
    ).toBe(true);
  });

  it("clears named epics on EVERY host", () => {
    const store = useWorktreeIntentMemoryStore.getState();
    store.setEpicIntent("epic-a", HOST_A, localIntent("/a"), 1);
    store.setEpicIntent("epic-a", HOST_B, localIntent("/a"), 2);
    store.setEpicIntent("epic-b", HOST_A, localIntent("/b"), 3);
    store.clearEpicIntent(["epic-a"]);
    const next = useWorktreeIntentMemoryStore.getState();
    // A deleted epic is gone account-wide, so its memory must go everywhere -
    // unlike the sweep purge, which is one host's filesystem event.
    expect(next.getEpicIntent("epic-a", HOST_A)).toBeNull();
    expect(next.getEpicIntent("epic-a", HOST_B)).toBeNull();
    expect(next.getEpicIntent("epic-b", HOST_A)).not.toBeNull();
  });

  it("buckets the persist key by email", () => {
    expect(worktreeIntentMemoryKey(null)).toContain(":anon");
    expect(worktreeIntentMemoryKey("a@b.com")).toContain(":a@b.com");
    expect(worktreeIntentMemoryKey("a@b.com")).not.toEqual(
      worktreeIntentMemoryKey("c@d.com"),
    );
  });

  it("round-trips persisted state through localStorage under byHost", () => {
    const store = useWorktreeIntentMemoryStore.getState();
    store.setFolderIntent(HOST_A, newWorktreeFolder("/a", "main"), 5);
    store.setEpicIntent("epic-a", HOST_A, localIntent("/a"), 5);

    const raw = window.localStorage.getItem(worktreeIntentMemoryKey(null));
    expect(raw).not.toBeNull();
    const persisted = JSON.parse(raw ?? "{}") as {
      state: {
        byHost: Record<
          string,
          {
            folderIntentByPath: Record<string, unknown>;
            epicIntentByEpicId: Record<string, unknown>;
          }
        >;
      };
    };
    expect(Object.keys(persisted.state.byHost)).toEqual([HOST_A]);
    expect(
      Object.keys(persisted.state.byHost[HOST_A].folderIntentByPath),
    ).toEqual(["/a"]);
    expect(
      Object.keys(persisted.state.byHost[HOST_A].epicIntentByEpicId),
    ).toEqual(["epic-a"]);
  });
});

describe("migrateWorktreeIntentMemoryPersistedState", () => {
  it("freezes v1's flat maps as the read-only legacy fallback", () => {
    const migrated = migrateWorktreeIntentMemoryPersistedState({
      folderIntentByPath: {
        "/a": { intent: localFolder("/a"), updatedAt: 7 },
      },
      epicIntentByEpicId: {
        "epic-a": { intent: localIntent("/a"), updatedAt: 8 },
      },
    });
    expect(migrated.byHost).toEqual({});
    expect(migrated.legacyFolderIntentByPath["/a"].intent).toEqual(
      localFolder("/a"),
    );
    expect(migrated.legacyEpicIntentByEpicId["epic-a"].intent).toEqual(
      localIntent("/a"),
    );
  });

  it("drops a v1 row whose key disagrees with the intent it holds", () => {
    const migrated = migrateWorktreeIntentMemoryPersistedState({
      folderIntentByPath: {
        // Keyed `/a` but remembering `/b` - seeding `/a` from it would apply
        // another folder's choice.
        "/a": { intent: localFolder("/b"), updatedAt: 1 },
      },
    });
    expect(migrated.legacyFolderIntentByPath).toEqual({});
  });

  it("drops v1 rows with an unparseable intent or timestamp", () => {
    const migrated = migrateWorktreeIntentMemoryPersistedState({
      folderIntentByPath: {
        "/a": { intent: { kind: "nonsense" }, updatedAt: 1 },
        "/b": { intent: localFolder("/b"), updatedAt: "soon" },
        "/c": { intent: localFolder("/c"), updatedAt: 3 },
      },
      epicIntentByEpicId: {
        "epic-empty": { intent: { entries: [] }, updatedAt: 1 },
      },
    });
    expect(Object.keys(migrated.legacyFolderIntentByPath)).toEqual(["/c"]);
    expect(migrated.legacyEpicIntentByEpicId).toEqual({});
  });

  it("returns empty state for a non-record payload", () => {
    const migrated = migrateWorktreeIntentMemoryPersistedState(null);
    expect(migrated).toEqual({
      byHost: {},
      legacyFolderIntentByPath: {},
      legacyEpicIntentByEpicId: {},
    });
  });
});

describe("worktree intent memory rehydration", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useWorktreeIntentMemoryStore.getState().resetForTests();
  });

  afterEach(() => {
    useWorktreeIntentMemoryStore.getState().resetForTests();
    window.localStorage.clear();
  });

  async function rehydrateV1Blob(): Promise<void> {
    window.localStorage.setItem(
      worktreeIntentMemoryKey(null),
      JSON.stringify({
        version: 1,
        state: {
          folderIntentByPath: {
            "/repo": {
              intent: newWorktreeFolder("/repo", "main"),
              updatedAt: 1,
            },
            "/other": { intent: localFolder("/other"), updatedAt: 1 },
          },
          epicIntentByEpicId: {
            "epic-a": { intent: localIntent("/repo"), updatedAt: 1 },
          },
        },
      }),
    );
    await useWorktreeIntentMemoryStore.persist.rehydrate();
  }

  it("migrates a v1 blob and answers for any host until one acts", async () => {
    await rehydrateV1Blob();

    const migrated = useWorktreeIntentMemoryStore.getState();
    expect(migrated.byHost).toEqual({});
    expect(migrated.getFolderIntent(HOST_A, "/repo")?.kind).toBe("worktree");
    expect(migrated.getFolderIntent(HOST_B, "/repo")?.kind).toBe("worktree");
    expect(migrated.getEpicIntent("epic-a", HOST_B)).toEqual(
      localIntent("/repo"),
    );
  });

  it("hands the whole legacy tier to the first host that records a choice", async () => {
    await rehydrateV1Blob();
    useWorktreeIntentMemoryStore
      .getState()
      .setFolderIntent(HOST_B, localFolder("/repo"), 2);

    const after = useWorktreeIntentMemoryStore.getState();
    // The acting host keeps its own decision AND inherits the untouched keys.
    expect(after.getFolderIntent(HOST_B, "/repo")?.kind).toBe("local");
    expect(after.getFolderIntent(HOST_B, "/other")?.kind).toBe("local");
    expect(after.getEpicIntent("epic-a", HOST_B)).toEqual(localIntent("/repo"));
    // The tier is retired, so no other host reads it again.
    expect(after.legacyFolderIntentByPath).toEqual({});
    expect(after.legacyEpicIntentByEpicId).toEqual({});
    expect(after.getFolderIntent(HOST_A, "/repo")).toBeNull();
    expect(after.getEpicIntent("epic-a", HOST_A)).toBeNull();
  });

  // Regression: with a shared legacy tier, purging the host entry that
  // SUPERSEDED a legacy choice fell back to the superseded choice and
  // silently re-seeded it.
  it("never resurfaces a superseded legacy choice after a purge", async () => {
    await rehydrateV1Blob();
    const store = useWorktreeIntentMemoryStore.getState();
    // Host A supersedes the legacy `/repo` choice with a branch of its own...
    store.setFolderIntent(
      HOST_A,
      {
        kind: "worktree",
        scripts: null,
        workspacePath: "/repo",
        repoIdentifier: null,
        isPrimary: true,
        branch: { type: "existing", name: "feat/superseding" },
      },
      2,
    );
    // ...which a sweep then removes. The legacy entry named a DIFFERENT
    // branch, so a predicate-based legacy purge would have left it readable.
    useWorktreeIntentMemoryStore
      .getState()
      .purgeRemovedWorktreeIntents(HOST_A, {
        worktreePaths: new Set(),
        branches: [{ repoIdentifier: null, branch: "feat/superseding" }],
      });

    const after = useWorktreeIntentMemoryStore.getState();
    expect(after.getFolderIntent(HOST_A, "/repo")).toBeNull();
    expect(after.legacyFolderIntentByPath).toEqual({});
  });

  it("adopts the legacy tier into the swept host rather than dropping it", async () => {
    await rehydrateV1Blob();
    // No host has written yet; the sweep itself is the first act.
    useWorktreeIntentMemoryStore
      .getState()
      .purgeRemovedWorktreeIntents(HOST_A, {
        worktreePaths: new Set(),
        branches: [{ repoIdentifier: null, branch: "main" }],
      });

    const after = useWorktreeIntentMemoryStore.getState();
    // `/repo` forked from the removed `main`, so it goes; `/other` is local
    // and survives - in HOST_A's bucket, no longer readable by HOST_B.
    expect(after.getFolderIntent(HOST_A, "/repo")).toBeNull();
    expect(after.getFolderIntent(HOST_A, "/other")?.kind).toBe("local");
    expect(after.getFolderIntent(HOST_B, "/other")).toBeNull();
    expect(after.legacyFolderIntentByPath).toEqual({});
  });

  it("re-validates and re-caps a v2 payload on rehydration", async () => {
    const oversized = Object.fromEntries(
      Array.from({ length: WORKTREE_INTENT_MEMORY_FOLDER_CAP + 5 }, (_, i) => [
        `/ws-${i}`,
        { intent: localFolder(`/ws-${i}`), updatedAt: i },
      ]),
    );
    window.localStorage.setItem(
      worktreeIntentMemoryKey(null),
      JSON.stringify({
        version: 2,
        state: {
          byHost: {
            [HOST_A]: {
              folderIntentByPath: {
                ...oversized,
                // Corrupt rows must not survive a hand-edited payload.
                "/bad-key": { intent: localFolder("/other"), updatedAt: 9_999 },
              },
              epicIntentByEpicId: {},
            },
            [HOST_B]: { folderIntentByPath: {}, epicIntentByEpicId: {} },
          },
          legacyFolderIntentByPath: {},
          legacyEpicIntentByEpicId: {},
        },
      }),
    );
    await useWorktreeIntentMemoryStore.persist.rehydrate();

    const entries = folderEntriesFor(HOST_A);
    expect(Object.keys(entries)).toHaveLength(
      WORKTREE_INTENT_MEMORY_FOLDER_CAP,
    );
    expect(Object.hasOwn(entries, "/bad-key")).toBe(false);
    expect(Object.hasOwn(entries, "/ws-0")).toBe(false);
    // An all-empty bucket is not kept.
    expect(
      Object.hasOwn(useWorktreeIntentMemoryStore.getState().byHost, HOST_B),
    ).toBe(false);
  });
});
