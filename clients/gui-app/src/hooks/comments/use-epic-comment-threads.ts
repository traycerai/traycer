import type { UseQueryResult } from "@tanstack/react-query";
import { type EpicArtifactKind } from "@traycer/protocol/common/registry";
import type {
  ListCommentThreadsRequest,
  ListCommentThreadsResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient } from "@/lib/host";
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
}

/**
 * TanStack Query backed read of the host's comment thread snapshot for a
 * single artifact. The host `epic.listCommentThreads` resolver wraps
 * `CommentThreadManager.readArtifactCommentThreads`, which is fed by the
 * Tiptap Cloud `TiptapCollabProvider` Y.Doc. Mutations from gui-app + Views
 * land in the same Y.Doc, so this query always returns the union of writers.
 *
 * Cross-product writes from Views currently rely on TanStack Query's default
 * stale window plus mutation-driven invalidation; a future iteration should
 * subscribe to Y.Doc updates over `/stream` and invalidate eagerly so the
 * sidebar updates without requiring a tab focus.
 */
export function useEpicCommentThreads(
  epicId: string,
  artifactType: EpicArtifactKind,
  artifactId: string,
  options: UseEpicCommentThreadsOptions,
): UseQueryResult<ListCommentThreadsResponse, HostRpcError> {
  const client = useHostClient();
  return useHostQuery({
    cacheKeyIdentity: undefined,
    client,
    method: "epic.listCommentThreads",
    params: { epicId, artifactType, artifactId },
    options: {
      enabled: options.enabled,
      staleTime: 15_000,
      refetchOnWindowFocus: true,
    },
  });
}
