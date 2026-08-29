/**
 * Behaviour-identity pins for the extracted replica runtime, wired through
 * `createOpenEpicStore` (`store.ts`). Each assertion is a cross-plane
 * sequencing invariant that a naive re-decomposition of the old monolithic
 * closure could silently break while every single-plane unit test still
 * passes.
 *
 * 1. A viewer-role snapshot tears down every artifact room AND republishes
 *    divergence (`epic-replica-runtime.ts`'s `applyRootSnapshot`: `if
 *    (!control.facts.isWritableRole()) { rooms.dropAllOnViewerDowngrade();
 *    records.publishDivergence(); return; }`).
 * 2. `requestFreshSnapshot` closes the socket BEFORE clearing coverage and
 *    reopens AFTER, so the reattach that follows sends no seed offer
 *    (`legacy-epic-stream-adapter.ts`'s `closeTransport`/`openTransport`
 *    split, `epic-replica-runtime.ts`'s `requestFreshSnapshot`).
 * 3. `detachTransport` publishes `hostTransportStatus: "closed"` but leaves
 *    the internal transport leg untouched, so the projected divergence
 *    fields freeze rather than resuming queueing
 *    (`epic-control-replica.ts`'s `noteTransportDetached` doc comment).
 * 4. A user switch on a DETACHED handle must not blank the projection. The
 *    old closure's `useAuthStore` subscriber ended with an unguarded
 *    `store.setState(projector.projectFull())` - every other call site in
 *    that file checked `projector.isAttached()` first, this one didn't -
 *    so a user switch after `detachTransport()` wrote EMPTY projected
 *    slices into a store whose retention contract says display freezes.
 *    Fixed: `reprojectForViewerChange()` -> `records.project()` ->
 *    `projector.projectFull()` now returns `EMPTY_PROJECTED_SLICES` AND
 *    publishes nothing while detached (`epic-projector.ts`'s `projectFull`
 *    guards `attached === null` before calling `attached.sink.publish`).
 * 5. `chatRecordListAuthoritative` must round-trip through the sink. The old
 *    auth subscriber cleared this projected field with a direct
 *    `store.setState({ chatRecordListAuthoritative: false })`, bypassing the
 *    sink `markChatRecordListAuthoritative()` reads its change gate from -
 *    so the sink kept believing `true` while the store said `false`, and
 *    `markChatRecordListAuthoritative()`'s early-out
 *    (`if (sink.read().chatRecordListAuthoritative) return;`) meant the flag
 *    could never be restored. Fixed: the subscriber now routes the clear
 *    through `runtime.markChatRecordListNotAuthoritative()`
 *    (`epic-records-replica.ts`), which writes the SAME sink the setter
 *    reads.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { ChatRecordSummaryV11 } from "@traycer/protocol/host/epic/chat-records";
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
 * Materializes the artifact-room doc for `artifactId` by taking a lease and
 * reading its fragment - the same "editor is mounted" stand-in used by
 * `store.test.ts`. The lease is intentionally not released, so the room stays
 * hot for the assertions that follow.
 */
