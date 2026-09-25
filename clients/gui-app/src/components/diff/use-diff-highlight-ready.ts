import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type {
  DiffsThemeNames,
  FileContents,
  FileDiffMetadata,
} from "@pierre/diffs";
import { useWorkerPool } from "@pierre/diffs/react";
import {
  acquireDiffWorkerPool,
  getDiffWorkerPoolAvailability,
  subscribeDiffWorkerPool,
  type DiffWorkerPoolAvailability,
} from "@/lib/diff/diff-worker-pool-demand";
import { useTileBodyVisible } from "@/components/epic-canvas/hooks/use-tile-body-visible";
import { getRetentionProfile } from "@/stores/replica-memory/retention-profile";

/**
 * Whether this surface should give its `@pierre/diffs` body back right now
 * because it is mounted but off screen.
 *
 * Unmounting is the ONLY way a surface can stop holding the pool open, which
 * is why this is a render decision and not just a skipped lease. A mounted
 * `<FileDiff>` captures its `WorkerPoolManager` in the ref callback that
 * creates its instance and never re-reads the context (`useFileDiffInstance`),
 * and `WorkerPoolManager.terminate()` leaves the manager re-initializable - so
 * releasing the lease under a still-mounted body would buy the isolates back
 * only until that body's next render, which re-spawns them on a manager the
 * library singleton has already forgotten. Closing the gate instead takes the
 * component down, and the lease cleanup below goes with it.
 *
 * `useTileBodyVisible()` is the same signal the scroll-restoration hooks use:
 * this pane is the shown one AND this tab is its front tab. On the phone the
 * shell keeps `retainedTopLevelSurfaces` surfaces mounted behind the visible
 * one, so it is a hidden pane - not an unmount - that a diff most often
 * leaves by, and without this the idle window in
 * `lib/diff/diff-worker-pool-demand.ts` never gets a zero-lease moment to
 * measure (device runs: it never fired once).
 *
 * NEVER while an editor is mounted. The body carries a live `@pierre/diffs`
 * editor there, and whatever has been typed into it lives in that instance -
 * dropping a backgrounded surface's unsaved edits to reclaim an isolate is not
 * a trade this makes. Such a surface keeps its lease, and the pool with it.
 */
function useConcealedDiffSurface(editorMounted: boolean): boolean {
  const bodyVisible = useTileBodyVisible();
  if (bodyVisible || editorMounted) return false;
  return getRetentionProfile().dropHiddenDiffBodies;
}

/**
 * Holds a lease on the worker pool for as long as this surface has a Diffs
 * component on screen, and reports where that lease stands.
 *
 * Every Diffs surface passes through one of the gates below before it mounts a
 * `@pierre/diffs` component, which makes them the one place a surface can say
 * "I am about to need a highlighter" early enough for the pool to be created
 * lazily (see `lib/diff/diff-worker-pool-demand.ts`). The lease is taken from
 * an effect rather than during render so that a render which is thrown away
 * never builds a pool.
 *
 * It is a LEASE rather than a one-way request because the store now needs the
 * falling edge too: releasing the last one is what tells it that nothing is
 * rendering a diff any more, which is the only moment its isolates can safely
 * be reclaimed (mobile profiles do; see that module). The cleanup therefore
 * has to run for every path that takes this surface's Diffs component down -
 * an unmount, or a conceal (see above) - which is exactly what returning it
 * from the effect gets.
 *
 * The gates stay closed until the pool is in CONTEXT (`useWorkerPool()`), not
 * merely in the store: a `@pierre/diffs` component mounted with no pool in
 * context highlights on the MAIN thread, and keeps doing so for its lifetime -
 * the pool arriving a render later does not re-route it. Only `"unavailable"`
 * (no provider mounted at all) releases a surface without one.
 */
