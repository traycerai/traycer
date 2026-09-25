import type { WorkerPoolManager } from "@pierre/diffs/worker";
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
 * as its surface is mounted, which makes "nobody is rendering a diff right now"
 * an observable fact and lets the mobile profile put a clock on it
 * (`diffWorkerPoolIdleMs`).
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
 * Building the pool and tearing it down, both supplied by the provider.
 *
 * `create` is the provider's because only it can name the worker factory Vite
 * must see literally and the theme to seed the highlighter with. `terminate`
 * is the provider's for a narrower reason: the manager is the library's
 * singleton (`getOrCreateWorkerPoolSingleton`), so dropping OUR reference to it
 * is not enough - the library has to forget it too, or the next `create` hands
 * back the corpse.
 */
export interface DiffWorkerPoolLifecycle {
  readonly create: () => WorkerPoolManager;
  readonly terminate: () => void;
}

interface DiffWorkerPoolStore {
  manager: WorkerPoolManager | undefined;
  lifecycle: DiffWorkerPoolLifecycle | null;
  /** Mounted diff surfaces holding the pool open. */
  leases: number;
  idleTimer: RuntimeTimer | null;
  unwatchVisibility: (() => void) | null;
}

const store: DiffWorkerPoolStore = {
  manager: undefined,
  lifecycle: null,
  leases: 0,
  idleTimer: null,
  unwatchVisibility: null,
};

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
  if (store.leases < 1 || store.lifecycle === null) return;
  store.manager = store.lifecycle.create();
  watchVisibilityWhileIdleWindowApplies();
  notify();
}

/**
 * Called by the provider at mount with the recipe for the pool. Creation
 * happens here immediately if a surface already leased before the provider
 * registered (a surface below the provider can mount in the same commit).
 */
export function registerDiffWorkerPoolLifecycle(
  lifecycle: DiffWorkerPoolLifecycle,
): void {
  store.lifecycle = lifecycle;
  createIfDue();
  notify();
}

/**
 * Provider unmount. The manager is the provider's to terminate, not ours.
 *
 * The demand goes with it. Every surface that can lease a pool renders BELOW
 * this provider, so they have all unmounted too and none of their leases is
 * being discarded - whereas leases left standing would outlive them and make
 * the next `registerDiffWorkerPoolLifecycle` build a pool during its own mount.
 * The shell can be torn down and rebuilt within one session (a host outage or
 * sign-out unmounts it under `HostReadyGate`), and the second shell has to be
 * as lazy as the first: eager spawning that only starts on the second lifetime
 * is exactly the cost this module exists to remove, minus the symptom that
 * would make anyone look.
 */
export function unregisterDiffWorkerPoolLifecycle(
  lifecycle: DiffWorkerPoolLifecycle,
): void {
  if (store.lifecycle !== lifecycle) return;
  cancelIdleWindow();
  stopWatchingVisibility();
  generation += 1;
  store.lifecycle = null;
  store.manager = undefined;
  store.leases = 0;
  notify();
}

/**
 * A diff surface is about to render, and holds the pool open until the
 * returned release is called. The first lease with a registered lifecycle
 * builds the pool; the last release starts the idle window, if the active
 * profile has one.
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
  if (store.leases > 0 && store.lifecycle === null) return "unavailable";
  return "pending";
}

export function subscribeDiffWorkerPool(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The last diff surface just unmounted.
 *
 * A hidden shell skips the window entirely. The window is a grace period for a
 * user who is *navigating between diffs*, and a backgrounded app has no such
 * user - on iOS it has a process the system is actively looking to kill, where
 * every isolate still resident counts against it.
 */
function startIdleWindow(): void {
  const idleMs = getRetentionProfile().diffWorkerPoolIdleMs;
  if (idleMs === null) return;
  if (store.manager === undefined) return;
  if (!isDocumentVisible()) {
    terminateIdlePool();
    return;
  }
  store.idleTimer = environment.scheduler.schedule(idleMs, () => {
    store.idleTimer = null;
    // Re-checked rather than trusted: a surface that mounted while the window
    // ran cancelled this timer, but a profile switched underneath it (tests
    // do) or a pool already gone leave a timer with nothing to do.
    if (store.leases > 0) return;
    terminateIdlePool();
  });
}

function cancelIdleWindow(): void {
  store.idleTimer?.cancel();
  store.idleTimer = null;
}

/**
 * Drop the pool, and the isolates behind it, while nothing is rendering a
 * diff.
 *
 * ONLY AT ZERO LEASES, and that is a correctness bound rather than a policy
 * one. `WorkerPoolManager.terminate()` rejects every in-flight and queued task
 * and kills its workers, but it does NOT poison the manager: the next task
 * submitted to it re-enters `initialize()` and spawns a fresh set. A mounted
 * `<FileDiff>` captures its manager once, in the ref callback that creates the
 * instance, and never re-reads the context - so terminating under one would
 * buy the memory back only until its next render, and the respawned isolates
 * would belong to a manager the library singleton has already forgotten, with
 * nothing left able to terminate them. A lease is exactly "a Diffs component is
 * mounted against this pool", so zero leases is the one moment that cannot
 * happen.
 *
 * In-flight prime-cache promises therefore belong to surfaces that have already
 * unmounted, and they SETTLE - `terminate()` rejects them with
 * `WorkerPoolTerminatedError` rather than leaving them pending - which is what
 * keeps a gate that re-mounts mid-flight from waiting on a promise no worker
 * will ever answer.
 */
function terminateIdlePool(): void {
  cancelIdleWindow();
  stopWatchingVisibility();
  if (store.manager === undefined) return;
  store.manager = undefined;
  store.lifecycle?.terminate();
  notify();
}

/**
 * Watch the page's visibility for as long as a pool exists under a profile
 * with an idle window - so, on the phone, and only once it has actually built
 * one. Nothing to watch on desktop: its window is `null`, and the pool it
 * keeps is the behaviour this module has always had.
 */
function watchVisibilityWhileIdleWindowApplies(): void {
  if (store.unwatchVisibility !== null) return;
  if (getRetentionProfile().diffWorkerPoolIdleMs === null) return;
  store.unwatchVisibility = subscribeDocumentVisibility(() => {
    if (isDocumentVisible()) return;
    if (store.leases > 0) return;
    terminateIdlePool();
  });
}

function stopWatchingVisibility(): void {
  store.unwatchVisibility?.();
  store.unwatchVisibility = null;
}

export function __resetDiffWorkerPoolForTests(): void {
  cancelIdleWindow();
  stopWatchingVisibility();
  generation += 1;
  store.manager = undefined;
  store.lifecycle = null;
  store.leases = 0;
  listeners.clear();
}
