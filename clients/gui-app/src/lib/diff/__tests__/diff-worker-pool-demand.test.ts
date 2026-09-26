import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { WorkerPoolManager } from "@pierre/diffs/worker";
import {
  __resetDiffWorkerPoolForTests,
  acquireDiffWorkerPool,
  getDiffWorkerPool,
  getDiffWorkerPoolAvailability,
  registerDiffWorkerPoolLifecycle,
  subscribeDiffWorkerPool,
  unregisterDiffWorkerPoolLifecycle,
  type DiffWorkerPoolLifecycle,
} from "@/lib/diff/diff-worker-pool-demand";
import { __resetDocumentVisibilitySubscribersForTests } from "@/lib/dom/document-visibility";
import {
  DESKTOP_RETENTION_PROFILE,
  MOBILE_RETENTION_PROFILE,
  setRetentionProfile,
} from "@/stores/replica-memory/retention-profile";

interface FakeWorkerPoolManager {
  readonly setRenderOptions: () => Promise<void>;
  readonly primeFileHighlightCache: () => Promise<void>;
  readonly primeDiffHighlightCache: () => Promise<void>;
}

/**
 * A prototype-less object asserted to the class type, with the three members
 * a consumer could call assigned onto it (`as unknown as` is lint-forbidden
 * here, and a three-member literal does not overlap the ~90-member class
 * enough for a direct `as`). Each fake is its own object identity, which is
 * all these tests read - none of the three methods is ever called.
 */
function fakeManager(id: string): WorkerPoolManager {
  const fake: FakeWorkerPoolManager & { readonly debugId: string } = {
    debugId: id,
    setRenderOptions: () => Promise.resolve(),
    primeFileHighlightCache: () => Promise.resolve(),
    primeDiffHighlightCache: () => Promise.resolve(),
  };
  return Object.assign(Object.create(null) as WorkerPoolManager, fake);
}

function fakeLifecycle(id: string): DiffWorkerPoolLifecycle {
  return { create: () => fakeManager(id), terminate: () => {} };
}

/** A lifecycle whose `create`/`terminate` can both be asserted on. */
interface SpyLifecycle {
  readonly lifecycle: DiffWorkerPoolLifecycle;
  readonly create: Mock<() => WorkerPoolManager>;
  readonly terminate: Mock<() => void>;
}

function spyLifecycle(id: string): SpyLifecycle {
  const create = vi.fn<() => WorkerPoolManager>(() => fakeManager(id));
  const terminate = vi.fn<() => void>(() => {});
  return { lifecycle: { create, terminate }, create, terminate };
}

/**
 * The Page Visibility API is read-only, so the hidden edge is produced the way
 * a browser produces it: redefine `visibilityState`, then dispatch the event
 * the module-level listener in `lib/dom/document-visibility.ts` is bound to.
 */
