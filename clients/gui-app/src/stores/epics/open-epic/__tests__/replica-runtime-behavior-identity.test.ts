import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { ChatRecordSummaryV11 } from "@traycer/protocol/host/epic/chat-records";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import { useAuthStore } from "@/stores/auth/auth-store";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function stateVectorBase64(doc: Y.Doc): string {
  return encodeBase64(Y.encodeStateVector(doc));
}

function emptySnapshot(): Uint8Array {
  return Y.encodeStateAsUpdate(new Y.Doc());
}

function buildMeta(
  role: "owner" | "editor" | "viewer" | null,
  hostDoc: Y.Doc | null,
): SnapshotMetaEpic {
  const nextHostDoc = hostDoc === null ? new Y.Doc() : hostDoc;
  return {
    schemaVersion: "1.0",
    epicLight:
      role === null
        ? null
        : {
            id: "epic-a",
            title: "Epic A",
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
    permissionRole: role,
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: stateVectorBase64(nextHostDoc),
  };
}

function seedRootArtifactWithArtifactRoom(
  targetDoc: Y.Doc,
  artifactId: string,
  artifactRoomId: string,
): void {
  const epicMap = targetDoc.getMap<unknown>("epic");
  let artifacts = epicMap.get("artifacts");
  if (!(artifacts instanceof Y.Map)) {
    artifacts = new Y.Map<unknown>();
    epicMap.set("artifacts", artifacts);
  }
  const entry = new Y.Map<unknown>();
  entry.set("id", artifactId);
  entry.set("kind", "spec");
  entry.set("title", "Spec One");
  entry.set("parentId", null);
  entry.set("createdAt", 0);
  entry.set("updatedAt", 0);
  entry.set("artifactRoomId", artifactRoomId);
  (artifacts as Y.Map<unknown>).set(artifactId, entry);
}

/**
 * A doc-backed artifact with no room - simpler seeding for tests that only
 * need a non-empty `artifacts` slice, not a materialized body.
 */
function seedRootArtifact(targetDoc: Y.Doc, artifactId: string): void {
  const epicMap = targetDoc.getMap<unknown>("epic");
  let artifacts = epicMap.get("artifacts");
  if (!(artifacts instanceof Y.Map)) {
    artifacts = new Y.Map<unknown>();
    epicMap.set("artifacts", artifacts);
  }
  const entry = new Y.Map<unknown>();
  entry.set("id", artifactId);
  entry.set("kind", "spec");
  entry.set("title", "Spec One");
  entry.set("parentId", null);
  entry.set("createdAt", 0);
  entry.set("updatedAt", 0);
  (artifacts as Y.Map<unknown>).set(artifactId, entry);
}

/**
 * Materializes the artifact-room doc for `artifactId` by taking a lease and reading its fragment -
 * the same "editor is mounted" stand-in used by `store.test.ts`.
 */
async function leasedFragmentDoc(
  opened: OpenedStoreForTest,
  artifactId: string,
): Promise<Y.Doc> {
  opened.store.getState().acquireArtifactBodyLease(artifactId);
  await opened.flush();
  const fragment = opened.store.getState().getArtifactFragment(artifactId);
  if (fragment === null) throw new Error("expected a materialized fragment");
  const fragmentDoc = fragment.doc;
  if (fragmentDoc === null) throw new Error("expected the fragment's doc");
  return fragmentDoc;
}

function chatRecord(
  overrides: Partial<ChatRecordSummaryV11>,
): ChatRecordSummaryV11 {
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
    // A registry answer (`epic.listChatRecords@1.1`) by default.
    docResident: false,
    ...overrides,
  };
}

/** Same pattern as `chat-records-union.test.ts`'s `signedInAs`. */
function signedInAs(userId: string): void {
  useAuthStore
    .getState()
    .setSignedIn(
      { userId, userName: userId, email: `${userId}@example.com` },
      { userId, username: userId },
      [],
    );
}

