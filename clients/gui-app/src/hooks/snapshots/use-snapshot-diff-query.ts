import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { FileEditReason } from "@traycer/protocol/persistence/epic/content-blocks";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

/** Caller supplies the writing host's client, never useHostClient(). Expand-only fetch. */
export function useSnapshotDiffQuery(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
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
  return useHostQuery<HostRpcRegistry, "snapshots.readSnapshotDiff">({
    cacheKeyIdentity: undefined,
    client: args.client,
    method: "snapshots.readSnapshotDiff",
    params: {
      beforeHash: args.beforeHash,
      afterHash: args.afterHash,
    },
    options: {
      // Nothing to fetch when both sides are absent (would be an empty diff).
      enabled:
        args.enabled && (args.beforeHash !== null || args.afterHash !== null),
      // A non-snapshot reason (blob_missing/binary/too_large) can be TRANSIENT (host momentarily unreachable, blob not yet synced), so give it a short staleness window instead of pinning the failure for the whole session - a later expand re-resolves once the condition clears.
      staleTime: (query) =>
        query.state.data?.reason === "snapshot" ? Infinity : 30 * 1000,
      gcTime: 30 * 60 * 1000,
      retry: false,
    },
  });
}
