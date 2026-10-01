import type { WorkerPoolManager, WorkerStats } from "@pierre/diffs/worker";
import type { RuntimeTimer } from "@traycer-clients/shared/replica-runtime";
import {
  isDocumentVisible,
  subscribeDocumentVisibility,
} from "@/lib/dom/document-visibility";
import { createRendererRuntimeEnvironment } from "@/stores/epics/open-epic/runtime/runtime-environment";
import { getRetentionProfile } from "@/stores/replica-memory/retention-profile";

/**
 * The lazily-created `@pierre/diffs` worker pool, the demand that creates it,
 * and the idle window that takes it away again.
 *
 * WHY THIS EXISTS. `WorkerPoolManager`'s constructor spawns `poolSize` dedicated
 * workers and initializes a highlighter (Oniguruma WASM engine + both themes)
 * in every one of them, synchronously with construction. The provider used to
 * construct it at app-shell mount, so a fresh window carried six fully
 * initialized highlighter isolates before it had shown a single diff - the
 * 2026-09-03 staging launch snapshot found 6 of the renderer's 11 worker
 * threads sitting in the pool's `workers` array with nothing to render. A
 * worker isolate is not a JS object the main-thread heap snapshot can see, so
 * that cost never appeared in the profiles that drove the earlier fixes.
 *
 * The pool is now created the first time a diff surface asks for it, through
 * the highlight-ready gates in `use-diff-highlight-ready.ts`, which are the one
 * place every Diffs surface already passes through before it mounts a
 * `@pierre/diffs` component. Creation stays synchronous (the manager itself
 * queues its own worker initialization), so a surface that asked in an effect
 * sees the pool on its very next render.
 *
 * Module state rather than React state because the pool is a process-wide
 * singleton on the library side too (`getOrCreateWorkerPoolSingleton`), and
 * because the demand can arrive from any depth of the tree while the one
 * provider that knows how to build it sits at the app-shell root.
 *
 * LEASES, not a latch. The demand used to be a one-way `requested` flag, which
 * was enough while the pool's only exit was the provider unmounting - and on
 * the phone the provider never unmounts, so the first diff of a session bought
 * its isolates for the life of the app. Each gate now holds a LEASE for as long
 * as its surface is ON SCREEN, which makes "nobody is looking at a diff right
 * now" an observable fact and lets the retention profile put a clock on it
 * (`diffWorkerPoolIdleMs`).
 *
 * The clock takes the ISOLATES, never the manager. `WorkerPoolManager` is
 * re-initializable: `terminate()` kills its workers and settles their tasks,
 * and the next task anyone submits to it re-enters `initialize()` and spawns
 * a fresh set. A mounted `<FileDiff>` captures its manager once, in the ref
 * callback that creates its instance (`useFileDiffInstance`), and never
 * re-reads the context - so the one manager the provider built stays the
 * library singleton, and stays in context, until the provider unmounts. Every
 * body mounted against it, hidden or not, therefore keeps its DOM through a
 * release, and whatever respawn a hidden body later causes lands on a manager
 * this module can still see and terminate again.
 */

/**
 * Where a surface's request stands. The gates in `use-diff-highlight-ready.ts`
 * read this next to the pool they get from React context, and the two can
 * disagree for one render: the store holds the manager the moment it is
 * created, the context catches up when the provider re-renders. `"ready"` with
 * no pool in context therefore means "about to arrive - hold", and only
 * `"unavailable"` releases a surface to the main-thread renderer.
 */
export type DiffWorkerPoolAvailability =
  /** The pool exists. */
  | "ready"
  /** Nothing holds a lease yet, or one does and the pool is being created. */
  | "pending"
  /**
   * Leased, and no provider is mounted to build a pool - a tree outside the
   * desktop shell. Render on the main thread, as such trees always did.
   */
  | "unavailable";

