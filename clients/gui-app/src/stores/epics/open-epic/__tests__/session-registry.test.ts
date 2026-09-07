import * as Y from "yjs";
import { INERT_ROOT_STATE_PORT } from "@/stores/epics/open-epic/test-support/root-state-port-fixture";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { CommandRecord } from "@traycer-clients/shared/replica-runtime";
import {
  publishAgentActivity,
  resetAgentActivity,
} from "@/__tests__/agent-activity-harness";
import {
  __setAgentActivityPlaneAnsweringForTests,
  useAgentActivityStore,
} from "@/stores/agent-activity-store";
import { OpenEpicSessionRegistry } from "@/stores/epics/open-epic/session-registry";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import type { EpicWriteCommandIntent } from "@/stores/epics/open-epic/runtime/epic-write-command";
import { createArtifactInDocForTests } from "@/stores/epics/open-epic/__tests__/projection-helpers-test-shims";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";

// ── No-op stream-client factory ─────────────────────────────────────────────── Honestly-typed,
// zero-implementation factory.

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

// ── TestHandle ──────────────────────────────────────────────────────────────── Wraps a real
// OpenedStoreForTest so the registry tests can:

interface TestHandle {
  readonly handle: OpenedStoreForTest;
  disposed: boolean;
  notify: () => void;
}

function buildTestHandle(id: string, dirty: boolean): TestHandle {
  const base = openStoreForTest({
    epicId: id,
    userId: null,
    // The factories go to the COMPOSITION now: the store stopped constructing a runtime, so a
    // `streamClientFactory` has nowhere else to go.
    factories: {
      streamClientFactory: noopStreamClientFactory,
      laneSelection: null,
    },
    writeCommand: null,
  });

  let disposed = false;
  const realDispose = base.dispose.bind(base);

  // Wrap dispose to track calls.
  const testDispose = () => {
    disposed = true;
    realDispose();
  };

  const wrappedHandle: OpenedStoreForTest = {
    // SPREAD, rather than a member-by-member forward.
    ...base,
    get doc() {
      return base.doc;
    },
    get awareness() {
      return base.awareness;
    },
    get store() {
      return base.store;
    },
    // The one member the wrapper actually exists to change.
    dispose: testDispose,
    hotArtifactRoomIdsForTests: () => [],
    ...INERT_ROOT_STATE_PORT,
  };

  // `isDirty` is the simplest lever on `holdsNothingToLose`: setting it makes the session
  // non-evictable regardless of queue size or write commands, and leaving it false keeps the store's
  if (dirty) {
    base.store.setState({ isDirty: true });
  }

  const testHandle: TestHandle = {
    handle: wrappedHandle,
    get disposed() {
      return disposed;
    },
    set disposed(value: boolean) {
      disposed = value;
    },
    // Fire the store's subscribers so the registry's auto-prune subscription triggers, mirroring what
    // production's store-update cycle does.
    notify: () => {
      base.store.setState({ ...base.store.getState() });
    },
  };

  return testHandle;
}

// Convenience: extract the OpenedStoreForTest from a TestHandle.
function h(t: TestHandle): OpenedStoreForTest {
  return t.handle;
}

// Overrides a built handle's `hostId` for a cross-host scenario.
function withHostId(th: TestHandle, hostId: string): TestHandle {
  return {
    get disposed() {
      return th.disposed;
    },
    set disposed(value: boolean) {
      th.disposed = value;
    },
    notify: () => th.notify(),
    handle: {
      ...th.handle,
      hostId,
      get doc() {
        return th.handle.doc;
      },
      get awareness() {
        return th.handle.awareness;
      },
      get store() {
        return th.handle.store;
      },
    },
  };
}

// The cap's `epicIsBusy` guard fails CLOSED when the activity plane cannot vouch for "no agent is
// working": every epic reads busy until the plane answers.
beforeEach(() => {
  __setAgentActivityPlaneAnsweringForTests();
});

afterEach(() => {
  workingByEpic.clear();
  resetAgentActivity();
});

