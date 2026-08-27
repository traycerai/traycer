/**
 * Task 4.3: `reparentArtifactAction` now VALIDATES against the projected
 * tree (`evaluateProjectedReparent`) and WRITES to the doc entry resolved
 * separately (`resolveReparentNode`). These are store-level tests of that
 * new validation surface - the doc-only-terminal-agent-onto-record-chat
 * pairing (the acceptance criterion this task exists for) is pinned as an
 * inversion of the old divergence fixture in
 * `components/epic-canvas/dnd/__tests__/sidebar-reparent-commit-doc-projected-agreement.test.ts`;
 * this file covers the rest of the matrix directly against
 * `reparentArtifact`, one level below the DnD commit helper.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { ChatRecordSummary } from "@traycer/protocol/host/epic/chat-records";
import { createArtifactInDocForTests } from "./projection-helpers-test-shims";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import {
  CrossFamilyParentError,
  MissingNodeError,
  ReparentCycleError,
} from "@/lib/errors";

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: "epic-1",
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

function newSession(): OpenEpicStoreHandle {
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
    epicId: "epic-1",
    streamClientFactory: factory,
    userId: null,
    onAuthError: null,
  });
  if (captured.value === null) throw new Error("factory not invoked");
  const seed = Y.encodeStateAsUpdate(new Y.Doc());
  captured.value.onSnapshot(makeMeta(), seed);
  return handle;
}

/** Mirrors `epic-projector.test.ts`'s `makeTerminalAgentEntry`. */
function makeTerminalAgentEntry(id: string, title: string): Y.Map<unknown> {
  const agent = new Y.Map<unknown>();
  agent.set("id", id);
  agent.set("harnessId", "codex");
  agent.set("title", title);
  agent.set("parentId", null);
  agent.set("createdAt", 1);
  agent.set("updatedAt", 1);
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

function seedTerminalAgent(
  handle: OpenEpicStoreHandle,
  id: string,
  title: string,
): void {
  const epic = handle.doc.getMap("epic");
  let tuiAgents = epic.get("tuiAgents");
  if (!(tuiAgents instanceof Y.Map)) {
    tuiAgents = new Y.Map<unknown>();
    epic.set("tuiAgents", tuiAgents);
  }
  (tuiAgents as Y.Map<unknown>).set(id, makeTerminalAgentEntry(id, title));
}

/** Sets a doc-backed `chats` entry with a specific `parentId`, bypassing
 * `createArtifactInDocForTests` (which always seeds `parentId: null`). Used
 * to build the doc arm of a cross-arm cycle. */
function seedDocChat(
  handle: OpenEpicStoreHandle,
  id: string,
  title: string,
  parentId: string | null,
): void {
  const epic = handle.doc.getMap("epic");
  let chats = epic.get("chats");
  if (!(chats instanceof Y.Map)) {
    chats = new Y.Map<unknown>();
    epic.set("chats", chats);
  }
  const entry = new Y.Map<unknown>();
  entry.set("id", id);
  entry.set("title", title);
  entry.set("parentId", parentId);
  entry.set("createdAt", 1);
  entry.set("updatedAt", 1);
  entry.set("messages", new Y.Array());
  (chats as Y.Map<unknown>).set(id, entry);
}

function chatRecord(overrides: Partial<ChatRecordSummary>): ChatRecordSummary {
  return {
    chatId: "chat-1",
    ownerUserId: "user-a",
    originHostId: "host-1",
    title: "A chat",
    isTitleEditedByUser: false,
    parentChatId: null,
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    archivedAt: null,
    runSettingsSummary: "claude",
    revision: 1,
    visibility: "private",
    origin: "own",
    ...overrides,
  };
}

describe("reparentArtifact validates against the projected tree", () => {
  let handle: OpenEpicStoreHandle | null = null;

  afterEach(() => {
    handle?.dispose();
    handle = null;
  });

  it("accepts a registry-backed parent as a legal target (not missing-node)", () => {
    handle = newSession();
    seedTerminalAgent(handle, "agent-1", "Agent");
    handle.store
      .getState()
      .applyChatRecords([chatRecord({ chatId: "chat-registry" })], null);

    const mutated = handle.store
      .getState()
      .reparentArtifact("agent-1", "chat-registry");

    expect(mutated).toBe(true);
    const after = handle.store.getState();
    expect(after.tree.nodeById["agent-1"].parentId).toBe("chat-registry");
    expect(after.tree.childrenByParent["chat-registry"]).toContain("agent-1");
  });

  it("throws MissingNodeError for a node genuinely absent from the tree", () => {
    handle = newSession();
    const parent = createArtifactInDocForTests(handle.doc, "spec", null);

    expect(() =>
      handle?.store.getState().reparentArtifact("ghost-node", parent),
    ).toThrow(MissingNodeError);
  });

  it("throws CrossFamilyParentError nesting an artifact under a chat, projected", () => {
    handle = newSession();
    const artifact = createArtifactInDocForTests(handle.doc, "spec", null);
    handle.store
      .getState()
      .applyChatRecords([chatRecord({ chatId: "chat-registry" })], null);

    expect(() =>
      handle?.store.getState().reparentArtifact(artifact, "chat-registry"),
    ).toThrow(CrossFamilyParentError);
  });

  it("catches a cycle that spans the doc and record arms", () => {
    handle = newSession();
    // chat-registry (record-only, root) <- chat-doc (doc-backed, parented
    // under chat-registry). The chain crosses both arms: this could not be
    // detected before 4.3, since the doc-only evaluator never saw
    // chat-registry at all.
    handle.store
      .getState()
      .applyChatRecords(
        [chatRecord({ chatId: "chat-registry", parentChatId: null })],
        null,
      );
    seedDocChat(handle, "chat-doc", "Doc chat", "chat-registry");

    // Moving chat-registry under chat-doc would cycle: chat-doc already
    // descends from chat-registry.
    expect(() =>
      handle?.store.getState().reparentArtifact("chat-registry", "chat-doc"),
    ).toThrow(ReparentCycleError);
  });

  it("returns false without throwing when the node has no doc entry to write", () => {
    handle = newSession();
    // A second, real doc-backed chat to serve as a legal (same-family,
    // non-same-parent) target for the registry-backed node.
    const docParent = createArtifactInDocForTests(handle.doc, "chat", null);
    handle.store
      .getState()
      .applyChatRecords(
        [chatRecord({ chatId: "chat-registry", parentChatId: null })],
        null,
      );

    const before = handle.store.getState();
    expect(before.tree.nodeById["chat-registry"].parentId).toBeNull();

    const mutated = handle.store
      .getState()
      .reparentArtifact("chat-registry", docParent);

    // The projection accepted the move (legal, not a no-op), but there is no
    // doc entry for "chat-registry" to write to - `epic.reparentChat` owns
    // that node's pointer instead.
    expect(mutated).toBe(false);
    const after = handle.store.getState();
    expect(after.tree.nodeById["chat-registry"].parentId).toBeNull();
  });

  /**
   * The nuance flagged in the task handoff: the projected tree's `parentId`
   * is the EFFECTIVE parent - `resolveEffectiveParent` promotes an unknown
   * raw pointer to root (`null`, see `projection-helpers.ts`). So a node
   * whose raw doc `parentId` dangles (points at an id nothing resolves to)
   * reads as `parentId: null` in the tree, and dropping it at root is now
   * `same-parent` - a silent no-op that leaves the dangling raw pointer in
   * place. The OLD doc-based evaluator read the raw `parentId` directly, saw
   * it did not equal `null`, and would have written `null` - cleaning the
   * dangling pointer as a side effect of an ordinary "un-nest" drop.
   *
   * This is pinned as CURRENT behaviour, not fixed: the projection is the
   * single source of truth for "where does this node currently sit," and by
   * that source the node already sits at root. Flagged to the assigning
   * agent per the handoff - not treated as a bug to work around here.
   */
  it("pins current behaviour: root drop on a dangling raw parentId is a no-op and leaves the raw pointer dirty", () => {
    handle = newSession();
    const artifact = createArtifactInDocForTests(
      handle.doc,
      "spec",
      "no-such-node",
    );

    const before = handle.store.getState();
    // The projection promotes the unknown raw parent to root.
    expect(before.tree.nodeById[artifact].parentId).toBeNull();

    const mutated = handle.store.getState().reparentArtifact(artifact, null);

    // Projected `parentId` already reads `null`, so this is `same-parent`:
    // a no-op, not a write.
    expect(mutated).toBe(false);

    const artifacts = handle.doc.getMap("epic").get("artifacts");
    if (!(artifacts instanceof Y.Map))
      throw new Error("expected artifacts map");
    // `instanceof Y.Map` narrows to `Y.Map<any>`, so read through an
    // explicitly-typed view rather than let an `any` escape into the test.
    const entry = (artifacts as Y.Map<unknown>).get(artifact);
    if (!(entry instanceof Y.Map)) throw new Error("expected artifact entry");
    // The raw pointer is left dangling - it was never cleaned, because the
    // projection never saw it as a real move.
    expect(entry.get("parentId")).toBe("no-such-node");
  });
});
