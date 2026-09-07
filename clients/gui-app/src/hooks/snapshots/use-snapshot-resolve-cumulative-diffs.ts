import { useMemo } from "react";
import type { ChatAccumulatedFileChange } from "@traycer/protocol/host/agent/gui/subscribe";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import type { AccumulatedChangeRow } from "@/lib/chat/accumulated-change-rows";
import type { ResolvedSnapshotDiff } from "@/lib/chat/resolve-snapshot-diff-content";
import type { SnapshotDiffTilePayload } from "@/stores/epics/canvas/types";
import { resolveSnapshotDiffContents } from "@/lib/chat/resolve-snapshot-diff-content";
import {
  contentlessAccumulatedChangePaths,
  fetchableAccumulatedChanges,
  mergeCumulativeDiffs,
  type CumulativeDiffResolution,
} from "@/lib/chat/cumulative-diff-resolution";
import { useHostQueries } from "@/hooks/host/use-host-queries";

/** Always call both paths; hook order cannot be conditional. null digest means do not fetch (contents rode the snapshot). */
export function useSnapshotResolveCumulativeDiffs(args: {
  readonly payload: SnapshotDiffTilePayload;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly chatId: string;
  readonly hostRows: ReadonlyArray<AccumulatedChangeRow>;
  /**
   * True only when `hostRows` is the whole set. A missing path in a prefix is still in transit, not reverted; treating it as reverted dropped early files from a reopened bundle.
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
  // Rows that get a section without a download - a bundle's PDF rows. Split
  // out here rather than dropped, because dropping them would silently lose
  // the section: `snapshotBundleSectionEntries` is built from `resolved`.
  const contentless = useMemo(
    () => contentlessAccumulatedChangePaths(filePaths, hostRows),
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
        contentless,
        undeliveredPaths,
        fetches: contentQueries.map((query) => ({
          isLoading: query.isLoading,
          data: query.data,
          // Carried, not derived from the other two: a failed query and an
          // idle one are the same `{isLoading: false, data: undefined}` pair.
          isError: query.isError,
        })),
      }),
    [
      contentQueries,
      contentless,
      fetchable,
      filePaths,
      inline,
      undeliveredPaths,
    ],
  );
}
