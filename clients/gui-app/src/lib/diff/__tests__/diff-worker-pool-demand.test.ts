import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { WorkerPoolManager, WorkerStats } from "@pierre/diffs/worker";
import {
  __resetDiffWorkerPoolForTests,
  acquireDiffWorkerPool,
  getDiffWorkerPool,
  getDiffWorkerPoolAvailability,
  registerDiffWorkerPoolCreator,
  subscribeDiffWorkerPool,
  unregisterDiffWorkerPoolCreator,
} from "@/lib/diff/diff-worker-pool-demand";
import { __resetDocumentVisibilitySubscribersForTests } from "@/lib/dom/document-visibility";
import {
  DESKTOP_RETENTION_PROFILE,
  MOBILE_RETENTION_PROFILE,
  setRetentionProfile,
} from "@/stores/replica-memory/retention-profile";

const MOBILE_IDLE_MS = MOBILE_RETENTION_PROFILE.diffWorkerPoolIdleMs;
const DESKTOP_IDLE_MS = DESKTOP_RETENTION_PROFILE.diffWorkerPoolIdleMs;

interface FakeWorkerPoolManagerMembers {
  readonly debugId: string;
  readonly setRenderOptions: () => Promise<void>;
  readonly primeFileHighlightCache: () => Promise<void>;
  readonly primeDiffHighlightCache: () => Promise<void>;
  readonly getStats: () => WorkerStats;
  readonly subscribeToStatChanges: (
    callback: (stats: WorkerStats) => unknown,
  ) => () => void;
  readonly terminate: () => void;
}

/**
 * The manager as the store sees it, plus handles to drive it: its stats are
 * set by the test, `broadcast` delivers them the way the library's own
 * `requestAnimationFrame` broadcast would, and `terminate` behaves like the
 * real one does to the stats (no workers, back to `"waiting"`).
 */
interface FakeManager {
  readonly manager: WorkerPoolManager;
  readonly terminate: Mock<() => void>;
  readonly setStats: (patch: Partial<WorkerStats>) => void;
  readonly broadcast: () => void;
}

const LIVE_STATS: WorkerStats = {
  managerState: "initialized",
  workersFailed: false,
  totalWorkers: 1,
  busyWorkers: 0,
  queuedTasks: 0,
  activeTasks: 0,
  themeSubscribers: 0,
  fileCacheSize: 0,
  diffCacheSize: 0,
};

/**
 * A prototype-less object asserted to the class type, with the members the
 * store and the gates call assigned onto it (`as unknown as` is lint-forbidden
 * here, and a handful of members does not overlap the ~90-member class enough
 * for a direct `as`).
 */
function fakeManager(id: string): FakeManager {
  let stats: WorkerStats = { ...LIVE_STATS };
  const subscribers = new Set<(stats: WorkerStats) => unknown>();
  const broadcast = () => {
    for (const subscriber of Array.from(subscribers)) subscriber(stats);
  };
  const terminate = vi.fn<() => void>(() => {
    stats = { ...stats, managerState: "waiting", totalWorkers: 0 };
    broadcast();
  });
  const members: FakeWorkerPoolManagerMembers = {
    debugId: id,
    setRenderOptions: () => Promise.resolve(),
    primeFileHighlightCache: () => Promise.resolve(),
    primeDiffHighlightCache: () => Promise.resolve(),
    getStats: () => stats,
    subscribeToStatChanges: (callback) => {
      subscribers.add(callback);
      callback(stats);
      return () => {
        subscribers.delete(callback);
      };
    },
    terminate,
  };
  return {
    manager: Object.assign(Object.create(null) as WorkerPoolManager, members),
    terminate,
    setStats: (patch) => {
      stats = { ...stats, ...patch };
    },
    broadcast,
  };
}

/** A creator whose calls, and every manager it built, can be asserted on. */
interface SpyCreator {
  readonly creator: Mock<() => WorkerPoolManager>;
  readonly built: ReadonlyArray<FakeManager>;
  /** The one manager this creator built; throws if it built none or several. */
  readonly only: () => FakeManager;
}

function spyCreator(id: string): SpyCreator {
  const built: Array<FakeManager> = [];
  const creator = vi.fn<() => WorkerPoolManager>(() => {
    const fake = fakeManager(`${id}-${built.length}`);
    built.push(fake);
    return fake.manager;
  });
  return {
    creator,
    built,
    only: () => {
      if (built.length !== 1) {
        throw new Error(`expected exactly one manager, built ${built.length}`);
      }
      return built[0];
    },
  };
}

