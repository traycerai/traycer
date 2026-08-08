import { useCallback, useEffect, useState } from "react";
import type {
  DiffsThemeNames,
  FileContents,
  FileDiffMetadata,
} from "@pierre/diffs";
import { useWorkerPool } from "@pierre/diffs/react";

/**
 * Hold only the first paint for highlighting. Once a Diffs surface has been
 * released, later content/theme cache misses prewarm in the background so the
 * mounted editor is never replaced by a loader.
 */
function useInitialHighlightReady(props: {
  readonly enabled: boolean;
  readonly hasWork: boolean;
  readonly prepare: (() => Promise<unknown>) | null;
}): boolean {
  const { enabled, hasWork, prepare } = props;
  const [released, setReleased] = useState(
    !enabled || !hasWork || prepare === null,
  );

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

  return !enabled || !hasWork || prepare === null || released;
}

export function useDiffsFileHighlightReady(props: {
  readonly file: FileContents;
  readonly theme: DiffsThemeNames;
  readonly enabled: boolean;
}): boolean {
  const pool = useWorkerPool();
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
  });
}

export function useDiffsDiffHighlightReady(props: {
  readonly fileDiffs: ReadonlyArray<FileDiffMetadata>;
  readonly theme: DiffsThemeNames;
  readonly enabled: boolean;
}): boolean {
  const pool = useWorkerPool();
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

  return (
    !enabled ||
    pool === undefined ||
    fileDiffs.length === 0 ||
    preparedTarget === fileDiffs
  );
}