describe("OpenEpicSessionRegistry", () => {
  it("evicts the LRU clean entry when adding a sixth session", () => {
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const handles: TestHandle[] = [];
    for (let i = 0; i < 5; i += 1) {
      const th = buildTestHandle(`e${i}`, false);
      handles.push(th);
      registry.acquire(`e${i}`, () => h(th));
    }

    registry.get("e0");

    const th5 = buildTestHandle("e5", false);
    registry.acquire("e5", () => h(th5));

    expect(registry.size()).toBe(5);
    expect(handles[1].disposed).toBe(true);
    expect(registry.get("e5")).not.toBeNull();
  });

  it("does not prune mounted clean sessions until their provider unmounts", () => {
    const registry = new OpenEpicSessionRegistry({ maxLive: 1 });
    const mountedA = buildTestHandle("mounted-a", false);
    const mountedB = buildTestHandle("mounted-b", false);

    registry.acquireMounted("mounted-a", () => h(mountedA));
    registry.acquireMounted("mounted-b", () => h(mountedB));

    expect(registry.size()).toBe(2);
    expect(mountedA.disposed).toBe(false);
    expect(mountedB.disposed).toBe(false);

    registry.releaseMounted("mounted-a");

    expect(registry.size()).toBe(1);
    expect(mountedA.disposed).toBe(true);
    expect(mountedB.disposed).toBe(false);
  });

  it("does not evict clean sessions with active agent work", () => {
    const registry = new OpenEpicSessionRegistry({ maxLive: 2 });
    const active = buildTestHandle("active", false);
    const inactiveA = buildTestHandle("inactive-a", false);
    const inactiveB = buildTestHandle("inactive-b", false);

    markAgentWorking(active, "chat-active");
    registry.acquire("active", () => h(active));
    registry.acquire("inactive-a", () => h(inactiveA));
    registry.acquire("inactive-b", () => h(inactiveB));

    expect(registry.size()).toBe(2);
    expect(active.disposed).toBe(false);
    expect(inactiveA.disposed).toBe(true);
    expect(inactiveB.disposed).toBe(false);
    expect(registry.get("active")).not.toBeNull();
  });

  it("auto-prunes overflow when active agent work clears", () => {
    const registry = new OpenEpicSessionRegistry({ maxLive: 1 });
    const activeA = buildTestHandle("active-a", false);
    const activeB = buildTestHandle("active-b", false);

    markAgentWorking(activeA, "chat-a");
    markAgentWorking(activeB, "chat-b");
    registry.acquire("active-a", () => h(activeA));
    registry.acquire("active-b", () => h(activeB));

    expect(registry.size()).toBe(2);
    expect(activeA.disposed).toBe(false);
    expect(activeB.disposed).toBe(false);

    clearAgentWorking(activeA);

    expect(registry.size()).toBe(1);
    expect(activeA.disposed).toBe(true);
    expect(activeB.disposed).toBe(false);
  });

  it("does not evict dirty entries even when above the cap (soft-cap overflow)", () => {
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const handles: TestHandle[] = [];
    for (let i = 0; i < 5; i += 1) {
      const th = buildTestHandle(`e${i}`, true);
      handles.push(th);
      registry.acquire(`e${i}`, () => h(th));
    }

    const th5 = buildTestHandle("e5", true);
    registry.acquire("e5", () => h(th5));

    expect(registry.size()).toBe(6);
    for (const th of handles) {
      expect(th.disposed).toBe(false);
    }

    handles[0].handle.store.setState({ isDirty: false });
    registry.prune();
    expect(registry.size()).toBe(5);
    expect(handles[0].disposed).toBe(true);
  });

  it("evicts a clean, loaded, unmounted session whose transport is reconnecting", () => {
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const reconnecting = buildTestHandle("e0", false);
    reconnecting.handle.store.setState({
      hostTransportStatus: "reconnecting",
      snapshotLoaded: true,
    });
    registry.acquire("e0", () => h(reconnecting));

    const handles: TestHandle[] = [reconnecting];
    for (let i = 1; i < 5; i += 1) {
      const th = buildTestHandle(`e${i}`, false);
      handles.push(th);
      registry.acquire(`e${i}`, () => h(th));
    }

    const th5 = buildTestHandle("e5", false);
    registry.acquire("e5", () => h(th5));

    expect(registry.size()).toBe(5);
    expect(reconnecting.disposed).toBe(true);
  });

  it("keeps a session on another host while the union is narrow, even with an open transport", () => {
    // The union is the SERVING host's answer, so a narrow one (no cloud link) can prove an epic idle
    // only for a session bound to THAT host - this registry can hold sessions bound to others, with no
    useAgentActivityStore.setState({
      connectionStatus: "open",
      servedBy: "local",
      stateFrameSeenThisEpoch: true,
      cloudSyncStatus: null,
      servingHostId: "host-serving",
    });
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const elsewhere = withHostId(
      buildTestHandle("e0", false),
      "host-elsewhere",
    );
    registry.acquire("e0", () => h(elsewhere));
    const onServingHost: TestHandle[] = [];
    for (let i = 1; i < 5; i += 1) {
      const th = withHostId(buildTestHandle(`e${i}`, false), "host-serving");
      onServingHost.push(th);
      registry.acquire(`e${i}`, () => h(th));
    }
    registry.acquire("e5", () =>
      h(withHostId(buildTestHandle("e5", false), "host-serving")),
    );

    // `e0` is the LRU entry, but the walk SKIPS it (its host is outside the union's reach) and evicts
    // the next eligible LRU entry instead - the cap stays enforced, just not against the one session
    expect(elsewhere.disposed).toBe(false);
    expect(registry.size()).toBe(5);
    expect(onServingHost[0].disposed).toBe(true);
  });

  it("still evicts a session on the union's own serving host while the union stays narrow", () => {
    // The narrow-union arm is scoped to sessions on a DIFFERENT host.
    useAgentActivityStore.setState({
      connectionStatus: "open",
      servedBy: "local",
      stateFrameSeenThisEpoch: true,
      cloudSyncStatus: null,
      servingHostId: "host-serving",
    });
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const handles: TestHandle[] = [];
    for (let i = 0; i < 5; i += 1) {
      const th = withHostId(buildTestHandle(`e${i}`, false), "host-serving");
      handles.push(th);
      registry.acquire(`e${i}`, () => h(th));
    }
    registry.acquire("e5", () =>
      h(withHostId(buildTestHandle("e5", false), "host-serving")),
    );

    expect(registry.size()).toBe(5);
    expect(handles[0].disposed).toBe(true);
  });

  it("keeps overflow while every session stays dirty and no subscription fires a clean state", () => {
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const handles: TestHandle[] = [];
    for (let i = 0; i < 6; i += 1) {
      const th = buildTestHandle(`e${i}`, true);
      handles.push(th);
      registry.acquire(`e${i}`, () => h(th));
    }

    expect(registry.size()).toBe(6);

    // Simulate subscription emits while every session remains dirty -
    // prune() must find no eligible candidate, so overflow persists.
    for (const th of handles) th.notify();

    expect(registry.size()).toBe(6);
    for (const th of handles) {
      expect(th.disposed).toBe(false);
    }
  });

  it("auto-prunes overflow when a dirty session later becomes clean (no new acquire)", () => {
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const handles: TestHandle[] = [];
    for (let i = 0; i < 6; i += 1) {
      const th = buildTestHandle(`e${i}`, true);
      handles.push(th);
      registry.acquire(`e${i}`, () => h(th));
    }

    expect(registry.size()).toBe(6);

    // Toggle the LRU session to clean and fire the store's subscriber so the
    // registry's acquire-time subscription triggers prune() and collapses overflow.
    handles[0].handle.store.setState({ isDirty: false });
    handles[0].notify();

    expect(registry.size()).toBe(5);
    expect(handles[0].disposed).toBe(true);
    for (let i = 1; i < 6; i += 1) {
      expect(handles[i].disposed).toBe(false);
    }
  });

  it("does not evict dirty queue-zero sessions during prune", () => {
    const registry = new OpenEpicSessionRegistry({ maxLive: 1 });
    const dirty = buildTestHandle("dirty", true);
    const clean = buildTestHandle("clean", false);

    registry.acquire("dirty", () => h(dirty));
    registry.acquire("clean", () => h(clean));

    expect(registry.size()).toBe(1);
    expect(dirty.disposed).toBe(false);
    expect(clean.disposed).toBe(true);
    expect(registry.get("dirty")).not.toBeNull();
  });

  it("does not evict anything on subscription emit while already at or below the cap", () => {
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const handles: TestHandle[] = [];
    for (let i = 0; i < 3; i += 1) {
      const th = buildTestHandle(`e${i}`, false);
      handles.push(th);
      registry.acquire(`e${i}`, () => h(th));
    }

    for (const th of handles) th.notify();

    expect(registry.size()).toBe(3);
    for (const th of handles) {
      expect(th.disposed).toBe(false);
    }
  });

  it("release forcibly disposes regardless of cap or cleanliness", () => {
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const th = buildTestHandle("e0", true);
    registry.acquire("e0", () => h(th));
    registry.release("e0", "discard", null);
    expect(th.disposed).toBe(true);
    expect(registry.get("e0")).toBeNull();
  });

  it("does not evict a dirty session even while its transport is reconnecting", () => {
    const registry = new OpenEpicSessionRegistry({ maxLive: 1 });
    const dirty = buildTestHandle("dirty", true);
    dirty.handle.store.setState({ hostTransportStatus: "reconnecting" });
    const clean = buildTestHandle("clean", false);

    registry.acquire("dirty", () => h(dirty));
    registry.acquire("clean", () => h(clean));

    expect(registry.size()).toBe(1);
    expect(dirty.disposed).toBe(false);
    expect(clean.disposed).toBe(true);
  });

  it("does not evict a session with a nonzero unsynced queue, even on a clean transport", () => {
    const registry = new OpenEpicSessionRegistry({ maxLive: 1 });
    const queued = buildTestHandle("queued", false);
    queued.handle.store.setState({
      hostTransportStatus: "open",
      unsyncedQueueSize: 1,
    });
    const clean = buildTestHandle("clean", false);

    registry.acquire("queued", () => h(queued));
    registry.acquire("clean", () => h(clean));

    expect(registry.size()).toBe(1);
    expect(queued.disposed).toBe(false);
    expect(clean.disposed).toBe(true);
  });

  it("does not evict a session with a pending write command", () => {
    const registry = new OpenEpicSessionRegistry({ maxLive: 1 });
    const pendingWrite = buildTestHandle("pending-write", false);
    const record: CommandRecord<EpicWriteCommandIntent> = {
      commandId: "cmd-1",
      intent: {
        kind: "update-epic-title",
        title: "New title",
        updatedAt: 0,
      },
      state: "pending",
      delivery: "queued",
      issuedAtMs: 0,
      attempts: 0,
      expectedEntityVersion: null,
      resolution: null,
    };
    pendingWrite.handle.store.setState({ writeCommands: [record] });
    const clean = buildTestHandle("clean", false);

    registry.acquire("pending-write", () => h(pendingWrite));
    registry.acquire("clean", () => h(clean));

    expect(registry.size()).toBe(1);
    expect(pendingWrite.disposed).toBe(false);
    expect(clean.disposed).toBe(true);
  });

  it("evicts a never-loaded, unmounted, empty session", () => {
    // `snapshotLoaded` defaults to false and is deliberately not part of `holdsNothingToLose` - a
    // session that never received a snapshot has nothing to lose either.
    const registry = new OpenEpicSessionRegistry({ maxLive: 1 });
    const neverLoaded = buildTestHandle("never-loaded", false);
    const other = buildTestHandle("other", false);

    registry.acquire("never-loaded", () => h(neverLoaded));
    registry.acquire("other", () => h(other));

    expect(registry.size()).toBe(1);
    expect(neverLoaded.disposed).toBe(true);
  });

  it("re-reads maxLive on every cap walk when given as a function", () => {
    let cap = 2;
    const registry = new OpenEpicSessionRegistry({ maxLive: () => cap });
    const handles: TestHandle[] = [];
    for (let i = 0; i < 3; i += 1) {
      const th = buildTestHandle(`e${i}`, false);
      handles.push(th);
      registry.acquire(`e${i}`, () => h(th));
    }

    // Cap is 2: the LRU entry (e0) was evicted immediately on the third acquire.
    expect(registry.size()).toBe(2);
    expect(handles[0].disposed).toBe(true);

    cap = 3;
    const th3 = buildTestHandle("e3", false);
    registry.acquire("e3", () => h(th3));

    // The new cap is read on THIS walk: nothing further is evicted.
    expect(registry.size()).toBe(3);
    expect(handles[1].disposed).toBe(false);
    expect(handles[2].disposed).toBe(false);
    expect(th3.disposed).toBe(false);
  });
});

