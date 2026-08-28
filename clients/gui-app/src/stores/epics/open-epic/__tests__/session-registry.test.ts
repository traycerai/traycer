import { afterEach, describe, expect, it } from "vitest";
import {
  publishAgentActivity,
  resetAgentActivity,
} from "@/__tests__/agent-activity-harness";
import { OpenEpicSessionRegistry } from "@/stores/epics/open-epic/session-registry";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";

// ── No-op stream-client factory ───────────────────────────────────────────────
// Honestly-typed, zero-implementation factory. No snapshots arrive; the
// registry only calls handle.isClean(), store.subscribe(), and dispose().

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

// ── TestHandle ────────────────────────────────────────────────────────────────
// Wraps a real OpenEpicStoreHandle so the registry tests can:
//   - observe dispose() calls via the `disposed` flag
//   - override isClean() via the `clean` flag (simulates dirty / reconnecting
//     without actually needing a live Y.Doc update cycle)
//   - fire store subscribers via notify() to exercise auto-prune

interface TestHandle {
  readonly handle: OpenEpicStoreHandle;
  disposed: boolean;
  clean: boolean;
  notify: () => void;
}

function buildTestHandle(id: string, clean: boolean): TestHandle {
  const base = createOpenEpicStore({
    epicId: id,
    streamClientFactory: noopStreamClientFactory,
    userId: null,
    onAuthError: null,
  });

  let disposed = false;
  const realDispose = base.dispose.bind(base);

  // Wrap dispose to track calls.
  const testDispose = () => {
    disposed = true;
    realDispose();
  };

  // Wrap isClean so tests can flip `clean` independently of Y.Doc state.
  let isCleanOverride = clean;

  const wrappedHandle: OpenEpicStoreHandle = {
    get epicId() {
      return base.epicId;
    },
    get userId() {
      return base.userId;
    },
    get doc() {
      return base.doc;
    },
    get awareness() {
      return base.awareness;
    },
    get store() {
      return base.store;
    },
    requestFreshSnapshot: () => base.requestFreshSnapshot(),
    dispose: testDispose,
    detachTransport: () => base.detachTransport(),
    isClean: () => isCleanOverride,
    hotArtifactRoomIdsForTests: () => [],
  };

  const testHandle: TestHandle = {
    handle: wrappedHandle,
    get disposed() {
      return disposed;
    },
    set disposed(value: boolean) {
      disposed = value;
    },
    get clean() {
      return isCleanOverride;
    },
    set clean(value: boolean) {
      isCleanOverride = value;
    },
    // Fire the store's subscribers so the registry's auto-prune subscription
    // triggers, mirroring what production's store-update cycle does.
    // Spread to produce a new object reference so Zustand's equality check
    // treats this as a change and notifies all subscribers.
    notify: () => {
      base.store.setState({ ...base.store.getState() });
    },
  };

  return testHandle;
}

// Convenience: extract the OpenEpicStoreHandle from a TestHandle.
function h(t: TestHandle): OpenEpicStoreHandle {
  return t.handle;
}

afterEach(() => {
  workingByEpic.clear();
  resetAgentActivity();
});