function useDiffWorkerPoolAvailability(
  hasWork: boolean,
  concealed: boolean,
): DiffWorkerPoolAvailability {
  // Having work to highlight is the demand signal, NOT being the enabled gate:
  // a surface that mounts with its read gate disabled (`WorkspaceFileRenderer`
  // straight into an edit session) still mounts a Diffs component, and one
  // that mounts pool-less highlights on the main thread for life. An empty
  // diff list is the only case with genuinely nothing to send a worker.
  //
  // A concealed surface is rendering its loader rather than a Diffs component
  // (see above), so it has nothing mounted against the pool and holds no
  // lease. Re-showing runs this effect again and takes a fresh one.
  useEffect(() => {
    if (!hasWork || concealed) return;
    return acquireDiffWorkerPool();
  }, [concealed, hasWork]);
  return useSyncExternalStore(
    subscribeDiffWorkerPool,
    getDiffWorkerPoolAvailability,
    getDiffWorkerPoolAvailability,
  );
}

/**
 * Hold only the first paint for highlighting. Once a Diffs surface has been
 * released, later content/theme cache misses prewarm in the background so the
 * mounted editor is never replaced by a loader.
 */
function useInitialHighlightReady(props: {
  readonly enabled: boolean;
  readonly hasWork: boolean;
  readonly concealed: boolean;
  readonly prepare: (() => Promise<unknown>) | null;
  readonly poolAvailability: DiffWorkerPoolAvailability;
}): boolean {
  const { concealed, enabled, hasWork, prepare, poolAvailability } = props;
  // A gate that mounts with nothing to wait for is released for the surface's
  // life. `WorkspaceFileRenderer` mounted mid-edit and `DiffContentPrimitive`
  // mounted with an edit session both start disabled and enable later; without
  // this, enabling would close the gate under an already-mounted editor and
  // replace it with a loader. Deliberately NOT seeded from `prepare === null`
  // the way it was before the pool became lazy - that is now the ordinary
  // first-render state, and seeding from it would release every surface before
  // the pool it is waiting for exists.
  const [released, setReleased] = useState(!enabled || !hasWork);

  // Re-arm the first-paint wait, but only on the edge where the pool this
  // surface was released against actually GOES (`prepare` follows the context
  // pool, so `null` here means it has). A conceal that outlives the idle
  // window comes back to cold isolates, and a body remounted over those
  // renders EMPTY until the library's own `initialize().then(rerender)` lands
  // - the loader is the honest thing to show for that gap. A conceal shorter
  // than the window comes back to a warm cache and stays released, which is
  // what the grace window is for.
  //
  // Adjusted during render (React's documented pattern for state derived from
  // a changing input) rather than from an effect: a setState in an effect body
  // renders the stale value first, and here that stale value is a mounted
  // `<FileDiff>` with no pool behind it.
  const [poolBehindGate, setPoolBehindGate] = useState(prepare !== null);
  if (poolBehindGate !== (prepare !== null)) {
    setPoolBehindGate(prepare !== null);
    if (concealed && prepare === null) setReleased(false);
  }

  useEffect(() => {
    // `concealed` included: a surface with no Diffs component mounted has
    // nothing to prewarm FOR, and submitting to a pool whose idle window this
    // very conceal started only buys a task the terminate has to reject.
    if (!enabled || !hasWork || concealed || prepare === null) return;
    let cancelled = false;
    void prepare().then(
      () => {
        if (!cancelled) setReleased(true);
      },
      () => {
        // Diffs can fall back to its main-thread renderer. A worker failure
        // must not strand the surface behind the first-paint gate.
        if (!cancelled) setReleased(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [concealed, enabled, hasWork, prepare]);

  if (!hasWork) return true;
  // Off screen and droppable: render the loader, which unmounts the Diffs
  // component and with it the lease its mount took out.
  if (concealed) return false;
  // No pool in context to prewarm with. "unavailable" means no provider at
  // all - render on the main thread, as this surface always did outside the
  // desktop shell. Anything else means the pool exists or is about to, and
  // the context will carry it on the next render - hold the gate. This holds
  // for a DISABLED gate too: `enabled` says whether to wait for the cache
  // prime, never whether the component about to mount needs a worker.
  if (prepare === null) return poolAvailability === "unavailable";
  return !enabled || released;
}

export function useDiffsFileHighlightReady(props: {
  readonly file: FileContents;
  readonly theme: DiffsThemeNames;
  readonly enabled: boolean;
}): boolean {
  const pool = useWorkerPool();
  // A DISABLED file gate is `WorkspaceFileRenderer` in edit mode - the `<File
  // edit>` below it owns an editor and whatever is unsaved in it, so it is
  // never concealed.
  const concealed = useConcealedDiffSurface(!props.enabled);
  // A file surface always has its one file to highlight, editing or not.
  const poolAvailability = useDiffWorkerPoolAvailability(true, concealed);
  const { file, theme } = props;
  const prepareHighlight = useCallback(async (): Promise<void> => {
    // The provider owns render options; theme makes this callback a distinct
    // cache-prewarm generation when that provider changes its namespace.
    void theme;
    await pool?.primeFileHighlightCache(file);
  }, [file, pool, theme]);
  return useInitialHighlightReady({
    enabled: props.enabled,
    hasWork: true,
    concealed,
    prepare: pool === undefined ? null : prepareHighlight,
    poolAvailability,
  });
}

export function useDiffsDiffHighlightReady(props: {
  readonly fileDiffs: ReadonlyArray<FileDiffMetadata>;
  readonly theme: DiffsThemeNames;
  readonly enabled: boolean;
}): boolean {
  const pool = useWorkerPool();
  // Same inversion as the file gate: this read gate is disabled exactly while
  // `DiffContentPrimitive` has an edit session, whose `<FileDiff edit>` holds
  // the editor.
  const concealed = useConcealedDiffSurface(!props.enabled);
  const poolAvailability = useDiffWorkerPoolAvailability(
    props.fileDiffs.length > 0,
    concealed,
  );
  const { fileDiffs, theme } = props;
  const prepareHighlight = useCallback(async (): Promise<void> => {
    if (pool === undefined) return;
    void theme;
    await Promise.all(
      fileDiffs.map((fileDiff) => pool.primeDiffHighlightCache(fileDiff)),
    );
  }, [fileDiffs, pool, theme]);
  return useInitialHighlightReady({
    enabled: props.enabled,
    hasWork: props.fileDiffs.length > 0,
    concealed,
    prepare: pool === undefined ? null : prepareHighlight,
    poolAvailability,
  });
}

/**
 * Every edit target must finish its own worker-cache generation before the
 * existing FileDiff instance enables `edit`. Unlike the first-paint gate
 * above, this resets for each new hydrated FileDiff array: the read-only
 * partial model and the hydrated edit model intentionally use different
 * cache identities.
 */
export function useDiffsDiffEditHighlightReady(props: {
  readonly fileDiffs: ReadonlyArray<FileDiffMetadata>;
  readonly theme: DiffsThemeNames;
  readonly enabled: boolean;
}): boolean {
  const pool = useWorkerPool();
  // The one gate whose `enabled` IS the edit session rather than its absence.
  // It never closes on conceal - the read gate beside it owns the body - but
  // it must stop leasing when that body goes, or the surface would hold the
  // pool open through a lease with nothing mounted behind it.
  const concealed = useConcealedDiffSurface(props.enabled);
  const poolAvailability = useDiffWorkerPoolAvailability(
    props.fileDiffs.length > 0,
    concealed,
  );
  const { enabled, fileDiffs, theme } = props;
  const [preparedTarget, setPreparedTarget] =
    useState<ReadonlyArray<FileDiffMetadata> | null>(null);

  useEffect(() => {
    if (!enabled || pool === undefined || fileDiffs.length === 0) return;
    let cancelled = false;
    void theme;
    void Promise.all(
      fileDiffs.map((fileDiff) => pool.primeDiffHighlightCache(fileDiff)),
    ).then(
      () => {
        if (!cancelled) setPreparedTarget(fileDiffs);
      },
      () => {
        // Match first-paint behavior: a failed worker must not permanently
        // disable editing. The forced render on release lets Diffs take its
        // main-thread fallback path.
        if (!cancelled) setPreparedTarget(fileDiffs);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, fileDiffs, pool, theme]);

  if (!enabled || fileDiffs.length === 0) return true;
  if (pool === undefined) return poolAvailability === "unavailable";
  return preparedTarget === fileDiffs;
}
