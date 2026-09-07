import type { UseQueryResult } from "@tanstack/react-query";
import { type EpicArtifactKind } from "@traycer/protocol/common/registry";
import type {
  ListCommentThreadsRequest,
  ListCommentThreadsResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

/** Co-located here (rather than under `lib/query-keys/`) because the comment surface is the sole consumer; promote when a second feature needs the same key shape. */
export function commentThreadsQueryKey(
  hostId: string,
  params: ListCommentThreadsRequest,
): readonly unknown[] {
  return ["host", hostId, "epic.listCommentThreads", params] as const;
}

export interface UseEpicCommentThreadsOptions {
  /** Disables the query when the comments view is closed for an epic so
   *  the host RPC isn't fired needlessly. */
  readonly enabled: boolean;
  /** When the records lane stopped pushing, or `null` while it is up - the same instant `useEpicLaneCommentThreadsDroppedAt` produces and `resolveArtifactCommentThreads` orders by. */
  readonly laneDroppedAt: number | null;
}

/** True while the lane is down so HOST_METHOD_POLL_TABLE cadence keeps answering. Not an interval: useHostQuery owns refetchInterval. */
export function commentThreadsShouldPoll(
  laneDroppedAt: number | null,
): boolean {
  return laneDroppedAt !== null;
}

/** Caller supplies the epic-session or tab client. No app-wide wrapper. */
export function useEpicCommentThreadsForClient(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly artifactType: EpicArtifactKind;
  readonly artifactId: string;
  readonly options: UseEpicCommentThreadsOptions;
}): UseQueryResult<ListCommentThreadsResponse, HostRpcError> {
  const { client, epicId, artifactType, artifactId, options } = args;
  return useHostQuery({
    cacheKeyIdentity: undefined,
    client,
    method: "epic.listCommentThreads",
    params: { epicId, artifactType, artifactId },
    options: {
      enabled: options.enabled,
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      // A query with `enabled: false` (the hover popover, which reads cache and must never fire traffic) is unaffected either way: TanStack does not run an interval on a disabled query.
      poll: commentThreadsShouldPoll(options.laneDroppedAt),
    },
  });
}