/**
 * Prune eligibility rides the host-selected activity view, not the epic's own collaboration
 * awareness, so these helpers publish one host entry covering every epic that currently has work.
 */
const workingByEpic = new Map<string, readonly string[]>();

function publishWorkingSet(): void {
  const byEpic: Record<
    string,
    { working: readonly string[]; turn: readonly string[] }
  > = {};
  for (const [epicId, agentIds] of workingByEpic) {
    byEpic[epicId] = { working: agentIds, turn: agentIds };
  }
  publishAgentActivity([{ hostId: "host-registry", byEpic }]);
}

function markAgentWorking(handle: TestHandle, agentId: string): void {
  workingByEpic.set(handle.handle.epicId, [agentId]);
  publishWorkingSet();
}

function clearAgentWorking(handle: TestHandle): void {
  workingByEpic.set(handle.handle.epicId, []);
  publishWorkingSet();
}

describe("cap eviction defers to the activity plane's own health", () => {
  // `epicIsBusy` fails CLOSED when `agentActivityPlaneAnswers()` is false: a blind plane must read
  // every epic as busy, or an outage that closes the activity stream (which also empties `byEpic`)
  function acquireOverflowing(
    registry: OpenEpicSessionRegistry,
    count: number,
  ): TestHandle[] {
    const handles: TestHandle[] = [];
    for (let i = 0; i < count; i += 1) {
      const th = buildTestHandle(`e${i}`, false);
      handles.push(th);
      registry.acquire(`e${i}`, () => h(th));
    }
    return handles;
  }

  it("evicts nothing while the activity plane's stream is closed, even though every entry is clean", () => {
    useAgentActivityStore.setState({ connectionStatus: "closed" });
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const handles = acquireOverflowing(registry, 6);

    expect(registry.size()).toBe(6);
    for (const th of handles) {
      expect(th.disposed).toBe(false);
    }
  });

  it("evicts nothing while the stream is open but has not yet delivered a state frame of its OWN", () => {
    // The shape a replacement epoch is in between its raw `open` and its first frame: `servedBy` and
    // `byEpic` survive the swap, so the only thing that says this epoch has not re-attested the union
    useAgentActivityStore.setState({
      connectionStatus: "open",
      servedBy: "cloud",
      stateFrameSeenThisEpoch: false,
    });
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const handles = acquireOverflowing(registry, 6);

    expect(registry.size()).toBe(6);
    for (const th of handles) {
      expect(th.disposed).toBe(false);
    }
  });

  it("evicts nothing while the host's cloud link is reconnecting", () => {
    useAgentActivityStore.setState({
      connectionStatus: "open",
      servedBy: "cloud",
      // Everything else vouches, so the cloud stamp is the only refusal in
      // play - without this the case would pass on the missing frame instead.
      stateFrameSeenThisEpoch: true,
      cloudSyncStatus: "reconnecting",
    });
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const handles = acquireOverflowing(registry, 6);

    expect(registry.size()).toBe(6);
    for (const th of handles) {
      expect(th.disposed).toBe(false);
    }
  });

  it("prunes overflow the moment the plane starts answering again, with no new acquire", () => {
    useAgentActivityStore.setState({ connectionStatus: "closed" });
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const handles = acquireOverflowing(registry, 6);
    expect(registry.size()).toBe(6);

    // No acquire follows: the flip fires through `subscribeAgentActivityPlaneHealth`, which every
    // session subscribes to independently of the working-set subscription.
    __setAgentActivityPlaneAnsweringForTests();

    expect(registry.size()).toBe(5);
    expect(handles[0].disposed).toBe(true);
  });
});


