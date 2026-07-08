import { describe, expect, it } from "vitest";
import { AGENT_WORKING_AWARENESS_FIELD } from "@traycer/protocol/host/epic/subscribe";
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
    isClean: () => isCleanOverride,
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
    registry.release("e0");
    expect(th.disposed).toBe(true);
    expect(registry.get("e0")).toBeNull();
  });
});

function markAgentWorking(handle: TestHandle, agentId: string): void {
  handle.handle.awareness.setLocalState({
    [AGENT_WORKING_AWARENESS_FIELD]: [agentId],
  });
}

function clearAgentWorking(handle: TestHandle): void {
  handle.handle.awareness.setLocalState({
    [AGENT_WORKING_AWARENESS_FIELD]: [],
  });
}