function setDocumentHidden(hidden: boolean): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("diff-worker-pool-demand", () => {
  beforeEach(() => {
    __resetDiffWorkerPoolForTests();
  });

  afterEach(() => {
    __resetDiffWorkerPoolForTests();
    __resetDocumentVisibilitySubscribersForTests();
    setDocumentHidden(false);
    setRetentionProfile(DESKTOP_RETENTION_PROFILE);
    vi.useRealTimers();
  });

  it("starts pending: no manager, no lifecycle, no lease", () => {
    expect(getDiffWorkerPool()).toBeUndefined();
    expect(getDiffWorkerPoolAvailability()).toBe("pending");
  });

  it("creates the pool exactly once when leased, then registered", () => {
    const { lifecycle, create } = spyLifecycle("a");
    acquireDiffWorkerPool();
    // No lifecycle registered yet: a lease alone cannot create the pool.
    expect(getDiffWorkerPoolAvailability()).toBe("unavailable");
    expect(getDiffWorkerPool()).toBeUndefined();

    registerDiffWorkerPoolLifecycle(lifecycle);

    expect(create).toHaveBeenCalledTimes(1);
    expect(getDiffWorkerPoolAvailability()).toBe("ready");
    expect(getDiffWorkerPool()).toBe(create.mock.results[0]?.value);
  });

  it("creates the pool exactly once when registered, then leased", () => {
    const { lifecycle, create } = spyLifecycle("b");
    registerDiffWorkerPoolLifecycle(lifecycle);
    expect(create).not.toHaveBeenCalled();
    expect(getDiffWorkerPoolAvailability()).toBe("pending");

    acquireDiffWorkerPool();

    expect(create).toHaveBeenCalledTimes(1);
    expect(getDiffWorkerPoolAvailability()).toBe("ready");
    expect(getDiffWorkerPool()).toBe(create.mock.results[0]?.value);
  });

  it("never creates a second pool for an extra lease or a re-registration", () => {
    const { lifecycle, create } = spyLifecycle("c");
    registerDiffWorkerPoolLifecycle(lifecycle);
    acquireDiffWorkerPool();
    expect(create).toHaveBeenCalledTimes(1);

    acquireDiffWorkerPool();
    registerDiffWorkerPoolLifecycle(lifecycle);

    expect(create).toHaveBeenCalledTimes(1);
  });

  it("reports 'unavailable' while leased with no lifecycle registered", () => {
    expect(getDiffWorkerPoolAvailability()).toBe("pending");
    acquireDiffWorkerPool();
    expect(getDiffWorkerPoolAvailability()).toBe("unavailable");
    expect(getDiffWorkerPool()).toBeUndefined();
  });

  it("moves from 'unavailable' to 'ready' once a lifecycle registers after the lease", () => {
    acquireDiffWorkerPool();
    expect(getDiffWorkerPoolAvailability()).toBe("unavailable");

    registerDiffWorkerPoolLifecycle(fakeLifecycle("d"));

    expect(getDiffWorkerPoolAvailability()).toBe("ready");
    expect(getDiffWorkerPool()).toBeDefined();
  });

  it("moves from 'pending' to 'ready' once the pool is created", () => {
    registerDiffWorkerPoolLifecycle(fakeLifecycle("e"));
    expect(getDiffWorkerPoolAvailability()).toBe("pending");

    acquireDiffWorkerPool();

    expect(getDiffWorkerPoolAvailability()).toBe("ready");
  });

  it("notifies subscribers on register, lease, and unregister", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDiffWorkerPool(listener);
    const lifecycle = fakeLifecycle("f");

    registerDiffWorkerPoolLifecycle(lifecycle);
    expect(listener).toHaveBeenCalledTimes(1);

    acquireDiffWorkerPool();
    // The lease both creates the pool (one notify from createIfDue) and
    // notifies again for the lease itself.
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(2);

    listener.mockClear();
    unregisterDiffWorkerPoolLifecycle(lifecycle);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it("stops notifying a listener once it has unsubscribed", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDiffWorkerPool(listener);
    unsubscribe();

    registerDiffWorkerPoolLifecycle(fakeLifecycle("g"));
    acquireDiffWorkerPool();

    expect(listener).not.toHaveBeenCalled();
  });

  it("treats unregistering a different lifecycle than the one registered as a no-op", () => {
    const registered = fakeLifecycle("h");
    const other = fakeLifecycle("not-registered");
    registerDiffWorkerPoolLifecycle(registered);
    acquireDiffWorkerPool();
    const manager = getDiffWorkerPool();
    expect(manager).toBeDefined();

    unregisterDiffWorkerPoolLifecycle(other);

    // The real lifecycle (and the manager it built) survive an unregister call
    // naming a different one.
    expect(getDiffWorkerPool()).toBe(manager);
    expect(getDiffWorkerPoolAvailability()).toBe("ready");
  });

  it("clears the manager, lifecycle, AND the leases when the registered lifecycle unregisters", () => {
    const lifecycle = fakeLifecycle("i");
    registerDiffWorkerPoolLifecycle(lifecycle);
    acquireDiffWorkerPool();
    expect(getDiffWorkerPool()).toBeDefined();

    unregisterDiffWorkerPoolLifecycle(lifecycle);

    expect(getDiffWorkerPool()).toBeUndefined();
    // The leases are cleared too, not just the lifecycle/manager: every
    // surface that could hold one renders below the provider, so it has
    // unmounted along with it, and a lease left standing would make the NEXT
    // registration build a pool eagerly during its own mount.
    expect(getDiffWorkerPoolAvailability()).toBe("pending");
  });

  it("does not eagerly rebuild a pool for a second app-shell lifetime's registration after unregister", () => {
    // The regression this pins: a host outage or sign-out unmounts the
    // provider and remounts it under `HostReadyGate` within one session. The
    // second lifetime must be exactly as lazy as the first - nothing has
    // leased a pool YET in this lifetime, so registering its lifecycle alone
    // must not build one.
    const first = spyLifecycle("k1");
    registerDiffWorkerPoolLifecycle(first.lifecycle);
    acquireDiffWorkerPool();
    expect(first.create).toHaveBeenCalledTimes(1);
    expect(getDiffWorkerPool()).toBeDefined();

    unregisterDiffWorkerPoolLifecycle(first.lifecycle);

    // Second lifetime: the provider re-registers with a fresh lifecycle.
    const second = spyLifecycle("k2");
    registerDiffWorkerPoolLifecycle(second.lifecycle);

    expect(second.create).not.toHaveBeenCalled();
    expect(getDiffWorkerPool()).toBeUndefined();
    expect(getDiffWorkerPoolAvailability()).toBe("pending");

    // Only a fresh lease, taken in THIS lifetime, re-creates the pool.
    acquireDiffWorkerPool();

    expect(second.create).toHaveBeenCalledTimes(1);
    expect(getDiffWorkerPool()).toBe(second.create.mock.results[0]?.value);
    expect(getDiffWorkerPoolAvailability()).toBe("ready");
  });

  it("getDiffWorkerPool() reflects exactly the manager the lifecycle produced", () => {
    const manager = fakeManager("j");
    registerDiffWorkerPoolLifecycle({
      create: () => manager,
      terminate: () => {},
    });
    acquireDiffWorkerPool();

    expect(getDiffWorkerPool()).toBe(manager);
  });

  it("a lease released after its provider unregistered does not drive the count negative", () => {
    // React commits deletions parent-first, so the provider's cleanup can run
    // BEFORE the gates below it release. A stale release must be inert, or the
    // next lifetime starts at -1 and never reaches the lease that builds a
    // pool.
    const first = fakeLifecycle("neg-1");
    registerDiffWorkerPoolLifecycle(first);
    const release = acquireDiffWorkerPool();

    unregisterDiffWorkerPoolLifecycle(first);
    release();
    release();

    const second = spyLifecycle("neg-2");
    registerDiffWorkerPoolLifecycle(second.lifecycle);
    // A count sitting at -1 reads as demand to `createIfDue`, so the second
    // lifetime would spawn its isolates during its own mount - the exact
    // eagerness this module exists to remove.
    expect(second.create).not.toHaveBeenCalled();

    acquireDiffWorkerPool();

    expect(second.create).toHaveBeenCalledTimes(1);
    expect(getDiffWorkerPoolAvailability()).toBe("ready");
  });

  describe("idle window", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it("keeps the pool forever under the desktop profile, which has no window", () => {
      const { lifecycle, terminate } = spyLifecycle("desktop");
      registerDiffWorkerPoolLifecycle(lifecycle);
      const release = acquireDiffWorkerPool();
      const manager = getDiffWorkerPool();

      release();
      vi.advanceTimersByTime(60 * 60_000);

      expect(terminate).not.toHaveBeenCalled();
      expect(getDiffWorkerPool()).toBe(manager);
    });

    it("terminates the pool once the mobile window elapses with no consumer", () => {
      setRetentionProfile(MOBILE_RETENTION_PROFILE);
      const idleMs = MOBILE_RETENTION_PROFILE.diffWorkerPoolIdleMs;
      if (idleMs === null) throw new Error("mobile profile has no idle window");
      const { lifecycle, terminate } = spyLifecycle("idle");
      registerDiffWorkerPoolLifecycle(lifecycle);
      const release = acquireDiffWorkerPool();
      expect(getDiffWorkerPool()).toBeDefined();

      release();
      // Still held through the grace period itself - the window exists so that
      // navigating between two diffs does not rebuild a WASM engine.
      vi.advanceTimersByTime(idleMs - 1);
      expect(terminate).not.toHaveBeenCalled();
      expect(getDiffWorkerPool()).toBeDefined();

      vi.advanceTimersByTime(1);

      expect(terminate).toHaveBeenCalledTimes(1);
      expect(getDiffWorkerPool()).toBeUndefined();
      expect(getDiffWorkerPoolAvailability()).toBe("pending");
    });

    it("keeps the pool when another consumer mounts inside the window", () => {
      setRetentionProfile(MOBILE_RETENTION_PROFILE);
      const idleMs = MOBILE_RETENTION_PROFILE.diffWorkerPoolIdleMs ?? 0;
      const { lifecycle, terminate } = spyLifecycle("handoff");
      registerDiffWorkerPoolLifecycle(lifecycle);
      const first = acquireDiffWorkerPool();
      const manager = getDiffWorkerPool();

      first();
      vi.advanceTimersByTime(idleMs / 2);
      const second = acquireDiffWorkerPool();
      vi.advanceTimersByTime(idleMs * 2);

      expect(terminate).not.toHaveBeenCalled();
      expect(getDiffWorkerPool()).toBe(manager);
      second();
    });

    it("never terminates while a consumer is still mounted", () => {
      setRetentionProfile(MOBILE_RETENTION_PROFILE);
      const { lifecycle, terminate } = spyLifecycle("mounted");
      registerDiffWorkerPoolLifecycle(lifecycle);
      const first = acquireDiffWorkerPool();
      const second = acquireDiffWorkerPool();

      first();
      vi.advanceTimersByTime(60 * 60_000);

      expect(terminate).not.toHaveBeenCalled();
      expect(getDiffWorkerPool()).toBeDefined();
      second();
    });

    it("terminates immediately when the app is backgrounded mid-window", () => {
      setRetentionProfile(MOBILE_RETENTION_PROFILE);
      const { lifecycle, terminate } = spyLifecycle("hidden");
      registerDiffWorkerPoolLifecycle(lifecycle);
      const release = acquireDiffWorkerPool();

      release();
      setDocumentHidden(true);

      // No timer advanced: the grace period is for a user navigating between
      // diffs, and a backgrounded iOS app has none.
      expect(terminate).toHaveBeenCalledTimes(1);
      expect(getDiffWorkerPool()).toBeUndefined();
    });

    it("skips the window entirely when the last consumer unmounts while hidden", () => {
      setRetentionProfile(MOBILE_RETENTION_PROFILE);
      const { lifecycle, terminate } = spyLifecycle("hidden-unmount");
      registerDiffWorkerPoolLifecycle(lifecycle);
      const release = acquireDiffWorkerPool();

      setDocumentHidden(true);
      // Held while the surface is still mounted: a mounted `<FileDiff>` keeps
      // the manager it captured and would respawn its workers on the next
      // render, behind a library singleton that has already forgotten it.
      expect(terminate).not.toHaveBeenCalled();

      release();

      expect(terminate).toHaveBeenCalledTimes(1);
      expect(getDiffWorkerPool()).toBeUndefined();
    });

    it("does not terminate on a hidden edge under the desktop profile", () => {
      const { lifecycle, terminate } = spyLifecycle("desktop-hidden");
      registerDiffWorkerPoolLifecycle(lifecycle);
      const release = acquireDiffWorkerPool();
      const manager = getDiffWorkerPool();

      release();
      setDocumentHidden(true);

      expect(terminate).not.toHaveBeenCalled();
      expect(getDiffWorkerPool()).toBe(manager);
    });

    it("rebuilds the pool on the next demand after an idle termination", () => {
      setRetentionProfile(MOBILE_RETENTION_PROFILE);
      const idleMs = MOBILE_RETENTION_PROFILE.diffWorkerPoolIdleMs ?? 0;
      const { lifecycle, create, terminate } = spyLifecycle("rebuild");
      registerDiffWorkerPoolLifecycle(lifecycle);
      const release = acquireDiffWorkerPool();
      const first = getDiffWorkerPool();

      release();
      vi.advanceTimersByTime(idleMs);
      expect(terminate).toHaveBeenCalledTimes(1);
      expect(getDiffWorkerPool()).toBeUndefined();

      // The provider is still mounted - only the pool went away - so the next
      // surface's lease is all it takes.
      acquireDiffWorkerPool();

      expect(create).toHaveBeenCalledTimes(2);
      expect(getDiffWorkerPool()).toBeDefined();
      expect(getDiffWorkerPool()).not.toBe(first);
      expect(getDiffWorkerPoolAvailability()).toBe("ready");
    });

    it("rebuilds the pool on the next demand after a backgrounded termination", () => {
      setRetentionProfile(MOBILE_RETENTION_PROFILE);
      const { lifecycle, create } = spyLifecycle("rebuild-hidden");
      registerDiffWorkerPoolLifecycle(lifecycle);
      acquireDiffWorkerPool()();
      setDocumentHidden(true);
      expect(getDiffWorkerPool()).toBeUndefined();

      setDocumentHidden(false);
      acquireDiffWorkerPool();

      expect(create).toHaveBeenCalledTimes(2);
      expect(getDiffWorkerPool()).toBeDefined();
    });

    it("settles the in-flight prime promises the terminated manager was holding", async () => {
      // `WorkerPoolManager.terminate()` rejects every queued and in-flight
      // task rather than leaving them pending, which is what keeps a gate
      // whose surface unmounted mid-prime from awaiting a promise no worker
      // will ever answer. Modelled here, because the real manager is not in
      // this unit's reach.
      setRetentionProfile(MOBILE_RETENTION_PROFILE);
      const idleMs = MOBILE_RETENTION_PROFILE.diffWorkerPoolIdleMs ?? 0;
      let rejectPrime: ((error: Error) => void) | null = null;
      const inFlight = new Promise<void>((_resolve, reject) => {
        rejectPrime = reject;
      });
      const lifecycle: DiffWorkerPoolLifecycle = {
        create: () => fakeManager("in-flight"),
        terminate: () => rejectPrime?.(new Error("WorkerPoolTerminatedError")),
      };
      registerDiffWorkerPoolLifecycle(lifecycle);
      const release = acquireDiffWorkerPool();

      let settled = false;
      const observed = inFlight.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      release();
      vi.advanceTimersByTime(idleMs);
      await observed;

      expect(settled).toBe(true);
      expect(getDiffWorkerPool()).toBeUndefined();
    });
  });
});