function buildRetentionHandle(
  epicId: string,
  dirty: boolean,
  queueSize: number,
): { handle: OpenedStoreForTest; closed: () => boolean } {
  let closeCount = 0;
  const handle = openStoreForTest({
    epicId: epicId,
    userId: null,
    // The factories go to the COMPOSITION now: the store stopped constructing a runtime, so a
    // `streamClientFactory` has nowhere else to go.
    factories: {
      streamClientFactory: () => ({
        applyUpdate: () => undefined,
        awareness: () => undefined,
        applyArtifactRoomUpdate: () => undefined,
        artifactRoomAwareness: () => undefined,
        retryMigration: () => undefined,
        close: () => {
          closeCount += 1;
        },
      }),
      laneSelection: null,
    },
    writeCommand: null,
  });
  handle.store.setState({ isDirty: dirty, unsyncedQueueSize: queueSize });
  return { handle, closed: () => closeCount > 0 };
}

function seedEpicTitle(handle: OpenedStoreForTest, title: string): void {
  handle.doc.getMap("epic").set("title", title);
}

function encodeBase64ForTests(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/** The exact shape `write-command-delivery.test.ts` uses to open the write gate. */
function writeGateOpenSnapshotMeta(epicId: string): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: epicId,
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
    hostStateVectorBase64: encodeBase64ForTests(
      Y.encodeStateVector(new Y.Doc()),
    ),
  };
}

function errorName(value: unknown): string {
  return value instanceof Error ? value.name : `not-an-error:${String(value)}`;
}

/** Races a promise against a short timer, so a genuine hang reddens fast. */
function raceAgainstHang(waiter: Promise<unknown>): Promise<unknown> {
  return Promise.race([
    waiter.then(
      () => "settled" as const,
      (cause: unknown) => cause,
    ),
    new Promise<"hung">((resolve) => {
      setTimeout(() => {
        resolve("hung");
      }, 250);
    }),
  ]);
}

/**
 * `buildRetentionHandle`-style construction (a real `openStoreForTest` store, marked clean), but
 * with the write gate actually OPEN and a `writeCommand` that never settles - so a command
 */