function leasedFragmentDoc(
  opened: OpenEpicStoreHandle,
  artifactId: string,
): Y.Doc {
  opened.store.getState().acquireArtifactBodyLease(artifactId);
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
 * A factory whose events feed into ONE shared array, in order, so the
 * ordering between `close()` on the outgoing client and the factory being
 * invoked again for the incoming one can be asserted directly rather than
 * inferred from side effects.
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
  let handle: OpenEpicStoreHandle | null = null;

  afterEach(() => {
    handle?.dispose();
    handle = null;
    // The auth store is module-global; a test that signs in must not leak
    // that identity into the next one (mirrors `chat-records-union.test.ts`).
    useAuthStore.getState().setSignedOut();
  });

  it("a viewer-role snapshot tears down every artifact room and republishes divergence", () => {
    const { factory, handle: streamHandle } = fakeFactory();
    handle = createOpenEpicStore({
      epicId: "epic-viewer-teardown",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
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

    const fragmentDoc = leasedFragmentDoc(opened, "art-1");
    expect(opened.hotArtifactRoomIdsForTests()).toEqual(["artifact-room-0"]);
    expect(opened.store.getState().isDirty).toBe(false);

    // Go offline and make a local edit to the room body - this sets the
    // room's own dirty watermark, which `hasRoomDivergence()` folds into the
    // published `isDirty` even though the ROOT doc has nothing unsynced.
    streamHandle().callbacks.onConnectionStatus("reconnecting", null);
    fragmentDoc.transact(() => {
      fragmentDoc.getMap("offline").set("k", "v");
    });
    expect(opened.store.getState().isDirty).toBe(true);

    // A reconnect snapshot that downgrades the role to viewer. Per
    // `applyRootSnapshot`, an unwritable role fails closed: every room is
    // torn down (`rooms.dropAllOnViewerDowngrade()`), unconditionally, and
    // divergence is republished (`records.publishDivergence()`) - so the
    // now-empty room set clears the room-side contribution to `isDirty`.
    streamHandle().callbacks.onSnapshot(
      buildMeta("viewer", donor),
      Y.encodeStateAsUpdate(donor),
    );

    expect(opened.store.getState().permissionRole).toBe("viewer");
    expect(opened.hotArtifactRoomIdsForTests()).toEqual([]);
    expect(opened.store.getState().isDirty).toBe(false);
    expect(opened.store.getState().unsyncedQueueSize).toBe(0);
  });

  it("requestFreshSnapshot closes the socket before coverage is cleared and reopens after, so the reattach offer is null", () => {
    const { factory, handle: streamHandle, sequence } = sequencingFactory();
    handle = createOpenEpicStore({
      epicId: "epic-close-before-open",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
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

    // Every factory invocation and every close lands in one shared sequence,
    // and the whole of it is asserted below rather than the tail. Truncating it
    // first (this read `sequence.length = 0`) would have been both a write to a
    // `readonly` array and a weaker test: erasing the constructor's own record
    // means an unexpected extra open before this point becomes invisible, which
    // is exactly the kind of thing an ordering assertion exists to catch.
    expect(sequence).toEqual(["open"]);

    opened.requestFreshSnapshot();

    // One open from construction, then close STRICTLY BEFORE the factory is
    // invoked again for the replacement client - the re-subscribe reads the
    // seed offer, so an offer taken before coverage is cleared would name state
    // this client just discarded.
    expect(sequence).toEqual(["open", "close", "open"]);
    expect(streamHandle().callbacks).toBeDefined();
  });

  it("detachTransport publishes hostTransportStatus:closed but freezes the divergence projection - a later local edit does not resume queueing", () => {
    const { factory, handle: streamHandle } = fakeFactory();
    handle = createOpenEpicStore({
      epicId: "epic-detach-freeze",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
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

    // A local edit AFTER the detach. Two different things happen to the two
    // divergence signals, and conflating them is the trap this test exists to
    // hold open.
    opened.doc.getMap("epic").set("title", "edited after detach");

    // THE FREEZE, and the only one: the queue does not grow. `detachTransport`
    // deliberately leaves the control plane's INTERNAL transport leg alone, so
    // `applyLocalUpdate` still takes its send path and the send is dropped by
    // an adapter with no client. Flipping that leg to "closed" would route the
    // edit into the unsynced buffer instead - a buffer nothing will ever drain,
    // on a handle whose whole promise is that it takes no further input.
    expect(opened.store.getState().unsyncedQueueSize).toBe(frozenQueueSize);
    expect(opened.store.getState().hostTransportStatus).toBe("closed");

    // NOT frozen, and it must not be: the edit really is unsynced, so saying so
    // is the honest reading. The doc's update listener is bound for the
    // replica's life and `detachTransport` does not unbind it - only dispose
    // and a replica swap do. Gating this on the detach would let a retained
    // buffer that has since accumulated NEW edits keep reporting itself clean,
    // which is the one direction the divergence arithmetic may never round.
    expect(opened.store.getState().isDirty).toBe(true);
    expect(
      opened.store.getState().dirtyWatermarkStateVectorBase64,
    ).not.toBeNull();
  });

  it("a user switch on a DETACHED handle does not blank the projected slices", () => {
    signedInAs("user-a");
    const { factory, handle: streamHandle } = fakeFactory();
    handle = createOpenEpicStore({
      epicId: "epic-detach-user-switch",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });
    const opened = handle;

    // Land a snapshot with a non-empty artifact slice, then a chat record so
    // `chats`/`tree` are non-empty too - the union (`chats`) is what the old
    // bug's unguarded `projectFull()` write would have blanked.
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
    // REFERENCE equality, not deep: a rebuilt-but-content-equal projection
    // would pass a `toEqual` check and miss the exact regression class this
    // pins - the old bug's `projectFull()` write handed back a NEW (empty)
    // object, which a deep-equality assertion against non-empty fixtures
    // would already have caught, but a fix that merely restores CONTENT
    // while still re-publishing on every detached user switch would not be.
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
    handle = createOpenEpicStore({
      epicId: "epic-authoritative-roundtrip",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
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

    // Step 2: a real user switch clears it through
    // `runtime.markChatRecordListNotAuthoritative()`, which writes the SAME
    // sink the setter's change gate reads.
    signedInAs("user-b");
    expect(opened.store.getState().chatRecordListAuthoritative).toBe(false);

    // Step 3: the whole point of this test. Against the bug, the sink was
    // still holding `true` from step 1 (the clear in step 2 wrote the store
    // directly, never the sink), so this call's early-out
    // (`if (sink.read().chatRecordListAuthoritative) return;`) would silently
    // no-op and the flag would stay `false` forever. Not collapsed into a
    // two-step assertion - this is the regression the fix targets.
    opened.store.getState().markChatRecordListAuthoritative();
    expect(opened.store.getState().chatRecordListAuthoritative).toBe(true);
  });
});
