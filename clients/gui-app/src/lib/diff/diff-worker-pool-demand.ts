import type { WorkerPoolManager } from "@pierre/diffs/worker";

/**
 * The lazily-created `@pierre/diffs` worker pool, and the demand signal that
 * creates it.
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
  /** Not requested yet, or requested and being created for this render. */
  | "pending"
  /**
   * Requested, and no provider is mounted to build it - a tree outside the
   * desktop shell. Render on the main thread, as such trees always did.
   */
  | "unavailable";

type PoolCreator = () => WorkerPoolManager;

interface DiffWorkerPoolStore {
  manager: WorkerPoolManager | undefined;
  creator: PoolCreator | null;
  requested: boolean;
}

const store: DiffWorkerPoolStore = {
  manager: undefined,
  creator: null,
  requested: false,
};

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function createIfDue(): void {
  if (store.manager !== undefined) return;
  if (!store.requested || store.creator === null) return;
  store.manager = store.creator();
  notify();
}

/**
 * Called by the provider at mount with the recipe for the pool. Creation
 * happens here immediately if a surface already asked before the provider
 * registered (a surface below the provider can mount in the same commit).
 */
export function registerDiffWorkerPoolCreator(creator: PoolCreator): void {
  store.creator = creator;
  createIfDue();
  notify();
}

/** Provider unmount. The manager is the provider's to terminate, not ours. */
export function unregisterDiffWorkerPoolCreator(creator: PoolCreator): void {
  if (store.creator !== creator) return;
  store.creator = null;
  store.manager = undefined;
  notify();
}

/**
 * A diff surface is about to render. Idempotent; the first call with a
 * registered creator builds the pool.
 */
export function requestDiffWorkerPool(): void {
  if (store.requested) return;
  store.requested = true;
  createIfDue();
  notify();
}

export function getDiffWorkerPool(): WorkerPoolManager | undefined {
  return store.manager;
}

export function getDiffWorkerPoolAvailability(): DiffWorkerPoolAvailability {
  if (store.manager !== undefined) return "ready";
  if (store.requested && store.creator === null) return "unavailable";
  return "pending";
}

export function subscribeDiffWorkerPool(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function __resetDiffWorkerPoolForTests(): void {
  store.manager = undefined;
  store.creator = null;
  store.requested = false;
  listeners.clear();
}