function buildRetentionHandleWithNeverSettlingWrite(epicId: string): {
  readonly handle: OpenedStoreForTest;
  readonly closed: () => boolean;
  readonly artifactId: string;
} {
  let closeCount = 0;
  const captured: { value: EpicStreamCallbacks | null } = { value: null };
  const factory: EpicStreamClientFactory = (_id, callbacks) => {
    captured.value = callbacks;
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => {
        closeCount += 1;
      },
    };
  };
  const handle = openStoreForTest({
    epicId,
    userId: null,
    factories: { streamClientFactory: factory, laneSelection: null },
    writeCommand: () => new Promise<{ readonly hostId: string }>(() => {}),
  });
  if (captured.value === null) throw new Error("factory not invoked");
  captured.value.onConnectionStatus("open", null);
  captured.value.onSnapshot(
    writeGateOpenSnapshotMeta(epicId),
    Y.encodeStateAsUpdate(new Y.Doc()),
  );
  const artifactId = createArtifactInDocForTests(handle.doc, "spec", null);
  // Clean: no unsynced Y.Doc edits - matching the sibling "disposes a CLEAN outgoing handle" test
  // this one extends.
  handle.store.setState({ isDirty: false, unsyncedQueueSize: 0 });
  return { handle, closed: () => closeCount > 0, artifactId };
}