function fakeCreator(id: string): () => WorkerPoolManager {
  return () => fakeManager(id).manager;
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

  it("starts pending: no manager, no creator, no lease", () => {
    expect(getDiffWorkerPool()).toBeUndefined();
    expect(getDiffWorkerPoolAvailability()).toBe("pending");
  });

  it("creates the pool exactly once when leased, then registered", () => {
    const { creator } = spyCreator("a");
    acquireDiffWorkerPool();
    // No creator registered yet: a lease alone cannot create the pool.
    expect(getDiffWorkerPoolAvailability()).toBe("unavailable");
    expect(getDiffWorkerPool()).toBeUndefined();

    registerDiffWorkerPoolCreator(creator);

    expect(creator).toHaveBeenCalledTimes(1);
    expect(getDiffWorkerPoolAvailability()).toBe("ready");
    expect(getDiffWorkerPool()).toBe(creator.mock.results[0]?.value);
  });

  it("creates the pool exactly once when registered, then leased", () => {
    const { creator } = spyCreator("b");
    registerDiffWorkerPoolCreator(creator);
    expect(creator).not.toHaveBeenCalled();
    expect(getDiffWorkerPoolAvailability()).toBe("pending");

    acquireDiffWorkerPool();

    expect(creator).toHaveBeenCalledTimes(1);
    expect(getDiffWorkerPoolAvailability()).toBe("ready");
    expect(getDiffWorkerPool()).toBe(creator.mock.results[0]?.value);
  });

  it("never creates a second pool for an extra lease or a re-registration", () => {
    const { creator } = spyCreator("c");
    registerDiffWorkerPoolCreator(creator);
    acquireDiffWorkerPool();
    expect(creator).toHaveBeenCalledTimes(1);

    acquireDiffWorkerPool();
    registerDiffWorkerPoolCreator(creator);

    expect(creator).toHaveBeenCalledTimes(1);
  });

  it("reports 'unavailable' while leased with no creator registered", () => {
    expect(getDiffWorkerPoolAvailability()).toBe("pending");
    acquireDiffWorkerPool();
    expect(getDiffWorkerPoolAvailability()).toBe("unavailable");
    expect(getDiffWorkerPool()).toBeUndefined();
  });

  it("notifies subscribers on register, lease, and unregister", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDiffWorkerPool(listener);
    const creator = fakeCreator("f");

    registerDiffWorkerPoolCreator(creator);
    expect(listener).toHaveBeenCalledTimes(1);

    acquireDiffWorkerPool();
    // The lease both creates the pool (one notify from createIfDue) and
    // notifies again for the lease itself.
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(2);

    listener.mockClear();
    unregisterDiffWorkerPoolCreator(creator);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it("stops notifying a listener once it has unsubscribed", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDiffWorkerPool(listener);
    unsubscribe();

    registerDiffWorkerPoolCreator(fakeCreator("g"));
    acquireDiffWorkerPool();

    expect(listener).not.toHaveBeenCalled();
  });

  it("treats unregistering a different creator than the one registered as a no-op", () => {
    const registered = fakeCreator("h");
    registerDiffWorkerPoolCreator(registered);
    acquireDiffWorkerPool();
    const manager = getDiffWorkerPool();
    expect(manager).toBeDefined();

    unregisterDiffWorkerPoolCreator(fakeCreator("not-registered"));

    expect(getDiffWorkerPool()).toBe(manager);
    expect(getDiffWorkerPoolAvailability()).toBe("ready");
  });

  it("does not eagerly rebuild a pool for a second app-shell lifetime's registration after unregister", () => {
    // A host outage or sign-out unmounts the provider and remounts it under
    // `HostReadyGate` within one session. The second lifetime must be exactly
    // as lazy as the first - every surface that held a lease rendered below
    // the provider and went with it, so registering alone must not build.
    const first = spyCreator("k1");
    registerDiffWorkerPoolCreator(first.creator);
    acquireDiffWorkerPool();
    expect(first.creator).toHaveBeenCalledTimes(1);

    unregisterDiffWorkerPoolCreator(first.creator);
    expect(getDiffWorkerPool()).toBeUndefined();

    const second = spyCreator("k2");
    registerDiffWorkerPoolCreator(second.creator);

    expect(second.creator).not.toHaveBeenCalled();
    expect(getDiffWorkerPoolAvailability()).toBe("pending");

    acquireDiffWorkerPool();

    expect(second.creator).toHaveBeenCalledTimes(1);
    expect(getDiffWorkerPoolAvailability()).toBe("ready");
  });

  it("a lease released after its provider unregistered does not drive the count negative", () => {
    // React commits deletions parent-first, so the provider's cleanup can run
    // BEFORE the gates below it release. A stale release must be inert, or the
    // next lifetime starts at -1 and never reaches the lease that builds a
    // pool.
    const first = fakeCreator("neg-1");
    registerDiffWorkerPoolCreator(first);
    const release = acquireDiffWorkerPool();

    unregisterDiffWorkerPoolCreator(first);
    release();
    release();

    const second = spyCreator("neg-2");
    registerDiffWorkerPoolCreator(second.creator);
    expect(second.creator).not.toHaveBeenCalled();

    acquireDiffWorkerPool();

    expect(second.creator).toHaveBeenCalledTimes(1);
    expect(getDiffWorkerPoolAvailability()).toBe("ready");
  });

  describe("idle window", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it("terminates the workers once the mobile window elapses, and keeps the manager", () => {
      setRetentionProfile(MOBILE_RETENTION_PROFILE);
      const spy = spyCreator("idle");
      registerDiffWorkerPoolCreator(spy.creator);
      const release = acquireDiffWorkerPool();
      const manager = getDiffWorkerPool();

      release();
      // Still held through the grace period itself - the window exists so that
      // navigating between two diffs does not rebuild a WASM engine.
      vi.advanceTimersByTime(MOBILE_IDLE_MS - 1);
      expect(spy.only().terminate).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);

      expect(spy.only().terminate).toHaveBeenCalledTimes(1);
      // The manager is what every mounted body captured. It stays the pool in
      // context, so nothing mounted against it has to go.
      expect(getDiffWorkerPool()).toBe(manager);
      expect(getDiffWorkerPoolAvailability()).toBe("ready");
    });

    it("gives desktop the same release on a five-minute window", () => {
      const spy = spyCreator("desktop");
      registerDiffWorkerPoolCreator(spy.creator);
      const release = acquireDiffWorkerPool();

      release();
      vi.advanceTimersByTime(MOBILE_IDLE_MS);
      // Desktop is not on the phone's clock.
      expect(spy.only().terminate).not.toHaveBeenCalled();

      vi.advanceTimersByTime(DESKTOP_IDLE_MS - MOBILE_IDLE_MS - 1);
      expect(spy.only().terminate).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);

      expect(spy.only().terminate).toHaveBeenCalledTimes(1);
      expect(getDiffWorkerPool()).toBe(spy.only().manager);
    });

    it("keeps the workers when another surface comes on screen inside the window", () => {
      setRetentionProfile(MOBILE_RETENTION_PROFILE);
      const spy = spyCreator("handoff");
      registerDiffWorkerPoolCreator(spy.creator);
      const first = acquireDiffWorkerPool();

      first();
      vi.advanceTimersByTime(MOBILE_IDLE_MS / 2);
      const second = acquireDiffWorkerPool();
      vi.advanceTimersByTime(MOBILE_IDLE_MS * 2);

      expect(spy.only().terminate).not.toHaveBeenCalled();
      second();
    });

    it("never terminates while a surface is on screen", () => {
      setRetentionProfile(MOBILE_RETENTION_PROFILE);
      const spy = spyCreator("mounted");
      registerDiffWorkerPoolCreator(spy.creator);
      const first = acquireDiffWorkerPool();
      const second = acquireDiffWorkerPool();

      first();
      vi.advanceTimersByTime(60 * 60_000);

      expect(spy.only().terminate).not.toHaveBeenCalled();
      second();
    });

    it("reuses the same manager for the next lease after a release", () => {
      setRetentionProfile(MOBILE_RETENTION_PROFILE);
      const spy = spyCreator("reuse");
      registerDiffWorkerPoolCreator(spy.creator);
      acquireDiffWorkerPool()();
      vi.advanceTimersByTime(MOBILE_IDLE_MS);
      expect(spy.only().terminate).toHaveBeenCalledTimes(1);

      // The manager re-initializes itself on its next task; a second manager
      // would leave every body mounted against the first one talking to a pool
      // the library singleton no longer knows.
      acquireDiffWorkerPool();

      expect(spy.creator).toHaveBeenCalledTimes(1);
      expect(getDiffWorkerPool()).toBe(spy.only().manager);
    });

    it("waits for in-flight work to drain before terminating", () => {
      setRetentionProfile(MOBILE_RETENTION_PROFILE);
      const spy = spyCreator("busy");
      registerDiffWorkerPoolCreator(spy.creator);
      const release = acquireDiffWorkerPool();
      // A hidden body's own highlight task is still running when the window
      // closes. Terminating would reject it, and that body would keep its
      // plain-text paint on return with nothing left to ask again.
      spy.only().setStats({ activeTasks: 1 });

      release();
      vi.advanceTimersByTime(MOBILE_IDLE_MS);
      expect(spy.only().terminate).not.toHaveBeenCalled();

      vi.advanceTimersByTime(5_000);
      expect(spy.only().terminate).not.toHaveBeenCalled();

      spy.only().setStats({ activeTasks: 0, queuedTasks: 1 });
      vi.advanceTimersByTime(5_000);
      expect(spy.only().terminate).not.toHaveBeenCalled();

      spy.only().setStats({ queuedTasks: 0 });
      vi.advanceTimersByTime(5_000);
      expect(spy.only().terminate).toHaveBeenCalledTimes(1);
    });

    it("stops waiting on a busy manager once a surface comes back on screen", () => {
      setRetentionProfile(MOBILE_RETENTION_PROFILE);
      const spy = spyCreator("busy-return");
      registerDiffWorkerPoolCreator(spy.creator);
      const release = acquireDiffWorkerPool();
      spy.only().setStats({ activeTasks: 1 });
      release();
      vi.advanceTimersByTime(MOBILE_IDLE_MS);

      const next = acquireDiffWorkerPool();
      spy.only().setStats({ activeTasks: 0 });
      vi.advanceTimersByTime(60 * 60_000);

      expect(spy.only().terminate).not.toHaveBeenCalled();
      next();
    });

    it("re-arms the window when the manager respawns workers with no lease", () => {
      setRetentionProfile(MOBILE_RETENTION_PROFILE);
      const spy = spyCreator("respawn");
      registerDiffWorkerPoolCreator(spy.creator);
      acquireDiffWorkerPool()();
      vi.advanceTimersByTime(MOBILE_IDLE_MS);
      expect(spy.only().terminate).toHaveBeenCalledTimes(1);

      // A hidden body re-highlighting new content, or a theme change, submits
      // a task to the dormant manager and it spawns a fresh worker. No lease
      // is released to start the window for that one.
      spy.only().setStats({ managerState: "initialized", totalWorkers: 1 });
      spy.only().broadcast();
      vi.advanceTimersByTime(MOBILE_IDLE_MS - 1);
      expect(spy.only().terminate).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1);

      expect(spy.only().terminate).toHaveBeenCalledTimes(2);
    });

    it("does not arm the window from a stats change while a lease holds the pool", () => {
      setRetentionProfile(MOBILE_RETENTION_PROFILE);
      const spy = spyCreator("leased-stats");
      registerDiffWorkerPoolCreator(spy.creator);
      const release = acquireDiffWorkerPool();

      spy.only().broadcast();
      vi.advanceTimersByTime(60 * 60_000);

      expect(spy.only().terminate).not.toHaveBeenCalled();
      release();
    });

    it("terminates immediately when the app is backgrounded mid-window", () => {
      setRetentionProfile(MOBILE_RETENTION_PROFILE);
      const spy = spyCreator("hidden");
      registerDiffWorkerPoolCreator(spy.creator);
      const release = acquireDiffWorkerPool();

      release();
      setDocumentHidden(true);

      // No timer advanced: the grace period is for a user navigating between
      // diffs, and a backgrounded iOS app has none.
      expect(spy.only().terminate).toHaveBeenCalledTimes(1);
      expect(getDiffWorkerPool()).toBe(spy.only().manager);
    });

    it("skips the window when the last lease goes while hidden", () => {
      setRetentionProfile(MOBILE_RETENTION_PROFILE);
      const spy = spyCreator("hidden-release");
      registerDiffWorkerPoolCreator(spy.creator);
      const release = acquireDiffWorkerPool();

      setDocumentHidden(true);
      // Held while a surface is still on screen in the page that went hidden.
      expect(spy.only().terminate).not.toHaveBeenCalled();

      release();

      expect(spy.only().terminate).toHaveBeenCalledTimes(1);
    });

    it("does not terminate again a manager that is already dormant", () => {
      setRetentionProfile(MOBILE_RETENTION_PROFILE);
      const spy = spyCreator("dormant");
      registerDiffWorkerPoolCreator(spy.creator);
      acquireDiffWorkerPool()();
      vi.advanceTimersByTime(MOBILE_IDLE_MS);
      expect(spy.only().terminate).toHaveBeenCalledTimes(1);

      // Shown and hidden again without the manager ever being asked for work.
      acquireDiffWorkerPool()();
      vi.advanceTimersByTime(MOBILE_IDLE_MS);
      setDocumentHidden(true);

      expect(spy.only().terminate).toHaveBeenCalledTimes(1);
    });

    it("stops watching the manager once the provider unregisters", () => {
      setRetentionProfile(MOBILE_RETENTION_PROFILE);
      const spy = spyCreator("unregistered");
      registerDiffWorkerPoolCreator(spy.creator);
      acquireDiffWorkerPool();

      unregisterDiffWorkerPoolCreator(spy.creator);
      // The provider has terminated the singleton itself; a broadcast from
      // the corpse must not start a window over a store that no longer has it.
      spy.only().broadcast();
      setDocumentHidden(true);
      vi.advanceTimersByTime(60 * 60_000);

      expect(spy.only().terminate).not.toHaveBeenCalled();
    });
  });
});
