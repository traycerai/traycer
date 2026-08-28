import type { ChatReadAccumulatedFileChangeResponse } from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import type { AccumulatedChangeRow } from "@/lib/chat/accumulated-change-rows";
import type { ResolvedSnapshotDiff } from "@/lib/chat/resolve-snapshot-diff-content";

/**
 * The two decisions behind a cumulative diff tile's contents, as plain
 * functions.
 *
 * They live here rather than inside `useSnapshotResolveCumulativeDiffs` because a
 * branch inside a hook is a branch with no cheap test: covering it means a
 * QueryClient, a host client, a zustand store and a renderer, all to assert
 * which of three states a file resolved to. The hook keeps the wiring; these
 * keep the judgement.
 */

/** One file's fetch address: the path, and the version being asked for. */
export interface FetchableAccumulatedChange {
  readonly filePath: string;
  readonly digest: string;
}

/**
 * Which of a tile's files need a contents fetch.
 *
 * Three reasons a path drops out, and they are not the same:
 *
 * - **No row.** The path was on the tile when it was opened and has since left
 *   the accumulated set - reverted, or edited back to its original. Nothing to
 *   show, and the tile renders one fewer section.
 * - **`digest: null`.** Its contents rode the snapshot (the pre-windowed line),
 *   or it is the client's own row for a file the active turn is still writing
 *   and no host version names yet. Resolved inline instead.
 * - **`hasContents: false`.** There is no before/after to ask for at all. A
 *   request would return nothing and the tile would spin waiting for it.
 */
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
    return [{ filePath, digest: row.digest }];
  });
}

/**
 * One fetch's outcome, reduced to what the merge below cares about.
 *
 * Deliberately not the query object: this is the whole surface the decision
 * needs, and taking the query would drag TanStack's state machine into every
 * test of it.
 */
export interface AccumulatedChangeFetchState {
  readonly isLoading: boolean;
  readonly data: ChatReadAccumulatedFileChangeResponse | undefined;
  /**
   * Whether this fetch FAILED, as distinct from not having answered yet.
   *
   * Carried because the two are indistinguishable from the other two fields: a
   * failed query reports `isLoading: false` and `data: undefined`, which is
   * byte-for-byte the shape of a query that has not started. Without this the
   * merge silently drops the file and the tile renders the remaining ones as a
   * complete bundle.
   */
  readonly isError: boolean;
}

export interface CumulativeDiffResolution {
  readonly resolved: ReadonlyArray<ResolvedSnapshotDiff>;
  readonly isLoading: boolean;
  readonly stale: boolean;
  /**
   * At least one file in the bundle could not be fetched.
   *
   * Separate from `stale`, because the two have opposite prognoses: a stale
   * result repairs itself when the replacement summary re-keys the fetch, and a
   * failed one does not repair itself at all. Both mean the same thing to a
   * caller deciding whether to render, which is that `resolved` is a SUBSET -
   * so both have to reach it.
   */
  readonly failed: boolean;
}

/**
 * Combine what rode the snapshot with what was fetched, in the tile's order.
 *
 * Ordered by `filePaths` rather than by either source. A bundle tile shows its
 * files in the order they were listed when it was opened, and a set assembled
 * "inline first, then fetched" would reshuffle them the moment one file's
 * contents started arriving separately from another's.
 *
 * Inline WINS a collision. The two sources are complementary by construction -
 * a row with a digest is not resolved inline - so a path in both is a state
 * that should not arise; resolving it toward the copy that needed no network
 * keeps the answer deterministic rather than dependent on fetch timing.
 */
export function mergeCumulativeDiffs(input: {
  readonly filePaths: ReadonlyArray<string>;
  readonly inline: ReadonlyArray<ResolvedSnapshotDiff>;
  readonly fetchable: ReadonlyArray<FetchableAccumulatedChange>;
  readonly fetches: ReadonlyArray<AccumulatedChangeFetchState>;
  /**
   * How many of `filePaths` the host rows cannot speak to yet, because the
   * summary stream is still arriving.
   *
   * Absence is ambiguous until the set is complete, and this hook resolves the
   * ambiguity toward LOADING rather than toward reverted. Reverting is the
   * conclusion that silently drops a section, and it is unrecoverable from the
   * user's side: the tile looks finished. Loading is recoverable by waiting,
   * which is exactly what is happening.
   */
  readonly undeliveredPaths: number;
}): CumulativeDiffResolution {
  const { fetchable, fetches, filePaths, inline, undeliveredPaths } = input;
  if (fetchable.length === 0) {
    // Before the first chunk this is EVERY path, which is the case that
    // rendered "source unavailable" for a bundle that was merely early.
    return {
      resolved: inline,
      isLoading: undeliveredPaths > 0,
      stale: false,
      failed: false,
    };
  }
  const fetched = new Map<string, ResolvedSnapshotDiff>();
  // Seeded, not assigned: a path the summary stream has not reached yet is
  // outstanding for the same reason a query still in flight is, and the tile
  // must keep loading rather than present a partial bundle as a whole one.
  let isLoading = undeliveredPaths > 0;
  let stale = false;
  let failed = false;
  // The two arrays are paired by position and the caller builds them that way,
  // so the bound is the shorter of them: a short `fetches` resolves fewer
  // files, which is the same state as one still in flight.
  const paired = Math.min(fetchable.length, fetches.length);
  // ...and stating that is not the same as acting on it. Every branch below
  // that means "this file has not answered" raises `isLoading`; an entry with
  // no fetch to pair against has not answered EITHER, and skipping it silently
  // let the bundle return complete with those paths missing - the precise
  // outcome the `isError` and `data === undefined` branches exist to prevent.
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
    // Neither loading, nor errored, nor answered: a query that has not been
    // enabled yet. Counted as outstanding rather than skipped, so the bundle
    // reads as incomplete instead of as complete-minus-a-file.
    if (fetch.data === undefined) {
      isLoading = true;
      continue;
    }
    if (fetch.data.stale) {
      // The summary that named this version has been superseded. The chunk
      // frame carrying its replacement re-keys the fetch, so this repairs
      // itself - the tile must not retry the rejected question.
      stale = true;
      continue;
    }
    fetched.set(entry.filePath, {
      filePath: entry.filePath,
      beforeContent: fetch.data.beforeContent,
      afterContent: fetch.data.afterContent,
    });
  }
  const inlineByPath = new Map(inline.map((entry) => [entry.filePath, entry]));
  const resolved = filePaths.flatMap((filePath) => {
    const entry = inlineByPath.get(filePath) ?? fetched.get(filePath);
    return entry === undefined ? [] : [entry];
  });
  return { resolved, isLoading, stale, failed };
}
