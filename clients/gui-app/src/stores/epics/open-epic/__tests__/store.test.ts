import "../../../../../__tests__/test-browser-apis";
import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
} from "@/stores/epics/open-epic/store";

interface FakeStreamHandle {
  readonly callbacks: EpicStreamCallbacks;
  readonly applied: Uint8Array[];
  readonly awarenessSent: Uint8Array[];
  readonly artifactRoomApplied: Array<{
    readonly artifactRoomId: string;
    readonly bytes: Uint8Array;
  }>;
  readonly artifactRoomAwarenessSent: Array<{
    readonly artifactRoomId: string;
    readonly bytes: Uint8Array;
  }>;
  retryMigrationCount: number;
  closeCount: number;
}

function fakeFactory(): {
  factory: EpicStreamClientFactory;
  handle: () => FakeStreamHandle;
  handles: () => ReadonlyArray<FakeStreamHandle>;
} {
  let current: FakeStreamHandle | null = null;
  const all: FakeStreamHandle[] = [];
  const factory: EpicStreamClientFactory = (_epicId, callbacks) => {
    const h: FakeStreamHandle = {
      callbacks,
      applied: [],
      awarenessSent: [],
      artifactRoomApplied: [],
      artifactRoomAwarenessSent: [],
      retryMigrationCount: 0,
      closeCount: 0,
    };
    current = h;
    all.push(h);
    return {
      applyUpdate: (bytes) => h.applied.push(bytes),
      awareness: (bytes) => h.awarenessSent.push(bytes),
      applyArtifactRoomUpdate: (artifactRoomId, bytes) => {
        h.artifactRoomApplied.push({ artifactRoomId, bytes });
      },
      artifactRoomAwareness: (artifactRoomId, bytes) => {
        h.artifactRoomAwarenessSent.push({ artifactRoomId, bytes });
      },
      retryMigration: () => {
        h.retryMigrationCount += 1;
      },
      close: () => {
        h.closeCount += 1;
      },
    };
  };
  return {
    factory,
    handle: () => {
      if (current === null) throw new Error("factory not invoked");
      return current;
    },
    handles: () => all,
  };
}

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function stateVectorBase64(doc: Y.Doc): string {
  return encodeBase64(Y.encodeStateVector(doc));
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

function emptySnapshot(): Uint8Array {
  return Y.encodeStateAsUpdate(new Y.Doc());
}

function expectBytesEqual(actual: Uint8Array, expected: Uint8Array): void {
  expect(Array.from(actual)).toEqual(Array.from(expected));
}

describe("createOpenEpicStore", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("projects the snapshot frame into store state", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-a",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });

    const donor = new Y.Doc();
    donor.getMap("epic").set("title", "hello");
    const snapshotBytes = Y.encodeStateAsUpdate(donor);

    handle().callbacks.onSnapshot(buildMeta("editor", null), snapshotBytes);

    const state = opened.store.getState();
    expect(state.snapshotLoaded).toBe(true);
    expect(state.permissionRole).toBe("editor");
    expect(state.snapshotMeta).not.toBeNull();
    expect(opened.doc.getMap("epic").get("title")).toBe("hello");

    opened.dispose();
  });

  it("namespaces the persist key by identity and epicId", () => {
    const { factory } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-a",
      streamClientFactory: factory,
      userId: "alice@example.com",
      onAuthError: null,
    });

    // Persisting a field flushes the slice to localStorage under the persist
    // middleware's resolved name. With localStorage cleared in beforeEach, the
    // single resulting key IS that resolved name. The expected value is a
    // hand-written literal (not derived from openEpicKey/STORE_KEYS): it guards
    // the full chain catalog leaf → builder → factory call site for the
    // per-epic, per-identity bucket. Segment order is bucket-then-epicId.
    opened.store.getState().setLastFocusedArtifactId("art-1");

    expect(window.localStorage.length).toBe(1);
    expect(window.localStorage.key(0)).toBe(
      "traycer-gui-app:open-epic:alice@example.com:epic-a",
    );

    opened.dispose();
  });

  it("records epicDeleted with attribution on the onEpicDeleted frame", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-a",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });

    handle().callbacks.onEpicDeleted({
      deletedByDisplayName: "Alice",
      deletedByTraycerUserId: "user-alice",
    });

    const state = opened.store.getState();
    expect(state.epicDeleted).toEqual({
      deletedByDisplayName: "Alice",
      deletedByTraycerUserId: "user-alice",
    });
    // A delete is not a revoke - accessLost stays its default.
    expect(state.accessLost).toBe(false);

    opened.dispose();
  });

  it("sets accessLost (not epicDeleted) on a full revoke via onPermissionChanged(null)", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-a",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });

    handle().callbacks.onSnapshot(buildMeta("editor", null), emptySnapshot());
    handle().callbacks.onPermissionChanged(null);

    const state = opened.store.getState();
    expect(state.accessLost).toBe(true);
    expect(state.permissionRole).toBeNull();
    // Revoke and delete are distinct signals; a revoke must not look like a
    // delete to the access coordinator.
    expect(state.epicDeleted).toBeNull();

    opened.dispose();
  });

  it("does not raise a close signal on a downgrade to viewer (downgrade != close)", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-a",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });

    handle().callbacks.onSnapshot(buildMeta("editor", null), emptySnapshot());
    handle().callbacks.onPermissionChanged("viewer");

    const state = opened.store.getState();
    expect(state.permissionRole).toBe("viewer");
    // A downgrade keeps the tab open read-only - neither terminal close signal
    // the coordinator reacts to may be set.
    expect(state.accessLost).toBe(false);
    expect(state.epicDeleted).toBeNull();

    opened.dispose();
  });

  it("applies subsequent update frames to the local Y.Doc", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-a",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });

    handle().callbacks.onSnapshot(buildMeta("editor", null), emptySnapshot());

    const donor = new Y.Doc();
    donor.getMap("epic").set("title", "v1");
    const update = Y.encodeStateAsUpdate(donor);
    handle().callbacks.onUpdate(update);

    expect(opened.doc.getMap("epic").get("title")).toBe("v1");

    opened.dispose();
  });

  it("marks the session dirty on local edits while open even when the queue stays empty", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-a",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });
    const hostDoc = new Y.Doc();
    handle().callbacks.onConnectionStatus("open", null);
    handle().callbacks.onSnapshot(
      buildMeta("editor", hostDoc),
      emptySnapshot(),
    );

    opened.doc.getMap("epic").set("title", "Locally edited");

    const state = opened.store.getState();
    expect(handle().applied.length).toBe(1);
    expect(state.isDirty).toBe(true);
    expect(state.unsyncedQueueSize).toBe(0);
    expect(state.dirtyWatermarkStateVectorBase64).toBe(
      stateVectorBase64(opened.doc),
    );
    expect(state.latestHostStateVectorBase64).toBe(stateVectorBase64(hostDoc));

    opened.dispose();
  });

  it("handles permission downgrade, upgrade, and full revoke", () => {
    const { factory, handle, handles } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-a",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });

    handle().callbacks.onConnectionStatus("open", null);
    handle().callbacks.onSnapshot(buildMeta("editor", null), emptySnapshot());
    opened.doc.getMap("epic").set("title", "Locally renamed");

    const initialStream = handles()[0];
    handle().callbacks.onPermissionChanged("viewer");
    expect(opened.store.getState().permissionRole).toBe("viewer");
    expect(opened.store.getState().snapshotLoaded).toBe(false);
    expect(opened.store.getState().connectionStatus).toBe("connecting");
    expect(opened.store.getState().isDirty).toBe(false);
    expect(opened.store.getState().dirtyWatermarkStateVectorBase64).toBeNull();
    expect(opened.store.getState().latestHostStateVectorBase64).toBeNull();
    expect(opened.doc.getMap("epic").get("title")).toBeUndefined();
    expect(initialStream.closeCount).toBe(1);
    expect(handles().length).toBe(2);

    const rebound = handles()[1];
    rebound.callbacks.onConnectionStatus("open", null);
    rebound.callbacks.onSnapshot(buildMeta("viewer", null), emptySnapshot());

    // A local write while viewer should be dropped after the refresh.
    opened.store.getState().applyLocalUpdate(new Uint8Array([9, 9]));
    expect(rebound.applied.length).toBe(0);

    // Upgrade back to editor re-enables writes.
    rebound.callbacks.onPermissionChanged("editor");
    opened.store.getState().applyLocalUpdate(new Uint8Array([4, 5]));
    expect(rebound.applied.length).toBe(1);

    // Full revoke → accessLost flips true.
    rebound.callbacks.onPermissionChanged(null);
    const after = opened.store.getState();
    expect(after.accessLost).toBe(true);
    expect(after.permissionRole).toBe(null);
    expect(after.isDirty).toBe(false);

    opened.dispose();
  });

  it("keeps offline bytes in the queue diagnostically but reconciles them as a single update on snapshot", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-a",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });
    const hostDoc = new Y.Doc();
    handle().callbacks.onSnapshot(
      buildMeta("editor", hostDoc),
      emptySnapshot(),
    );
    // Immediately drop the connection.
    handle().callbacks.onConnectionStatus("reconnecting", null);

    opened.doc.getMap("epic").set("title", "Offline title");
    opened.doc.getMap("epic").set("body", "Offline body");
    expect(handle().applied.length).toBe(0);
    expect(opened.store.getState().unsyncedQueueSize).toBe(2);
    expect(opened.store.getState().isDirty).toBe(true);

    const expectedReconcile = Y.encodeStateAsUpdate(
      opened.doc,
      Y.encodeStateVector(hostDoc),
    );

    // Reconnect → fresh snapshot clears the queue and ships one reconcile update.
    handle().callbacks.onConnectionStatus("open", null);
    handle().callbacks.onSnapshot(
      buildMeta("editor", hostDoc),
      emptySnapshot(),
    );
    expect(handle().applied.length).toBe(1);
    expectBytesEqual(handle().applied[0], expectedReconcile);
    expect(opened.store.getState().unsyncedQueueSize).toBe(0);

    opened.dispose();
  });

  it("shows reconnecting on cloud sync loss but keeps streaming edits to the local host (durable offline persistence is host-owned)", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-a",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });
    const hostDoc = new Y.Doc();
    handle().callbacks.onConnectionStatus("open", null);
    // Establish a genuine first connect (transport open + cloud caught up) so
    // the later drop reads as a reconnect, not the bootstrap "connecting".
    handle().callbacks.onCloudSyncStatus("connected");
    handle().callbacks.onSnapshot(
      buildMeta("editor", hostDoc),
      emptySnapshot(),
    );
    handle().applied.length = 0;

    // Host reports its cloud link dropped. The renderer↔host transport is
    // still open, so the pill shows "reconnecting" ...
    handle().callbacks.onCloudSyncStatus("disconnected");
    expect(opened.store.getState().connectionStatus).toBe("reconnecting");

    // ... but a local edit MUST still stream to the (healthy) local host, not
    // sit in the renderer's in-memory queue. The host durably persists it
    // (SQLite pending-update store) while its cloud link is down and replays it
    // on restart; queuing it here would strand it in memory and lose it on
    // restart - the pending-update-replay regression this guards.
    opened.doc.getMap("epic").set("title", "Cloud offline title");
    expect(handle().applied.length).toBe(1);
    expect(opened.store.getState().unsyncedQueueSize).toBe(0);

    // Cloud reconnect returns the pill to open with nothing left to flush
    // (the edit already reached the host while the cloud was down).
    handle().callbacks.onCloudSyncStatus("connected");
    expect(opened.store.getState().connectionStatus).toBe("open");
    expect(opened.store.getState().unsyncedQueueSize).toBe(0);
    expect(handle().applied.length).toBe(1);

    opened.dispose();
  });

  it("clears isDirty when a snapshot's host state vector covers the dirty watermark", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-a",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });
    const initialHostDoc = new Y.Doc();
    handle().callbacks.onConnectionStatus("open", null);
    handle().callbacks.onSnapshot(
      buildMeta("editor", initialHostDoc),
      emptySnapshot(),
    );

    opened.doc.getMap("epic").set("title", "Locally edited");

    const hostDoc = new Y.Doc();
    Y.applyUpdate(hostDoc, handle().applied[0]);
    handle().applied.length = 0;
    handle().callbacks.onSnapshot(
      buildMeta("editor", hostDoc),
      Y.encodeStateAsUpdate(hostDoc),
    );

    const state = opened.store.getState();
    expect(state.isDirty).toBe(false);
    expect(state.dirtyWatermarkStateVectorBase64).toBeNull();
    expect(state.latestHostStateVectorBase64).toBe(stateVectorBase64(hostDoc));
    expect(handle().applied.length).toBe(0);

    opened.dispose();
  });

  it("keeps isDirty true and emits a reconcile update when a snapshot does not cover the dirty watermark", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-a",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });
    const hostDoc = new Y.Doc();
    handle().callbacks.onConnectionStatus("open", null);
    handle().callbacks.onSnapshot(
      buildMeta("editor", hostDoc),
      emptySnapshot(),
    );

    opened.doc.getMap("epic").set("title", "Locally edited");
    const expectedReconcile = Y.encodeStateAsUpdate(
      opened.doc,
      Y.encodeStateVector(hostDoc),
    );

    handle().applied.length = 0;
    handle().callbacks.onSnapshot(
      buildMeta("editor", hostDoc),
      emptySnapshot(),
    );

    const state = opened.store.getState();
    expect(state.isDirty).toBe(true);
    expect(state.latestHostStateVectorBase64).toBe(stateVectorBase64(hostDoc));
    expect(handle().applied.length).toBe(1);
    expect(handle().applied[0].length).toBeGreaterThan(2);
    expectBytesEqual(handle().applied[0], expectedReconcile);

    opened.dispose();
  });

  it("treats snapshot reconcile as a no-op when local state is already a subset of the host state vector", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-a",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });
    const hostDoc = new Y.Doc();
    hostDoc.getMap("epic").set("title", "Server truth");
    const snapshotBytes = Y.encodeStateAsUpdate(hostDoc);

    handle().callbacks.onConnectionStatus("open", null);
    handle().callbacks.onSnapshot(buildMeta("editor", hostDoc), snapshotBytes);
    handle().applied.length = 0;

    handle().callbacks.onSnapshot(buildMeta("editor", hostDoc), snapshotBytes);

    expect(opened.store.getState().isDirty).toBe(false);
    expect(handle().applied.length).toBe(0);

    opened.dispose();
  });

  it("does not clear isDirty on host-origin updates without convergence proof", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-a",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });
    handle().callbacks.onConnectionStatus("open", null);
    handle().callbacks.onSnapshot(buildMeta("editor", null), emptySnapshot());

    opened.doc.getMap("epic").set("title", "Locally edited");

    const remoteHostDoc = new Y.Doc();
    remoteHostDoc.getMap("epic").set("server", "remote-only");
    const remoteUpdate = Y.encodeStateAsUpdate(remoteHostDoc);
    handle().callbacks.onUpdate(remoteUpdate);

    const state = opened.store.getState();
    expect(state.isDirty).toBe(true);
    expect(state.latestHostStateVectorBase64).toBe(
      stateVectorBase64(remoteHostDoc),
    );

    opened.dispose();
  });

  it("clears isDirty when a host-origin update establishes convergence", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-a",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });
    handle().callbacks.onConnectionStatus("open", null);
    handle().callbacks.onSnapshot(buildMeta("editor", null), emptySnapshot());

    opened.doc.getMap("epic").set("title", "Locally edited");
    const localUpdate = handle().applied[0];
    handle().callbacks.onUpdate(localUpdate);

    const hostDoc = new Y.Doc();
    Y.applyUpdate(hostDoc, localUpdate);
    const state = opened.store.getState();
    expect(state.isDirty).toBe(false);
    expect(state.dirtyWatermarkStateVectorBase64).toBeNull();
    expect(state.latestHostStateVectorBase64).toBe(stateVectorBase64(hostDoc));

    opened.dispose();
  });

  it("persists lastFocusedArtifactId to localStorage and restores it on remount", () => {
    const { factory } = fakeFactory();
    const first = createOpenEpicStore({
      epicId: "epic-a",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });
    first.store.getState().setLastFocusedArtifactId("art-42");
    first.dispose();

    const { factory: factory2 } = fakeFactory();
    const second = createOpenEpicStore({
      epicId: "epic-a",
      streamClientFactory: factory2,
      userId: null,
      onAuthError: null,
    });
    expect(second.store.getState().lastFocusedArtifactId).toBe("art-42");
    second.dispose();
  });

  it("scopes lastFocusedArtifactId persistence per userId", () => {
    const { factory: factoryA } = fakeFactory();
    const userA = createOpenEpicStore({
      epicId: "epic-shared",
      streamClientFactory: factoryA,
      userId: "alice@example.com",
      onAuthError: null,
    });
    userA.store.getState().setLastFocusedArtifactId("art-alice");
    userA.dispose();

    const { factory: factoryB } = fakeFactory();
    const userB = createOpenEpicStore({
      epicId: "epic-shared",
      streamClientFactory: factoryB,
      userId: "bob@example.com",
      onAuthError: null,
    });
    // Bob has never focused anything - he must NOT see Alice's focus state.
    expect(userB.store.getState().lastFocusedArtifactId).toBeNull();
    userB.store.getState().setLastFocusedArtifactId("art-bob");
    userB.dispose();

    // Round-trip: Alice still sees her own focus value, Bob still sees his.
    const { factory: factoryA2 } = fakeFactory();
    const userAAgain = createOpenEpicStore({
      epicId: "epic-shared",
      streamClientFactory: factoryA2,
      userId: "alice@example.com",
      onAuthError: null,
    });
    expect(userAAgain.store.getState().lastFocusedArtifactId).toBe("art-alice");
    userAAgain.dispose();

    const { factory: factoryB2 } = fakeFactory();
    const userBAgain = createOpenEpicStore({
      epicId: "epic-shared",
      streamClientFactory: factoryB2,
      userId: "bob@example.com",
      onAuthError: null,
    });
    expect(userBAgain.store.getState().lastFocusedArtifactId).toBe("art-bob");
    userBAgain.dispose();
  });

  it("applies inbound awareness updates to the local Awareness", async () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-aware",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });
    handle().callbacks.onConnectionStatus("open", null);
    handle().callbacks.onSnapshot(buildMeta("editor", null), emptySnapshot());

    // Build a peer Awareness and encode its update for this doc.
    const { Awareness, encodeAwarenessUpdate } =
      await import("y-protocols/awareness");
    const peerDoc = new Y.Doc();
    const peer = new Awareness(peerDoc);
    peer.setLocalState({ userName: "Peer" });
    const peerUpdate = encodeAwarenessUpdate(peer, [peer.clientID]);

    handle().callbacks.onAwareness(peerUpdate);
    const states = opened.awareness.getStates();
    let saw = false;
    states.forEach((value: unknown) => {
      if (
        typeof value === "object" &&
        value !== null &&
        (value as { userName?: string }).userName === "Peer"
      ) {
        saw = true;
      }
    });
    expect(saw).toBe(true);

    opened.dispose();
  });

  it("emits outbound awareness on local Awareness state change", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-out",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });
    handle().callbacks.onConnectionStatus("open", null);
    handle().callbacks.onSnapshot(buildMeta("editor", null), emptySnapshot());

    opened.awareness.setLocalState({ cursor: 7 });
    expect(handle().awarenessSent.length).toBeGreaterThan(0);

    opened.dispose();
  });

  it("does not re-emit inbound awareness back out through the stream (no-loop)", async () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-loop",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });
    handle().callbacks.onConnectionStatus("open", null);
    handle().callbacks.onSnapshot(buildMeta("editor", null), emptySnapshot());

    const { Awareness, encodeAwarenessUpdate } =
      await import("y-protocols/awareness");
    const peerDoc = new Y.Doc();
    const peer = new Awareness(peerDoc);
    peer.setLocalState({ userName: "Remote" });
    const peerUpdate = encodeAwarenessUpdate(peer, [peer.clientID]);

    const before = handle().awarenessSent.length;
    handle().callbacks.onAwareness(peerUpdate);
    const after = handle().awarenessSent.length;
    expect(after).toBe(before);

    opened.dispose();
  });

  it("dispose closes the underlying stream client exactly once", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-dispose",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });
    expect(handle().closeCount).toBe(0);
    opened.dispose();
    expect(handle().closeCount).toBe(1);
    // Idempotent.
    opened.dispose();
    expect(handle().closeCount).toBe(1);
  });

  it("requestFreshSnapshot rebinds the stream and clears unsynced local replica state", () => {
    const { factory, handles } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-refresh",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });

    handles()[0].callbacks.onConnectionStatus("open", null);
    handles()[0].callbacks.onSnapshot(
      buildMeta("editor", null),
      emptySnapshot(),
    );
    opened.doc.getMap("epic").set("title", "Local only");

    opened.requestFreshSnapshot();

    expect(handles()[0].closeCount).toBe(1);
    expect(handles().length).toBe(2);
    expect(opened.store.getState().snapshotLoaded).toBe(false);
    expect(opened.store.getState().connectionStatus).toBe("connecting");
    expect(opened.store.getState().isDirty).toBe(false);
    expect(opened.store.getState().dirtyWatermarkStateVectorBase64).toBeNull();
    expect(opened.store.getState().latestHostStateVectorBase64).toBeNull();
    expect(opened.doc.getMap("epic").get("title")).toBeUndefined();

    const donor = new Y.Doc();
    donor.getMap("epic").set("title", "Server truth");
    const snapshot = Y.encodeStateAsUpdate(donor);
    handles()[1].callbacks.onConnectionStatus("open", null);
    handles()[1].callbacks.onSnapshot(buildMeta("editor", null), snapshot);

    expect(opened.doc.getMap("epic").get("title")).toBe("Server truth");

    opened.dispose();
  });

  it("stops forwarding awareness updates after dispose", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-awareness-dispose",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });
    handle().callbacks.onConnectionStatus("open", null);
    handle().callbacks.onSnapshot(buildMeta("editor", null), emptySnapshot());

    opened.awareness.setLocalState({ cursor: 1 });
    const beforeDispose = handle().awarenessSent.length;
    opened.dispose();
    opened.awareness.setLocalState({ cursor: 2 });

    expect(handle().awarenessSent.length).toBe(beforeDispose);
  });

  it("invokes onAuthError and surfaces the error when the host closes the stream with UNAUTHORIZED", () => {
    const { factory, handle } = fakeFactory();
    let authErrorCount = 0;
    const opened = createOpenEpicStore({
      epicId: "epic-unauth",
      streamClientFactory: factory,
      userId: null,
      onAuthError: () => {
        authErrorCount += 1;
      },
    });

    handle().callbacks.onConnectionStatus("closed", {
      kind: "fatalError",
      details: {
        code: "UNAUTHORIZED",
        reason: "no token cached for user",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });

    expect(authErrorCount).toBe(1);
    // A terminal closed/UNAUTHORIZED (the stream gave up after its own
    // revalidation) surfaces an error rather than leaving a silent "closed".
    expect(opened.store.getState().snapshotFetchError).toEqual({
      code: "UNAUTHORIZED",
      message: "no token cached for user",
    });
    opened.dispose();
  });

  it("does not invoke onAuthError on caller-initiated close or non-UNAUTHORIZED fatal errors", () => {
    const { factory, handle } = fakeFactory();
    let authErrorCount = 0;
    const opened = createOpenEpicStore({
      epicId: "epic-unauth-negative",
      streamClientFactory: factory,
      userId: null,
      onAuthError: () => {
        authErrorCount += 1;
      },
    });

    handle().callbacks.onConnectionStatus("closed", { kind: "caller" });
    handle().callbacks.onConnectionStatus("closed", {
      kind: "fatalError",
      details: {
        code: "INCOMPATIBLE",
        reason: "schema mismatch",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });

    expect(authErrorCount).toBe(0);
    opened.dispose();
  });

  // ── B6: artifact-room-scoped frame handling ──────────────────────────────────────

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

  it("resolves an artifact body fragment from the artifact-room doc seeded by onArtifactRoomSnapshot", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-artifact-rooms",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });

    // Build a donor with one artifact pointing at artifact-room-0.
    const donor = new Y.Doc();
    seedRootArtifactWithArtifactRoom(donor, "art-1", "artifact-room-0");
    handle().callbacks.onConnectionStatus("open", null);
    handle().callbacks.onSnapshot(
      buildMeta("editor", null),
      Y.encodeStateAsUpdate(donor),
    );

    // Fragment is unavailable until artifactRoomSnapshot lands.
    expect(opened.store.getState().artifacts.byId["art-1"].artifactRoomId).toBe(
      "artifact-room-0",
    );
    expect(opened.store.getState().getArtifactFragment("art-1")).toBeNull();
    expect(opened.store.getState().getArtifactBodyAvailability("art-1")).toBe(
      "unavailable",
    );

    // Host ships an empty artifact-room doc snapshot for artifact-room-0.
    const artifactRoomDoc = new Y.Doc();
    artifactRoomDoc.getXmlFragment("artifact-body:art-1").insert(0, []);
    handle().callbacks.onArtifactRoomSnapshot(
      "artifact-room-0",
      Y.encodeStateAsUpdate(artifactRoomDoc),
      stateVectorBase64(artifactRoomDoc),
    );

    const state = opened.store.getState();
    expect(state.artifactRooms.stateByArtifactRoomId["artifact-room-0"]).toBe(
      "ready",
    );
    expect(state.getArtifactBodyAvailability("art-1")).toBe("ready");
    const fragment = state.getArtifactFragment("art-1");
    expect(fragment).not.toBeNull();
    // The fragment must live in the artifact-room doc, not in the root Epic doc, so
    // editor binding does not accidentally mutate root metadata.
    expect(fragment?.doc).not.toBe(opened.doc);

    opened.dispose();
  });

  it("surfaces unavailable / retrying artifactRoom states via onArtifactRoomState without losing root metadata", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-artifact-rooms",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });

    const donor = new Y.Doc();
    donor.getMap("epic").set("title", "Stays");
    seedRootArtifactWithArtifactRoom(donor, "art-1", "artifact-room-0");
    handle().callbacks.onConnectionStatus("open", null);
    handle().callbacks.onSnapshot(
      buildMeta("editor", null),
      Y.encodeStateAsUpdate(donor),
    );

    handle().callbacks.onArtifactRoomState("artifact-room-0", "unavailable");
    expect(opened.store.getState().getArtifactBodyAvailability("art-1")).toBe(
      "unavailable",
    );
    // Root metadata must remain stable even when the artifactRoom is unavailable.
    expect(opened.doc.getMap("epic").get("title")).toBe("Stays");

    handle().callbacks.onArtifactRoomState("artifact-room-0", "retrying");
    expect(opened.store.getState().getArtifactBodyAvailability("art-1")).toBe(
      "retrying",
    );
    expect(opened.store.getState().getArtifactFragment("art-1")).toBeNull();

    opened.dispose();
  });

  it("forwards artifact-room doc edits as outbound artifactRoomApplyUpdate frames keyed by artifactRoomId", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-artifact-rooms",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });

    const donor = new Y.Doc();
    seedRootArtifactWithArtifactRoom(donor, "art-1", "artifact-room-0");
    handle().callbacks.onConnectionStatus("open", null);
    handle().callbacks.onSnapshot(
      buildMeta("editor", null),
      Y.encodeStateAsUpdate(donor),
    );
    const artifactRoomDoc = new Y.Doc();
    artifactRoomDoc.getXmlFragment("artifact-body:art-1").insert(0, []);
    handle().callbacks.onArtifactRoomSnapshot(
      "artifact-room-0",
      Y.encodeStateAsUpdate(artifactRoomDoc),
      stateVectorBase64(artifactRoomDoc),
    );

    const fragment = opened.store.getState().getArtifactFragment("art-1");
    expect(fragment).not.toBeNull();
    if (fragment === null) throw new Error("missing fragment");
    const fragmentDoc = fragment.doc;
    if (fragmentDoc === null) throw new Error("missing fragment doc");

    // Mutate the artifactRoom's own doc so the store's update listener fires the
    // outbound `artifactRoomApplyUpdate` route.
    fragmentDoc.transact(() => {
      fragmentDoc.getMap("touch").set("k", "v");
    });

    expect(handle().artifactRoomApplied.length).toBeGreaterThan(0);
    expect(handle().artifactRoomApplied[0].artifactRoomId).toBe(
      "artifact-room-0",
    );
    // Host-origin artifactRoom updates from `onArtifactRoomUpdate` MUST NOT be echoed back.
    handle().artifactRoomApplied.length = 0;
    handle().callbacks.onArtifactRoomUpdate(
      "artifact-room-0",
      new Uint8Array([0, 0]),
      stateVectorBase64(artifactRoomDoc),
    );
    expect(handle().artifactRoomApplied.length).toBe(0);

    opened.dispose();
  });

  it("applies inbound artifactRoomAwareness to a artifact-room-scoped Awareness instance, not the root awareness", async () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-artifact-rooms",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });

    const donor = new Y.Doc();
    seedRootArtifactWithArtifactRoom(donor, "art-1", "artifact-room-0");
    handle().callbacks.onConnectionStatus("open", null);
    handle().callbacks.onSnapshot(
      buildMeta("editor", null),
      Y.encodeStateAsUpdate(donor),
    );
    const artifactRoomDoc = new Y.Doc();
    artifactRoomDoc.getXmlFragment("artifact-body:art-1").insert(0, []);
    handle().callbacks.onArtifactRoomSnapshot(
      "artifact-room-0",
      Y.encodeStateAsUpdate(artifactRoomDoc),
      stateVectorBase64(artifactRoomDoc),
    );

    const artifactRoomAwareness = opened.store
      .getState()
      .getArtifactBodyAwareness("art-1");
    expect(artifactRoomAwareness).not.toBeNull();
    if (artifactRoomAwareness === null)
      throw new Error("missing artifactRoom awareness");

    // Build a synthetic awareness frame from a separate Awareness producer
    // so we can assert it lands on the artifactRoom instance and not the root.
    const { Awareness, encodeAwarenessUpdate } =
      await import("y-protocols/awareness");
    const producer = new Awareness(new Y.Doc());
    producer.setLocalState({ user: { name: "remote-on-artifact-room" } });
    const frame = encodeAwarenessUpdate(producer, [producer.clientID]);

    handle().callbacks.onArtifactRoomAwareness("artifact-room-0", frame);

    // ArtifactRoom awareness has the remote state.
    const artifactRoomStates = Array.from(
      artifactRoomAwareness.getStates().entries(),
    );
    expect(
      artifactRoomStates.some(
        ([, value]) =>
          (value as { user?: { name?: string } }).user?.name ===
          "remote-on-artifact-room",
      ),
    ).toBe(true);
    // Root awareness was NOT touched by the artifactRoom frame.
    const rootStates = Array.from(opened.awareness.getStates().entries());
    expect(
      rootStates.some(
        ([, value]) =>
          (value as { user?: { name?: string } }).user?.name ===
          "remote-on-artifact-room",
      ),
    ).toBe(false);

    opened.dispose();
  });

  it("emits outbound artifactRoom awareness keyed by artifactRoomId when the artifactRoom awareness changes locally", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-artifact-rooms",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });

    const donor = new Y.Doc();
    seedRootArtifactWithArtifactRoom(donor, "art-1", "artifact-room-0");
    handle().callbacks.onConnectionStatus("open", null);
    handle().callbacks.onSnapshot(
      buildMeta("editor", null),
      Y.encodeStateAsUpdate(donor),
    );
    handle().callbacks.onArtifactRoomSnapshot(
      "artifact-room-0",
      emptySnapshot(),
      stateVectorBase64(new Y.Doc()),
    );

    const artifactRoomAwareness = opened.store
      .getState()
      .getArtifactBodyAwareness("art-1");
    expect(artifactRoomAwareness).not.toBeNull();
    if (artifactRoomAwareness === null)
      throw new Error("missing artifactRoom awareness");

    // Reset the root awareness send buffer so the open-status emit on
    // initial connection does not pollute the assertion: we want to know
    // that the artifact-room-awareness setLocalState below routes ONLY through the
    // artifactRoom channel, not the root.
    handle().awarenessSent.length = 0;
    handle().artifactRoomAwarenessSent.length = 0;

    artifactRoomAwareness.setLocalState({ user: { name: "local-cursor" } });

    expect(handle().artifactRoomAwarenessSent.length).toBeGreaterThan(0);
    expect(handle().artifactRoomAwarenessSent[0].artifactRoomId).toBe(
      "artifact-room-0",
    );
    // Same local change must NOT be sent on the root awareness channel.
    expect(handle().awarenessSent.length).toBe(0);

    opened.dispose();
  });

  it("queues artifact-room-body local edits during reconnect and replays them after the fresh root snapshot", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-artifact-rooms",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });

    const donor = new Y.Doc();
    seedRootArtifactWithArtifactRoom(donor, "art-1", "artifact-room-0");
    handle().callbacks.onConnectionStatus("open", null);
    handle().callbacks.onSnapshot(
      buildMeta("editor", null),
      Y.encodeStateAsUpdate(donor),
    );
    handle().callbacks.onArtifactRoomSnapshot(
      "artifact-room-0",
      emptySnapshot(),
      stateVectorBase64(new Y.Doc()),
    );

    const fragment = opened.store.getState().getArtifactFragment("art-1");
    if (fragment === null) throw new Error("missing fragment");
    const fragmentDoc = fragment.doc;
    if (fragmentDoc === null) throw new Error("missing fragment doc");

    // Drop into a non-open state and edit locally - the update must be
    // queued, not silently lost.
    handle().callbacks.onConnectionStatus("connecting", null);
    handle().artifactRoomApplied.length = 0;
    fragmentDoc.transact(() => {
      fragmentDoc.getMap("offline").set("k", "v");
    });
    expect(handle().artifactRoomApplied.length).toBe(0);

    // Raw reconnect open is only transport readiness; it must not replay
    // artifactRoom writes until the fresh root snapshot confirms write permission.
    handle().callbacks.onConnectionStatus("open", null);
    expect(handle().artifactRoomApplied.length).toBe(0);

    handle().callbacks.onSnapshot(
      buildMeta("editor", donor),
      Y.encodeStateAsUpdate(donor),
    );
    expect(handle().artifactRoomApplied.length).toBeGreaterThan(0);
    expect(handle().artifactRoomApplied[0].artifactRoomId).toBe(
      "artifact-room-0",
    );

    opened.dispose();
  });

  it("does not flush queued artifact-room-body edits with a stale editor role when the reconnect snapshot downgrades to viewer", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-artifact-rooms",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });

    const donor = new Y.Doc();
    seedRootArtifactWithArtifactRoom(donor, "art-1", "artifact-room-0");
    handle().callbacks.onConnectionStatus("open", null);
    handle().callbacks.onSnapshot(
      buildMeta("editor", null),
      Y.encodeStateAsUpdate(donor),
    );
    handle().callbacks.onArtifactRoomSnapshot(
      "artifact-room-0",
      emptySnapshot(),
      stateVectorBase64(new Y.Doc()),
    );

    const fragment = opened.store.getState().getArtifactFragment("art-1");
    if (fragment === null) throw new Error("missing fragment");
    const fragmentDoc = fragment.doc;
    if (fragmentDoc === null) throw new Error("missing fragment doc");

    handle().callbacks.onConnectionStatus("reconnecting", null);
    fragmentDoc.transact(() => {
      fragmentDoc.getMap("offline").set("k", "v");
    });

    handle().artifactRoomApplied.length = 0;
    handle().callbacks.onConnectionStatus("open", null);
    expect(handle().artifactRoomApplied.length).toBe(0);

    handle().callbacks.onSnapshot(
      buildMeta("viewer", donor),
      Y.encodeStateAsUpdate(donor),
    );
    expect(opened.store.getState().permissionRole).toBe("viewer");
    expect(handle().artifactRoomApplied.length).toBe(0);

    handle().callbacks.onSnapshot(
      buildMeta("editor", donor),
      Y.encodeStateAsUpdate(donor),
    );
    handle().callbacks.onArtifactRoomSnapshot(
      "artifact-room-0",
      emptySnapshot(),
      stateVectorBase64(new Y.Doc()),
    );
    expect(handle().artifactRoomApplied.length).toBe(0);
    const refreshedFragment = opened.store
      .getState()
      .getArtifactFragment("art-1");
    expect(refreshedFragment).not.toBeNull();
    if (refreshedFragment === null)
      throw new Error("missing refreshed fragment");
    const refreshedFragmentDoc = refreshedFragment.doc;
    if (refreshedFragmentDoc === null)
      throw new Error("missing refreshed fragment doc");
    expect(refreshedFragmentDoc.getMap("offline").get("k")).toBeUndefined();

    opened.dispose();
  });

  it("clears queued artifact-room-body edits on viewer downgrade (fail-closed)", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-artifact-rooms",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });

    const donor = new Y.Doc();
    seedRootArtifactWithArtifactRoom(donor, "art-1", "artifact-room-0");
    handle().callbacks.onConnectionStatus("open", null);
    handle().callbacks.onSnapshot(
      buildMeta("editor", null),
      Y.encodeStateAsUpdate(donor),
    );
    handle().callbacks.onArtifactRoomSnapshot(
      "artifact-room-0",
      emptySnapshot(),
      stateVectorBase64(new Y.Doc()),
    );

    const fragment = opened.store.getState().getArtifactFragment("art-1");
    if (fragment === null) throw new Error("missing fragment");
    const fragmentDoc = fragment.doc;
    if (fragmentDoc === null) throw new Error("missing fragment doc");

    handle().callbacks.onConnectionStatus("connecting", null);
    fragmentDoc.transact(() => {
      fragmentDoc.getMap("offline").set("k", "v");
    });

    // Downgrade to viewer - any queued local artifactRoom edits must be dropped.
    handle().callbacks.onPermissionChanged("viewer");

    // Even after reopen no queued edit should be sent (the viewer
    // downgrade also triggers a fresh-snapshot path; what matters is
    // that no stale artifactRoomApplyUpdate is emitted for the queued edit).
    handle().artifactRoomApplied.length = 0;

    opened.dispose();
  });

  it("merges incoming artifactRoomSnapshot into the existing local artifactRoom replica without destroying offline edits", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-artifact-rooms",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });

    const donor = new Y.Doc();
    seedRootArtifactWithArtifactRoom(donor, "art-1", "artifact-room-0");
    handle().callbacks.onConnectionStatus("open", null);
    handle().callbacks.onSnapshot(
      buildMeta("editor", null),
      Y.encodeStateAsUpdate(donor),
    );
    const seedArtifactRoomDoc = new Y.Doc();
    seedArtifactRoomDoc.getXmlFragment("artifact-body:art-1").insert(0, []);
    handle().callbacks.onArtifactRoomSnapshot(
      "artifact-room-0",
      Y.encodeStateAsUpdate(seedArtifactRoomDoc),
      stateVectorBase64(seedArtifactRoomDoc),
    );

    const fragment = opened.store.getState().getArtifactFragment("art-1");
    if (fragment === null) throw new Error("missing fragment");
    // Snapshot the artifact-room doc identity before the second snapshot so we can
    // assert the editor's bound fragment was preserved (no remount).
    const docBefore = fragment.doc;
    expect(docBefore).not.toBeNull();

    // Drop into reconnecting and apply a local body edit - this becomes
    // the dirty divergence the merge path must preserve.
    handle().callbacks.onConnectionStatus("reconnecting", null);
    const fragmentDoc = fragment.doc;
    if (fragmentDoc === null) throw new Error("missing fragment doc");
    fragmentDoc.transact(() => {
      fragmentDoc.getMap("offline").set("k", "v");
    });

    // Host now ships a fresh `artifactRoomSnapshot` for the SAME artifactRoom.
    handle().artifactRoomApplied.length = 0;
    handle().callbacks.onConnectionStatus("open", null);
    handle().callbacks.onSnapshot(
      buildMeta("editor", donor),
      Y.encodeStateAsUpdate(donor),
    );
    const refreshedArtifactRoomDoc = new Y.Doc();
    refreshedArtifactRoomDoc
      .getXmlFragment("artifact-body:art-1")
      .insert(0, []);
    refreshedArtifactRoomDoc.getMap("server").set("flag", true);
    handle().callbacks.onArtifactRoomSnapshot(
      "artifact-room-0",
      Y.encodeStateAsUpdate(refreshedArtifactRoomDoc),
      stateVectorBase64(refreshedArtifactRoomDoc),
    );

    // Local replica must still hold the offline edit AND the new server
    // map - the snapshot was merged, not replaced.
    const fragmentAfter = opened.store.getState().getArtifactFragment("art-1");
    expect(fragmentAfter).not.toBeNull();
    if (fragmentAfter === null) throw new Error("missing fragment after");
    expect(fragmentAfter.doc).toBe(docBefore);
    const fragmentAfterDoc = fragmentAfter.doc;
    if (fragmentAfterDoc === null)
      throw new Error("missing fragment-after doc");
    expect(fragmentAfterDoc.getMap("offline").get("k")).toBe("v");
    expect(fragmentAfterDoc.getMap("server").get("flag")).toBe(true);

    // The store must have shipped a reconcile update so the host
    // catches up to the offline edit; the offline-buffer queue is also
    // drained because the reconcile subsumes its bytes.
    expect(handle().artifactRoomApplied.length).toBeGreaterThan(0);
    expect(handle().artifactRoomApplied[0].artifactRoomId).toBe(
      "artifact-room-0",
    );

    opened.dispose();
  });

  it("keeps streaming artifact-room body edits to the host during a cloud-sync drop", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-artifact-rooms",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });

    const donor = new Y.Doc();
    seedRootArtifactWithArtifactRoom(donor, "art-1", "artifact-room-0");
    handle().callbacks.onConnectionStatus("open", null);
    // Cloud catch-up completes the first connect (connectionStatus → "open") so
    // the drop below reads as a reconnect, not the bootstrap "connecting".
    handle().callbacks.onCloudSyncStatus("connected");
    handle().callbacks.onSnapshot(
      buildMeta("editor", null),
      Y.encodeStateAsUpdate(donor),
    );
    const seedArtifactRoomDoc = new Y.Doc();
    seedArtifactRoomDoc.getXmlFragment("artifact-body:art-1").insert(0, []);
    handle().callbacks.onArtifactRoomSnapshot(
      "artifact-room-0",
      Y.encodeStateAsUpdate(seedArtifactRoomDoc),
      stateVectorBase64(seedArtifactRoomDoc),
    );

    const fragment = opened.store.getState().getArtifactFragment("art-1");
    if (fragment === null) throw new Error("missing fragment");
    const fragmentDoc = fragment.doc;
    if (fragmentDoc === null) throw new Error("missing fragment doc");

    // Host's cloud link drops; the renderer↔host transport stays open, so
    // the pill shows reconnecting...
    handle().callbacks.onCloudSyncStatus("disconnected");
    expect(opened.store.getState().connectionStatus).toBe("reconnecting");

    // ...but a body edit must stream straight to the local host (which
    // durably persists + later syncs it), NOT sit in the artifact-room pending
    // queue where a restart would discard it.
    handle().artifactRoomApplied.length = 0;
    fragmentDoc.transact(() => {
      fragmentDoc.getMap("offline").set("k", "v");
    });
    expect(handle().artifactRoomApplied.length).toBeGreaterThan(0);
    expect(handle().artifactRoomApplied[0].artifactRoomId).toBe(
      "artifact-room-0",
    );

    opened.dispose();
  });

  it("defers the snapshot reconcile until a fresh editor root snapshot after reopen", () => {
    // Reproduces the reconnect ordering gap that ticket
    // 4a598302-ac79-47a5-a686-cc9e35bde18b fixes: a fresh `artifactRoomSnapshot`
    // can land while `connectionStatus` is still `connecting` /
    // `reconnecting` (after the host transitions before the
    // status frame is observed). The merge must preserve every local
    // artifact-room-body edit produced during the reconnect window AND must
    // retain an outbound propagation path so the fresh root snapshot after
    // reopen ships a reconcile carrying those edits to the host.
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-artifact-rooms",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });

    const donor = new Y.Doc();
    seedRootArtifactWithArtifactRoom(donor, "art-1", "artifact-room-0");
    handle().callbacks.onConnectionStatus("open", null);
    handle().callbacks.onSnapshot(
      buildMeta("editor", null),
      Y.encodeStateAsUpdate(donor),
    );
    const seedArtifactRoomDoc = new Y.Doc();
    seedArtifactRoomDoc.getXmlFragment("artifact-body:art-1").insert(0, []);
    handle().callbacks.onArtifactRoomSnapshot(
      "artifact-room-0",
      Y.encodeStateAsUpdate(seedArtifactRoomDoc),
      stateVectorBase64(seedArtifactRoomDoc),
    );

    const fragment = opened.store.getState().getArtifactFragment("art-1");
    if (fragment === null) throw new Error("missing fragment");
    const docBefore = fragment.doc;
    expect(docBefore).not.toBeNull();

    // ── 1. Stream transitions away from `open` and a local edit lands.
    handle().callbacks.onConnectionStatus("reconnecting", null);
    handle().artifactRoomApplied.length = 0;
    const fragmentDoc = fragment.doc;
    if (fragmentDoc === null) throw new Error("missing fragment doc");
    fragmentDoc.transact(() => {
      fragmentDoc.getMap("offline").set("k", "v");
    });
    // Edit is queued, not sent.
    expect(handle().artifactRoomApplied.length).toBe(0);

    // ── 2. A fresh `artifactRoomSnapshot` arrives BEFORE the status frame.
    const refreshedArtifactRoomDoc = new Y.Doc();
    refreshedArtifactRoomDoc
      .getXmlFragment("artifact-body:art-1")
      .insert(0, []);
    refreshedArtifactRoomDoc.getMap("server").set("flag", true);
    handle().callbacks.onArtifactRoomSnapshot(
      "artifact-room-0",
      Y.encodeStateAsUpdate(refreshedArtifactRoomDoc),
      stateVectorBase64(refreshedArtifactRoomDoc),
    );
    // Snapshot must NOT ship a reconcile while the stream is not open
    // - that would race the transport's open transition.
    expect(handle().artifactRoomApplied.length).toBe(0);
    // …and must NOT remount the artifact-room doc while the local replica still
    // holds dirty offline edits.
    const fragmentAfterSnapshot = opened.store
      .getState()
      .getArtifactFragment("art-1");
    expect(fragmentAfterSnapshot).not.toBeNull();
    if (fragmentAfterSnapshot === null)
      throw new Error("missing fragment after snapshot");
    expect(fragmentAfterSnapshot.doc).toBe(docBefore);
    const fragmentAfterSnapshotDoc = fragmentAfterSnapshot.doc;
    if (fragmentAfterSnapshotDoc === null)
      throw new Error("missing fragment-after-snapshot doc");
    // Local body content survives the merge alongside the new server map.
    expect(fragmentAfterSnapshotDoc.getMap("offline").get("k")).toBe("v");
    expect(fragmentAfterSnapshotDoc.getMap("server").get("flag")).toBe(true);

    // ── 3. Stream reopens - raw open alone must not flush.
    //
    // Acceptance for ticket 4a598302-ad33-…: the outbound surface after
    // the fresh editor root snapshot carries EXACTLY one `artifactRoomApplyUpdate`
    // for the correct `artifactRoomId`. That single frame is the snapshot-derived
    // reconcile; it must subsume any locally-buffered edits captured during
    // the reconnect window so the queue is not double-shipped alongside the
    // reconcile.
    handle().callbacks.onConnectionStatus("open", null);
    expect(handle().artifactRoomApplied).toHaveLength(0);

    handle().callbacks.onSnapshot(
      buildMeta("editor", donor),
      Y.encodeStateAsUpdate(donor),
    );
    expect(handle().artifactRoomApplied).toHaveLength(1);
    expect(handle().artifactRoomApplied[0].artifactRoomId).toBe(
      "artifact-room-0",
    );
    // The reconcile carries the offline edit the host has not yet
    // observed. Apply it to a fresh copy of the host's snapshot view
    // and assert the offline map round-trips. This proves the single
    // outbound frame is sufficient - no retained `pendingUpdates`
    // queue is required after the snapshot merge.
    const hostReplay = new Y.Doc();
    Y.applyUpdate(hostReplay, Y.encodeStateAsUpdate(refreshedArtifactRoomDoc));
    Y.applyUpdate(hostReplay, handle().artifactRoomApplied[0].bytes);
    expect(hostReplay.getMap("offline").get("k")).toBe("v");

    opened.dispose();
  });

  it("does not send a stale reconcile after viewer downgrade between snapshot-while-not-open and reopen", () => {
    // Fail-closed contract: if a `artifactRoomSnapshot` arrives while the
    // stream is not open and the role then drops to viewer before
    // the stream reopens, the deferred reconcile MUST be discarded.
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-artifact-rooms",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });

    const donor = new Y.Doc();
    seedRootArtifactWithArtifactRoom(donor, "art-1", "artifact-room-0");
    handle().callbacks.onConnectionStatus("open", null);
    handle().callbacks.onSnapshot(
      buildMeta("editor", null),
      Y.encodeStateAsUpdate(donor),
    );
    const seedArtifactRoomDoc = new Y.Doc();
    seedArtifactRoomDoc.getXmlFragment("artifact-body:art-1").insert(0, []);
    handle().callbacks.onArtifactRoomSnapshot(
      "artifact-room-0",
      Y.encodeStateAsUpdate(seedArtifactRoomDoc),
      stateVectorBase64(seedArtifactRoomDoc),
    );

    const fragment = opened.store.getState().getArtifactFragment("art-1");
    if (fragment === null) throw new Error("missing fragment");
    const fragmentDoc = fragment.doc;
    if (fragmentDoc === null) throw new Error("missing fragment doc");

    // Reconnecting → local edit → snapshot-while-not-open stashes a
    // deferred reconcile.
    handle().callbacks.onConnectionStatus("reconnecting", null);
    fragmentDoc.transact(() => {
      fragmentDoc.getMap("offline").set("k", "v");
    });
    handle().artifactRoomApplied.length = 0;
    const refreshedArtifactRoomDoc = new Y.Doc();
    refreshedArtifactRoomDoc
      .getXmlFragment("artifact-body:art-1")
      .insert(0, []);
    handle().callbacks.onArtifactRoomSnapshot(
      "artifact-room-0",
      Y.encodeStateAsUpdate(refreshedArtifactRoomDoc),
      stateVectorBase64(refreshedArtifactRoomDoc),
    );
    expect(handle().artifactRoomApplied.length).toBe(0);

    // Downgrade to viewer mid-reconnect. The viewer-downgrade path
    // also rebinds the stream via `requestFreshSnapshot`, so the
    // reopen we observe below is on the rebound handle. The original
    // handle's pending reconcile must NOT be sent on reopen of any
    // future stream.
    handle().callbacks.onPermissionChanged("viewer");

    // Even after a follow-up open + artifactRoom snapshot, no stale reconcile
    // bytes should ship on the original handle.
    const originalApplied = handle().artifactRoomApplied.length;
    handle().callbacks.onConnectionStatus("open", null);
    expect(handle().artifactRoomApplied.length).toBe(originalApplied);

    opened.dispose();
  });

  it("does not send a stale reconcile after a null permission revoke between snapshot-while-not-open and reopen", () => {
    // Companion to the viewer fail-closed case: a full revoke
    // (`permissionRole === null`) follows a different code path -
    // it does not call `requestFreshSnapshot` but goes straight
    // through `clearAllPendingArtifactRoomUpdates`. The deferred reconcile
    // stashed during the reconnect window MUST still be discarded so
    // a subsequent `onConnectionStatus("open")` on the same handle
    // does not emit stale `artifactRoomApplyUpdate` bytes.
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-artifact-rooms",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });

    const donor = new Y.Doc();
    seedRootArtifactWithArtifactRoom(donor, "art-1", "artifact-room-0");
    handle().callbacks.onConnectionStatus("open", null);
    handle().callbacks.onSnapshot(
      buildMeta("editor", null),
      Y.encodeStateAsUpdate(donor),
    );
    const seedArtifactRoomDoc = new Y.Doc();
    seedArtifactRoomDoc.getXmlFragment("artifact-body:art-1").insert(0, []);
    handle().callbacks.onArtifactRoomSnapshot(
      "artifact-room-0",
      Y.encodeStateAsUpdate(seedArtifactRoomDoc),
      stateVectorBase64(seedArtifactRoomDoc),
    );

    const fragment = opened.store.getState().getArtifactFragment("art-1");
    if (fragment === null) throw new Error("missing fragment");
    const fragmentDoc = fragment.doc;
    if (fragmentDoc === null) throw new Error("missing fragment doc");

    // Reconnecting → local edit → snapshot-while-not-open stashes a
    // deferred reconcile.
    handle().callbacks.onConnectionStatus("reconnecting", null);
    fragmentDoc.transact(() => {
      fragmentDoc.getMap("offline").set("k", "v");
    });
    handle().artifactRoomApplied.length = 0;
    const refreshedArtifactRoomDoc = new Y.Doc();
    refreshedArtifactRoomDoc
      .getXmlFragment("artifact-body:art-1")
      .insert(0, []);
    handle().callbacks.onArtifactRoomSnapshot(
      "artifact-room-0",
      Y.encodeStateAsUpdate(refreshedArtifactRoomDoc),
      stateVectorBase64(refreshedArtifactRoomDoc),
    );
    expect(handle().artifactRoomApplied.length).toBe(0);

    // Full revoke. Unlike the viewer downgrade, this path does NOT
    // tear down the stream handle - `accessLost` flips and the queue
    // / pending reconcile must be cleared in place.
    handle().callbacks.onPermissionChanged(null);
    expect(opened.store.getState().accessLost).toBe(true);
    expect(opened.store.getState().permissionRole).toBeNull();

    // Reopening on the same handle (e.g. transport recovers before
    // a permission re-grant) must not emit any artifactRoomApplyUpdate.
    handle().callbacks.onConnectionStatus("open", null);
    expect(handle().artifactRoomApplied).toHaveLength(0);

    opened.dispose();
  });

  it("clears the per-artifact-room dirty signal when a artifactRoomUpdate's host state vector covers the local watermark", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-artifact-rooms",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });

    const donor = new Y.Doc();
    seedRootArtifactWithArtifactRoom(donor, "art-1", "artifact-room-0");
    handle().callbacks.onConnectionStatus("open", null);
    handle().callbacks.onSnapshot(
      buildMeta("editor", null),
      Y.encodeStateAsUpdate(donor),
    );
    const seedArtifactRoomDoc = new Y.Doc();
    seedArtifactRoomDoc.getXmlFragment("artifact-body:art-1").insert(0, []);
    handle().callbacks.onArtifactRoomSnapshot(
      "artifact-room-0",
      Y.encodeStateAsUpdate(seedArtifactRoomDoc),
      stateVectorBase64(seedArtifactRoomDoc),
    );

    const fragment = opened.store.getState().getArtifactFragment("art-1");
    if (fragment === null) throw new Error("missing fragment");
    const fragmentDoc = fragment.doc;
    if (fragmentDoc === null) throw new Error("missing fragment doc");

    // Local edit while open: the store fan-outs artifactRoomApplyUpdate and marks
    // the per-artifact-room dirty watermark.
    handle().artifactRoomApplied.length = 0;
    fragmentDoc.transact(() => {
      fragmentDoc.getMap("local").set("typed", "yes");
    });
    expect(handle().artifactRoomApplied.length).toBe(1);
    expect(opened.store.getState().isDirty).toBe(true);
    expect(opened.isClean()).toBe(false);
    const localUpdate = handle().artifactRoomApplied[0].bytes;

    // Host echos the local update back as a artifactRoomUpdate; the included
    // state vector must cover the local watermark and clear the dirty
    // bit on the per-artifact-room replica.
    const hostArtifactRoomDoc = new Y.Doc();
    Y.applyUpdate(
      hostArtifactRoomDoc,
      Y.encodeStateAsUpdate(seedArtifactRoomDoc),
    );
    Y.applyUpdate(hostArtifactRoomDoc, localUpdate);
    handle().callbacks.onArtifactRoomUpdate(
      "artifact-room-0",
      localUpdate,
      stateVectorBase64(hostArtifactRoomDoc),
    );
    expect(opened.store.getState().isDirty).toBe(false);
    expect(opened.isClean()).toBe(true);

    // Doing another snapshot pass with the host's now-up-to-date view
    // must NOT emit a redundant reconcile update, since coverage is
    // already proven.
    handle().artifactRoomApplied.length = 0;
    handle().callbacks.onArtifactRoomSnapshot(
      "artifact-room-0",
      Y.encodeStateAsUpdate(hostArtifactRoomDoc),
      stateVectorBase64(hostArtifactRoomDoc),
    );
    expect(handle().artifactRoomApplied.length).toBe(0);

    opened.dispose();
  });

  it("discardUnsyncedEdits clears public dirty state for artifact-room body edits", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-artifact-rooms",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });

    const donor = new Y.Doc();
    seedRootArtifactWithArtifactRoom(donor, "art-1", "artifact-room-0");
    handle().callbacks.onConnectionStatus("open", null);
    handle().callbacks.onSnapshot(
      buildMeta("editor", null),
      Y.encodeStateAsUpdate(donor),
    );
    const seedArtifactRoomDoc = new Y.Doc();
    seedArtifactRoomDoc.getXmlFragment("artifact-body:art-1").insert(0, []);
    handle().callbacks.onArtifactRoomSnapshot(
      "artifact-room-0",
      Y.encodeStateAsUpdate(seedArtifactRoomDoc),
      stateVectorBase64(seedArtifactRoomDoc),
    );

    const fragment = opened.store.getState().getArtifactFragment("art-1");
    if (fragment === null) throw new Error("missing fragment");
    const fragmentDoc = fragment.doc;
    if (fragmentDoc === null) throw new Error("missing fragment doc");

    fragmentDoc.transact(() => {
      fragmentDoc.getMap("local").set("typed", "yes");
    });
    expect(opened.store.getState().isDirty).toBe(true);
    expect(opened.isClean()).toBe(false);

    opened.store.getState().discardUnsyncedEdits();

    expect(opened.store.getState().isDirty).toBe(false);
    expect(opened.isClean()).toBe(true);

    opened.dispose();
  });

  it("converges per-artifact-room dirty state when the host resolver acks a client-origin artifactRoomApplyUpdate by echoing the same bytes back with the post-apply host artifactRoom state vector", () => {
    // Models the fix for the Batch 3 convergence gap: the resolver suppresses
    // the artifact-room doc's update observer for self-origin applies (to avoid a
    // feedback loop), so without an explicit ack the GUI never observes
    // host coverage of its own local artifactRoom edit. The contract-level fix is
    // for the resolver to emit a `artifactRoomUpdate` keyed by artifactRoomId carrying
    // `hostArtifactRoomStateVectorBase64` taken AFTER applying the inbound bytes.
    // This test pins the GUI side: re-applying the same bytes is harmless
    // (Yjs is idempotent), and the included covering state vector must
    // clear the per-artifact-room dirty watermark so a follow-up snapshot does not
    // ship a redundant reconcile.
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-artifact-rooms",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });

    const donor = new Y.Doc();
    seedRootArtifactWithArtifactRoom(donor, "art-1", "artifact-room-0");
    handle().callbacks.onConnectionStatus("open", null);
    handle().callbacks.onSnapshot(
      buildMeta("editor", null),
      Y.encodeStateAsUpdate(donor),
    );
    const seedArtifactRoomDoc = new Y.Doc();
    seedArtifactRoomDoc.getXmlFragment("artifact-body:art-1").insert(0, []);
    handle().callbacks.onArtifactRoomSnapshot(
      "artifact-room-0",
      Y.encodeStateAsUpdate(seedArtifactRoomDoc),
      stateVectorBase64(seedArtifactRoomDoc),
    );

    const fragment = opened.store.getState().getArtifactFragment("art-1");
    if (fragment === null) throw new Error("missing fragment");
    const fragmentDoc = fragment.doc;
    if (fragmentDoc === null) throw new Error("missing fragment doc");

    // Step 1: GUI emits a local artifact-room-body edit while the stream is open.
    // The store fans this out as a single outbound artifactRoomApplyUpdate frame
    // and stamps the per-artifact-room dirty watermark with the post-edit state
    // vector.
    handle().artifactRoomApplied.length = 0;
    fragmentDoc.transact(() => {
      fragmentDoc.getMap("local").set("typed", "yes");
    });
    expect(handle().artifactRoomApplied).toHaveLength(1);
    expect(handle().artifactRoomApplied[0].artifactRoomId).toBe(
      "artifact-room-0",
    );
    expect(opened.store.getState().isDirty).toBe(true);
    expect(opened.isClean()).toBe(false);
    const sentBytes = handle().artifactRoomApplied[0].bytes;

    // Step 2: simulate the host resolver applying that update against
    // its artifact-room doc and acking back. The ack carries:
    //   - the same binary payload (the resolver re-uses the inbound
    //     bytes - idempotent under Yjs)
    //   - hostArtifactRoomStateVectorBase64 taken AFTER the apply, so it covers
    //     the GUI's local watermark
    const hostArtifactRoomDoc = new Y.Doc();
    Y.applyUpdate(
      hostArtifactRoomDoc,
      Y.encodeStateAsUpdate(seedArtifactRoomDoc),
    );
    Y.applyUpdate(hostArtifactRoomDoc, sentBytes);
    const ackVector = stateVectorBase64(hostArtifactRoomDoc);
    handle().callbacks.onArtifactRoomUpdate(
      "artifact-room-0",
      sentBytes,
      ackVector,
    );
    expect(opened.store.getState().isDirty).toBe(false);
    expect(opened.isClean()).toBe(true);

    // Local replica content is still consistent (the ack apply is a
    // no-op under Yjs CRDT semantics).
    const localFragment = opened.store.getState().getArtifactFragment("art-1");
    expect(localFragment).not.toBeNull();
    if (localFragment === null) throw new Error("missing fragment after ack");
    const localFragmentDoc = localFragment.doc;
    if (localFragmentDoc === null)
      throw new Error("missing local fragment doc");
    expect(localFragmentDoc.getMap("local").get("typed")).toBe("yes");

    // Step 3: indirect proof of dirty-watermark clearance - a follow-up
    // artifactRoomSnapshot whose state vector merely matches the post-ack host
    // view must NOT trigger a reconcile fan-out. If the watermark were
    // still set, the store would ship sentBytes again to converge.
    handle().artifactRoomApplied.length = 0;
    handle().callbacks.onArtifactRoomSnapshot(
      "artifact-room-0",
      Y.encodeStateAsUpdate(hostArtifactRoomDoc),
      stateVectorBase64(hostArtifactRoomDoc),
    );
    expect(handle().artifactRoomApplied).toHaveLength(0);

    opened.dispose();
  });

  it("preserves local edits when artifactRoomSnapshot arrives BEFORE the local edit (steady state)", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-artifact-rooms",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });

    const donor = new Y.Doc();
    seedRootArtifactWithArtifactRoom(donor, "art-1", "artifact-room-0");
    handle().callbacks.onConnectionStatus("open", null);
    handle().callbacks.onSnapshot(
      buildMeta("editor", null),
      Y.encodeStateAsUpdate(donor),
    );
    const seedArtifactRoomDoc = new Y.Doc();
    seedArtifactRoomDoc.getXmlFragment("artifact-body:art-1").insert(0, []);
    handle().callbacks.onArtifactRoomSnapshot(
      "artifact-room-0",
      Y.encodeStateAsUpdate(seedArtifactRoomDoc),
      stateVectorBase64(seedArtifactRoomDoc),
    );

    const fragmentBefore = opened.store.getState().getArtifactFragment("art-1");
    if (fragmentBefore === null) throw new Error("missing fragment");
    const fragmentBeforeDoc = fragmentBefore.doc;
    if (fragmentBeforeDoc === null)
      throw new Error("missing fragment-before doc");

    // Local edit AFTER the snapshot - the editor fan-outs an
    // applyArtifactRoomUpdate. The fragment identity must NOT remount.
    fragmentBeforeDoc.transact(() => {
      fragmentBeforeDoc.getMap("typed-after-snapshot").set("k", "v");
    });
    expect(handle().artifactRoomApplied.length).toBe(1);

    const fragmentAfter = opened.store.getState().getArtifactFragment("art-1");
    expect(fragmentAfter).toBe(fragmentBefore);

    opened.dispose();
  });

  it("clears the per-artifact-room dirty watermark on viewer downgrade (fail-closed)", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-artifact-rooms",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });

    const donor = new Y.Doc();
    seedRootArtifactWithArtifactRoom(donor, "art-1", "artifact-room-0");
    handle().callbacks.onConnectionStatus("open", null);
    handle().callbacks.onSnapshot(
      buildMeta("editor", null),
      Y.encodeStateAsUpdate(donor),
    );
    const seedArtifactRoomDoc = new Y.Doc();
    seedArtifactRoomDoc.getXmlFragment("artifact-body:art-1").insert(0, []);
    handle().callbacks.onArtifactRoomSnapshot(
      "artifact-room-0",
      Y.encodeStateAsUpdate(seedArtifactRoomDoc),
      stateVectorBase64(seedArtifactRoomDoc),
    );

    const fragment = opened.store.getState().getArtifactFragment("art-1");
    if (fragment === null) throw new Error("missing fragment");
    const fragmentDoc = fragment.doc;
    if (fragmentDoc === null) throw new Error("missing fragment doc");

    // Disconnect + edit so the dirty watermark is set without an
    // outbound applyArtifactRoomUpdate landing.
    handle().callbacks.onConnectionStatus("reconnecting", null);
    fragmentDoc.transact(() => {
      fragmentDoc.getMap("dirty").set("k", "v");
    });

    handle().artifactRoomApplied.length = 0;

    // Downgrade to viewer - fail-closed: the queue and the dirty
    // watermark are dropped before the resolver re-snapshots.
    handle().callbacks.onPermissionChanged("viewer");

    // Reconnect + resnapshot from the viewer-downgrade path. Even if
    // the new snapshot's state vector trails the prior watermark, we
    // must not ship a stale local update - the store dropped the
    // watermark on the downgrade.
    const refreshed = handle().callbacks;
    refreshed.onConnectionStatus("open", null);
    refreshed.onSnapshot(buildMeta("viewer", null), emptySnapshot());
    refreshed.onArtifactRoomSnapshot(
      "artifact-room-0",
      emptySnapshot(),
      stateVectorBase64(new Y.Doc()),
    );
    expect(handle().artifactRoomApplied.length).toBe(0);

    opened.dispose();
  });

  it("does not assume artifactRoom frames imply root metadata changes - artifactRoom state slice updates do not touch projected root slices", () => {
    const { factory, handle } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-artifact-rooms",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });

    const donor = new Y.Doc();
    donor.getMap("epic").set("title", "Title from snapshot");
    handle().callbacks.onConnectionStatus("open", null);
    handle().callbacks.onSnapshot(
      buildMeta("editor", null),
      Y.encodeStateAsUpdate(donor),
    );

    const titleBefore = opened.store.getState().epic.title;
    const treeBefore = opened.store.getState().tree;
    handle().callbacks.onArtifactRoomState("artifact-room-x", "unavailable");
    handle().callbacks.onArtifactRoomState("artifact-room-y", "retrying");

    expect(opened.store.getState().epic.title).toBe(titleBefore);
    expect(opened.store.getState().tree).toBe(treeBefore);
    expect(
      opened.store.getState().artifactRooms.stateByArtifactRoomId[
        "artifact-room-x"
      ],
    ).toBe("unavailable");
    expect(
      opened.store.getState().artifactRooms.stateByArtifactRoomId[
        "artifact-room-y"
      ],
    ).toBe("retrying");

    opened.dispose();
  });

  describe("migration slice", () => {
    it("starts idle and transitions to running on migrationStarted + progress", () => {
      const { factory, handle } = fakeFactory();
      const opened = createOpenEpicStore({
        epicId: "epic-a",
        streamClientFactory: factory,
        userId: null,
        onAuthError: null,
      });

      expect(opened.store.getState().migration.status).toBe("idle");

      handle().callbacks.onMigrationStarted();
      expect(opened.store.getState().migration).toMatchObject({
        status: "running",
        phase: "prepare",
      });

      handle().callbacks.onMigrationProgress("upload", 3, 7);
      expect(opened.store.getState().migration).toEqual({
        status: "running",
        phase: "upload",
        chunksDone: 3,
        chunksTotal: 7,
      });

      handle().callbacks.onMigrationProgress("finalize", 0, 1);
      expect(opened.store.getState().migration.phase).toBe("finalize");

      opened.dispose();
    });

    it("resets to idle once the post-migration snapshot lands", () => {
      const { factory, handle } = fakeFactory();
      const opened = createOpenEpicStore({
        epicId: "epic-a",
        streamClientFactory: factory,
        userId: null,
        onAuthError: null,
      });

      handle().callbacks.onMigrationStarted();
      handle().callbacks.onMigrationProgress("upload", 5, 5);
      expect(opened.store.getState().migration.status).toBe("running");

      handle().callbacks.onSnapshot(buildMeta("editor", null), emptySnapshot());
      expect(opened.store.getState().migration.status).toBe("idle");

      opened.dispose();
    });

    it("transitions to error on onMigrationFailed and retries in-stream", () => {
      const { factory, handle } = fakeFactory();
      const opened = createOpenEpicStore({
        epicId: "epic-a",
        streamClientFactory: factory,
        userId: null,
        onAuthError: null,
      });

      // The host's `migrationFailed` path keeps the WS open, so the
      // renderer's `currentStatus` is still "open". The retryMigration
      // action must route through the existing stream client, not fall
      // back to a session reopen. Simulate the open status explicitly.
      handle().callbacks.onConnectionStatus("open", null);
      handle().callbacks.onMigrationStarted();
      handle().callbacks.onMigrationFailed("publishArtifactRoom timeout");

      expect(opened.store.getState().migration).toEqual({
        status: "error",
        phase: null,
        chunksDone: 0,
        chunksTotal: 0,
      });

      opened.store.getState().retryMigration();
      expect(handle().retryMigrationCount).toBe(1);
      expect(opened.store.getState().migration.status).toBe("running");

      opened.dispose();
    });

    it("transitions to not-allowed on onMigrationNotAllowed (terminal, not retryable)", () => {
      const { factory, handle } = fakeFactory();
      const opened = createOpenEpicStore({
        epicId: "epic-a",
        streamClientFactory: factory,
        userId: null,
        onAuthError: null,
      });

      handle().callbacks.onConnectionStatus("open", null);
      handle().callbacks.onMigrationNotAllowed();

      expect(opened.store.getState().migration).toEqual({
        status: "not-allowed",
        phase: null,
        chunksDone: 0,
        chunksTotal: 0,
      });

      // Retry is a no-op: there is no error state to recover and the host
      // never started a migration for this caller.
      opened.store.getState().retryMigration();
      expect(handle().retryMigrationCount).toBe(0);
      expect(opened.store.getState().migration.status).toBe("not-allowed");

      opened.dispose();
    });

    it("transitions to error on a fatal close after migration started", () => {
      const { factory, handle } = fakeFactory();
      const opened = createOpenEpicStore({
        epicId: "epic-a",
        streamClientFactory: factory,
        userId: null,
        onAuthError: null,
      });

      handle().callbacks.onMigrationStarted();
      handle().callbacks.onConnectionStatus("closed", {
        kind: "fatalError",
        details: {
          code: "INCOMPATIBLE",
          reason: "boom",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      });

      expect(opened.store.getState().migration).toEqual({
        status: "error",
        phase: null,
        chunksDone: 0,
        chunksTotal: 0,
      });

      opened.dispose();
    });

    it("routes UNAUTHORIZED fatal close to onAuthError even mid-migration (does not pin user on migration error)", () => {
      // Pre-fix, a fatal close arriving while migration was running was
      // unconditionally converted into the migration error modal - including
      // UNAUTHORIZED - which trapped the user behind the modal instead of
      // letting the re-auth flow take over.
      const { factory, handle } = fakeFactory();
      let authErrorCount = 0;
      const opened = createOpenEpicStore({
        epicId: "epic-mid-migration-unauth",
        streamClientFactory: factory,
        userId: null,
        onAuthError: () => {
          authErrorCount += 1;
        },
      });

      handle().callbacks.onMigrationStarted();
      handle().callbacks.onConnectionStatus("closed", {
        kind: "fatalError",
        details: {
          code: "UNAUTHORIZED",
          reason: "token expired",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      });

      expect(authErrorCount).toBe(1);
      // Migration must NOT be flipped into the error modal - it stays in
      // the running state the modal already showed, and the auth flow owns
      // recovery from here.
      expect(opened.store.getState().migration.status).toBe("running");

      opened.dispose();
    });

    it("ignores fatal close when no migration ever started", () => {
      const { factory, handle } = fakeFactory();
      const opened = createOpenEpicStore({
        epicId: "epic-a",
        streamClientFactory: factory,
        userId: null,
        onAuthError: null,
      });

      handle().callbacks.onConnectionStatus("closed", {
        kind: "fatalError",
        details: {
          code: "INCOMPATIBLE",
          reason: "boom",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      });

      expect(opened.store.getState().migration.status).toBe("idle");

      opened.dispose();
    });

    it("retryMigration after a fatal close reopens the session instead of sending a dead-WS frame", () => {
      // The fatal-close path leaves the WS disposed - sending retryMigration
      // on it would be silently dropped by ws-stream-client, trapping the
      // user on the Prepare step. Verify the store falls back to a full
      // requestFreshSnapshot (close + reopen) instead of in-stream retry.
      const { factory, handle, handles } = fakeFactory();
      const opened = createOpenEpicStore({
        epicId: "epic-a",
        streamClientFactory: factory,
        userId: null,
        onAuthError: null,
      });

      const initialStream = handle();
      handle().callbacks.onMigrationStarted();
      handle().callbacks.onConnectionStatus("closed", {
        kind: "fatalError",
        details: {
          code: "INCOMPATIBLE",
          reason: "boom",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      });
      expect(opened.store.getState().migration.status).toBe("error");

      opened.store.getState().retryMigration();

      // No in-stream retry frame on the dead client - would be dropped.
      expect(initialStream.retryMigrationCount).toBe(0);
      // The store closed the old client and opened a fresh one.
      expect(initialStream.closeCount).toBe(1);
      expect(handles()).toHaveLength(2);
      expect(opened.store.getState().migration).toEqual({
        status: "running",
        phase: "prepare",
        chunksDone: 0,
        chunksTotal: 1,
      });

      opened.dispose();
    });

    it("retryMigration is a no-op when migration is not in error", () => {
      const { factory, handle } = fakeFactory();
      const opened = createOpenEpicStore({
        epicId: "epic-a",
        streamClientFactory: factory,
        userId: null,
        onAuthError: null,
      });

      opened.store.getState().retryMigration();
      expect(handle().retryMigrationCount).toBe(0);

      handle().callbacks.onMigrationStarted();
      opened.store.getState().retryMigration();
      expect(handle().retryMigrationCount).toBe(0);
      expect(opened.store.getState().migration.status).toBe("running");

      opened.dispose();
    });
  });

  it("settles an in-flight attachment read when disposed without an abort", async () => {
    const { factory } = fakeFactory();
    const opened = createOpenEpicStore({
      epicId: "epic-a",
      streamClientFactory: factory,
      userId: null,
      onAuthError: null,
    });

    // Park a waiter on a hash that has not synced in yet, then dispose the
    // session without firing the caller's abort signal - the path the
    // registry's MRU prune takes. The promise must still resolve (null) and
    // the waiter's observer must unbind, rather than dangling on the
    // destroyed doc forever.
    const controller = new AbortController();
    let settled = false;
    const pending = opened.store
      .getState()
      .readAttachmentBytes("missing-hash", controller.signal)
      .then((bytes) => {
        settled = true;
        return bytes;
      });

    opened.dispose();

    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(settled).toBe(true);
    expect(await pending).toBeNull();
  });
});