describe("retained unsynced buffers across a host re-point (F10)", () => {
  const EPIC = "epic-f10";
  const IDENTITY_A = {
    hostStamp: "host-a",
    ownerIdentityKey: "key-a",
    editsTransferredToReplacement: false,
  };

  function repoint(
    registry: OpenEpicSessionRegistry,
    previous: OpenedStoreForTest,
    next: OpenedStoreForTest,
    identity: { hostStamp: string | null; ownerIdentityKey: string | null },
  ): boolean {
    // Every arm in this describe is the F10 shape: a re-point with no same-room merge behind it, so
    // the outgoing handle is the ONLY copy of its edits and retention is the whole subject.
    return registry.replaceMounted(EPIC, previous, next, {
      ...identity,
      editsTransferredToReplacement: false,
    });
  }

  it("reports the retained buffer even though the LIVE session is clean", () => {
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const previous = buildRetentionHandle(EPIC, true, 3);
    seedEpicTitle(previous.handle, "Rewrite the onboarding");
    // Re-assert AFTER the doc write, not before. The seed above is a local mutation, so it publishes -
    // and a publish re-states every field the records projection owns, `unsyncedQueueSize` among them.
    previous.handle.store.setState({ isDirty: true, unsyncedQueueSize: 3 });
    registry.acquireMounted(EPIC, () => previous.handle);
    const next = buildRetentionHandle(EPIC, false, 0);

    expect(repoint(registry, previous.handle, next.handle, IDENTITY_A)).toBe(
      true,
    );

    // The row EXISTS at all - the condition, not just its content.
    const rows = registry.getUnsyncedEdits();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.epicId).toBe(EPIC);
    expect(rows[0]?.queueSize).toBe(3);
    expect(rows[0]?.isDirty).toBe(true);
    // Title falls through to the retained handle: a freshly re-pointed live session has no Y.Doc title
    // and no snapshot meta, so preferring it unconditionally would label the row with a bare epic id.
    expect(rows[0]?.title).toBe("Rewrite the onboarding");
  });

  it("answers the per-epic predicate every close and move gate reads", () => {
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const previous = buildRetentionHandle(EPIC, true, 2);
    registry.acquireMounted(EPIC, () => previous.handle);
    const next = buildRetentionHandle(EPIC, false, 0);
    repoint(registry, previous.handle, next.handle, IDENTITY_A);

    // The projection and this predicate are the same walk.
    expect(registry.hasUnsyncedEdits(EPIC)).toBe(true);
  });

  it("closes the retained handle's transport so it stops dialing", () => {
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const previous = buildRetentionHandle(EPIC, true, 1);
    registry.acquireMounted(EPIC, () => previous.handle);
    const next = buildRetentionHandle(EPIC, false, 0);
    repoint(registry, previous.handle, next.handle, IDENTITY_A);

    // Positive first: the buffer is retained...
    expect(registry.getUnsyncedEdits()).toHaveLength(1);
    // ...and it is inert. A retained handle that kept its stream client would report dial evidence for
    // a host this window has left, into the input host-death detection reads.
    expect(previous.closed()).toBe(true);
  });

  it("disposes a CLEAN outgoing handle instead of retaining it", () => {
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const previous = buildRetentionHandle(EPIC, false, 0);
    registry.acquireMounted(EPIC, () => previous.handle);
    const next = buildRetentionHandle(EPIC, false, 0);
    repoint(registry, previous.handle, next.handle, IDENTITY_A);

    // The control.
    expect(registry.getUnsyncedEdits()).toHaveLength(0);
    expect(registry.hasUnsyncedEdits(EPIC)).toBe(false);
  });

  it("disposes a clean outgoing handle that still has an outstanding write command, and settles its waiter", async () => {
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const rig = buildRetentionHandleWithNeverSettlingWrite(EPIC);
    registry.acquireMounted(EPIC, () => rig.handle);

    const commandId = await rig.handle.store.getState().enqueueWriteCommand({
      kind: "rename-artifact",
      artifactId: rig.artifactId,
      title: "New",
    });
    expect(commandId).not.toBeNull();
    if (commandId === null) {
      throw new Error("expected enqueueWriteCommand to mint a command id");
    }
    await rig.handle.flush();
    const waiter = rig.handle.store.getState().waitForWriteCommand(commandId);

    const next = buildRetentionHandle(EPIC, false, 0);
    expect(repoint(registry, rig.handle, next.handle, IDENTITY_A)).toBe(true);

    // The retention gate is DELIBERATELY unchanged: a clean outgoing handle is still not retained,
    // even though it has a pending write command - the two are different questions (unsynced Y.Doc
    expect(registry.getUnsyncedEdits()).toHaveLength(0);

    const outcome = await raceAgainstHang(waiter);
    // THE REDDENING ONE - today this hangs: `replaceMounted`'s dispose of a
    // clean outgoing handle never settles the command it just orphaned.
    expect(errorName(outcome)).toBe("EpicSessionEndedError");
  });

  it("merges a second retention for the same host AND identity", () => {
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const first = buildRetentionHandle(EPIC, true, 2);
    registry.acquireMounted(EPIC, () => first.handle);
    const second = buildRetentionHandle(EPIC, true, 5);
    repoint(registry, first.handle, second.handle, IDENTITY_A);
    const third = buildRetentionHandle(EPIC, false, 0);
    repoint(registry, second.handle, third.handle, IDENTITY_A);

    // One row, summed - not two retentions and not a replacement.
    const rows = registry.getUnsyncedEdits();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.queueSize).toBe(7);
  });

  /** Waits for the merge tail to run to completion. A MACROTASK, not a count of microtasks. */
  async function settled(): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  /**
   * A handle whose root-state PORT is held open, so the merge window is observable by ORDER rather
   * than by timing.
   */
  function deferredSource(epicId: string): {
    readonly handle: OpenedStoreForTest;
    readonly settle: (outcome: "resolve" | "reject") => void;
    readonly disposed: () => number;
    readonly transportClosed: () => boolean;
  } {
    const built = buildRetentionHandle(epicId, true, 3);
    let release: ((bytes: Uint8Array) => void) | null = null;
    let fail: ((cause: unknown) => void) | null = null;
    let disposeCount = 0;
    const handle: OpenedStoreForTest = {
      ...built.handle,
      encodeRootState: () =>
        new Promise<Uint8Array>((resolve, reject) => {
          release = resolve;
          fail = reject;
        }),
      dispose: () => {
        disposeCount += 1;
        built.handle.dispose();
      },
    };
    return {
      handle,
      settle: (outcome) => {
        // "Resolve" has to mean the target ACCEPTS, or the happy path is never exercised at all.
        if (outcome === "resolve")
          release?.(Y.encodeStateAsUpdate(new Y.Doc()));
        else fail?.(new Error("encode failed"));
      },
      disposed: () => disposeCount,
      transportClosed: built.closed,
    };
  }

  it("holds the merged-from handle undisposed until the transfer settles", async () => {
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const first = buildRetentionHandle(EPIC, true, 2);
    registry.acquireMounted(EPIC, () => first.handle);
    const source = deferredSource(EPIC);
    repoint(registry, first.handle, source.handle, IDENTITY_A);
    const third = buildRetentionHandle(EPIC, false, 0);
    repoint(registry, source.handle, third.handle, IDENTITY_A);

    // INSIDE the window: encoded, not yet applied, not yet disposed.
    expect(source.disposed()).toBe(0);
    // (a) The transport went at detach and does not come back. A source that reattached here would
    // dial a host this window has left, into the selection authority's death-detection input.
    expect(source.transportClosed()).toBe(true);

    source.settle("resolve");
    await settled();

    expect(source.disposed()).toBe(1);
    expect(source.transportClosed()).toBe(true);
  });

  it("KEEPS the merged-from handle when the transfer rejects, as its own buffer", async () => {
    // REVERSED, and the reversal is the point.
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const first = buildRetentionHandle(EPIC, true, 2);
    registry.acquireMounted(EPIC, () => first.handle);
    const source = deferredSource(EPIC);
    repoint(registry, first.handle, source.handle, IDENTITY_A);
    const third = buildRetentionHandle(EPIC, false, 0);
    repoint(registry, source.handle, third.handle, IDENTITY_A);

    // PREMISE, positively: the merge really was attempted - one buffer, with
    // the source's three edits optimistically credited onto the target's two.
    expect(registry.retainedCountForTests(EPIC)).toBe(1);
    expect([...registry.retainedQueueSizesForTests(EPIC)]).toEqual([5]);

    source.settle("reject");
    await settled();

    expect(source.disposed()).toBe(0);
    expect(registry.retainedCountForTests(EPIC)).toBe(2);
    // And the credit for a transfer that did not happen was taken back. The TOTAL is 5 either way,
    // which is why this reads the buffers rather than the row.
    expect([...registry.retainedQueueSizesForTests(EPIC)]).toEqual([2, 3]);
  });

  // NO PIN for "a second merge for the same source", and the absence is deliberate.

  it("still retains when the outgoing store would read CLEAN after teardown", () => {
    // ONE pin, not two.
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const built = buildRetentionHandle(EPIC, true, 6);
    built.handle.store.setState({ isDirty: true, unsyncedQueueSize: 6 });
    const outgoing: OpenedStoreForTest = {
      ...built.handle,
      get epicId() {
        return built.handle.epicId;
      },
      get doc() {
        return built.handle.doc;
      },
      get awareness() {
        return built.handle.awareness;
      },
      get store() {
        return built.handle.store;
      },
      dispose: () => {
        built.handle.store.setState({ isDirty: false, unsyncedQueueSize: 0 });
        built.handle.dispose();
      },
    };
    registry.acquireMounted(EPIC, () => outgoing);
    const next = buildRetentionHandle(EPIC, false, 0);

    expect(repoint(registry, outgoing, next.handle, IDENTITY_A)).toBe(true);

    const rows = registry.getUnsyncedEdits();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.queueSize).toBe(6);
  });

  it("refuses to merge across an owner-identity rotation on the same host", () => {
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const first = buildRetentionHandle(EPIC, true, 2);
    registry.acquireMounted(EPIC, () => first.handle);
    const second = buildRetentionHandle(EPIC, true, 5);
    repoint(registry, first.handle, second.handle, IDENTITY_A);
    const third = buildRetentionHandle(EPIC, false, 0);
    // Same host, rotated identity.
    repoint(registry, second.handle, third.handle, {
      hostStamp: "host-a",
      ownerIdentityKey: "key-a-rotated",
    });

    const rows = registry.getUnsyncedEdits();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.queueSize).toBe(7);
    expect(registry.retainedCountForTests(EPIC)).toBe(2);
  });

  it("never merges on an absent identity reading, including two absences", () => {
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const first = buildRetentionHandle(EPIC, true, 2);
    registry.acquireMounted(EPIC, () => first.handle);
    const second = buildRetentionHandle(EPIC, true, 5);
    repoint(registry, first.handle, second.handle, {
      hostStamp: "host-a",
      ownerIdentityKey: null,
    });
    const third = buildRetentionHandle(EPIC, false, 0);
    repoint(registry, second.handle, third.handle, {
      hostStamp: "host-a",
      ownerIdentityKey: null,
    });

    // `null` is absence of proof, not a match - so it must not match another `null` either.
    expect(registry.retainedCountForTests(EPIC)).toBe(2);
    expect(registry.getUnsyncedEdits()[0]?.queueSize).toBe(7);
  });

  it("drains the retained buffer along with the live session", () => {
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const previous = buildRetentionHandle(EPIC, true, 4);
    registry.acquireMounted(EPIC, () => previous.handle);
    const next = buildRetentionHandle(EPIC, false, 0);
    repoint(registry, previous.handle, next.handle, IDENTITY_A);
    expect(registry.getUnsyncedEdits()).toHaveLength(1);

    registry.drainUnsyncedEdits(EPIC);

    // Discard is one decision per epic because the row is one per epic.
    expect(registry.getUnsyncedEdits()).toHaveLength(0);
    expect(registry.hasUnsyncedEdits(EPIC)).toBe(false);
  });

  it("reclaims retentions when the tab is closed", () => {
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const previous = buildRetentionHandle(EPIC, true, 4);
    registry.acquireMounted(EPIC, () => previous.handle);
    const next = buildRetentionHandle(EPIC, false, 0);
    repoint(registry, previous.handle, next.handle, IDENTITY_A);
    expect(registry.getUnsyncedEdits()).toHaveLength(1);

    registry.release(EPIC, "discard", null);

    // `prune()` cannot reach retentions and must not, so tab close is one of the few real reclamation
    // paths.
    expect(registry.getUnsyncedEdits()).toHaveLength(0);
    expect(registry.retainedCountForTests(EPIC)).toBe(0);
  });

  it("reclaims retentions on sign-out, so no prior identity's doc survives", () => {
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const previous = buildRetentionHandle(EPIC, true, 4);
    registry.acquireMounted(EPIC, () => previous.handle);
    const next = buildRetentionHandle(EPIC, false, 0);
    repoint(registry, previous.handle, next.handle, IDENTITY_A);
    expect(registry.getUnsyncedEdits()).toHaveLength(1);

    registry.disposeAll();

    // `disposeAll` is the auth lifecycle's hook and its contract is that no prior identity's Y.Doc
    // survives into the next session.
    expect(registry.getUnsyncedEdits()).toHaveLength(0);
    expect(registry.retainedCountForTests(EPIC)).toBe(0);
  });
});


