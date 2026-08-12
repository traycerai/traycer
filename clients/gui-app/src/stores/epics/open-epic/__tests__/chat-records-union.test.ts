/**
 * The store-backed chat RECORD channel (chat-sync-v2 ticket 49).
 *
 * Since the single-write pivot the epic Y.Doc is no longer where a chat's
 * existence is recorded: creation writes only the chat database, and the upgrade
 * sweep DELETES a doc entry once its chat is proven published. These tests drive
 * the session through both halves - `epic.listChatRecords` rows in through
 * `applyChatRecords`, doc entries in through the epic stream - and assert what
 * the renderer's record table is in each combination.
 *
 * The ablation each of these is written against: with the union removed
 * (`chats` = the doc projection), the first test's chat is in no slice at all -
 * no record, no tree row, nothing to rename.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { ChatRecordSummary } from "@traycer/protocol/host/epic/chat-records";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";

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

/** A doc chat entry, exactly as a pre-pivot build projected one. */
function docChatEntry(args: {
  readonly id: string;
  readonly title: string;
  readonly parentId: string | null;
  readonly hostId: string | null;
}): Y.Map<unknown> {
  const chat = new Y.Map<unknown>();
  chat.set("id", args.id);
  chat.set("title", args.title);
  chat.set("parentId", args.parentId);
  chat.set("createdAt", 1);
  chat.set("updatedAt", 1);
  chat.set("isTitleEditedByUser", false);
  if (args.hostId !== null) chat.set("hostId", args.hostId);
  return chat;
}

function record(overrides: Partial<ChatRecordSummary>): ChatRecordSummary {
  return {
    chatId: "chat-1",
    ownerUserId: "user-a",
    originHostId: "host-1",
    title: "A chat",
    isTitleEditedByUser: false,
    parentChatId: null,
    createdAt: 1,
    updatedAt: 2,
    archivedAt: null,
    runSettingsSummary: "claude",
    ...overrides,
  };
}

interface Session {
  readonly handle: OpenEpicStoreHandle;
  readonly callbacks: EpicStreamCallbacks;
  /** Applies a doc mutation the way the host's replicated update would. */
  readonly mutateDoc: (mutate: (chats: Y.Map<unknown>) => void) => void;
}

function newSession(seedDoc: (doc: Y.Doc) => void): Session {
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
  const seed = new Y.Doc();
  seedDoc(seed);
  captured.value.onSnapshot(makeMeta(), Y.encodeStateAsUpdate(seed));
  return {
    handle,
    callbacks: captured.value,
    mutateDoc: (mutate) => {
      const chats = handle.doc.getMap("epic").get("chats");
      if (!(chats instanceof Y.Map)) throw new Error("no chats map");
      mutate(chats as Y.Map<unknown>);
    },
  };
}

/**
 * Keyed explicitly rather than read back off each entry: a `Y.Map` that has not
 * been integrated into a doc yet answers `undefined` to `get`, so the id has to
 * travel beside it.
 */
function seedChats(
  entries: ReadonlyArray<readonly [string, Y.Map<unknown>]>,
): (doc: Y.Doc) => void {
  return (doc) => {
    const chats = new Y.Map<unknown>();
    for (const [id, entry] of entries) chats.set(id, entry);
    doc.getMap("epic").set("chats", chats);
  };
}

