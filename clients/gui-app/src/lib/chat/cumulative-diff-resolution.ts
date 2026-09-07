import type { ChatReadAccumulatedFileChangeResponse } from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import type { AccumulatedChangeRow } from "@/lib/chat/accumulated-change-rows";
import type { ResolvedSnapshotDiff } from "@/lib/chat/resolve-snapshot-diff-content";
import { isPdfAssetPath } from "@/lib/assets/image-extension-allowlist";

/** The two decisions behind a cumulative diff tile's contents, as plain functions. */

/** One file's fetch address: the path, and the version being asked for. */
export interface FetchableAccumulatedChange {
  readonly filePath: string;
  readonly digest: string;
}

/** Whether this path's section renders without ever reading the file's bytes. */
function rendersWithoutContents(filePath: string): boolean {
  return isPdfAssetPath(filePath);
}

/** Which of a tile's files need a contents fetch. */
export function fetchableAccumulatedChanges(
  filePaths: ReadonlyArray<string>,
  hostRows: ReadonlyArray<AccumulatedChangeRow>,
): ReadonlyArray<FetchableAccumulatedChange> {
  const rowsByPath = new Map(hostRows.map((row) => [row.filePath, row]));
  return filePaths.flatMap((filePath) => {
    const row = rowsByPath.get(filePath);
    if (row === undefined || row.digest === null || !row.hasContents) {
      return [];
    }
    if (rendersWithoutContents(filePath)) return [];
    return [{ filePath, digest: row.digest }];
  });
}

/**
 * The tile's paths that are resolved by EXISTENCE rather than by content: a row is there, so the section is there, but its bytes are never read.
 */
export function contentlessAccumulatedChangePaths(
  filePaths: ReadonlyArray<string>,
  hostRows: ReadonlyArray<AccumulatedChangeRow>,
): ReadonlyArray<string> {
  const knownPaths = new Set(hostRows.map((row) => row.filePath));
  return filePaths.filter(
    (filePath) => knownPaths.has(filePath) && rendersWithoutContents(filePath),
  );
}

/** One fetch's outcome, reduced to what the merge below cares about. */
export interface AccumulatedChangeFetchState {
  readonly isLoading: boolean;
  readonly data: ChatReadAccumulatedFileChangeResponse | undefined;
  /** Whether this fetch FAILED, as distinct from not having answered yet. */
  readonly isError: boolean;
}

export interface CumulativeDiffResolution {
  readonly resolved: ReadonlyArray<ResolvedSnapshotDiff>;
  readonly isLoading: boolean;
  readonly stale: boolean;
  /** At least one file in the bundle could not be fetched. */
  readonly failed: boolean;
}

/** Combine what rode the snapshot with what was fetched, in the tile's order. */
export function mergeCumulativeDiffs(input: {
  readonly filePaths: ReadonlyArray<string>;
  readonly inline: ReadonlyArray<ResolvedSnapshotDiff>;
  readonly fetchable: ReadonlyArray<FetchableAccumulatedChange>;
  readonly fetches: ReadonlyArray<AccumulatedChangeFetchState>;
  /**
   * Paths resolved by existence alone - see {@link contentlessAccumulatedChangePaths}.
   * They enter the result with null contents so their section is rendered, and they are never outstanding: nothing is in flight for them, so they cannot hold the tile in its loading state or drop it into source-unavailable.
   */
  readonly contentless: ReadonlyArray<string>;
  /** How many of `filePaths` the host rows cannot speak to yet, because the summary stream is still arriving. */
  readonly undeliveredPaths: number;
}): CumulativeDiffResolution {
  const {
    contentless,
    fetchable,
    fetches,
    filePaths,
    inline,
    undeliveredPaths,
  } = input;
  const fetched = new Map<string, ResolvedSnapshotDiff>();
  const contentlessByPath = new Map<string, ResolvedSnapshotDiff>(
    contentless.map((filePath) => [
      filePath,
      { filePath, beforeContent: null, afterContent: null },
    ]),
  );
  const inlineByPath = new Map(inline.map((entry) => [entry.filePath, entry]));
  // In the tile's order, whatever each path resolved through. Inline wins,
  // then a completed fetch, then existence alone.
  const orderResolved = (): ReadonlyArray<ResolvedSnapshotDiff> =>
    filePaths.flatMap((filePath) => {
      const entry =
        inlineByPath.get(filePath) ??
        fetched.get(filePath) ??
        contentlessByPath.get(filePath);
      return entry === undefined ? [] : [entry];
    });
  if (fetchable.length === 0) {
    // Before the first chunk this is EVERY path, which is the case that rendered "source unavailable" for a bundle that was merely early.
    // A bundle of nothing BUT contentless rows lands here too, and its sections still have to come out.
    return {
      resolved: orderResolved(),
      isLoading: undeliveredPaths > 0,
      stale: false,
      failed: false,
    };
  }
  // Seeded, not assigned: a path the summary stream has not reached yet is outstanding for the same reason a query still in flight is, and the tile must keep loading rather than present a partial bundle as a whole one.
  let isLoading = undeliveredPaths > 0;
  let stale = false;
  let failed = false;
  // The two arrays are paired by position and the caller builds them that way, so the bound is the shorter of them: a short `fetches` resolves fewer files, which is the same state as one still in flight.
  const paired = Math.min(fetchable.length, fetches.length);
  // ...and stating that is not the same as acting on it.
  // Every branch below that means "this file has not answered" raises `isLoading`; an entry with no fetch to pair against has not answered EITHER, and skipping it silently let the bundle return complete with those paths missing - the precise outcome the.
  if (fetchable.length > paired) isLoading = true;
  for (let index = 0; index < paired; index += 1) {
    const entry = fetchable[index];
    const fetch = fetches[index];
    if (fetch.isLoading) {
      isLoading = true;
      continue;
    }
    if (fetch.isError) {
      failed = true;
      continue;
    }
    // Neither loading, nor errored, nor answered: a query that has not been enabled yet.
    // Counted as outstanding rather than skipped, so the bundle reads as incomplete instead of as complete-minus-a-file.
    if (fetch.data === undefined) {
      isLoading = true;
      continue;
    }
    if (fetch.data.stale) {
      // The summary that named this version has been superseded.
      // The chunk frame carrying its replacement re-keys the fetch, so this repairs itself - the tile must not retry the rejected question.
      stale = true;
      continue;
    }
    fetched.set(entry.filePath, {
      filePath: entry.filePath,
      beforeContent: fetch.data.beforeContent,
      afterContent: fetch.data.afterContent,
    });
  }
  return { resolved: orderResolved(), isLoading, stale, failed };
}