interface FakeStreamHandle {
  readonly callbacks: EpicStreamCallbacks;
}

/**
 * Same `fakeFactory` shape as `store.test.ts` / `delta-seed-reattach.test.ts`.
 */
function fakeFactory(): {
  factory: EpicStreamClientFactory;
  handle: () => FakeStreamHandle;
} {
  let current: FakeStreamHandle | null = null;
  const factory: EpicStreamClientFactory = (_epicId, callbacks) => {
    current = { callbacks };
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    };
  };
  return {
    factory,
    handle: () => {
      if (current === null) throw new Error("factory not invoked");
      return current;
    },
  };
}

/**
 * A factory whose events feed into ONE shared array, in order, so the ordering between `close()`
 * on the outgoing client and the factory being invoked again for the incoming one can be asserted
 */
function sequencingFactory(): {
  factory: EpicStreamClientFactory;
  handle: () => FakeStreamHandle;
  sequence: readonly string[];
} {
  const sequence: string[] = [];
  let current: FakeStreamHandle | null = null;
  const factory: EpicStreamClientFactory = (_epicId, callbacks) => {
    sequence.push("open");
    current = { callbacks };
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => {
        sequence.push("close");
      },
    };
  };
  return {
    factory,
    handle: () => {
      if (current === null) throw new Error("factory not invoked");
      return current;
    },
    sequence,
  };
}