/**
 * Building the pool, supplied by the provider, because only it can name the
 * worker factory Vite must see literally and the theme to seed the highlighter
 * with. Tearing the manager down is the provider's unmount alone; an idle
 * release terminates the manager's workers in place (see above).
 */
type PoolCreator = () => WorkerPoolManager;

interface DiffWorkerPoolStore {
  manager: WorkerPoolManager | undefined;
  creator: PoolCreator | null;
  /** On-screen diff surfaces holding the pool's isolates open. */
  leases: number;
  idleTimer: RuntimeTimer | null;
  unwatchVisibility: (() => void) | null;
  unwatchStats: (() => void) | null;
}

const store: DiffWorkerPoolStore = {
  manager: undefined,
  creator: null,
  leases: 0,
  idleTimer: null,
  unwatchVisibility: null,
  unwatchStats: null,
};

/**
 * How soon an idle release that found the manager still working tries again.
 * Short, because the work it waits on is a highlight already in flight.
 */
const BUSY_RETRY_MS = 1_000;

/**
 * Bumped whenever the store is reset wholesale - a provider unregistering, a
 * test reset. A lease stamped with a stale generation releases into nothing
 * rather than decrementing a count that has already been zeroed and re-earned
 * by the NEXT provider lifetime.
 */
let generation = 0;

/**
 * The clock and the scheduler through the runtime environment rather than
 * `window`, for the reason every other timer under the epic runtime does it,
 * and because the suite's fake timers patch that same `window`-bound pair.
 */
const environment = createRendererRuntimeEnvironment();

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of Array.from(listeners)) listener();
}

function createIfDue(): void {
  if (store.manager !== undefined) return;
  // `< 1`, not `=== 0`: a count driven below zero would read as demand here
  // and build a pool nothing asked for. The generation stamp on each lease
  // already prevents that; this is the arm that makes the failure inert
  // rather than inverted if one ever slips through.
  if (store.leases < 1 || store.creator === null) return;
  const manager = store.creator();
  store.manager = manager;
  watchVisibility();
  store.unwatchStats = manager.subscribeToStatChanges(rearmOnRespawn);
  notify();
}

/**
 * Called by the provider at mount with the recipe for the pool. Creation
 * happens here immediately if a surface already leased before the provider
 * registered (a surface below the provider can mount in the same commit).
 */
export function registerDiffWorkerPoolCreator(creator: PoolCreator): void {
  store.creator = creator;
  createIfDue();
  notify();
}

/**
 * Provider unmount. The manager is the provider's to terminate, not ours.
 *
 * The demand goes with it. Every surface that can lease a pool renders BELOW
 * this provider, so they have all unmounted too and none of their leases is
 * being discarded - whereas leases left standing would outlive them and make
 * the next `registerDiffWorkerPoolCreator` build a pool during its own mount.
 * The shell can be torn down and rebuilt within one session (a host outage or
 * sign-out unmounts it under `HostReadyGate`), and the second shell has to be
 * as lazy as the first: eager spawning that only starts on the second lifetime
 * is exactly the cost this module exists to remove, minus the symptom that
 * would make anyone look.
 */
export function unregisterDiffWorkerPoolCreator(creator: PoolCreator): void {
  if (store.creator !== creator) return;
  cancelIdleWindow();
  stopWatching();
  generation += 1;
  store.creator = null;
  store.manager = undefined;
  store.leases = 0;
  notify();
}

/**
 * A diff surface is on screen, and holds the pool's isolates open until the
 * returned release is called. The first lease with a registered creator
 * builds the pool; the last release starts the idle window.
 *
 * The release is idempotent and generation-stamped, so a React unmount that
 * tears the provider down BEFORE its children (deletions commit parent-first)
 * cannot drive the count negative.
 */
export function acquireDiffWorkerPool(): () => void {
  const leaseGeneration = generation;
  store.leases += 1;
  cancelIdleWindow();
  createIfDue();
  notify();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (leaseGeneration !== generation) return;
    store.leases -= 1;
    if (store.leases > 0) return;
    startIdleWindow();
  };
}

