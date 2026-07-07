import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { FileEditReason } from "@traycer/protocol/persistence/epic/content-blocks";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

/**
 * Lazy before/after fetch for a single `file_change` block's snapshot diff.
 *
 * The chat doc no longer inlines file before/after content - the block carries
 * only the content-addressed `beforeHash`/`afterHash`. This hook reads the
 * decoded contents out of the host's on-disk SnapshotStore on demand (when a
 * diff row is expanded), so the unsynced doc stays small and the (common)
 * non-expanded case fetches nothing.
 *
 * Scope: the machine-local / active host (`useHostClient`), where snapshot
 * blobs physically live. A snapshot whose blob is gone (or on another machine
 * for a shared epic) resolves with a `blob_missing`/`binary`/`too_large`
 * reason rather than content - the renderer shows the matching banner.
 */
export function useSnapshotDiffQuery(args: {
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly enabled: boolean;
}): UseQueryResult<
  {
    readonly beforeContent: string | null;
    readonly afterContent: string | null;
    readonly reason: FileEditReason;
  },
  HostRpcError
> {
  const client = useHostClient();
  return useHostQuery<HostRpcRegistry, "snapshots.readSnapshotDiff">({
    cacheKeyIdentity: undefined,
    client,
    method: "snapshots.readSnapshotDiff",
    params: {
      beforeHash: args.beforeHash,
      afterHash: args.afterHash,
    },
    options: {
      // Nothing to fetch when both sides are absent (would be an empty diff).
      enabled:
        args.enabled && (args.beforeHash !== null || args.afterHash !== null),
      // A resolved `snapshot` is immutable (content-addressed) → cache forever.
      // A non-snapshot reason (blob_missing/binary/too_large) can be TRANSIENT
      // (host momentarily unreachable, blob not yet synced), so give it a
      // short staleness window instead of pinning the failure for the whole
      // session - a later expand re-resolves once the condition clears.
      staleTime: (query) =>
        query.state.data?.reason === "snapshot" ? Infinity : 30 * 1000,
      gcTime: 30 * 60 * 1000,
      retry: false,
    },
  });
}