describe("replica runtime behaviour identity - epic.subscribe@1 scripted sequences", () => {
  let handle: OpenedStoreForTest | null = null;

  afterEach(() => {
    handle?.dispose();
    handle = null;
    // The auth store is module-global; a test that signs in must not leak
    // that identity into the next one (mirrors `chat-records-union.test.ts`).
    useAuthStore.getState().setSignedOut();
  });

  it("a viewer-role snapshot tears down every artifact room and republishes divergence", async () => {
    const { factory, handle: streamHandle } = fakeFactory();
    handle = openStoreForTest({
      epicId: "epic-viewer-teardown",
      userId: null,
      // `handle.doc` still resolves because this harness builds the runtime in THIS thread.
      factories: {
        streamClientFactory: factory,
        laneSelection: null,
      },
      // Explicit: `null` means this suite never writes, so a write in
      // one that said so fails rather than resolving quietly.
      writeCommand: null,
    });
    const opened = handle;

    // Editor snapshot carrying one artifact with a room, then the room's own
    // snapshot - materializes the room hot once an editor takes a lease.
    const donor = new Y.Doc();
    seedRootArtifactWithArtifactRoom(donor, "art-1", "artifact-room-0");
    streamHandle().callbacks.onConnectionStatus("open", null);
    streamHandle().callbacks.onSnapshot(
      buildMeta("editor", donor),
      Y.encodeStateAsUpdate(donor),
    );
    streamHandle().callbacks.onArtifactRoomSnapshot(
      "artifact-room-0",
      emptySnapshot(),
      stateVectorBase64(new Y.Doc()),
    );

    const fragmentDoc = await leasedFragmentDoc(opened, "art-1");
    expect(opened.hotArtifactRoomIdsForTests()).toEqual(["artifact-room-0"]);
    expect(opened.store.getState().isDirty).toBe(false);

    // Go offline and make a local edit to the room body - this sets the room's own dirty watermark,
    // which `hasRoomDivergence()` folds into the published `isDirty` even though the ROOT doc has
    streamHandle().callbacks.onConnectionStatus("reconnecting", null);
    fragmentDoc.transact(() => {
      fragmentDoc.getMap("offline").set("k", "v");
    });
    expect(opened.store.getState().isDirty).toBe(true);

    // A reconnect snapshot that downgrades the role to viewer.
    streamHandle().callbacks.onSnapshot(
      buildMeta("viewer", donor),
      Y.encodeStateAsUpdate(donor),
    );

    expect(opened.store.getState().permissionRole).toBe("viewer");
    expect(opened.hotArtifactRoomIdsForTests()).toEqual([]);
    expect(opened.store.getState().isDirty).toBe(false);
    expect(opened.store.getState().unsyncedQueueSize).toBe(0);
    // The published projection agrees: no artifact reads as `ready` when every
    // room backing one has been destroyed.
    expect(
      opened.store.getState().artifactRooms.stateByArtifactId["art-1"],
    ).not.toBe("ready");

    // AND STAYS THAT WAY across an ordinary root update.
    donor.getMap("epic").set("title", "an ordinary later edit");
    streamHandle().callbacks.onUpdate(Y.encodeStateAsUpdate(donor));

    expect(opened.hotArtifactRoomIdsForTests()).toEqual([]);
    expect(
      opened.store.getState().artifactRooms.stateByArtifactId["art-1"],
    ).not.toBe("ready");
  });

  it("requestFreshSnapshot closes the socket before coverage is cleared and reopens after, so the reattach offer is null", () => {
    const { factory, handle: streamHandle, sequence } = sequencingFactory();
    handle = openStoreForTest({
      epicId: "epic-close-before-open",
      userId: null,
      // `handle.doc` still resolves because this harness builds the runtime in THIS thread.
      factories: {
        streamClientFactory: factory,
        laneSelection: null,
      },
      // Explicit: `null` means this suite never writes, so a write in
      // one that said so fails rather than resolving quietly.
      writeCommand: null,
    });
    const opened = handle;

    // Seed a full snapshot carrying a roomId, so a non-null seed offer exists
    // going into `requestFreshSnapshot`.
    const donor = new Y.Doc();
    donor.getMap("epic").set("title", "hello");
    streamHandle().callbacks.onSnapshot(
      { ...buildMeta("editor", donor), roomId: "room-xyz" },
      Y.encodeStateAsUpdate(donor),
    );

    // Every factory invocation and every close lands in one shared sequence, and the whole of it is
    // asserted below rather than the tail.
    expect(sequence).toEqual(["open"]);

    opened.requestFreshSnapshot();

    expect(sequence).toEqual(["open", "close", "open"]);
    expect(streamHandle().callbacks).toBeDefined();
  });

  it("detachTransport publishes hostTransportStatus:closed but freezes the divergence projection - a later local edit does not resume queueing", () => {
    const { factory, handle: streamHandle } = fakeFactory();
    handle = openStoreForTest({
      epicId: "epic-detach-freeze",
      userId: null,
      // `handle.doc` still resolves because this harness builds the runtime in THIS thread.
      factories: {
        streamClientFactory: factory,
        laneSelection: null,
      },
      // Explicit: `null` means this suite never writes, so a write in
      // one that said so fails rather than resolving quietly.
      writeCommand: null,
    });
    const opened = handle;

    const donor = new Y.Doc();
    donor.getMap("epic").set("title", "hello");
    streamHandle().callbacks.onConnectionStatus("open", null);
    streamHandle().callbacks.onSnapshot(
      buildMeta("editor", donor),
      Y.encodeStateAsUpdate(donor),
    );

    expect(opened.store.getState().hostTransportStatus).toBe("open");

    opened.detachTransport();

    expect(opened.store.getState().hostTransportStatus).toBe("closed");

    const frozenQueueSize = opened.store.getState().unsyncedQueueSize;

    // A local edit AFTER the detach. Two different things happen to the two divergence signals, and
    // conflating them is the trap this test exists to hold open.
    opened.doc.getMap("epic").set("title", "edited after detach");

    // THE FREEZE, and the only one: the queue does not grow.
    expect(opened.store.getState().unsyncedQueueSize).toBe(frozenQueueSize);
    expect(opened.store.getState().hostTransportStatus).toBe("closed");

    // NOT frozen, and it must not be: the edit really is unsynced, so saying so is the honest reading.
    expect(opened.store.getState().isDirty).toBe(true);
    expect(
      opened.store.getState().dirtyWatermarkStateVectorBase64,
    ).not.toBeNull();
  });

  it("a user switch on a DETACHED handle does not blank the projected slices", () => {
    signedInAs("user-a");
    const { factory, handle: streamHandle } = fakeFactory();
    handle = openStoreForTest({
      epicId: "epic-detach-user-switch",
      userId: null,
      // `handle.doc` still resolves because this harness builds the runtime in THIS thread.
      factories: {
        streamClientFactory: factory,
        laneSelection: null,
      },
      // Explicit: `null` means this suite never writes, so a write in
      // one that said so fails rather than resolving quietly.
      writeCommand: null,
    });
    const opened = handle;

    const donor = new Y.Doc();
    donor.getMap("epic").set("title", "Detach test epic");
    seedRootArtifact(donor, "art-1");
    streamHandle().callbacks.onConnectionStatus("open", null);
    streamHandle().callbacks.onSnapshot(
      buildMeta("editor", donor),
      Y.encodeStateAsUpdate(donor),
    );
    opened.store
      .getState()
      .applyChatRecords(
        [chatRecord({ chatId: "chat-1", ownerUserId: "user-a" })],
        null,
      );

    const before = opened.store.getState();
    // Non-vacuous: fail loudly rather than pass a reference check against
    // fixtures that never populated anything.
    expect(before.artifacts.allIds.length).toBeGreaterThan(0);
    expect(before.chats.allIds.length).toBeGreaterThan(0);

    const epicBefore = before.epic;
    const artifactsBefore = before.artifacts;
    const chatsBefore = before.chats;
    const treeBefore = before.tree;

    opened.detachTransport();

    // Drive a real user switch through the auth store - the subscriber only
    // fires when `profile?.userId` actually changes.
    signedInAs("user-b");

    const after = opened.store.getState();
    expect(after.epic).toBe(epicBefore);
    expect(after.artifacts).toBe(artifactsBefore);
    expect(after.chats).toBe(chatsBefore);
    expect(after.tree).toBe(treeBefore);
    // Belt-and-suspenders: the retained content itself is still there, not
    // merely the same (possibly-emptied) reference.
    expect(after.artifacts.allIds.length).toBeGreaterThan(0);
    expect(after.chats.allIds.length).toBeGreaterThan(0);
  });

  it("chatRecordListAuthoritative round-trips through the sink across a user switch", () => {
    signedInAs("user-a");
    const { factory, handle: streamHandle } = fakeFactory();
    handle = openStoreForTest({
      epicId: "epic-authoritative-roundtrip",
      userId: null,
      // `handle.doc` still resolves because this harness builds the runtime in THIS thread.
      factories: {
        streamClientFactory: factory,
        laneSelection: null,
      },
      // Explicit: `null` means this suite never writes, so a write in
      // one that said so fails rather than resolving quietly.
      writeCommand: null,
    });
    const opened = handle;

    const donor = new Y.Doc();
    donor.getMap("epic").set("title", "Authoritative roundtrip epic");
    streamHandle().callbacks.onConnectionStatus("open", null);
    streamHandle().callbacks.onSnapshot(
      buildMeta("editor", donor),
      Y.encodeStateAsUpdate(donor),
    );

    // Step 1: mark authoritative, store reads true.
    opened.store.getState().markChatRecordListAuthoritative();
    expect(opened.store.getState().chatRecordListAuthoritative).toBe(true);

    // Step 2: a real user switch clears it through `runtime.markChatRecordListNotAuthoritative()`,
    // which writes the SAME sink the setter's change gate reads.
    signedInAs("user-b");
    expect(opened.store.getState().chatRecordListAuthoritative).toBe(false);

    // Step 3: the whole point of this test.
    opened.store.getState().markChatRecordListAuthoritative();
    expect(opened.store.getState().chatRecordListAuthoritative).toBe(true);
  });
});