export function getDiffWorkerPool(): WorkerPoolManager | undefined {
  return store.manager;
}

export function getDiffWorkerPoolAvailability(): DiffWorkerPoolAvailability {
  if (store.manager !== undefined) return "ready";
  if (store.leases > 0 && store.creator === null) return "unavailable";
  return "pending";
}

export function subscribeDiffWorkerPool(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The last on-screen diff surface just went (unmounted, or hidden).
 *
 * A hidden shell skips the window entirely. The window is a grace period for a
 * user who is *navigating between diffs*, and a backgrounded app has no such
 * user - on iOS it has a process the system is actively looking to kill, where
 * every isolate still resident counts against it.
 */
function startIdleWindow(): void {
  if (store.manager === undefined) return;
  if (!isDocumentVisible()) {
    releaseIdleIsolates();
    return;
  }
  scheduleRelease(getRetentionProfile().diffWorkerPoolIdleMs);
}

function scheduleRelease(delayMs: number): void {
  cancelIdleWindow();
  store.idleTimer = environment.scheduler.schedule(delayMs, () => {
    store.idleTimer = null;
    releaseIdleIsolates();
  });
}

function cancelIdleWindow(): void {
  store.idleTimer?.cancel();
  store.idleTimer = null;
}

/**
 * Terminate the manager's workers while no diff is on screen. The manager
 * itself stays: it is still the library singleton and still in context, and
 * the next task submitted to it spawns a fresh set (see the module comment).
 *
 * ONLY AT ZERO LEASES, so no on-screen body ever renders against a pool that
 * is going away.
 *
 * ONLY WHILE THE MANAGER IS IDLE, which is a correctness bound rather than a
 * policy one. `terminate()` rejects every queued and in-flight task, and a
 * hidden body whose own highlight task was rejected is never told: its
 * renderer keeps the plain-text result it painted while waiting, and
 * `FileDiff.render()` returns early for an unchanged diff, so re-showing it
 * would not ask again. With no task in flight, every mounted body already
 * holds its highlighted result in its own renderer, and losing the workers
 * costs it nothing. A busy manager is retried shortly instead.
 */
function releaseIdleIsolates(): void {
  cancelIdleWindow();
  const { manager } = store;
  if (manager === undefined || store.leases > 0) return;
  const stats = manager.getStats();
  if (stats.totalWorkers === 0 && stats.managerState === "waiting") return;
  if (stats.activeTasks > 0 || stats.queuedTasks > 0) {
    scheduleRelease(BUSY_RETRY_MS);
    return;
  }
  manager.terminate();
}

/**
 * The manager spawned workers with no lease holding them - a hidden body
 * re-highlighting new content, or a theme change re-initializing the pool.
 * Nothing will release a lease to start the window for those, so their
 * arrival starts it.
 */
function rearmOnRespawn(stats: WorkerStats): void {
  if (store.leases > 0 || store.idleTimer !== null) return;
  if (stats.totalWorkers === 0) return;
  startIdleWindow();
}

/** Backgrounding the page is a release point for a pool no one is looking at. */
function watchVisibility(): void {
  if (store.unwatchVisibility !== null) return;
  store.unwatchVisibility = subscribeDocumentVisibility(() => {
    if (isDocumentVisible()) return;
    if (store.leases > 0) return;
    releaseIdleIsolates();
  });
}

function stopWatching(): void {
  store.unwatchVisibility?.();
  store.unwatchVisibility = null;
  store.unwatchStats?.();
  store.unwatchStats = null;
}

export function __resetDiffWorkerPoolForTests(): void {
  cancelIdleWindow();
  stopWatching();
  generation += 1;
  store.manager = undefined;
  store.creator = null;
  store.leases = 0;
  listeners.clear();
}