describe("OpenEpicSessionRegistry", () => {
  it("evicts the LRU clean entry when adding a sixth session", () => {
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const handles: TestHandle[] = [];
    for (let i = 0; i < 5; i += 1) {
      const th = buildTestHandle(`e${i}`, true);
      handles.push(th);
      registry.acquire(`e${i}`, () => h(th));
    }

    registry.get("e0");

    const th5 = buildTestHandle("e5", true);
    registry.acquire("e5", () => h(th5));

    expect(registry.size()).toBe(5);
    expect(handles[1].disposed).toBe(true);
    expect(registry.get("e5")).not.toBeNull();
  });

  it("does not prune mounted clean sessions until their provider unmounts", () => {
    const registry = new OpenEpicSessionRegistry({ maxLive: 1 });
    const mountedA = buildTestHandle("mounted-a", true);
    const mountedB = buildTestHandle("mounted-b", true);

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
    const active = buildTestHandle("active", true);
    const inactiveA = buildTestHandle("inactive-a", true);
    const inactiveB = buildTestHandle("inactive-b", true);

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
    const activeA = buildTestHandle("active-a", true);
    const activeB = buildTestHandle("active-b", true);

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
      const th = buildTestHandle(`e${i}`, false);
      handles.push(th);
      registry.acquire(`e${i}`, () => h(th));
    }

    const th5 = buildTestHandle("e5", false);
    registry.acquire("e5", () => h(th5));

    expect(registry.size()).toBe(6);
    for (const th of handles) {
      expect(th.disposed).toBe(false);
    }

    handles[0].clean = true;
    registry.prune();
    expect(registry.size()).toBe(5);
    expect(handles[0].disposed).toBe(true);
  });

  it("treats reconnecting sessions as ineligible for eviction even with empty queue", () => {
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const handles: TestHandle[] = [];
    for (let i = 0; i < 5; i += 1) {
      const th = buildTestHandle(`e${i}`, i !== 2);
      handles.push(th);
      registry.acquire(`e${i}`, () => h(th));
    }

    const th5 = buildTestHandle("e5", true);
    registry.acquire("e5", () => h(th5));

    expect(registry.size()).toBe(5);
    expect(handles[2].disposed).toBe(false);
  });

  it("keeps overflow while every session stays dirty and no subscription fires a clean state", () => {
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const handles: TestHandle[] = [];
    for (let i = 0; i < 6; i += 1) {
      const th = buildTestHandle(`e${i}`, false);
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
      const th = buildTestHandle(`e${i}`, false);
      handles.push(th);
      registry.acquire(`e${i}`, () => h(th));
    }

    expect(registry.size()).toBe(6);

    // Toggle the LRU session to clean and fire the store's subscriber so the
    // registry's acquire-time subscription triggers prune() and collapses overflow.
    handles[0].clean = true;
    handles[0].notify();

    expect(registry.size()).toBe(5);
    expect(handles[0].disposed).toBe(true);
    for (let i = 1; i < 6; i += 1) {
      expect(handles[i].disposed).toBe(false);
    }
  });

  it("does not evict dirty queue-zero sessions during prune", () => {
    const registry = new OpenEpicSessionRegistry({ maxLive: 1 });
    const dirty = buildTestHandle("dirty", false);
    const clean = buildTestHandle("clean", true);

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
      const th = buildTestHandle(`e${i}`, true);
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
    const th = buildTestHandle("e0", false);
    registry.acquire("e0", () => h(th));
    registry.release("e0", "discard", null);
    expect(th.disposed).toBe(true);
    expect(registry.get("e0")).toBeNull();
  });
});

