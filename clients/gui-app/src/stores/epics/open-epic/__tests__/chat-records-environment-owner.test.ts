/**
 * A team host keys its task chats by its ENVIRONMENT id and lists them to every
 * admitted member as `origin: "own"`, so the row's owner is never the member.
 * The GUI reads that word through one leaf helper (`isChatVisibleToUser`) and
 * stamps the answer on every projection as `ownedByViewer`.
 *
 * The first block pins the helper's table. The rest drive a REAL open-epic
 * session through its record table, so each claim is read off what the
 * renderer publishes: `chats.byId`, the optimistic overlay, the stand-in
 * retirement.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type {
  ChatRecordOrigin,
  ChatRecordSummaryV11,
} from "@traycer/protocol/host/epic/chat-records";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import { useAuthStore } from "@/stores/auth/auth-store";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { isChatVisibleToUser } from "@/stores/epics/open-epic/projection-helpers";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";

const ENV = "env_team";
const HOST = "host-team";
/** An `issuedAtSeq` no delta in these tests has reached. */
const LATER_THAN_ANY_DELTA = 1_000_000;

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

function newSession(): OpenedStoreForTest {
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
  const handle = openStoreForTest({
    epicId: "epic-test",
    userId: null,
    factories: { streamClientFactory: factory, laneSelection: null },
    writeCommand: null,
  });
  if (captured.value === null) throw new Error("factory not invoked");
  captured.value.onSnapshot(makeMeta(), Y.encodeStateAsUpdate(new Y.Doc()));
  return handle;
}

function record(
  overrides: Partial<ChatRecordSummaryV11>,
): ChatRecordSummaryV11 {
  return {
    chatId: "chat-1",
    ownerUserId: "user-b",
    originHostId: HOST,
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
    docResident: false,
    ...overrides,
  };
}