describe("release states its meaning for retained buffers", () => {
  const EPIC = "epic-release";

  it("keeps another host's buffer when THIS host's identity rotates", () => {
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const onHostA = buildRetentionHandle(EPIC, true, 6);
    registry.acquireMounted(EPIC, () => onHostA.handle);
    const onHostB = buildRetentionHandle(EPIC, false, 0);
    registry.replaceMounted(EPIC, onHostA.handle, onHostB.handle, {
      hostStamp: "host-a",
      ownerIdentityKey: "key-a",
      editsTransferredToReplacement: false,
    });
    expect(registry.getUnsyncedEdits()).toHaveLength(1);

    // Host B rotates its owner identity. The provider's rebuild arm releases the live session - it
    // must not take host A's unsynced work with it.
    registry.release(EPIC, "keep", null);

    expect(registry.retainedCountForTests(EPIC)).toBe(1);
    const rows = registry.getUnsyncedEdits();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.queueSize).toBe(6);
  });

  it("retains the DIRTY LIVE handle when an owner-identity rotation releases it", () => {
    // Codex #1243 post-merge. `"keep"` spared only buffers ALREADY retained; the live handle - the one
    // actually holding the user's unsynced edits - was disposed either way.
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const live = buildRetentionHandle(EPIC, true, 4);
    registry.acquireMounted(EPIC, () => live.handle);
    expect(registry.getUnsyncedEdits()).toHaveLength(1);

    registry.release(EPIC, "keep", {
      hostStamp: "host-a",
      ownerIdentityKey: "key-before-rotation",
    });

    // The live session is gone, but its edits are not: they are now a retained buffer, reachable
    // through the same projection every close and quit gate reads.
    expect(registry.get(EPIC)).toBeNull();
    expect(registry.retainedCountForTests(EPIC)).toBe(1);
    const rows = registry.getUnsyncedEdits();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.queueSize).toBe(4);
    // Retained, not destroyed - and its transport is detached so it stops
    // dialing a host this window has left.
    expect(live.closed()).toBe(true);
  });

  it("disposes a CLEAN live handle on the same path rather than retaining an empty buffer", () => {
    // The control: retention is for unsynced edits, not for every release. Retaining a clean handle
    // would put an empty row in the quit sheet and nothing would ever retire it.
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const live = buildRetentionHandle(EPIC, false, 0);
    registry.acquireMounted(EPIC, () => live.handle);

    registry.release(EPIC, "keep", {
      hostStamp: "host-a",
      ownerIdentityKey: "key-before-rotation",
    });

    expect(registry.retainedCountForTests(EPIC)).toBe(0);
    expect(registry.getUnsyncedEdits()).toHaveLength(0);
  });

  it("destroys the dirty live handle when the caller names NO identity, which is how a user change stays a security boundary", () => {
    // `null` is the decision the user-change arm takes: another person is at the keyboard and no prior
    // identity's document may survive it. The rotation arm above is the one that must not.
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const live = buildRetentionHandle(EPIC, true, 4);
    registry.acquireMounted(EPIC, () => live.handle);

    registry.release(EPIC, "keep", null);

    expect(registry.retainedCountForTests(EPIC)).toBe(0);
    expect(registry.getUnsyncedEdits()).toHaveLength(0);
  });

  it("still reclaims on tab close, where the user answered for the buffer", () => {
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const previous = buildRetentionHandle(EPIC, true, 6);
    registry.acquireMounted(EPIC, () => previous.handle);
    const next = buildRetentionHandle(EPIC, false, 0);
    registry.replaceMounted(EPIC, previous.handle, next.handle, {
      hostStamp: "host-a",
      ownerIdentityKey: "key-a",
      editsTransferredToReplacement: false,
    });

    registry.release(EPIC, "discard", null);

    // The control for the arm above: `"keep"` must not have made reclamation
    // unreachable, or the retention would simply leak instead.
    expect(registry.retainedCountForTests(EPIC)).toBe(0);
    expect(registry.getUnsyncedEdits()).toHaveLength(0);
  });
});