/**
 * Prune eligibility rides the host-selected activity view, not the epic's own
 * collaboration awareness, so these helpers publish one host
 * entry covering every epic that currently has work. Publishing the whole set
 * each time mirrors the host, which republishes its full entry on every
 * activity boundary.
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

// ── F10: dirty sessions retained across a host re-point ───────────────────────
// Below protocol `@1.2` the host sends no `roomId`, so the cross-host document
// merge is unreachable and `replaceMounted`'s dispose destroyed the outgoing
// handle's unsynced edits outright.
//
// Every fixture here asserts the retention POSITIVELY first - the row exists,
// with its content - before asserting anything it prevents. Four of the five
// rules the retention has to satisfy are negatives ("not adopted", "not
// reported", "does not flush"), and a negative is satisfied just as well by a
// retention that never happened, so a fixture that opens with one is testing
// nothing. The single mutation that must redden this whole block is making the
// gate in `replaceMounted` dispose unconditionally again.

function buildRetentionHandle(
  epicId: string,
  dirty: boolean,
  queueSize: number,
): { handle: OpenEpicStoreHandle; closed: () => boolean } {
  let closeCount = 0;
  const handle = createOpenEpicStore({
    epicId,
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
    userId: null,
    onAuthError: null,
  });
  handle.store.setState({ isDirty: dirty, unsyncedQueueSize: queueSize });
  return { handle, closed: () => closeCount > 0 };
}

function seedEpicTitle(handle: OpenEpicStoreHandle, title: string): void {
  handle.doc.getMap("epic").set("title", title);
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
    previous: OpenEpicStoreHandle,
    next: OpenEpicStoreHandle,
    identity: { hostStamp: string | null; ownerIdentityKey: string | null },
  ): boolean {
    // Every arm in this describe is the F10 shape: a re-point with no
    // same-room merge behind it, so the outgoing handle is the ONLY copy of
    // its edits and retention is the whole subject.
    return registry.replaceMounted(EPIC, previous, next, {
      ...identity,
      editsTransferredToReplacement: false,
    });
  }

  it("reports the retained buffer even though the LIVE session is clean", () => {
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const previous = buildRetentionHandle(EPIC, true, 3);
    seedEpicTitle(previous.handle, "Rewrite the onboarding");
    registry.acquireMounted(EPIC, () => previous.handle);
    const next = buildRetentionHandle(EPIC, false, 0);

    expect(repoint(registry, previous.handle, next.handle, IDENTITY_A)).toBe(
      true,
    );

    // The row EXISTS at all - the condition, not just its content. The live
    // entry is clean here, which is the normal state right after a re-point,
    // and the pre-fix projection skipped the epic entirely on that basis.
    const rows = registry.getUnsyncedEdits();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.epicId).toBe(EPIC);
    expect(rows[0]?.queueSize).toBe(3);
    expect(rows[0]?.isDirty).toBe(true);
    // Title falls through to the retained handle: a freshly re-pointed live
    // session has no Y.Doc title and no snapshot meta, so preferring it
    // unconditionally would label the row with a bare epic id.
    expect(rows[0]?.title).toBe("Rewrite the onboarding");
  });

  it("answers the per-epic predicate every close and move gate reads", () => {
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const previous = buildRetentionHandle(EPIC, true, 2);
    registry.acquireMounted(EPIC, () => previous.handle);
    const next = buildRetentionHandle(EPIC, false, 0);
    repoint(registry, previous.handle, next.handle, IDENTITY_A);

    // The projection and this predicate are the same walk. Before the
    // unification they were two traversals, and this one answered off the
    // live entry alone - so tab-close and the window-move discarded without
    // asking while the quit sheet was still protecting the same work.
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
    // ...and it is inert. A retained handle that kept its stream client would
    // report dial evidence for a host this window has left, into the input
    // host-death detection reads.
    expect(previous.closed()).toBe(true);
  });

  it("disposes a CLEAN outgoing handle instead of retaining it", () => {
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const previous = buildRetentionHandle(EPIC, false, 0);
    registry.acquireMounted(EPIC, () => previous.handle);
    const next = buildRetentionHandle(EPIC, false, 0);
    repoint(registry, previous.handle, next.handle, IDENTITY_A);

    // The control. Gating on `isClean()` instead of `isDirty` would retain
    // here too - `isClean()` requires an open transport, which a re-point has
    // by definition taken away - and nothing would ever retire it.
    expect(registry.getUnsyncedEdits()).toHaveLength(0);
    expect(registry.hasUnsyncedEdits(EPIC)).toBe(false);
  });

  it("merges a second retention for the same host AND identity", () => {
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const first = buildRetentionHandle(EPIC, true, 2);
    registry.acquireMounted(EPIC, () => first.handle);
    const second = buildRetentionHandle(EPIC, true, 5);
    repoint(registry, first.handle, second.handle, IDENTITY_A);
    const third = buildRetentionHandle(EPIC, false, 0);
    repoint(registry, second.handle, third.handle, IDENTITY_A);

    // One row, summed - not two retentions and not a replacement. Same epic,
    // same host, same proven identity means the same room, which is what
    // makes the merge legal with no `roomId` and therefore legal below `@1.2`.
    const rows = registry.getUnsyncedEdits();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.queueSize).toBe(7);
  });

  it("refuses to merge across an owner-identity rotation on the same host", () => {
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const first = buildRetentionHandle(EPIC, true, 2);
    registry.acquireMounted(EPIC, () => first.handle);
    const second = buildRetentionHandle(EPIC, true, 5);
    repoint(registry, first.handle, second.handle, IDENTITY_A);
    const third = buildRetentionHandle(EPIC, false, 0);
    // Same host, rotated identity. A rotation is only ever reachable on ONE
    // host, so the stamp alone cannot tell these apart - merging them would
    // produce a single buffer spanning two owner identities, which can be
    // honestly flushed to neither.
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

    // `null` is absence of proof, not a match - so it must not match another
    // `null` either. Two retentions whose identity reading had not landed yet
    // would otherwise collide on a shared "unknown" key and one document
    // would silently replace the other.
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
    // Draining through `get(epicId)` would reach only the live session and
    // leave this buffer behind, after a Discard the user believes was total.
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

    // `prune()` cannot reach retentions and must not, so tab close is one of
    // the few real reclamation paths. It is also the point where the user has
    // already answered the close confirmation - which now reads the retained
    // buffer too, so the answer covers it.
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

    // `disposeAll` is the auth lifecycle's hook and its contract is that no
    // prior identity's Y.Doc survives into the next session. It cleared
    // `entries` only, so a retention would have outlived a user switch
    // holding that user's unsynced edits.
    expect(registry.getUnsyncedEdits()).toHaveLength(0);
    expect(registry.retainedCountForTests(EPIC)).toBe(0);
  });
});

// ── `release` means three different things to its three callers ───────────────
// Reclaiming retentions inside `release` looked like the tab-close path alone,
// because that is the caller its doc-comment names. It is also reached by a
// DENIED desktop ownership claim and by the provider's rebuild arm - neither of
// which offered the user a decision. The rebuild arm is the pointed one: it
// fires on an owner-identity rotation, a rotation is only ever detected on ONE
// host, and the retained buffers can belong to others.

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

    // Host B rotates its owner identity. The provider's rebuild arm releases
    // the live session - it must not take host A's unsynced work with it.
    // Deleting it here would be strictly more destructive than the
    // cross-identity MERGE `findMergeTarget` refuses, and would happen with
    // no decision and no log.
    registry.release(EPIC, "keep", null);

    expect(registry.retainedCountForTests(EPIC)).toBe(1);
    const rows = registry.getUnsyncedEdits();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.queueSize).toBe(6);
  });

  it("retains the DIRTY LIVE handle when an owner-identity rotation releases it", () => {
    // Codex #1243 post-merge. `"keep"` spared only buffers ALREADY retained;
    // the live handle - the one actually holding the user's unsynced edits -
    // was disposed either way. An owner-identity rotation leaves `userId`
    // unchanged, so the provider takes this arm, and a same-host
    // re-enrollment therefore destroyed a dirty Y.Doc with no confirmation
    // and no retention.
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const live = buildRetentionHandle(EPIC, true, 4);
    registry.acquireMounted(EPIC, () => live.handle);
    expect(registry.getUnsyncedEdits()).toHaveLength(1);

    registry.release(EPIC, "keep", {
      hostStamp: "host-a",
      ownerIdentityKey: "key-before-rotation",
    });

    // The live session is gone, but its edits are not: they are now a
    // retained buffer, reachable through the same projection every close and
    // quit gate reads.
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
    // The control: retention is for unsynced edits, not for every release.
    // Retaining a clean handle would put an empty row in the quit sheet and
    // nothing would ever retire it.
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
    // `null` is the decision the user-change arm takes: another person is at
    // the keyboard and no prior identity's document may survive it. The
    // rotation arm above is the one that must not.
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
    // Codex #1243 T-57. When both snapshots name the same room,
    // `EpicSessionProvider` applies the outgoing doc into the replacement
    // under LOCAL_ORIGIN BEFORE calling this - so those edits are already
    // queued on the new handle and will sync through its transport.
    //
    // The outgoing handle is nonetheless still `isDirty`: its own store never
    // saw an acknowledgement, and never can, because `retainDirtyHandle`
    // detaches its transport. So the dirty test ALONE cannot tell "the only
    // copy of this work" from "a second copy of work the replacement now
    // owns", and retaining the second copy pins the epic as unsyncable
    // forever - the quit and update-install prompts keep naming work that
    // synced long ago, until the tab is closed.
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const outgoing = buildRetentionHandle(EPIC, true, 4);
    registry.acquireMounted(EPIC, () => outgoing.handle);
    const incoming = buildRetentionHandle(EPIC, false, 0);

    // Premise, positively: the handle being displaced really is dirty, so
    // this arm is exercising the transfer branch and not passing because
    // there was nothing to retain in the first place.
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
    // The control. The flag must be what decides, not the re-point: an
    // identical sequence with `false` is the room-swap / sub-`@1.2` case where
    // the outgoing handle IS the only copy, and destroying it there is the
    // data loss the retention was added for.
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
    // The regression: `resolveUnsyncedTitle` PREFERS the live `Y.Doc` title
    // over `metaTitle`, but the eligibility key used to watch `metaTitle`
    // alone. A title landing in the doc on a dirty session left the key
    // unchanged, so `handleEligibilityChange` short-circuited before
    // `emit()` - the React-subscribed quit sheet kept the stale (bare
    // epicId) title while an imperative `getUnsyncedEdits()` call already
    // saw the real one.
    const registry = new OpenEpicSessionRegistry({ maxLive: 5 });
    const EPIC = "epic-live-title-emit";
    const th = buildTestHandle(EPIC, false);
    th.handle.store.setState({ isDirty: true, unsyncedQueueSize: 1 });
    registry.acquireMounted(EPIC, () => h(th));

    let emitCount = 0;
    registry.subscribe(() => {
      emitCount += 1;
    });

    // Only the live doc title moves - `isDirty`, `unsyncedQueueSize`,
    // `isClean()` and `metaTitle` (there is no snapshot meta here at all)
    // are all unchanged. `notify()` mirrors what a real Y-doc title write
    // does to the store's subscription, per its own doc comment above.
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
    // The control: a `notify()` that changes nothing observable must stay
    // silent, or the fix above would just be "always emit" wearing a title
    // check - which defeats the whole per-keystroke gating this key exists
    // for.
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
