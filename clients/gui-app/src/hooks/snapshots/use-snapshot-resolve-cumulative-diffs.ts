import { useMemo } from "react";
import type { ChatAccumulatedFileChange } from "@traycer/protocol/host/agent/gui/subscribe";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import type { AccumulatedChangeRow } from "@/lib/chat/accumulated-change-rows";
import type { ResolvedSnapshotDiff } from "@/lib/chat/resolve-snapshot-diff-content";
import type { SnapshotDiffTilePayload } from "@/stores/epics/canvas/types";
import { resolveSnapshotDiffContents } from "@/lib/chat/resolve-snapshot-diff-content";
import {
  fetchableAccumulatedChanges,
  mergeCumulativeDiffs,
  type CumulativeDiffResolution,
} from "@/lib/chat/cumulative-diff-resolution";
import { useHostQueries } from "@/hooks/host/use-host-queries";

/**
 * Before/after contents for a CUMULATIVE snapshot tile, on either line (D7).
 *
 * A cumulative tile (one file, or the whole accumulated set as a bundle) used
 * to read its contents straight out of the snapshot's `accumulatedFileChanges`.
 * On the windowed line that array is empty by construction - the snapshot
 * carries summaries, and the bodies come from `chat.readAccumulatedFileChange`
 * when a diff is actually opened, which is what this hook does.
 *
 * ## Why both paths run every render
 *
 * The inline resolution and the fetch are both evaluated and one is chosen,
 * rather than branching before the hook call. Hook order cannot be conditional,
 * and the alternative - two sibling components picked by line - would put the
 * line discriminator in the component tree, where a tile that changed lines
 * mid-life would remount and lose its scroll position. On the pre-windowed line
 * the request list is empty, and `useHostQueries` over an empty list is free.
 *
 * ## `null` digest means "do not fetch"
 *
 * A row whose digest is `null` is one whose contents rode the snapshot, so it
 * is resolved inline. That makes the two paths complementary rather than
 * alternative, and a mixed set - which the active turn produces, since a file
 * the running turn created has no host version yet - is handled correctly by
 * construction rather than by a special case.
 */
export function useSnapshotResolveCumulativeDiffs(args: {
  readonly payload: SnapshotDiffTilePayload;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly chatId: string;
  readonly hostRows: ReadonlyArray<AccumulatedChangeRow>;
  /**
   * Whether {@link hostRows} is the whole accumulated set rather than the
   * prefix delivered so far.
   *
   * Load-bearing for absence. A bundle names its paths as of when it was
   * opened, and this hook reads a path missing from `hostRows` as "reverted
   * since, so drop the section". That is right for a complete set and wrong
   * for a prefix: reopening an existing bundle starts from the snapshot, whose
   * summary chunks normally arrive AFTERWARDS, so every file still in transit
   * looked reverted and the tile rendered the early ones as a finished bundle -
   * or "source unavailable" before the first chunk - with nothing on screen
   * saying it was still loading.
   */
  readonly hostRowsComplete: boolean;
  readonly inlineChanges: ReadonlyArray<ChatAccumulatedFileChange>;
  /** False for a hash-backed tile, whose contents come from the hash query. */
  readonly enabled: boolean;
}): CumulativeDiffResolution {
  const {
    chatId,
    client,
    enabled,
    epicId,
    hostRows,
    hostRowsComplete,
    inlineChanges,
    payload,
  } = args;

  // The paths this tile shows, in the order it shows them. A bundle names them
  // as of when it was opened, so a path since reverted off the accumulated set
  // simply resolves to nothing and drops out below.
  const filePaths = useMemo<ReadonlyArray<string>>(() => {
    if (!enabled) return [];
    if (payload.kind === "snapshot-cumulative-bundle") return payload.filePaths;
    if (payload.kind === "snapshot-cumulative") return [payload.filePath];
    return [];
  }, [enabled, payload]);

  const fetchable = useMemo(
    () => fetchableAccumulatedChanges(filePaths, hostRows),
    [filePaths, hostRows],
  );
  // Paths this tile shows that `hostRows` says nothing about YET. Zero once the
  // set is complete, at which point an absent path really is a reverted one.
  const undeliveredPaths = useMemo(() => {
    if (hostRowsComplete) return 0;
    const known = new Set(hostRows.map((row) => row.filePath));
    return filePaths.filter((filePath) => !known.has(filePath)).length;
  }, [filePaths, hostRows, hostRowsComplete]);

  const contentQueries = useHostQueries<
    HostRpcRegistry,
    "chat.readAccumulatedFileChange"
  >({
    client,
    requests: useMemo(
      () =>
        fetchable.map((entry) => ({
          method: "chat.readAccumulatedFileChange" as const,
          params: {
            epicId,
            chatId,
            filePath: entry.filePath,
            digest: entry.digest,
          },
        })),
      [chatId, epicId, fetchable],
    ),
    cacheKeyIdentity: undefined,
    options: {
      // A digest names one immutable version of one file's accumulated change,
      // so a non-stale answer can never change under its own key. A `stale`
      // answer is not cached: the key it was asked under is already superseded.
      staleTime: (query) => (query.state.data?.stale === false ? Infinity : 0),
      gcTime: 30 * 60 * 1000,
      retry: false,
    },
  });

  const inline = useMemo<ReadonlyArray<ResolvedSnapshotDiff>>(() => {
    if (!enabled) return [];
    if (
      payload.kind !== "snapshot-cumulative" &&
      payload.kind !== "snapshot-cumulative-bundle"
    ) {
      return [];
    }
    return resolveSnapshotDiffContents(payload, {
      messages: [],
      liveAssistantBlocks: null,
      accumulatedFileChanges: inlineChanges,
    });
  }, [enabled, inlineChanges, payload]);

  return useMemo(
    () =>
      mergeCumulativeDiffs({
        filePaths,
        inline,
        fetchable,
        undeliveredPaths,
        fetches: contentQueries.map((query) => ({
          isLoading: query.isLoading,
          data: query.data,
          // Carried, not derived from the other two: a failed query and an
          // idle one are the same `{isLoading: false, data: undefined}` pair.
          isError: query.isError,
        })),
      }),
    [contentQueries, fetchable, filePaths, inline, undeliveredPaths],
  );
}
