/**
 * Direct projector parity + identity tests. Drives the projector by
 * mutating a Y.Doc through the public store API and asserting the
 * projected slices match a reference projection of the live doc.
 */
import "../../../../../__tests__/test-browser-apis";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createArtifactInDocForTests } from "./projection-helpers-test-shims";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";
import { projectFullState } from "@/stores/epics/open-epic/projection-helpers";
import { useAuthStore } from "@/stores/auth/auth-store";

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: "epic-test",
      title: "Epic test",
      initialUserPrompt: "",
      ticketCount: 0,
      specCount: 0,
      storyCount: 0,
      reviewCount: 0,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      createdBy: "u",
      version: "1",
    },
    permissionRole: "editor",
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: encodeBase64(Y.encodeStateVector(new Y.Doc())),
  };
}

function newSession(): {
  handle: OpenEpicStoreHandle;
  callbacks: EpicStreamCallbacks;
} {
  const captured: { value: EpicStreamCallbacks | null } = { value: null };
  const factory: EpicStreamClientFactory = (_id, callbacks) => {
    captured.value = callbacks;
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    };
  };
  const handle = createOpenEpicStore({
    epicId: "epic-test",
    streamClientFactory: factory,
    userId: null,
    onAuthError: null,
  });
  if (captured.value === null) throw new Error("factory not invoked");
  // Send an empty snapshot with editor role so mutation actions run.
  const seed = Y.encodeStateAsUpdate(new Y.Doc());
  captured.value.onSnapshot(makeMeta(), seed);
  return { handle, callbacks: captured.value };
}

function makeChatEntry(
  id: string,
  userId: string | null,
  title: string,
): Y.Map<unknown> {
  const chat = new Y.Map<unknown>();
  chat.set("id", id);
  chat.set("title", title);
  chat.set("parentId", null);
  chat.set("createdAt", 1);
  chat.set("updatedAt", 1);
  if (userId !== null) chat.set("userId", userId);
  return chat;
}

function makeTerminalAgentEntry(
  id: string,
  userId: string | null,
  title: string,
): Y.Map<unknown> {
  const agent = new Y.Map<unknown>();
  agent.set("id", id);
  agent.set("harnessId", "codex");
  agent.set("title", title);
  agent.set("parentId", null);
  agent.set("createdAt", 1);
  agent.set("updatedAt", 1);
  if (userId !== null) agent.set("userId", userId);
  agent.set("hostId", "host-1");
  agent.set("workspaceFolders", ["/repo"]);
  agent.set("model", null);
  agent.set("reasoningEffort", null);
  agent.set("agentMode", "regular");
  agent.set("harnessSessionId", null);
  agent.set("terminalShellCommand", null);
  agent.set("terminalShellArgs", null);
  return agent;
}

/**
 * Build a deleted-artifact tombstone entry exactly as the host writes it into
 * `epic.deletedArtifacts`. `status` is only set for ticket/story (spec/review
 * pass null), mirroring `projectDeletedArtifact`.
 */
function makeTombstone(args: {
  id: string;
  kind: EpicArtifactKind;
  title: string;
  deletedAt: string;
  status: number | null;
}): Y.Map<unknown> {
  const entry = new Y.Map<unknown>();
  entry.set("id", args.id);
  entry.set("kind", args.kind);
  entry.set("title", args.title);
  entry.set("deletedAt", args.deletedAt);
  if (args.status !== null) entry.set("status", args.status);
  return entry;
}

