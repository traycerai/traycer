import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type {
  DiffsThemeNames,
  FileContents,
  FileDiffMetadata,
} from "@pierre/diffs";
import { useWorkerPool } from "@pierre/diffs/react";
import {
  getDiffWorkerPoolAvailability,
  requestDiffWorkerPool,
  subscribeDiffWorkerPool,
  type DiffWorkerPoolAvailability,
} from "@/lib/diff/diff-worker-pool-demand";

/**
 * Asks for the worker pool and reports where that request stands.
 *
 * Every Diffs surface passes through one of the gates below before it mounts a
 * `@pierre/diffs` component, which makes them the one place a surface can say
 * "I am about to need a highlighter" early enough for the pool to be created
 * lazily (see `lib/diff/diff-worker-pool-demand.ts`). The request is made from
 * an effect rather than during render so that a render which is thrown away
 * never builds a pool.
 *
 * The gates stay closed until the pool is in CONTEXT (`useWorkerPool()`), not
 * merely in the store: a `@pierre/diffs` component mounted with no pool in
 * context highlights on the MAIN thread, and keeps doing so for its lifetime -
 * the pool arriving a render later does not re-route it. Only `"unavailable"`
 * (no provider mounted at all) releases a surface without one.
 */
function useDiffWorkerPoolAvailability(
  wanted: boolean,
): DiffWorkerPoolAvailability {
  // Only a gate that is enabled and has something to highlight asks: a
  // disabled gate or an empty diff list would otherwise build the pool for
  // a surface that will never send it work.
  useEffect(() => {
    if (wanted) requestDiffWorkerPool();
  }, [wanted]);
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
  readonly prepare: (() => Promise<unknown>) | null;
  readonly poolAvailability: DiffWorkerPoolAvailability;
}): boolean {
  const { enabled, hasWork, prepare, poolAvailability } = props;
  const [released, setReleased] = useState(false);

  useEffect(() => {
    if (!enabled || !hasWork || prepare === null) return;
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
  }, [enabled, hasWork, prepare]);

  if (!enabled || !hasWork || released) return true;
  // No pool in context to prewarm with. "unavailable" means no provider at
  // all - render on the main thread, as this surface always did outside the
  // desktop shell. Anything else means the pool exists or is about to, and
  // the context will carry it on the next render - hold the gate.
  if (prepare === null) return poolAvailability === "unavailable";
  return false;
}

export function useDiffsFileHighlightReady(props: {
  readonly file: FileContents;
  readonly theme: DiffsThemeNames;
  readonly enabled: boolean;
}): boolean {
  const pool = useWorkerPool();
  const poolAvailability = useDiffWorkerPoolAvailability(props.enabled);
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
  const poolAvailability = useDiffWorkerPoolAvailability(
    props.enabled && props.fileDiffs.length > 0,
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
  const poolAvailability = useDiffWorkerPoolAvailability(
    props.enabled && props.fileDiffs.length > 0,
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
