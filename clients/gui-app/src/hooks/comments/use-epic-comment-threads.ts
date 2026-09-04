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

/**
 * Query-key builder shared between the threads query and the mutation
 * invalidation paths in `use-comment-thread-mutations`. Co-located here
 * (rather than under `lib/query-keys/`) because the comment surface is the
 * sole consumer; promote when a second feature needs the same key shape.
 */
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
  /**
   * When the records lane stopped pushing, or `null` while it is up - the same
   * instant `useEpicLaneCommentThreadsDroppedAt` produces and
   * `resolveArtifactCommentThreads` orders by.
   *
   * Here it decides whether the table's poll cadence applies right now. See
   * {@link commentThreadsShouldPoll} for why the lane's liveness has to reach
   * the query at all.
   */
  readonly laneDroppedAt: number | null;
}

/**
 * Whether the poll should run its table-owned cadence, given the lane's state.
 *
 * WHY THE QUERY HAS TO KNOW. `resolveArtifactCommentThreads` hands precedence
 * back to the poll once it has answered SINCE the lane dropped, and its doc
 * used to justify having no lane-triggered refetch by saying the query
 * "already refetches on window focus and after its stale window". The second
 * half was never true: `staleTime` marks data stale, it does not SCHEDULE a
 * request - only a mount, a focus, a reconnect or an invalidation fetches, and
 * a lane-status transition invalidates nothing. So on a continuously focused
 * window with a permanently dead lane and no local mutation, the poll never
 * ran again and the resolver waited forever on an event that could not arrive:
 * remote additions, deletions and status changes stayed frozen behind retained
 * lane rows. Which is the resurrection bug the ordering rule was added to
 * prevent, arriving by the other road.
 *
 * A cadence rather than an invalidation on the drop EDGE, because the harm is
 * not confined to the transition: while the lane stays down the poll is the
 * only source, so it has to keep answering, not answer once.
 *
 * A BOOLEAN, not an interval, because the interval is not this module's to
 * choose: `useHostQuery` reserves `refetchInterval` and owns cadence through
 * `HOST_METHOD_POLL_TABLE`, where this method's `{ kind: "fixed" }` entry
 * lives. All a caller may say is whether the table's cadence applies right
 * now. That seam also sets `refetchIntervalInBackground: false`, which is
 * wanted here rather than merely tolerated: a blurred window stops polling and
 * `refetchOnWindowFocus` covers the moment it returns, so the two answer both
 * halves without either running twice.
 *
 * Pure and exported so the policy is pinnable without a QueryClient harness -
 * the same reason `resolveArtifactCommentThreads` is a pure function beside
 * its hook.
 */
export function commentThreadsShouldPoll(
  laneDroppedAt: number | null,
): boolean {
  return laneDroppedAt !== null;
}

/**
 * TanStack Query backed read of the host's comment thread snapshot for a
 * single artifact. The host `epic.listCommentThreads` resolver wraps
 * `CommentThreadManager.readArtifactCommentThreads`, which is fed by the
 * artifact room's `TiptapCollabProvider` Y.Doc, cloud-backed or locally
 * durable. Mutations from gui-app + Views land in the same Y.Doc, so this
 * query always returns the union of writers.
 *
 * Cross-product writes from Views currently rely on TanStack Query's default
 * stale window plus mutation-driven invalidation; a future iteration should
 * subscribe to Y.Doc updates over `/stream` and invalidate eagerly so the
 * sidebar updates without requiring a tab focus.
 *
 * `client` is the caller's, and there is deliberately no app-wide wrapper: every
 * mount of this query is Epic-scoped - the collab TILE and its hover popover
 * (tab client), and the Epic sidebar (session client). An app-wide read here
 * asked the machine the app happened to be pointed at for another host's
 * threads during an A→B re-point, and keyed the cache under that host (D15).
 */
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
      // The table's cadence, but only while the lane is down - see
      // `commentThreadsShouldPoll`. A query with `enabled: false` (the hover
      // popover, which reads cache and must never fire traffic) is unaffected
      // either way: TanStack does not run an interval on a disabled query.
      poll: commentThreadsShouldPoll(options.laneDroppedAt),
    },
  });
}