/** The row a team host serves to an admitted member. */
function envRecord(
  overrides: Partial<ChatRecordSummaryV11>,
): ChatRecordSummaryV11 {
  return record({ ownerUserId: ENV, ...overrides });
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

afterEach(() => {
  useAuthStore.getState().setSignedOut();
});

describe("isChatVisibleToUser", () => {
  interface Case {
    readonly name: string;
    readonly origin: ChatRecordOrigin | null;
    readonly owner: string | null;
    readonly viewer: string | null;
    readonly answeredFor: string | null;
    readonly visible: boolean;
  }
  const cases: readonly Case[] = [
    {
      name: "no origin, owner is the viewer",
      origin: null,
      owner: "u",
      viewer: "u",
      answeredFor: null,
      visible: true,
    },
    {
      name: "no origin, foreign owner",
      origin: null,
      owner: "x",
      viewer: "u",
      answeredFor: null,
      visible: false,
    },
    {
      name: "no origin, null viewer fails open",
      origin: null,
      owner: "x",
      viewer: null,
      answeredFor: null,
      visible: true,
    },
    {
      name: "no origin, null owner fails open",
      origin: null,
      owner: null,
      viewer: "u",
      answeredFor: null,
      visible: true,
    },
    {
      name: "own, foreign owner, no stamp and no viewer fails open",
      origin: "own",
      owner: ENV,
      viewer: null,
      answeredFor: null,
      visible: true,
    },
    {
      name: "own, foreign owner, no stamp once the viewer is known",
      origin: "own",
      owner: ENV,
      viewer: "u",
      answeredFor: null,
      visible: false,
    },
    {
      name: "own, foreign owner, stamp is the viewer",
      origin: "own",
      owner: ENV,
      viewer: "u",
      answeredFor: "u",
      visible: true,
    },
    {
      name: "own, foreign owner, stamp is another user",
      origin: "own",
      owner: ENV,
      viewer: "u",
      answeredFor: "w",
      visible: false,
    },
    {
      name: "own, owner is the viewer, stamp is another user",
      origin: "own",
      owner: "u",
      viewer: "u",
      answeredFor: "w",
      visible: true,
    },
    {
      name: "foreign, foreign owner",
      origin: "foreign",
      owner: "x",
      viewer: "u",
      answeredFor: null,
      visible: false,
    },
    {
      name: "foreign, owner is the viewer",
      origin: "foreign",
      owner: "u",
      viewer: "u",
      answeredFor: "w",
      visible: true,
    },
    {
      name: "foreign, null viewer fails open",
      origin: "foreign",
      owner: "x",
      viewer: null,
      answeredFor: null,
      visible: true,
    },
    {
      name: "foreign, null owner fails open",
      origin: "foreign",
      owner: null,
      viewer: "u",
      answeredFor: null,
      visible: true,
    },
  ];
  it.each(cases)("$name", (row) => {
    expect(
      isChatVisibleToUser(row.origin, row.owner, row.viewer, row.answeredFor),
    ).toBe(row.visible);
  });
});

describe("an environment-owned `own` row, through the record table", () => {
  it("is the signed-in member's chat, and takes a rename and a reparent", async () => {
    signedInAs("user-b");
    const handle = newSession();
    const store = handle.store;
    store
      .getState()
      .applyChatRecords(
        [
          envRecord({ chatId: "parent", title: "Parent" }),
          envRecord({ chatId: "env-chat", title: "Env chat" }),
        ],
        null,
      );

    const state = store.getState();
    expect(state.chats.allIds.slice().sort()).toEqual(["env-chat", "parent"]);
    expect(state.chats.byId["env-chat"].userId).toBe(ENV);
    expect(state.chats.byId["env-chat"].ownedByViewer).toBe(true);
    expect(state.tree.rootIds.slice().sort()).toEqual(["env-chat", "parent"]);

    // The overlay's registry-backed gate asks the record table whether it
    // SERVES the node to the viewer; an owner-equality answer would have left
    // this a doc-only rename that the dead sweep deletes.
    const renameId = await store
      .getState()
      .beginRenameMutation("env-chat", "Renamed");
    expect(renameId).not.toBeNull();
    expect(store.getState().chats.byId["env-chat"].title).toBe("Renamed");

    const reparentId = await store
      .getState()
      .beginReparentMutation("env-chat", "parent");
    expect(reparentId).not.toBeNull();
    expect(store.getState().tree.childrenByParent.parent).toEqual(["env-chat"]);
    handle.dispose();
  });

  it("stays in the slice the tab-absence sweep reads, through a delta and a later snapshot", () => {
    signedInAs("user-b");
    const handle = newSession();
    const store = handle.store;
    store.getState().applyChatRecordDelta({
      kind: "upsert",
      epicId: "epic-test",
      record: envRecord({ chatId: "env-chat", revision: 1 }),
    });
    expect(Object.hasOwn(store.getState().chats.byId, "env-chat")).toBe(true);

    store
      .getState()
      .applyChatRecords([envRecord({ chatId: "env-chat", revision: 2 })], null);
    expect(Object.hasOwn(store.getState().chats.byId, "env-chat")).toBe(true);
    handle.dispose();
  });
});

describe("an account switch on a table that has only seen deltas", () => {
  it("does not show the previous account's `own` rows to the next one", () => {
    // No list snapshot ever lands, so only the deltas can say whom the host
    // answered for. A's rows must not survive the switch into B's slice.
    signedInAs("user-a");
    const handle = newSession();
    const store = handle.store;
    store.getState().applyChatRecordDelta({
      kind: "upsert",
      epicId: "epic-test",
      record: record({ chatId: "a-chat", ownerUserId: "user-a" }),
    });
    store.getState().applyChatRecordDelta({
      kind: "upsert",
      epicId: "epic-test",
      record: envRecord({ chatId: "env-chat" }),
    });
    expect(store.getState().chats.allIds.slice().sort()).toEqual([
      "a-chat",
      "env-chat",
    ]);

    signedInAs("user-b");
    expect(store.getState().chats.allIds).toEqual([]);
    handle.dispose();
  });
});

describe("a pre-P11 row with no environment owner", () => {
  it("shows an `own` row owned by the viewer and hides a `foreign` row owned by another user", () => {
    signedInAs("user-a");
    const handle = newSession();
    handle.store.getState().applyChatRecords(
      [
        record({ chatId: "mine", ownerUserId: "user-a" }),
        record({
          chatId: "theirs",
          ownerUserId: "user-b",
          origin: "foreign",
          visibility: "task",
        }),
      ],
      null,
    );
    const state = handle.store.getState();
    expect(state.chats.allIds).toEqual(["mine"]);
    expect(state.chats.byId.mine.ownedByViewer).toBe(true);
    handle.dispose();
  });

  it("shows a `foreign` replica owned by the viewer", () => {
    signedInAs("user-a");
    const handle = newSession();
    handle.store.getState().applyChatRecordDelta({
      kind: "upsert",
      epicId: "epic-test",
      record: record({
        chatId: "elsewhere",
        ownerUserId: "user-a",
        originHostId: "host-2",
        origin: "foreign",
        visibility: "task",
      }),
    });
    const state = handle.store.getState();
    expect(state.chats.allIds).toEqual(["elsewhere"]);
    expect(state.chats.byId.elsewhere.ownedByViewer).toBe(true);
    handle.dispose();
  });
});

describe("a stand-in for a chat created on a team host", () => {
  function beginStandIn(handle: OpenedStoreForTest): void {
    handle.store.getState().beginPendingChatCreation({
      chatId: "just-created",
      hostId: HOST,
      parentChatId: null,
      title: "",
      ownerUserId: "user-b",
    });
    expect(handle.store.getState().chats.byId["just-created"].userId).toBe(
      "user-b",
    );
  }

  it("retires when the host's environment-owned `own` row arrives in a snapshot", () => {
    signedInAs("user-b");
    const handle = newSession();
    beginStandIn(handle);

    handle.store
      .getState()
      .applyChatRecords(
        [envRecord({ chatId: "just-created", title: "Served" })],
        null,
      );
    const chats = handle.store.getState().chats;
    expect(chats.allIds).toEqual(["just-created"]);
    expect(chats.byId["just-created"].userId).toBe(ENV);

    // The stand-in is gone for good: a later snapshot that omits the row would
    // otherwise resurrect it under the viewer, beside the environment's copy.
    handle.store.getState().applyChatRecords([], null);
    expect(handle.store.getState().chats.allIds).toEqual([]);
    handle.dispose();
  });

  it("retires when the host's environment-owned `own` row arrives as a delta", () => {
    signedInAs("user-b");
    const handle = newSession();
    beginStandIn(handle);

    handle.store.getState().applyChatRecordDelta({
      kind: "upsert",
      epicId: "epic-test",
      record: envRecord({ chatId: "just-created", title: "Pushed" }),
    });
    const chats = handle.store.getState().chats;
    expect(chats.allIds).toEqual(["just-created"]);
    expect(chats.byId["just-created"].userId).toBe(ENV);

    // A list issued after the delta that no longer carries the row takes it
    // out; a stand-in that outlived the delta would show through in its place.
    handle.store.getState().applyChatRecords([], LATER_THAN_ANY_DELTA);
    expect(handle.store.getState().chats.allIds).toEqual([]);
    handle.dispose();
  });

  it("is not retired by a `foreign` row with another owner", () => {
    signedInAs("user-b");
    const handle = newSession();
    beginStandIn(handle);

    handle.store.getState().applyChatRecordDelta({
      kind: "upsert",
      epicId: "epic-test",
      record: record({
        chatId: "just-created",
        ownerUserId: ENV,
        origin: "foreign",
        visibility: "task",
        revision: 5,
      }),
    });
    handle.store.getState().applyChatRecords(
      [
        record({
          chatId: "just-created",
          ownerUserId: ENV,
          origin: "foreign",
          visibility: "task",
          revision: 6,
        }),
      ],
      null,
    );

    const chats = handle.store.getState().chats;
    expect(chats.allIds).toEqual(["just-created"]);
    expect(chats.byId["just-created"].userId).toBe("user-b");
    expect(chats.byId["just-created"].hostId).toBe(HOST);
    handle.dispose();
  });

  it("is not retired by an environment-owned `own` row from ANOTHER host", () => {
    signedInAs("user-b");
    const handle = newSession();
    beginStandIn(handle);

    handle.store
      .getState()
      .applyChatRecords(
        [envRecord({ chatId: "just-created", originHostId: "host-other" })],
        null,
      );
    expect(handle.store.getState().chats.byId["just-created"].hostId).toBe(
      "host-other",
    );

    handle.store.getState().applyChatRecords([], LATER_THAN_ANY_DELTA);
    const chats = handle.store.getState().chats;
    expect(chats.allIds).toEqual(["just-created"]);
    expect(chats.byId["just-created"].userId).toBe("user-b");
    expect(chats.byId["just-created"].hostId).toBe(HOST);
    handle.dispose();
  });
});
