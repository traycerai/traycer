import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorktreeFolderIntent } from "@traycer/protocol/host/worktree-schemas";
import {
  anyHostHasStagedWorktreeIntent,
  forkChatStagingKeysForEpic,
  newConversationModalStagingKey,
  pendingChildTerminalAgentStagingKey,
  pendingForkChatStagingKey,
  pendingTerminalAgentStagingKey,
  readStagedWorktreeIntent,
  useWorktreeIntentStagingStore,
  worktreeStagingKeyString,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";
import { worktreeIntentStagingKey } from "@/lib/persist";

const HOST_A = "host-a";
const HOST_B = "host-b";

const LANDING_KEY: WorktreeStagingKey = {
  surface: "landing",
  hostId: HOST_A,
  draftId: "draft-1",
};
const OWNER_KEY: WorktreeStagingKey = {
  surface: "owner",
  hostId: HOST_A,
  epicId: "epic-1",
  ownerKind: "chat",
  ownerId: "chat-1",
};

function localEntry(
  workspacePath: string,
  isPrimary: boolean,
): WorktreeFolderIntent {
  return { kind: "local", workspacePath, repoIdentifier: null, isPrimary };
}

function worktreeEntry(workspacePath: string): WorktreeFolderIntent {
  return {
    kind: "worktree",
    scripts: null,
    workspacePath,
    repoIdentifier: null,
    isPrimary: true,
    branch: {
      type: "new",
      name: "feat",
      source: "main",
      carryUncommittedChanges: false,
    },
  };
}

describe("worktree-intent-staging-store", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useWorktreeIntentStagingStore.getState().resetForTests();
  });

  afterEach(() => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    window.localStorage.clear();
  });

  it("serializes keys distinctly per surface, host first", () => {
    expect(worktreeStagingKeyString(LANDING_KEY)).toBe(
      "landing:host-a:draft-1",
    );
    expect(
      worktreeStagingKeyString({
        surface: "landing",
        hostId: HOST_A,
        draftId: null,
      }),
    ).toBe("landing:host-a:");
    // The unresolved-host bucket is an EMPTY segment, which no encoded host id
    // can produce.
    expect(
      worktreeStagingKeyString({
        surface: "landing",
        hostId: null,
        draftId: null,
      }),
    ).toBe("landing::");
    expect(worktreeStagingKeyString(OWNER_KEY)).toBe(
      "owner:host-a:epic-1:chat:chat-1",
    );
  });

  it("stageEntry merges a single folder, normalizing the primary", () => {
    const store = useWorktreeIntentStagingStore.getState();
    store.stageEntry(LANDING_KEY, localEntry("/a", true));
    store.stageEntry(LANDING_KEY, worktreeEntry("/b"));
    const staged = readStagedWorktreeIntent(LANDING_KEY);
    expect(staged?.entries.map((e) => e.workspacePath)).toEqual(["/a", "/b"]);
    // The later primary wins; the earlier entry is demoted.
    expect(
      staged?.entries.find((e) => e.workspacePath === "/a")?.isPrimary,
    ).toBe(false);
  });

  it("stageIntent merges every entry of an intent", () => {
    const store = useWorktreeIntentStagingStore.getState();
    store.stageIntent(LANDING_KEY, {
      entries: [localEntry("/a", false), worktreeEntry("/b")],
    });
    expect(readStagedWorktreeIntent(LANDING_KEY)?.entries).toHaveLength(2);
  });

  it("setIntent replaces, and clears the key on null / empty", () => {
    const store = useWorktreeIntentStagingStore.getState();
    store.stageEntry(LANDING_KEY, worktreeEntry("/b"));
    store.setIntent(LANDING_KEY, { entries: [localEntry("/a", true)] });
    expect(readStagedWorktreeIntent(LANDING_KEY)?.entries).toEqual([
      localEntry("/a", true),
    ]);
    store.setIntent(LANDING_KEY, { entries: [] });
    expect(readStagedWorktreeIntent(LANDING_KEY)).toBeNull();
  });

  it("unstageEntry drops one folder and clears the key once empty", () => {
    const store = useWorktreeIntentStagingStore.getState();
    store.stageEntry(OWNER_KEY, localEntry("/a", true));
    store.stageEntry(OWNER_KEY, worktreeEntry("/b"));
    store.unstageEntry(OWNER_KEY, "/a");
    expect(
      readStagedWorktreeIntent(OWNER_KEY)?.entries.map((e) => e.workspacePath),
    ).toEqual(["/b"]);
    store.unstageEntry(OWNER_KEY, "/b");
    expect(readStagedWorktreeIntent(OWNER_KEY)).toBeNull();
  });

  it("keys the SAME slot separately per host, and reads back per host", () => {
    const store = useWorktreeIntentStagingStore.getState();
    // Identical draft/epic/owner coordinates on two machines. The paths are
    // host-local, so these must not share one slot.
    const onA: WorktreeStagingKey = {
      surface: "landing",
      hostId: HOST_A,
      draftId: "draft-1",
    };
    const onB: WorktreeStagingKey = { ...onA, hostId: HOST_B };
    store.stageEntry(onA, localEntry("/repo", true));
    store.stageEntry(onB, worktreeEntry("/repo"));

    expect(worktreeStagingKeyString(onA)).not.toBe(
      worktreeStagingKeyString(onB),
    );
    expect(readStagedWorktreeIntent(onA)?.entries[0].kind).toBe("local");
    expect(readStagedWorktreeIntent(onB)?.entries[0].kind).toBe("worktree");
  });

  it("keeps the unresolved-host bucket separate from every real host", () => {
    const store = useWorktreeIntentStagingStore.getState();
    const unresolved: WorktreeStagingKey = {
      surface: "landing",
      hostId: null,
      draftId: "draft-1",
    };
    store.stageEntry(unresolved, localEntry("/repo", true));

    expect(
      readStagedWorktreeIntent({ ...unresolved, hostId: HOST_A }),
    ).toBeNull();
    expect(readStagedWorktreeIntent(unresolved)).not.toBeNull();
  });

  // A `:` in a host id must not split the key into a different slot - the same
  // percent-encoding rule the persist-key builders apply to their id segments.
  it("encodes a host id so a colon cannot forge another slot", () => {
    const colonHost: WorktreeStagingKey = {
      surface: "owner",
      hostId: "host:a",
      epicId: "epic-1",
      ownerKind: "chat",
      ownerId: "chat-1",
    };
    const serialized = worktreeStagingKeyString(colonHost);
    expect(serialized).toBe("owner:host%3Aa:epic-1:chat:chat-1");
    expect(serialized).not.toBe(
      worktreeStagingKeyString({ ...colonHost, hostId: "host" }),
    );
  });

  // A slot's host can change under an open session, so both "consume this
  // slot" and "this slot's identity changed" have to act on the whole family -
  // otherwise the host the user drifted away from keeps a live copy.
  describe("across-host slot lifecycle", () => {
    const nullDraftA: WorktreeStagingKey = {
      surface: "landing",
      hostId: HOST_A,
      draftId: null,
    };
    const nullDraftB: WorktreeStagingKey = { ...nullDraftA, hostId: HOST_B };

    it("clearForAllHosts consumes every host's copy of one slot", () => {
      const store = useWorktreeIntentStagingStore.getState();
      store.stageEntry(nullDraftA, localEntry("/a", true));
      store.stageEntry(nullDraftB, localEntry("/b", true));
      store.setSuspendedWorkspacePaths(nullDraftA, ["/a"]);

      // Submitted while B happened to be selected.
      useWorktreeIntentStagingStore.getState().clearForAllHosts(nullDraftB);

      const next = useWorktreeIntentStagingStore.getState();
      expect(readStagedWorktreeIntent(nullDraftA)).toBeNull();
      expect(readStagedWorktreeIntent(nullDraftB)).toBeNull();
      expect(
        next.suspendedWorkspacePathsByKey[worktreeStagingKeyString(nullDraftA)],
      ).toBeUndefined();
    });

    it("clearForAllHosts leaves a DIFFERENT slot identity alone", () => {
      const store = useWorktreeIntentStagingStore.getState();
      const otherDraft: WorktreeStagingKey = { ...nullDraftA, draftId: "keep" };
      store.stageEntry(nullDraftA, localEntry("/a", true));
      store.stageEntry(otherDraft, localEntry("/keep", true));

      useWorktreeIntentStagingStore.getState().clearForAllHosts(nullDraftA);

      expect(readStagedWorktreeIntent(nullDraftA)).toBeNull();
      expect(readStagedWorktreeIntent(otherDraft)).not.toBeNull();
    });

    // Minting the draft id must carry BOTH hosts' picks onto their own
    // destination slots. Moving only the active host's copy loses the other
    // pick AND strands it under the null-draft key, where the next brand-new
    // landing page on that host would inherit it.
    it("migrateKeyForAllHosts moves each host's copy onto its own host", () => {
      const store = useWorktreeIntentStagingStore.getState();
      store.stageEntry(nullDraftA, localEntry("/a", true));
      store.stageEntry(nullDraftB, localEntry("/b", true));

      useWorktreeIntentStagingStore
        .getState()
        .migrateKeyForAllHosts(nullDraftB, {
          ...nullDraftB,
          draftId: "minted",
        });

      const mintedA: WorktreeStagingKey = { ...nullDraftA, draftId: "minted" };
      const mintedB: WorktreeStagingKey = { ...nullDraftB, draftId: "minted" };
      expect(readStagedWorktreeIntent(mintedA)?.entries[0].workspacePath).toBe(
        "/a",
      );
      expect(readStagedWorktreeIntent(mintedB)?.entries[0].workspacePath).toBe(
        "/b",
      );
      // Nothing is stranded under the null-draft key for either host.
      expect(readStagedWorktreeIntent(nullDraftA)).toBeNull();
      expect(readStagedWorktreeIntent(nullDraftB)).toBeNull();
    });

    it("migrateKeyForAllHosts never clobbers a destination that already picked", () => {
      const store = useWorktreeIntentStagingStore.getState();
      const mintedA: WorktreeStagingKey = { ...nullDraftA, draftId: "minted" };
      store.stageEntry(nullDraftA, localEntry("/from", true));
      store.stageEntry(mintedA, localEntry("/already-there", true));

      useWorktreeIntentStagingStore
        .getState()
        .migrateKeyForAllHosts(nullDraftA, mintedA);

      expect(readStagedWorktreeIntent(mintedA)?.entries[0].workspacePath).toBe(
        "/already-there",
      );
      expect(
        readStagedWorktreeIntent(nullDraftA)?.entries[0].workspacePath,
      ).toBe("/from");
    });
  });

  describe("migrateKeyForAllHosts", () => {
    const fromKey: WorktreeStagingKey = {
      surface: "landing",
      hostId: HOST_A,
      draftId: null,
    };
    const toKey: WorktreeStagingKey = {
      surface: "landing",
      hostId: HOST_A,
      draftId: "draft-minted",
    };

    it("moves staged intent and suspended paths, clears the source, and bumps both revisions", () => {
      const store = useWorktreeIntentStagingStore.getState();
      store.stageEntry(fromKey, worktreeEntry("/a"));
      store.setSuspendedWorkspacePaths(fromKey, ["/a"]);
      const fromId = worktreeStagingKeyString(fromKey);
      const toId = worktreeStagingKeyString(toKey);
      const fromRevisionBefore =
        useWorktreeIntentStagingStore.getState().revisionByKey[fromId] ?? 0;
      const toRevisionBefore =
        useWorktreeIntentStagingStore.getState().revisionByKey[toId] ?? 0;

      store.migrateKeyForAllHosts(fromKey, toKey);

      expect(readStagedWorktreeIntent(fromKey)).toBeNull();
      expect(readStagedWorktreeIntent(toKey)?.entries).toEqual([
        worktreeEntry("/a"),
      ]);
      expect(
        useWorktreeIntentStagingStore.getState().suspendedWorkspacePathsByKey[
          fromId
        ],
      ).toBeUndefined();
      expect(
        useWorktreeIntentStagingStore.getState().suspendedWorkspacePathsByKey[
          toId
        ],
      ).toEqual(["/a"]);
      expect(
        useWorktreeIntentStagingStore.getState().revisionByKey[fromId] ?? 0,
      ).toBeGreaterThan(fromRevisionBefore);
      expect(
        useWorktreeIntentStagingStore.getState().revisionByKey[toId] ?? 0,
      ).toBeGreaterThan(toRevisionBefore);
    });

    it("never clobbers an existing destination intent", () => {
      const store = useWorktreeIntentStagingStore.getState();
      store.stageEntry(fromKey, worktreeEntry("/a"));
      store.stageEntry(toKey, localEntry("/b", true));
      store.setSuspendedWorkspacePaths(fromKey, ["/a"]);

      store.migrateKeyForAllHosts(fromKey, toKey);

      expect(readStagedWorktreeIntent(fromKey)?.entries).toEqual([
        worktreeEntry("/a"),
      ]);
      expect(readStagedWorktreeIntent(toKey)?.entries).toEqual([
        localEntry("/b", true),
      ]);
      expect(
        useWorktreeIntentStagingStore.getState().suspendedWorkspacePathsByKey[
          worktreeStagingKeyString(fromKey)
        ],
      ).toEqual(["/a"]);
    });

    it("no-ops when the source key has nothing staged", () => {
      const store = useWorktreeIntentStagingStore.getState();
      store.stageEntry(toKey, localEntry("/b", true));
      const before = useWorktreeIntentStagingStore.getState();

      store.migrateKeyForAllHosts(fromKey, toKey);

      const after = useWorktreeIntentStagingStore.getState();
      expect(after.intentByKey).toEqual(before.intentByKey);
      expect(after.revisionByKey).toEqual(before.revisionByKey);
      expect(after.suspendedWorkspacePathsByKey).toEqual(
        before.suspendedWorkspacePathsByKey,
      );
    });

    it("no-ops when fromKey and toKey serialize identically", () => {
      const store = useWorktreeIntentStagingStore.getState();
      store.stageEntry(fromKey, worktreeEntry("/a"));
      const before = useWorktreeIntentStagingStore.getState();

      store.migrateKeyForAllHosts(fromKey, {
        surface: "landing",
        hostId: HOST_A,
        draftId: null,
      });

      const after = useWorktreeIntentStagingStore.getState();
      expect(after.intentByKey).toEqual(before.intentByKey);
      expect(after.revisionByKey).toEqual(before.revisionByKey);
    });
  });

  it("stageBranchName replaces only the targeted type:new branch name", () => {
    const store = useWorktreeIntentStagingStore.getState();
    store.setIntent(LANDING_KEY, {
      entries: [worktreeEntry("/b"), localEntry("/a", false)],
    });
    store.stageBranchName(LANDING_KEY, "/b", "team/regenerated");
    const staged = readStagedWorktreeIntent(LANDING_KEY);
    const worktree = staged?.entries.find((e) => e.workspacePath === "/b");
    expect(worktree?.kind === "worktree" ? worktree.branch.name : null).toBe(
      "team/regenerated",
    );
    // Local sibling is untouched.
    expect(staged?.entries.find((e) => e.workspacePath === "/a")?.kind).toBe(
      "local",
    );
  });

  it("clear removes only the targeted key", () => {
    const store = useWorktreeIntentStagingStore.getState();
    store.stageEntry(LANDING_KEY, localEntry("/a", true));
    store.stageEntry(OWNER_KEY, localEntry("/b", true));
    store.clear(LANDING_KEY);
    expect(readStagedWorktreeIntent(LANDING_KEY)).toBeNull();
    expect(readStagedWorktreeIntent(OWNER_KEY)).not.toBeNull();
  });

  it("scopes the pending launcher / fork keys per epic (no cross-epic bleed)", () => {
    const store = useWorktreeIntentStagingStore.getState();
    store.stageEntry(
      pendingTerminalAgentStagingKey(HOST_A, "epic-A"),
      worktreeEntry("/a"),
    );
    // A different epic's launcher slot is independent.
    expect(
      readStagedWorktreeIntent(
        pendingTerminalAgentStagingKey(HOST_A, "epic-B"),
      ),
    ).toBeNull();
    expect(
      readStagedWorktreeIntent(
        pendingTerminalAgentStagingKey(HOST_A, "epic-A"),
      ),
    ).not.toBeNull();
    // The launcher and the fork dialog are distinct slots within one epic.
    expect(
      worktreeStagingKeyString(
        pendingTerminalAgentStagingKey(HOST_A, "epic-A"),
      ),
    ).not.toBe(
      worktreeStagingKeyString(pendingForkChatStagingKey(HOST_A, "epic-A")),
    );
  });

  // The fork slot is the one `owner` slot whose host is a live choice rather
  // than a property of its owner: the dialog can retarget while open.
  it("scopes the pending fork-chat key per target host (no cross-host bleed)", () => {
    const store = useWorktreeIntentStagingStore.getState();
    const hostA = pendingForkChatStagingKey("host-a", "epic-A");
    const hostB = pendingForkChatStagingKey("host-b", "epic-A");
    expect(worktreeStagingKeyString(hostA)).not.toBe(
      worktreeStagingKeyString(hostB),
    );
    store.stageEntry(hostA, worktreeEntry("/a"));
    expect(readStagedWorktreeIntent(hostB)).toBeNull();
    expect(readStagedWorktreeIntent(hostA)).not.toBeNull();
  });

  it("enumerates every fork-chat slot for an epic, including snapshot-only extras", () => {
    const store = useWorktreeIntentStagingStore.getState();
    store.stageEntry(
      pendingForkChatStagingKey("host-a", "epic-A"),
      worktreeEntry("/a"),
    );
    const extraB = worktreeStagingKeyString(
      pendingForkChatStagingKey("host-b", "epic-A"),
    );
    const otherEpic = worktreeStagingKeyString(
      pendingForkChatStagingKey("host-c", "epic-B"),
    );
    const keys = forkChatStagingKeysForEpic("epic-A", [extraB, otherEpic]);
    expect(keys.map(worktreeStagingKeyString).sort()).toEqual(
      [
        worktreeStagingKeyString(pendingForkChatStagingKey("host-a", "epic-A")),
        extraB,
      ].sort(),
    );
  });

  // A host id containing the key separator must survive the round trip the
  // enumeration does - it is the only place a serialized key is decoded.
  it("recovers a fork-chat host id that contains the key separator", () => {
    const weird = "host:with:colons";
    const store = useWorktreeIntentStagingStore.getState();
    store.stageEntry(
      pendingForkChatStagingKey(weird, "epic-A"),
      worktreeEntry("/a"),
    );
    const keys = forkChatStagingKeysForEpic("epic-A", []);
    expect(keys).toHaveLength(1);
    expect(keys[0].hostId).toBe(weird);
  });

  it("scopes the per-parent child slot per parent (no concurrent-row collisions)", () => {
    const store = useWorktreeIntentStagingStore.getState();
    store.stageEntry(
      pendingChildTerminalAgentStagingKey(HOST_A, "epic-A", "parent-1"),
      worktreeEntry("/a"),
    );
    // A sibling row (different parent) has an independent slot.
    expect(
      readStagedWorktreeIntent(
        pendingChildTerminalAgentStagingKey(HOST_A, "epic-A", "parent-2"),
      ),
    ).toBeNull();
    expect(
      readStagedWorktreeIntent(
        pendingChildTerminalAgentStagingKey(HOST_A, "epic-A", "parent-1"),
      ),
    ).not.toBeNull();
    // The per-parent slot is distinct from the shared epic launcher slot.
    expect(
      worktreeStagingKeyString(
        pendingChildTerminalAgentStagingKey(HOST_A, "epic-A", "parent-1"),
      ),
    ).not.toBe(
      worktreeStagingKeyString(
        pendingTerminalAgentStagingKey(HOST_A, "epic-A"),
      ),
    );
  });

  it("scopes the new-conversation modal slot per parent (child vs top-level)", () => {
    const store = useWorktreeIntentStagingStore.getState();
    // A top-level create stages under the epic/null slot.
    store.stageEntry(
      newConversationModalStagingKey(HOST_A, "epic-A", null),
      worktreeEntry("/a"),
    );
    // Reopening the modal to add a CHILD reads an independent slot, so it never
    // inherits the top-level (or another parent's) staged worktree intent.
    expect(
      readStagedWorktreeIntent(
        newConversationModalStagingKey(HOST_A, "epic-A", "parent-1"),
      ),
    ).toBeNull();
    expect(
      readStagedWorktreeIntent(
        newConversationModalStagingKey(HOST_A, "epic-A", null),
      ),
    ).not.toBeNull();
    // Different parents get distinct slots.
    expect(
      worktreeStagingKeyString(
        newConversationModalStagingKey(HOST_A, "epic-A", "parent-1"),
      ),
    ).not.toBe(
      worktreeStagingKeyString(
        newConversationModalStagingKey(HOST_A, "epic-A", "parent-2"),
      ),
    );
  });

  it("never persists the per-parent child scratch slot", () => {
    const store = useWorktreeIntentStagingStore.getState();
    store.stageEntry(
      pendingChildTerminalAgentStagingKey(HOST_A, "epic-A", "parent-1"),
      worktreeEntry("/a"),
    );
    const raw = window.localStorage.getItem(worktreeIntentStagingKey(null));
    const persisted =
      raw === null
        ? { state: { intentByKey: {} } }
        : (JSON.parse(raw) as {
            state: { intentByKey: Record<string, unknown> };
          });
    expect(Object.keys(persisted.state.intentByKey)).not.toContain(
      worktreeStagingKeyString(
        pendingChildTerminalAgentStagingKey(HOST_A, "epic-A", "parent-1"),
      ),
    );
    // Still readable in-memory for the open submenu.
    expect(
      readStagedWorktreeIntent(
        pendingChildTerminalAgentStagingKey(HOST_A, "epic-A", "parent-1"),
      ),
    ).not.toBeNull();
  });

  it("persists owner + landing intents to localStorage but not the scratch slots", () => {
    const store = useWorktreeIntentStagingStore.getState();
    store.stageEntry(OWNER_KEY, worktreeEntry("/a"));
    store.stageEntry(LANDING_KEY, localEntry("/b", true));
    store.stageEntry(
      pendingTerminalAgentStagingKey(HOST_A, "epic-A"),
      worktreeEntry("/c"),
    );

    const raw = window.localStorage.getItem(worktreeIntentStagingKey(null));
    expect(raw).not.toBeNull();
    const persisted = JSON.parse(raw ?? "{}") as {
      state: { intentByKey: Record<string, unknown> };
    };
    const keys = Object.keys(persisted.state.intentByKey);
    expect(keys).toContain(worktreeStagingKeyString(OWNER_KEY));
    expect(keys).toContain(worktreeStagingKeyString(LANDING_KEY));
    // The transient launcher scratch slot is staged in-memory but never written.
    expect(keys).not.toContain(
      worktreeStagingKeyString(
        pendingTerminalAgentStagingKey(HOST_A, "epic-A"),
      ),
    );
    expect(
      readStagedWorktreeIntent(
        pendingTerminalAgentStagingKey(HOST_A, "epic-A"),
      ),
    ).not.toBeNull();
  });

  it("restores a persisted pending pick on rehydrate", async () => {
    const ownerId = worktreeStagingKeyString(OWNER_KEY);
    window.localStorage.setItem(
      worktreeIntentStagingKey(null),
      JSON.stringify({
        state: {
          intentByKey: {
            [ownerId]: { entries: [worktreeEntry("/a")] },
          },
        },
        version: 2,
      }),
    );

    await useWorktreeIntentStagingStore.persist.rehydrate();

    expect(readStagedWorktreeIntent(OWNER_KEY)?.entries[0]?.workspacePath).toBe(
      "/a",
    );
  });

  // A v1 key carries no host, so no live key can ever address it again - and
  // leaving it would let the purge read its epic id as a host segment.
  it("drops pre-host-scoping (v1) slots on rehydrate", async () => {
    window.localStorage.setItem(
      worktreeIntentStagingKey(null),
      JSON.stringify({
        state: {
          intentByKey: {
            "owner:epic-1:chat:chat-1": { entries: [worktreeEntry("/a")] },
          },
        },
        version: 1,
      }),
    );

    await useWorktreeIntentStagingStore.persist.rehydrate();

    expect(useWorktreeIntentStagingStore.getState().intentByKey).toEqual({});
  });

  // Pairs with `clearForAllHosts`'s reach: a caller that clears every bucket
  // must ask about every bucket, or it silently drops an intent staged while
  // the surface was pinned to another host (Codex review finding).
  describe("anyHostHasStagedWorktreeIntent", () => {
    const draftA: WorktreeStagingKey = {
      surface: "landing",
      hostId: HOST_A,
      draftId: "draft-9",
    };
    const draftB: WorktreeStagingKey = { ...draftA, hostId: HOST_B };

    it("is true when an intent is staged under the SAME host bucket", () => {
      useWorktreeIntentStagingStore
        .getState()
        .stageEntry(draftA, localEntry("/a", true));

      expect(anyHostHasStagedWorktreeIntent(draftA)).toBe(true);
    });

    it("is true when an intent is staged under a DIFFERENT host bucket for the same slot", () => {
      // Staged while the surface was pinned to host B; asked at host A's
      // bucket for the identical slot.
      useWorktreeIntentStagingStore
        .getState()
        .stageEntry(draftB, localEntry("/b", true));

      expect(anyHostHasStagedWorktreeIntent(draftA)).toBe(true);
      expect(readStagedWorktreeIntent(draftA)).toBeNull();
    });

    it("is false when the slot is empty across every host", () => {
      expect(anyHostHasStagedWorktreeIntent(draftA)).toBe(false);
    });

    it("does not conflate a DIFFERENT slot (draftId, epicId, parentId, surface)", () => {
      useWorktreeIntentStagingStore
        .getState()
        .stageEntry(draftA, localEntry("/a", true));
      // A different draftId, same host - a different `landing` slot.
      const otherDraft: WorktreeStagingKey = {
        ...draftA,
        draftId: "draft-other",
      };
      expect(anyHostHasStagedWorktreeIntent(otherDraft)).toBe(false);

      // A modal slot staged for one epic/parent must not answer for another
      // epic, another parent, or the sibling `owner` surface.
      const modalSlot = newConversationModalStagingKey(HOST_A, "epic-1", null);
      useWorktreeIntentStagingStore
        .getState()
        .stageEntry(modalSlot, localEntry("/modal", true));

      expect(
        anyHostHasStagedWorktreeIntent(
          newConversationModalStagingKey(HOST_A, "epic-2", null),
        ),
      ).toBe(false);
      expect(
        anyHostHasStagedWorktreeIntent(
          newConversationModalStagingKey(HOST_A, "epic-1", "parent-1"),
        ),
      ).toBe(false);
      expect(anyHostHasStagedWorktreeIntent(OWNER_KEY)).toBe(false);
      // The staged slot itself still answers true.
      expect(anyHostHasStagedWorktreeIntent(modalSlot)).toBe(true);
    });
  });
});