describe("a re-point whose edits were MERGED into the replacement", () => {
  const EPIC = "epic-transferred";

  it("disposes the outgoing handle instead of retaining a duplicate of it", () => {
    // Codex #1243 T-57.
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const outgoing = buildRetentionHandle(EPIC, true, 4);
    registry.acquireMounted(EPIC, () => outgoing.handle);
    const incoming = buildRetentionHandle(EPIC, false, 0);

    // Premise, positively: the handle being displaced really is dirty, so this arm is exercising the
    // transfer branch and not passing because there was nothing to retain in the first place.
    expect(outgoing.handle.store.getState().isDirty).toBe(true);

    const replaced = registry.replaceMounted(
      EPIC,
      outgoing.handle,
      incoming.handle,
      {
        hostStamp: "host-a",
        ownerIdentityKey: "key-a",
        editsTransferredToReplacement: true,
      },
    );

    expect(replaced).toBe(true);
    expect(registry.retainedCountForTests(EPIC)).toBe(0);
    expect(registry.getUnsyncedEdits()).toHaveLength(0);
  });

  it("still retains when nothing was transferred - F10 is not weakened", () => {
    // The control.
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const outgoing = buildRetentionHandle(EPIC, true, 4);
    registry.acquireMounted(EPIC, () => outgoing.handle);
    const incoming = buildRetentionHandle(EPIC, false, 0);

    registry.replaceMounted(EPIC, outgoing.handle, incoming.handle, {
      hostStamp: "host-a",
      ownerIdentityKey: "key-a",
      editsTransferredToReplacement: false,
    });

    expect(registry.retainedCountForTests(EPIC)).toBe(1);
    expect(registry.getUnsyncedEdits()).toHaveLength(1);
  });
});

describe("eligibility key watches the live Y.Doc title, not just metaTitle", () => {
  it("emits when the live title changes on an already-dirty session, even though metaTitle never does", () => {
    // A title landing in the doc on a dirty session left the key unchanged, so
    // `handleEligibilityChange` short-circuited before `emit()` - the React-subscribed quit sheet kept
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const EPIC = "epic-live-title-emit";
    const th = buildTestHandle(EPIC, false);
    th.handle.store.setState({ isDirty: true, unsyncedQueueSize: 1 });
    registry.acquireMounted(EPIC, () => h(th));

    let emitCount = 0;
    registry.subscribe(() => {
      emitCount += 1;
    });

    // Only the live doc title moves - `isDirty`, `unsyncedQueueSize`, `isClean()` and `metaTitle`
    // (there is no snapshot meta here at all) are all unchanged.
    seedEpicTitle(h(th), "Renamed while dirty");
    th.notify();

    expect(emitCount).toBeGreaterThan(0);
    // The reader that was already correct stays correct - this proves the
    // fix is about the emit gate firing, not about the title value itself.
    const rows = registry.getUnsyncedEdits();
    expect(rows.find((row) => row.epicId === EPIC)?.title).toBe(
      "Renamed while dirty",
    );
  });

  it("does not emit again when neither the live title nor any other key field moves", () => {
    // The control: a `notify()` that changes nothing observable must stay silent, or the fix above
    // would just be "always emit" wearing a title check - which defeats the whole per-keystroke gating
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const EPIC = "epic-live-title-no-emit";
    const th = buildTestHandle(EPIC, false);
    th.handle.store.setState({ isDirty: true, unsyncedQueueSize: 1 });
    registry.acquireMounted(EPIC, () => h(th));

    let emitCount = 0;
    registry.subscribe(() => {
      emitCount += 1;
    });

    th.notify();

    expect(emitCount).toBe(0);
  });
});