describe("chats.byId unions the host's records with the doc projection", () => {
  it("gives a swept chat back its record, its tree row and its parent", () => {
    const session = newSession(seedChats([]));
    session.handle.store.getState().applyChatRecords([
      record({ chatId: "parent", title: "Parent" }),
      record({
        chatId: "swept",
        title: "Swept chat",
        parentChatId: "parent",
        isTitleEditedByUser: true,
      }),
    ]);

    const state = session.handle.store.getState();
    // The doc knows about neither - that is the post-sweep steady state.
    expect(state.docChats.allIds).toEqual([]);
    expect(state.chats.allIds.slice().sort()).toEqual(["parent", "swept"]);
    expect(state.chats.byId.swept).toEqual({
      id: "swept",
      title: "Swept chat",
      parentId: "parent",
      createdAt: 1,
      updatedAt: 2,
      userId: "user-a",
      hostId: "host-1",
      isTitleEditedByUser: true,
      settings: null,
      archivedAt: null,
    });
    // Tree position, which is what a store-only chat lost entirely.
    expect(state.tree.nodeById.swept.parentId).toBe("parent");
    expect(state.tree.childrenByParent.parent).toEqual(["swept"]);
    expect(state.tree.rootIds).toEqual(["parent"]);
    session.handle.dispose();
  });

  it("keeps a doc-only legacy chat, by the same reference, in doc-only mode", () => {
    const session = newSession(
      seedChats([
        [
          "legacy",
          docChatEntry({
            id: "legacy",
            title: "Legacy chat",
            parentId: null,
            hostId: null,
          }),
        ],
      ]),
    );
    const state = session.handle.store.getState();
    expect(state.chats.allIds).toEqual(["legacy"]);
    expect(state.chats.byId.legacy.title).toBe("Legacy chat");
    // Legacy `null` hostId semantics survive: nothing invented a host for a
    // record no registry answered for.
    expect(state.chats.byId.legacy.hostId).toBeNull();
    // Doc-only mode hands the doc slice through by reference, so nothing
    // downstream of `chats` sees a change it has to re-render for.
    expect(state.chats).toBe(state.docChats);
    session.handle.dispose();
  });

  it("degrades to doc-only when the host lacks the method", () => {
    // `E_HOST_UNSUPPORTED` means the sync hook never calls `applyChatRecords`,
    // so this session is exactly the pre-ticket one.
    const session = newSession(
      seedChats([
        [
          "legacy",
          docChatEntry({
            id: "legacy",
            title: "Legacy chat",
            parentId: null,
            hostId: "host-1",
          }),
        ],
      ]),
    );
    const state = session.handle.store.getState();
    expect(state.chatRecords.allIds).toEqual([]);
    expect(state.chats.allIds).toEqual(["legacy"]);
    expect(state.tree.rootIds).toEqual(["legacy"]);
    session.handle.dispose();
  });

  it("does not duplicate a chat present in both, and lets the row win", () => {
    const session = newSession(
      seedChats([
        [
          "both",
          docChatEntry({
            id: "both",
            title: "Frozen doc title",
            parentId: null,
            hostId: "host-1",
          }),
        ],
      ]),
    );
    session.handle.store.getState().applyChatRecords([
      record({
        chatId: "both",
        title: "Renamed since",
        isTitleEditedByUser: true,
        parentChatId: null,
        archivedAt: 5_000,
      }),
    ]);

    const state = session.handle.store.getState();
    expect(state.chats.allIds).toEqual(["both"]);
    // Every field the row carries: the doc's copy froze at whatever an earlier
    // build last projected.
    expect(state.chats.byId.both.title).toBe("Renamed since");
    expect(state.chats.byId.both.isTitleEditedByUser).toBe(true);
    expect(state.chats.byId.both.archivedAt).toBe(5_000);
    expect(state.tree.nodeById.both.title).toBe("Renamed since");
    session.handle.dispose();
  });

  it("keeps the doc entry's settings, which the registry row does not carry", () => {
    const withSettings = docChatEntry({
      id: "both",
      title: "Doc",
      parentId: null,
      hostId: "host-1",
    });
    const settings = new Y.Map<unknown>();
    settings.set("harnessId", "claude");
    settings.set("model", "opus");
    settings.set("permissionMode", "full_access");
    settings.set("reasoningEffort", null);
    settings.set("serviceTier", null);
    settings.set("agentMode", "regular");
    settings.set("profileId", null);
    withSettings.set("settings", settings);

    const session = newSession(seedChats([["both", withSettings]]));
    expect(session.handle.store.getState().chats.byId.both.settings).not.toBe(
      null,
    );
    session.handle.store
      .getState()
      .applyChatRecords([record({ chatId: "both", title: "Renamed" })]);

    const state = session.handle.store.getState();
    expect(state.chats.byId.both.title).toBe("Renamed");
    expect(state.chats.byId.both.settings?.model).toBe("opus");
    session.handle.dispose();
  });

  it("survives the sweep deleting the doc entry of a chat it still holds", () => {
    const session = newSession(
      seedChats([
        [
          "swept",
          docChatEntry({
            id: "swept",
            title: "Doc title",
            parentId: null,
            hostId: "host-1",
          }),
        ],
      ]),
    );
    session.handle.store
      .getState()
      .applyChatRecords([record({ chatId: "swept", title: "Live title" })]);
    // What `ChatDocEntrySweep` does once publication is proven.
    session.mutateDoc((chats) => chats.delete("swept"));

    const state = session.handle.store.getState();
    expect(state.docChats.allIds).toEqual([]);
    // The doc removal reconciles against the DOC slice; the record survives it.
    expect(state.chats.allIds).toEqual(["swept"]);
    expect(state.chats.byId.swept.title).toBe("Live title");
    expect(state.tree.rootIds).toEqual(["swept"]);
    session.handle.dispose();
  });

  it("keeps another signed-in user's rows out of the record table", () => {
    // Rows in hand when the account switches, or a host that answered for the
    // wrong identity: the union applies the same display filter the doc
    // projection does, at projection time rather than at ingest, so a user
    // switch re-derives it instead of trusting an older decision.
    useAuthStore
      .getState()
      .setSignedIn(
        { userId: "user-a", userName: "A", email: "a@example.com" },
        { userId: "user-a", username: "A" },
        [],
      );
    try {
      const session = newSession(seedChats([]));
      session.handle.store
        .getState()
        .applyChatRecords([
          record({ chatId: "mine", ownerUserId: "user-a" }),
          record({ chatId: "theirs", ownerUserId: "user-b" }),
        ]);

      const state = session.handle.store.getState();
      expect(state.chats.allIds).toEqual(["mine"]);
      expect(state.tree.nodeById.theirs).toBeUndefined();
      session.handle.dispose();
    } finally {
      useAuthStore.getState().setSignedOut();
    }
  });

  it("removes a chat the host stops serving, and is idempotent otherwise", () => {
    const session = newSession(seedChats([]));
    const store = session.handle.store;
    store
      .getState()
      .applyChatRecords([record({ chatId: "a" }), record({ chatId: "b" })]);
    const afterFirst = store.getState().chats;

    // An identical answer writes nothing - the poll behind this must not
    // re-render an epic that has not changed.
    store
      .getState()
      .applyChatRecords([record({ chatId: "a" }), record({ chatId: "b" })]);
    expect(store.getState().chats).toBe(afterFirst);

    // A deleted chat simply stops being served.
    store.getState().applyChatRecords([record({ chatId: "a" })]);
    expect(store.getState().chats.allIds).toEqual(["a"]);
    expect(store.getState().tree.nodeById.b).toBeUndefined();
    session.handle.dispose();
  });
});
