import type { WorkerPoolManager } from "@pierre/diffs/worker";

/** The lazily-created `@pierre/diffs` worker pool, and the demand signal that creates it. */

/**
 * Where a surface's request stands.
 * The gates in `use-diff-highlight-ready.ts` read this next to the pool they get from React context, and the two can disagree for one render: the store holds the manager the moment it is created, the context catches up when the provider re-renders.
 */
export type DiffWorkerPoolAvailability =
  /** The pool exists. */
  | "ready"
  /** Not requested yet, or requested and being created for this render. */
  | "pending"
  /**
   * Requested, and no provider is mounted to build it - a tree outside the desktop shell.
   * Render on the main thread, as such trees always did.
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
 * Called by the provider at mount with the recipe for the pool.
 * Creation happens here immediately if a surface already asked before the provider registered (a surface below the provider can mount in the same commit).
 */
export function registerDiffWorkerPoolCreator(creator: PoolCreator): void {
  store.creator = creator;
  createIfDue();
  notify();
}

/**
 * Provider unmount.
 * The manager is the provider's to terminate, not ours.
 */
export function unregisterDiffWorkerPoolCreator(creator: PoolCreator): void {
  if (store.creator !== creator) return;
  store.creator = null;
  store.manager = undefined;
  store.requested = false;
  notify();
}

/**
 * A diff surface is about to render.
 * Idempotent; the first call with a registered creator builds the pool.
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
