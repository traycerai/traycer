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
 *
 * The second describe block drives the PUSH half (`applyChatRecordDelta`,
 * multi-host-chats record layer) into the SAME table, with its own ablations
 * named on each test.
 */
import { afterEach, describe, expect, it } from "vitest";
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
    archived: false,
    archivedAt: null,
    runSettingsSummary: "claude",
    revision: 1,
    visibility: "private",
    origin: "own",
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

function signedInAs(userId: string): void {
  useAuthStore
    .getState()
    .setSignedIn(
      { userId, userName: userId, email: `${userId}@example.com` },
      { userId, username: userId },
      [],
    );
}

// The auth store is module-global, so a test that signs in must not leak that
// identity into the next one. Owned here at the suite level rather than by
// per-test `finally` blocks.
afterEach(() => {
  useAuthStore.getState().setSignedOut();
});

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
        archived: true,
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

  it("keeps the published chats identity across a doc patch the union masks", () => {
    // A chat present in BOTH sources holds a fresh MERGED object in the union
    // on every recompute (the row wins each field, the doc supplies settings),
    // so a per-entry REFERENCE gate can never say "unchanged" for it.
    // Ablation: gate `unionInto`'s publish on reference equality instead of
    // `chatSlicesEq` and the doc mutation below - masked field-for-field by
    // the row - hands every chat consumer a new `chats` identity carrying the
    // same content.
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
    const store = session.handle.store;
    store
      .getState()
      .applyChatRecords([record({ chatId: "both", title: "Row title" })]);
    const before = store.getState().chats;
    expect(before.byId.both.title).toBe("Row title");

    // A doc-side write to a field the row overrides anyway: the DOC slice
    // changes, the union's content does not.
    session.mutateDoc((chats) => {
      const entry = chats.get("both");
      if (!(entry instanceof Y.Map)) throw new Error("no doc entry");
      (entry as Y.Map<unknown>).set("title", "Doc renamed underneath");
    });

    expect(store.getState().docChats.byId.both.title).toBe(
      "Doc renamed underneath",
    );
    expect(store.getState().chats).toBe(before);
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
    signedInAs("user-a");
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

describe("applyChatRecordDelta pushes into the same table the poll fills", () => {
  it("lands a brand-new chat, tree row included, with no poll in between", () => {
    const session = newSession(seedChats([]));
    const store = session.handle.store;
    store.getState().applyChatRecords([record({ chatId: "existing" })]);

    store.getState().applyChatRecordDelta({
      kind: "upsert",
      epicId: "epic-test",
      record: record({
        chatId: "pushed",
        title: "Pushed chat",
        parentChatId: "existing",
        revision: 1,
      }),
    });

    const state = store.getState();
    expect(state.chats.allIds.slice().sort()).toEqual(["existing", "pushed"]);
    expect(state.chats.byId.pushed.title).toBe("Pushed chat");
    // The record channel's whole point: a store-only chat with a tree row.
    expect(state.tree.nodeById.pushed.parentId).toBe("existing");
    expect(state.tree.childrenByParent.existing).toEqual(["pushed"]);
    session.handle.dispose();
  });

  it("never lets a collaborator's SAME-ID row evict the viewer's own chat", () => {
    // Record identity is `(epicId, ownerUserId, chatId)`: the id is host-minted,
    // so two users can hold the same one inside one task. Ablation: key
    // `chatRecordRows` on `chatId` alone and the second delta below overwrites
    // the first - the viewer's own chat vanishes from their own sidebar because
    // somebody else created a chat whose id happened to collide.
    //
    // The collaborator's row carries a HIGHER revision, which is the realistic
    // case and the one that matters: revisions are monotonic PER RECORD, so two
    // owners' revisions for the same id are incomparable. Under id-only keying
    // the staleness guard would compare them anyway - and the bigger number
    // wins, whoever it belongs to.
    signedInAs("user-a");
    const session = newSession(seedChats([]));
    const store = session.handle.store;
    store.getState().applyChatRecordDelta({
      kind: "upsert",
      epicId: "epic-test",
      record: record({
        chatId: "c",
        title: "Mine",
        ownerUserId: "user-a",
        revision: 2,
      }),
    });
    store.getState().applyChatRecordDelta({
      kind: "upsert",
      epicId: "epic-test",
      record: record({
        chatId: "c",
        title: "Theirs",
        ownerUserId: "user-b",
        originHostId: "host-2",
        origin: "foreign",
        visibility: "task",
        revision: 99,
      }),
    });

    expect(store.getState().chats.allIds).toEqual(["c"]);
    expect(store.getState().chats.byId.c.title).toBe("Mine");
    expect(store.getState().chats.byId.c.userId).toBe("user-a");
    session.handle.dispose();
  });

  it("retains a held-back row and re-derives the table when the signed-in user changes", () => {
    // The reason selecting one owner AT INGEST is safe: the raw rows are all
    // retained, so a user switch rebuilds the table rather than re-filtering a
    // selection that was already frozen. Ablation: drop the
    // `republishChatRecordsForCurrentUser` call from the auth subscription and
    // user-b signs in to user-a's chat list.
    signedInAs("user-a");
    const session = newSession(seedChats([]));
    const store = session.handle.store;
    store.getState().applyChatRecords([
      record({ chatId: "mine", ownerUserId: "user-a" }),
      record({
        chatId: "theirs",
        ownerUserId: "user-b",
        origin: "foreign",
      }),
    ]);
    store.getState().markChatRecordListAuthoritative();
    expect(store.getState().chats.allIds).toEqual(["mine"]);
    expect(store.getState().chatRecordListAuthoritative).toBe(true);

    signedInAs("user-b");
    expect(store.getState().chats.allIds).toEqual(["theirs"]);
    // User A's answered list cannot authorize deleting rows for user B. The
    // viewer-keyed query marks the new answer authoritative when it arrives.
    expect(store.getState().chatRecordListAuthoritative).toBe(false);
    session.handle.dispose();
  });

  it("takes a FOREIGN row - another host's replica - into chats.byId", () => {
    const session = newSession(seedChats([]));
    const store = session.handle.store;
    store.getState().applyChatRecordDelta({
      kind: "upsert",
      epicId: "epic-test",
      record: record({
        chatId: "elsewhere",
        title: "On my other machine",
        originHostId: "host-2",
        origin: "foreign",
        visibility: "task",
        revision: 4,
      }),
    });

    const state = store.getState();
    expect(state.chats.allIds).toEqual(["elsewhere"]);
    // The MINTING host, carried through - a chat is bound to its host for life,
    // so a tab opened from this row must dial host-2 and not this one.
    expect(state.chats.byId.elsewhere.hostId).toBe("host-2");
    // A replica carries no settings tuple; the row only ever held a summary.
    expect(state.chats.byId.elsewhere.settings).toBeNull();
    expect(state.tree.rootIds).toEqual(["elsewhere"]);
    session.handle.dispose();
  });

  it("reads a foreign ARCHIVED row as archived, though it carries no timestamp", () => {
    // The two planes disagree about the TYPE of this fact: the host registry
    // stores a timestamp, the cloud row (which a foreign row replicates) stores
    // a boolean. Ablation: copy `archivedAt` straight through in
    // `chatProjectionFromRecord` and this row renders as an ACTIVE chat.
    const session = newSession(seedChats([]));
    session.handle.store.getState().applyChatRecordDelta({
      kind: "upsert",
      epicId: "epic-test",
      record: record({
        chatId: "foreign-archived",
        origin: "foreign",
        archived: true,
        archivedAt: null,
        updatedAt: 900,
        revision: 2,
      }),
    });

    const projection =
      session.handle.store.getState().chats.byId["foreign-archived"];
    // Exactly the row's `updatedAt`: the derivation's documented fallback for
    // an archived row with no timestamp, not just "some non-null time".
    expect(projection.archivedAt).toBe(900);
    // An own row still reports its real timestamp - the derivation adds a
    // floor, it does not overwrite what the registry knows.
    session.handle.store.getState().applyChatRecordDelta({
      kind: "upsert",
      epicId: "epic-test",
      record: record({
        chatId: "own-archived",
        archived: true,
        archivedAt: 5_000,
        revision: 2,
      }),
    });
    expect(
      session.handle.store.getState().chats.byId["own-archived"].archivedAt,
    ).toBe(5_000);
    session.handle.dispose();
  });

  it("rejects a STALE-revision upsert and accepts the next fresh one", () => {
    // Ablation: drop the `record.revision <= held.revision` guard and the
    // replayed frame below reinstates "Old title" - a rename that undoes itself
    // whenever the transport redelivers, reorders or duplicates a delta.
    const session = newSession(seedChats([]));
    const store = session.handle.store;
    store
      .getState()
      .applyChatRecords([
        record({ chatId: "c", title: "Current", revision: 5 }),
      ]);

    store.getState().applyChatRecordDelta({
      kind: "upsert",
      epicId: "epic-test",
      record: record({ chatId: "c", title: "Old title", revision: 4 }),
    });
    expect(store.getState().chats.byId.c.title).toBe("Current");

    // Equal is stale too: revisions are per-chat monotonic, so "not newer" is
    // the test, not "older".
    store.getState().applyChatRecordDelta({
      kind: "upsert",
      epicId: "epic-test",
      record: record({ chatId: "c", title: "Same revision", revision: 5 }),
    });
    expect(store.getState().chats.byId.c.title).toBe("Current");

    store.getState().applyChatRecordDelta({
      kind: "upsert",
      epicId: "epic-test",
      record: record({ chatId: "c", title: "Newer", revision: 6 }),
    });
    expect(store.getState().chats.byId.c.title).toBe("Newer");
    session.handle.dispose();
  });

  it("removes the row - the sidebar's tree row goes with it - and records why", () => {
    const session = newSession(seedChats([]));
    const store = session.handle.store;
    store
      .getState()
      .applyChatRecords([record({ chatId: "a" }), record({ chatId: "gone" })]);
    expect(store.getState().tree.rootIds.slice().sort()).toEqual(["a", "gone"]);

    store.getState().applyChatRecordDelta({
      kind: "remove",
      epicId: "epic-test",
      chatId: "gone",
      reason: "revoked",
    });

    const state = store.getState();
    expect(state.chats.allIds).toEqual(["a"]);
    // What makes the sidebar row disappear: nothing in the sidebar is asked to
    // do anything, the row simply stops being in the tree it renders from.
    expect(state.tree.rootIds).toEqual(["a"]);
    expect(state.tree.nodeById.gone).toBeUndefined();
    expect(state.chatRetractions).toEqual({ gone: "revoked" });
    session.handle.dispose();
  });

  it("keeps the retraction reason for a chat this session never held a record for", () => {
    // The cross-host case: the tab was opened from the unified sidebar, so the
    // record table never had the row, and the removal changes no slice at all.
    // Ablation: gate `publishChatRecords` on `chatSlicesEq` alone and the open
    // tab is never told - it keeps rendering a transcript it may no longer read.
    const session = newSession(seedChats([]));
    session.handle.store.getState().applyChatRecordDelta({
      kind: "remove",
      epicId: "epic-test",
      chatId: "never-held",
      reason: "deleted",
    });
    expect(session.handle.store.getState().chatRetractions).toEqual({
      "never-held": "deleted",
    });
    session.handle.dispose();
  });

  it("is absorbing: neither a later upsert nor a stale poll resurrects the row", () => {
    // Ablation: drop the retraction check from `applyChatRecords` and the
    // in-flight poll below puts the chat straight back, seconds after its tab
    // announced it was gone.
    const session = newSession(seedChats([]));
    const store = session.handle.store;
    store
      .getState()
      .applyChatRecords([record({ chatId: "gone", revision: 1 })]);
    store.getState().applyChatRecordDelta({
      kind: "remove",
      epicId: "epic-test",
      chatId: "gone",
      reason: "deleted",
    });

    store.getState().applyChatRecordDelta({
      kind: "upsert",
      epicId: "epic-test",
      record: record({ chatId: "gone", revision: 99 }),
    });
    expect(store.getState().chats.allIds).toEqual([]);

    // An `epic.listChatRecords` answer issued BEFORE the removal, landing after.
    store
      .getState()
      .applyChatRecords([record({ chatId: "gone", revision: 1 })]);
    expect(store.getState().chats.allIds).toEqual([]);
    expect(store.getState().chatRetractions).toEqual({ gone: "deleted" });
    session.handle.dispose();
  });

  it("is idempotent on a redelivered removal", () => {
    const session = newSession(seedChats([]));
    const store = session.handle.store;
    store.getState().applyChatRecords([record({ chatId: "a", revision: 2 })]);
    const before = store.getState().chats;

    store.getState().applyChatRecordDelta({
      kind: "remove",
      epicId: "epic-test",
      chatId: "b",
      reason: "deleted",
    });
    // The FIRST removal re-projects even though it changed no row - that is the
    // deliberate gate bypass that lets a cross-host tab hear about its own
    // retraction. Same content, new identity.
    const afterFirstRemove = store.getState().chats;
    expect(afterFirstRemove).toEqual(before);

    // The redelivered one is a no-op end to end: same reason, row already gone.
    store.getState().applyChatRecordDelta({
      kind: "remove",
      epicId: "epic-test",
      chatId: "b",
      reason: "deleted",
    });
    expect(store.getState().chats).toBe(afterFirstRemove);

    // And an unchanged poll answer still writes nothing, as it always has.
    store.getState().applyChatRecords([record({ chatId: "a", revision: 2 })]);
    expect(store.getState().chats).toBe(afterFirstRemove);
    session.handle.dispose();
  });
});

/**
 * `beginPendingChatCreation` / `clearPendingChatCreation` (chat-sync-v2
 * ticket A5) - the registry that makes a just-created chat visible before its
 * record completes the round trip. These drive the SAME store the two
 * describe blocks above do, so a pending row and a record row are exercised
 * through the one seam (`publishChatRecords`) both the poll and the push path
 * share.
 */
describe("pending chat creations", () => {
  it("survives the poll's clear-and-replace when the answer does not include it yet", () => {
    signedInAs("user-a");
    // Ablation: this is the whole point of the ticket. Fold the union out of
    // `publishChatRecords` and the second `applyChatRecords` below - which
    // rebuilds `chatRecordRows` from scratch and knows nothing about
    // "just-created" - evicts it exactly like any other stale entry would be.
    const session = newSession(seedChats([]));
    const store = session.handle.store;
    store.getState().applyChatRecords([record({ chatId: "existing" })]);
    store.getState().beginPendingChatCreation({
      chatId: "just-created",
      hostId: "host-1",
      parentChatId: null,
      title: "",
      ownerUserId: "user-a",
    });
    expect(store.getState().chats.allIds.slice().sort()).toEqual([
      "existing",
      "just-created",
    ]);

    // A poll answer issued before the create was even sent - it cannot know
    // about "just-created" - landing after.
    store.getState().applyChatRecords([record({ chatId: "existing" })]);

    expect(store.getState().chats.allIds.slice().sort()).toEqual([
      "existing",
      "just-created",
    ]);
    expect(store.getState().chatRecords.allIds.slice().sort()).toEqual([
      "existing",
      "just-created",
    ]);
    expect(store.getState().tree.nodeById["just-created"]).toBeDefined();
    session.handle.dispose();
  });

  it("is replaced, not duplicated, when its own record arrives via the poll", () => {
    signedInAs("user-a");
    const session = newSession(seedChats([]));
    const store = session.handle.store;
    store.getState().beginPendingChatCreation({
      chatId: "just-created",
      hostId: "submit-host",
      parentChatId: "parent-x",
      title: "",
      ownerUserId: "user-a",
    });
    expect(store.getState().chats.byId["just-created"].hostId).toBe(
      "submit-host",
    );

    store.getState().applyChatRecords([
      record({
        chatId: "just-created",
        title: "Served title",
        originHostId: "served-host",
        parentChatId: null,
      }),
    ]);

    const state = store.getState();
    expect(
      state.chats.allIds.filter((id) => id === "just-created"),
    ).toHaveLength(1);
    // The served row wins every field - the submit-time guess is gone, not
    // merged with it.
    expect(state.chats.byId["just-created"].title).toBe("Served title");
    expect(state.chats.byId["just-created"].hostId).toBe("served-host");
    expect(state.chats.byId["just-created"].parentId).toBeNull();
    session.handle.dispose();
  });

  it("is replaced, not duplicated, when its own record arrives via a push delta", () => {
    signedInAs("user-a");
    const session = newSession(seedChats([]));
    const store = session.handle.store;
    store.getState().beginPendingChatCreation({
      chatId: "just-created",
      hostId: "submit-host",
      parentChatId: null,
      title: "",
      ownerUserId: "user-a",
    });

    store.getState().applyChatRecordDelta({
      kind: "upsert",
      epicId: "epic-test",
      record: record({
        chatId: "just-created",
        title: "Pushed title",
        originHostId: "served-host",
        revision: 1,
      }),
    });

    const state = store.getState();
    expect(
      state.chats.allIds.filter((id) => id === "just-created"),
    ).toHaveLength(1);
    expect(state.chats.byId["just-created"].title).toBe("Pushed title");
    expect(state.chats.byId["just-created"].hostId).toBe("served-host");
    session.handle.dispose();
  });

  it("does not poison the record revision guard when a real row hands the pending one over", () => {
    signedInAs("user-a");
    // Pins the reason the pending map is held separately from
    // `chatRecordRows` rather than seeded into it with a fabricated
    // `revision: 0`: that would make the real row's own first delta (also
    // revision 0) read as a replay of itself and be dropped, stranding the
    // stand-in permanently.
    const session = newSession(seedChats([]));
    const store = session.handle.store;
    store.getState().beginPendingChatCreation({
      chatId: "c",
      hostId: "host-1",
      parentChatId: null,
      title: "",
      ownerUserId: "user-a",
    });

    store.getState().applyChatRecordDelta({
      kind: "upsert",
      epicId: "epic-test",
      record: record({ chatId: "c", title: "First", revision: 0 }),
    });
    expect(store.getState().chats.byId.c.title).toBe("First");

    // A re-delivery of that same first revision is still stale and dropped.
    store.getState().applyChatRecordDelta({
      kind: "upsert",
      epicId: "epic-test",
      record: record({ chatId: "c", title: "Replayed", revision: 0 }),
    });
    expect(store.getState().chats.byId.c.title).toBe("First");

    // A genuinely newer revision still applies normally.
    store.getState().applyChatRecordDelta({
      kind: "upsert",
      epicId: "epic-test",
      record: record({ chatId: "c", title: "Second", revision: 1 }),
    });
    expect(store.getState().chats.byId.c.title).toBe("Second");
    session.handle.dispose();
  });

  it("clearPendingChatCreation drops the row and republishes; a no-op for an unknown chat", () => {
    signedInAs("user-a");
    const session = newSession(seedChats([]));
    const store = session.handle.store;
    store.getState().beginPendingChatCreation({
      chatId: "doomed",
      hostId: "host-1",
      parentChatId: null,
      title: "",
      ownerUserId: "user-a",
    });
    expect(store.getState().chats.allIds).toEqual(["doomed"]);

    store.getState().clearPendingChatCreation("doomed");
    expect(store.getState().chats.allIds).toEqual([]);

    // Idempotent: clearing an id nothing is retained for writes nothing, so
    // it must not hand out a fresh `chats` identity either.
    const after = store.getState().chats;
    store.getState().clearPendingChatCreation("no-such-chat");
    expect(store.getState().chats).toBe(after);
    session.handle.dispose();
  });

  it("is retired by a retraction, and a later registration for the same chat is refused", () => {
    signedInAs("user-a");
    // Removal is absorbing and outranks a creation this session is still
    // holding open: a pending row is the weakest claim there is.
    const session = newSession(seedChats([]));
    const store = session.handle.store;
    store.getState().beginPendingChatCreation({
      chatId: "doomed",
      hostId: "host-1",
      parentChatId: null,
      title: "",
      ownerUserId: "user-a",
    });
    expect(store.getState().chats.allIds).toEqual(["doomed"]);

    store.getState().applyChatRecordDelta({
      kind: "remove",
      epicId: "epic-test",
      chatId: "doomed",
      reason: "deleted",
    });
    expect(store.getState().chats.allIds).toEqual([]);
    expect(store.getState().chatRetractions).toEqual({ doomed: "deleted" });

    store.getState().beginPendingChatCreation({
      chatId: "doomed",
      hostId: "host-1",
      parentChatId: null,
      title: "retry",
      ownerUserId: "user-a",
    });
    expect(store.getState().chats.allIds).toEqual([]);
    session.handle.dispose();
  });

  it("hides a pending creation from a different signed-in user, and restores it on switching back", () => {
    // Same display filter the record and doc slices apply, at the same
    // projection-time boundary - see the "keeps another signed-in user's rows
    // out" test above for the record-row equivalent.
    signedInAs("user-a");
    const session = newSession(seedChats([]));
    const store = session.handle.store;
    store.getState().beginPendingChatCreation({
      chatId: "mine",
      hostId: "host-1",
      parentChatId: null,
      title: "",
      ownerUserId: "user-a",
    });
    expect(store.getState().chats.allIds).toEqual(["mine"]);

    signedInAs("user-b");
    expect(store.getState().chats.allIds).toEqual([]);

    signedInAs("user-a");
    expect(store.getState().chats.allIds).toEqual(["mine"]);
    session.handle.dispose();
  });

  it("is not retired by a COLLABORATOR's same-id record, through either path", () => {
    // The pending-side half of "never lets a collaborator's SAME-ID row evict
    // the viewer's own chat" above, and the reason retirement keys on
    // `(ownerUserId, chatId)` rather than the id: `chatId` is not globally
    // unique, so two owners can hold the same one inside one task.
    //
    // Ablation: retire on `chatId` alone and user-b's row - which is filtered
    // straight back out of the published table because it is not user-a's -
    // silently takes user-a's just-created chat down with it. The user watches
    // the agent they just made disappear because a collaborator's unrelated
    // chat happened to collide.
    signedInAs("user-a");
    const session = newSession(seedChats([]));
    const store = session.handle.store;
    store.getState().beginPendingChatCreation({
      chatId: "c",
      hostId: "host-1",
      parentChatId: null,
      title: "",
      ownerUserId: "user-a",
    });
    const theirs = record({
      chatId: "c",
      ownerUserId: "user-b",
      originHostId: "host-2",
      title: "Theirs",
      origin: "foreign",
      visibility: "task",
      revision: 99,
    });

    // Push path.
    store.getState().applyChatRecordDelta({
      kind: "upsert",
      epicId: "epic-test",
      record: theirs,
    });
    expect(store.getState().chats.allIds).toEqual(["c"]);
    expect(store.getState().chats.byId.c.userId).toBe("user-a");
    expect(store.getState().chats.byId.c.hostId).toBe("host-1");

    // Poll path.
    store.getState().applyChatRecords([theirs]);
    expect(store.getState().chats.allIds).toEqual(["c"]);
    expect(store.getState().chats.byId.c.userId).toBe("user-a");

    // The viewer's OWN row still hands over normally - the narrowing is on
    // identity, not a blanket refusal to reconcile.
    store
      .getState()
      .applyChatRecords([record({ chatId: "c", title: "Mine", revision: 3 })]);
    expect(store.getState().chats.byId.c.title).toBe("Mine");
    expect(store.getState().chats.byId.c.hostId).toBe("host-1");
    session.handle.dispose();
  });

  it("retains even when the record beat the create's answer, so a stale poll cannot leave nothing", () => {
    // An ordering the create cannot control: the owning host pushes its record
    // the moment it commits, so the delta can arrive BEFORE `epic.createChat`
    // answers.
    //
    // Ablation: refuse the registration in that case - "there is already a real
    // row, nothing to stand in for" - and the older list answer below, issued
    // before the chat existed and landing after it, clear-and-replaces that row
    // away leaving NEITHER a record nor a stand-in. The chat vanishes until
    // another poll, which cross-host is the minutes-long replication path.
    signedInAs("user-a");
    const session = newSession(seedChats([]));
    const store = session.handle.store;
    const served = record({ chatId: "c", title: "Served", revision: 4 });

    store.getState().applyChatRecordDelta({
      kind: "upsert",
      epicId: "epic-test",
      record: served,
    });
    store.getState().beginPendingChatCreation({
      chatId: "c",
      hostId: "host-1",
      parentChatId: null,
      title: "",
      ownerUserId: "user-a",
    });
    // Retained, but SHADOWED: while the real row is there it wins every field.
    expect(store.getState().chats.allIds).toEqual(["c"]);
    expect(store.getState().chats.byId.c.title).toBe("Served");

    // The stale answer lands.
    store.getState().applyChatRecords([]);
    expect(store.getState().chats.allIds).toEqual(["c"]);
    expect(store.getState().chats.byId.c.title).toBe("");

    // The next answer that carries the row hands over and retires the stand-in
    // - proven by the answer after it, which now empties the table for real.
    store.getState().applyChatRecords([served]);
    expect(store.getState().chats.byId.c.title).toBe("Served");
    store.getState().applyChatRecords([]);
    expect(store.getState().chats.allIds).toEqual([]);
    session.handle.dispose();
  });

  it("files the stand-in under the CAPTURED owner, not whoever is signed in when it lands", () => {
    // The create was authorized as user-a; the profile changed while it was in
    // flight, and the host's answer arrives with user-b signed in. Reading the
    // profile here would file user-a's chat under user-b - visible to a user who
    // never made it, and unretirable by user-a's real record, which arrives
    // under its actual owner and so never matches the row.
    signedInAs("user-a");
    const session = newSession(seedChats([]));
    const store = session.handle.store;

    signedInAs("user-b");
    store.getState().beginPendingChatCreation({
      chatId: "created-as-a",
      hostId: "host-1",
      parentChatId: null,
      title: "",
      ownerUserId: "user-a",
    });

    // Invisible to the user now signed in...
    expect(store.getState().chats.allIds).toEqual([]);

    // ...and still user-a's when they come back, where its own record retires it.
    signedInAs("user-a");
    expect(store.getState().chats.allIds).toEqual(["created-as-a"]);
    store.getState().applyChatRecords([record({ chatId: "created-as-a" })]);
    expect(store.getState().chats.byId["created-as-a"].userId).toBe("user-a");
    session.handle.dispose();
  });

  it("refuses to retain a creation the caller could not attribute", () => {
    // A stand-in has to say whose it is: the registry keys on
    // `(ownerUserId, chatId)`, and an unattributed row could be retired by a
    // stranger's same-id record or rendered to whoever signs in next. Refusing
    // degrades to the behavior that existed before this registry - the chat
    // surfaces when its own record arrives - which is why every test above
    // names an owner.
    //
    // `null` is how the CALLER reports "nobody was signed in when the request
    // left". The store no longer reads the profile itself, so this is the whole
    // of the unattributed case rather than a stand-in for an empty auth store.
    const session = newSession(seedChats([]));
    const store = session.handle.store;

    store.getState().beginPendingChatCreation({
      chatId: "unattributed",
      hostId: "host-1",
      parentChatId: null,
      title: "",
      ownerUserId: null,
    });

    expect(store.getState().chats.allIds).toEqual([]);
    session.handle.dispose();
  });
});