describe("epic-projector", () => {
  it("starts with empty projected slices", () => {
    const { handle } = newSession();
    const state = handle.store.getState();
    expect(state.artifacts.allIds).toEqual([]);
    expect(state.chats.allIds).toEqual([]);
    expect(state.tree.rootIds).toEqual([]);
    expect(Object.keys(state.contentRevByArtifactId)).toEqual([]);
    expect(state.epic.title).toBe("");
    handle.dispose();
  });

  it("a seeded artifact populates artifacts.byId, allIds and the tree", () => {
    const { handle } = newSession();
    const id = createArtifactInDocForTests(handle.doc, "spec", null);
    const state = handle.store.getState();
    expect(state.artifacts.allIds).toContain(id);
    expect(state.artifacts.byId[id].kind).toBe("spec");
    expect(state.artifacts.byId[id].title).toBe("New spec");
    expect(state.artifacts.byId[id].artifactRoomId).toBeNull();
    expect(state.tree.rootIds).toContain(id);
    expect(state.tree.nodeById[id].type).toBe("spec");
    handle.dispose();
  });

  it("projects artifactRoomId metadata without changing tree display fields", () => {
    const { handle } = newSession();
    const id = createArtifactInDocForTests(handle.doc, "spec", null);
    const artifactBefore = handle.store.getState().artifacts.byId[id];
    const treeBefore = handle.store.getState().tree;

    const artifacts = handle.doc.getMap("epic").get("artifacts");
    if (!(artifacts instanceof Y.Map)) {
      throw new Error("expected artifacts map");
    }
    const artifactsMap: Y.Map<unknown> = artifacts;
    const entry = artifactsMap.get(id);
    if (!(entry instanceof Y.Map)) {
      throw new Error("expected artifact entry");
    }
    const entryMap: Y.Map<unknown> = entry;
    entryMap.set("artifactRoomId", "artifact-room-0");

    const state = handle.store.getState();
    expect(state.artifacts.byId[id]).not.toBe(artifactBefore);
    expect(state.artifacts.byId[id].artifactRoomId).toBe("artifact-room-0");
    expect(state.tree).toBe(treeBefore);
    handle.dispose();
  });

  it("rename only re-allocates the renamed slot; siblings keep ===", () => {
    const { handle } = newSession();
    const a = createArtifactInDocForTests(handle.doc, "spec", null);
    const b = createArtifactInDocForTests(handle.doc, "ticket", null);
    const beforeA = handle.store.getState().artifacts.byId[a];
    const beforeB = handle.store.getState().artifacts.byId[b];

    handle.store.getState().renameArtifact(a, "Renamed A");

    const afterA = handle.store.getState().artifacts.byId[a];
    const afterB = handle.store.getState().artifacts.byId[b];
    expect(afterA).not.toBe(beforeA);
    expect(afterA.title).toBe("Renamed A");
    expect(afterB).toBe(beforeB);
    handle.dispose();
  });

  it("title edit does not invalidate tree rootIds when set is unchanged", () => {
    const { handle } = newSession();
    const a = createArtifactInDocForTests(handle.doc, "spec", null);
    const treeBefore = handle.store.getState().tree;

    handle.store.getState().renameArtifact(a, "Renamed");

    const treeAfter = handle.store.getState().tree;
    // rootIds membership unchanged → reference preserved
    expect(treeAfter.rootIds).toBe(treeBefore.rootIds);
    handle.dispose();
  });

  it("structural change (parent move) updates childrenByParent buckets", () => {
    const { handle } = newSession();
    const parent = createArtifactInDocForTests(handle.doc, "spec", null);
    const child = createArtifactInDocForTests(handle.doc, "ticket", null);

    handle.store.getState().reparentArtifact(child, parent);

    const tree = handle.store.getState().tree;
    expect(tree.rootIds).toContain(parent);
    expect(tree.rootIds).not.toContain(child);
    expect(tree.childrenByParent[parent]).toContain(child);
    handle.dispose();
  });

  it("delete preserves artifact child parent links for host cascade", () => {
    const { handle } = newSession();
    const root = createArtifactInDocForTests(handle.doc, "spec", null);
    const mid = createArtifactInDocForTests(handle.doc, "spec", root);
    const leaf = createArtifactInDocForTests(handle.doc, "ticket", mid);
    const chat = createArtifactInDocForTests(handle.doc, "chat", mid);

    handle.store.getState().deleteArtifact(mid);

    const state = handle.store.getState();
    expect(Object.hasOwn(state.artifacts.byId, mid)).toBe(false);
    expect(state.artifacts.byId[leaf].parentId).toBe(mid);
    expect(state.tree.rootIds).toContain(leaf);
    expect(state.tree.childrenByParent[root] ?? []).not.toContain(leaf);
    expect(state.chats.byId[chat].parentId).toBe(root);
    handle.dispose();
  });

  it("chat creation populates chats slice and tree as a chat node", () => {
    const { handle } = newSession();
    const id = createArtifactInDocForTests(handle.doc, "chat", null);
    const state = handle.store.getState();
    expect(state.chats.allIds).toContain(id);
    expect(state.chats.byId[id].title).toBe("New chat");
    expect(state.tree.nodeById[id].type).toBe("chat");
    handle.dispose();
  });

  it("setEpicTitle updates epic.title slice only", () => {
    const { handle } = newSession();
    const before = handle.store.getState();
    const beforeArtifacts = before.artifacts;

    handle.store.getState().setEpicTitle("New Title");

    const after = handle.store.getState();
    expect(after.epic.title).toBe("New Title");
    // Unrelated slices stay reference-stable
    expect(after.artifacts).toBe(beforeArtifacts);
    handle.dispose();
  });

  it("projected slices match a fresh full projection of the live Y.Doc", () => {
    const { handle } = newSession();
    const a = createArtifactInDocForTests(handle.doc, "spec", null);
    const b = createArtifactInDocForTests(handle.doc, "ticket", a);
    const c = createArtifactInDocForTests(handle.doc, "chat", null);
    handle.store.getState().setEpicTitle("Parity Check");
    handle.store.getState().renameArtifact(b, "Ticket B");
    void a;
    void c;

    const live = projectFullState(handle.doc, null);
    const state = handle.store.getState();

    expect(state.epic).toEqual(live.epic);
    expect(state.artifacts.allIds.slice().sort()).toEqual(
      live.artifacts.allIds.slice().sort(),
    );
    for (const id of live.artifacts.allIds) {
      expect(state.artifacts.byId[id]).toEqual(live.artifacts.byId[id]);
    }
    expect(state.chats.allIds).toEqual(live.chats.allIds);
    expect(state.tree.rootIds.slice().sort()).toEqual(
      live.tree.rootIds.slice().sort(),
    );
    handle.dispose();
  });

  it("hides chats owned by a different user across chats and tree", () => {
    const doc = new Y.Doc();
    const chats = new Y.Map<unknown>();
    chats.set("mine", makeChatEntry("mine", "user-a", "Mine"));
    chats.set("theirs", makeChatEntry("theirs", "user-b", "Theirs"));
    // No userId yet: the optimistic local create writes the chat before the
    // host backfills the owner. Must stay visible to its creator.
    chats.set("orphan", makeChatEntry("orphan", null, "Orphan"));
    doc.getMap("epic").set("chats", chats);

    // Signed in as user-a: their own chat + the unowned chat show; user-b's
    // chat is hidden from every derived slice.
    const mine = projectFullState(doc, "user-a");
    expect(mine.chats.allIds.slice().sort()).toEqual(["mine", "orphan"]);
    expect(Object.keys(mine.chats.byId).sort()).toEqual(["mine", "orphan"]);
    expect(mine.tree.rootIds.slice().sort()).toEqual(["mine", "orphan"]);

    // Fail open when the signed-in user is unknown (hydrating): show everything.
    const anon = projectFullState(doc, null);
    expect(anon.chats.allIds.slice().sort()).toEqual([
      "mine",
      "orphan",
      "theirs",
    ]);

    doc.destroy();
  });

  it("hides terminal agents owned by a different user across tuiAgents and tree", () => {
    const doc = new Y.Doc();
    const tuiAgents = new Y.Map<unknown>();
    tuiAgents.set("mine", makeTerminalAgentEntry("mine", "user-a", "Mine"));
    tuiAgents.set(
      "theirs",
      makeTerminalAgentEntry("theirs", "user-b", "Theirs"),
    );
    // Legacy/mid-create records without `userId` fail open like chats.
    tuiAgents.set("legacy", makeTerminalAgentEntry("legacy", null, "Legacy"));
    doc.getMap("epic").set("tuiAgents", tuiAgents);

    const mine = projectFullState(doc, "user-a");
    expect(mine.tuiAgents.allIds.slice().sort()).toEqual(["legacy", "mine"]);
    expect(Object.keys(mine.tuiAgents.byId).sort()).toEqual(["legacy", "mine"]);
    expect(mine.tree.rootIds.slice().sort()).toEqual(["legacy", "mine"]);
    expect(mine.tree.nodeById.theirs).toBeUndefined();

    const anon = projectFullState(doc, null);
    expect(anon.tuiAgents.allIds.slice().sort()).toEqual([
      "legacy",
      "mine",
      "theirs",
    ]);

    doc.destroy();
  });

  it("hides a foreign chat arriving via an incremental update", () => {
    // Drives the INCREMENTAL projector path (observeDeep -> applyPatches), not
    // the snapshot path, so it guards the ownership filter in applyPatches.
    useAuthStore
      .getState()
      .setSignedIn(
        { userId: "user-a", userName: "A", email: "a@example.com" },
        { userId: "user-a", username: "A" },
        [],
      );
    try {
      const { handle } = newSession();
      // A collaborator (user-b) adds a chat with a message after the snapshot.
      // newSession seeds an empty doc, so the chats container is created fresh.
      handle.doc.transact(() => {
        const chats = new Y.Map<unknown>();
        const chat = new Y.Map<unknown>();
        chat.set("id", "theirs");
        chat.set("title", "Theirs");
        chat.set("parentId", null);
        chat.set("createdAt", 1);
        chat.set("updatedAt", 1);
        chat.set("userId", "user-b");
        chats.set("theirs", chat);
        handle.doc.getMap("epic").set("chats", chats);
      });

      const state = handle.store.getState();
      expect(state.chats.byId.theirs).toBeUndefined();
      expect(state.tree.nodeById.theirs).toBeUndefined();
      handle.dispose();
    } finally {
      useAuthStore.getState().setSignedOut();
    }
  });

  it("hides a foreign terminal agent arriving via an incremental update", () => {
    useAuthStore
      .getState()
      .setSignedIn(
        { userId: "user-a", userName: "A", email: "a@example.com" },
        { userId: "user-a", username: "A" },
        [],
      );
    try {
      const { handle } = newSession();
      handle.doc.transact(() => {
        const tuiAgents = new Y.Map<unknown>();
        tuiAgents.set(
          "theirs",
          makeTerminalAgentEntry("theirs", "user-b", "Theirs"),
        );
        handle.doc.getMap("epic").set("tuiAgents", tuiAgents);
      });

      const state = handle.store.getState();
      expect(state.tuiAgents.byId.theirs).toBeUndefined();
      expect(state.tree.nodeById.theirs).toBeUndefined();
      handle.dispose();
    } finally {
      useAuthStore.getState().setSignedOut();
    }
  });

  it("reprojects when auth user id hydrates after an initial fail-open projection", () => {
    useAuthStore.getState().setSignedOut();
    const { handle } = newSession();
    try {
      handle.doc.transact(() => {
        const chats = new Y.Map<unknown>();
        chats.set("theirs", makeChatEntry("theirs", "user-b", "Theirs"));
        const tuiAgents = new Y.Map<unknown>();
        tuiAgents.set(
          "their-agent",
          makeTerminalAgentEntry("their-agent", "user-b", "Their agent"),
        );
        handle.doc.getMap("epic").set("chats", chats);
        handle.doc.getMap("epic").set("tuiAgents", tuiAgents);
      });

      expect(handle.store.getState().chats.byId.theirs).toBeDefined();
      expect(
        handle.store.getState().tuiAgents.byId["their-agent"],
      ).toBeDefined();

      useAuthStore
        .getState()
        .setSignedIn(
          { userId: "user-a", userName: "A", email: "a@example.com" },
          { userId: "user-a", username: "A" },
          [],
        );

      const state = handle.store.getState();
      expect(state.chats.byId.theirs).toBeUndefined();
      expect(state.tuiAgents.byId["their-agent"]).toBeUndefined();
      expect(state.tree.nodeById.theirs).toBeUndefined();
      expect(state.tree.nodeById["their-agent"]).toBeUndefined();
    } finally {
      handle.dispose();
      useAuthStore.getState().setSignedOut();
    }
  });

  it("rebuilds the tree only when a chat userId change alters visible membership", () => {
    useAuthStore
      .getState()
      .setSignedIn(
        { userId: "user-a", userName: "A", email: "a@example.com" },
        { userId: "user-a", username: "A" },
        [],
      );
    const { handle } = newSession();
    try {
      const chats = new Y.Map<unknown>();
      const mine = makeChatEntry("mine", null, "Mine");
      const theirs = makeChatEntry("theirs", "user-b", "Theirs");
      chats.set("mine", mine);
      chats.set("theirs", theirs);
      handle.doc.getMap("epic").set("chats", chats);

      const treeBeforeVisibleBackfill = handle.store.getState().tree;
      mine.set("userId", "user-a");
      expect(handle.store.getState().tree).toBe(treeBeforeVisibleBackfill);

      const treeBeforeMembershipChange = handle.store.getState().tree;
      theirs.set("userId", "user-a");
      const treeAfterMembershipChange = handle.store.getState().tree;
      expect(treeAfterMembershipChange).not.toBe(treeBeforeMembershipChange);
      expect(treeAfterMembershipChange.nodeById.theirs).toBeDefined();
    } finally {
      handle.dispose();
      useAuthStore.getState().setSignedOut();
    }
  });

  it("rebuilds the tree only when a terminal-agent userId change alters visible membership", () => {
    useAuthStore
      .getState()
      .setSignedIn(
        { userId: "user-a", userName: "A", email: "a@example.com" },
        { userId: "user-a", username: "A" },
        [],
      );
    const { handle } = newSession();
    try {
      const tuiAgents = new Y.Map<unknown>();
      const mine = makeTerminalAgentEntry("mine", null, "Mine");
      const theirs = makeTerminalAgentEntry("theirs", "user-b", "Theirs");
      tuiAgents.set("mine", mine);
      tuiAgents.set("theirs", theirs);
      handle.doc.getMap("epic").set("tuiAgents", tuiAgents);

      const treeBeforeVisibleBackfill = handle.store.getState().tree;
      mine.set("userId", "user-a");
      expect(handle.store.getState().tree).toBe(treeBeforeVisibleBackfill);

      const treeBeforeMembershipChange = handle.store.getState().tree;
      theirs.set("userId", "user-a");
      const treeAfterMembershipChange = handle.store.getState().tree;
      expect(treeAfterMembershipChange).not.toBe(treeBeforeMembershipChange);
      expect(treeAfterMembershipChange.nodeById.theirs).toBeDefined();
    } finally {
      handle.dispose();
      useAuthStore.getState().setSignedOut();
    }
  });

  it("hides a chat when a userId flip makes it foreign", () => {
    useAuthStore
      .getState()
      .setSignedIn(
        { userId: "user-a", userName: "A", email: "a@example.com" },
        { userId: "user-a", username: "A" },
        [],
      );
    const { handle } = newSession();
    try {
      const ghost = makeChatEntry("ghost", null, "Ghost");
      handle.doc.transact(() => {
        const chats = new Y.Map<unknown>();
        chats.set("ghost", ghost);
        handle.doc.getMap("epic").set("chats", chats);
      });

      const before = handle.store.getState();
      expect(before.chats.byId.ghost).toBeDefined();

      // Owner is backfilled to a different user: visibility flips to hidden via
      // a metadata-only change.
      ghost.set("userId", "user-b");

      const after = handle.store.getState();
      expect(after.chats.byId.ghost).toBeUndefined();
      expect(after.tree.nodeById.ghost).toBeUndefined();
    } finally {
      handle.dispose();
      useAuthStore.getState().setSignedOut();
    }
  });

  it("projects tombstones into deletedArtifacts.byId and allIds with the projection shape", () => {
    const { handle } = newSession();
    handle.doc.transact(() => {
      const tombstones = new Y.Map<unknown>();
      tombstones.set(
        "ticket-1",
        makeTombstone({
          id: "ticket-1",
          kind: "ticket",
          title: "Old ticket",
          deletedAt: "2026-06-10T00:00:00Z",
          status: 2,
        }),
      );
      tombstones.set(
        "spec-1",
        makeTombstone({
          id: "spec-1",
          kind: "spec",
          title: "Old spec",
          deletedAt: "2026-06-09T00:00:00Z",
          status: null,
        }),
      );
      handle.doc.getMap("epic").set("deletedArtifacts", tombstones);
    });

    const state = handle.store.getState();
    expect(state.deletedArtifacts.allIds.slice().sort()).toEqual([
      "spec-1",
      "ticket-1",
    ]);
    expect(state.deletedArtifacts.byId["ticket-1"]).toEqual({
      id: "ticket-1",
      kind: "ticket",
      title: "Old ticket",
      deletedAt: "2026-06-10T00:00:00Z",
      status: 2,
    });
    // spec/review tombstones carry a null status.
    expect(state.deletedArtifacts.byId["spec-1"].status).toBeNull();
    handle.dispose();
  });

  it("reflects a tombstone status update and removal in the slice", () => {
    const { handle } = newSession();
    const tombstones = new Y.Map<unknown>();
    const entry = makeTombstone({
      id: "t1",
      kind: "ticket",
      title: "T",
      deletedAt: "2026-06-10T00:00:00Z",
      status: 0,
    });
    handle.doc.transact(() => {
      tombstones.set("t1", entry);
      handle.doc.getMap("epic").set("deletedArtifacts", tombstones);
    });

    const before = handle.store.getState().deletedArtifacts;
    expect(before.byId.t1.status).toBe(0);

    // In-place status update on the live tombstone entry.
    entry.set("status", 2);
    const afterUpdate = handle.store.getState().deletedArtifacts;
    expect(afterUpdate.byId.t1.status).toBe(2);
    expect(afterUpdate.byId.t1).not.toBe(before.byId.t1);

    // Removing the entry drops it from byId and allIds.
    tombstones.delete("t1");
    const afterRemove = handle.store.getState().deletedArtifacts;
    expect(Object.hasOwn(afterRemove.byId, "t1")).toBe(false);
    expect(afterRemove.allIds).not.toContain("t1");
    handle.dispose();
  });

  it("a tombstone-only change does not rebuild the live artifact tree or byId", () => {
    const { handle } = newSession();
    const live = createArtifactInDocForTests(handle.doc, "spec", null);

    const treeBefore = handle.store.getState().tree;
    const artifactsBefore = handle.store.getState().artifacts;
    const byIdBefore = artifactsBefore.byId;

    handle.doc.transact(() => {
      const tombstones = new Y.Map<unknown>();
      tombstones.set(
        "gone",
        makeTombstone({
          id: "gone",
          kind: "ticket",
          title: "Gone",
          deletedAt: "2026-06-10T00:00:00Z",
          status: 1,
        }),
      );
      handle.doc.getMap("epic").set("deletedArtifacts", tombstones);
    });

    const after = handle.store.getState();
    // Tombstones are not tree nodes, so the change must not set
    // structuralTreeDirty: the tree slice and the live-artifact table keep
    // their refs (no rebuild), down to the individual artifact slot.
    expect(after.tree).toBe(treeBefore);
    expect(after.artifacts).toBe(artifactsBefore);
    expect(after.artifacts.byId).toBe(byIdBefore);
    expect(after.artifacts.byId[live]).toBe(byIdBefore[live]);
    // The tombstone still landed in its own slice.
    expect(after.deletedArtifacts.byId.gone.title).toBe("Gone");
    handle.dispose();
  });

  it("preserves live artifact rename identity semantics when tombstones exist", () => {
    const { handle } = newSession();
    const a = createArtifactInDocForTests(handle.doc, "spec", null);
    const b = createArtifactInDocForTests(handle.doc, "ticket", null);

    handle.doc.transact(() => {
      const tombstones = new Y.Map<unknown>();
      tombstones.set(
        "old",
        makeTombstone({
          id: "old",
          kind: "spec",
          title: "Old",
          deletedAt: "2026-06-10T00:00:00Z",
          status: null,
        }),
      );
      handle.doc.getMap("epic").set("deletedArtifacts", tombstones);
    });

    const beforeA = handle.store.getState().artifacts.byId[a];
    const beforeB = handle.store.getState().artifacts.byId[b];
    const deletedBefore = handle.store.getState().deletedArtifacts;

    handle.store.getState().renameArtifact(a, "Renamed A");

    const after = handle.store.getState();
    // Rename still re-allocates only A's slot; B stays ===.
    expect(after.artifacts.byId[a]).not.toBe(beforeA);
    expect(after.artifacts.byId[a].title).toBe("Renamed A");
    expect(after.artifacts.byId[b]).toBe(beforeB);
    // A live-artifact rename leaves the tombstone slice ref untouched.
    expect(after.deletedArtifacts).toBe(deletedBefore);
    handle.dispose();
  });
});
