import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  CloudChatSummary,
  ListCloudChatsResponse,
} from "@traycer/protocol/host/epic/cloud-chat";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQueryWithResponseMap } from "@/hooks/host/use-host-query";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import {
  cloudDraftIngestSeq,
  draftsCloudScopeId,
  subscribeDraftsCloudScope,
} from "@/lib/drafts/draft-mirror-coordinator";
import { cloudChatListCacheKeyIdentity } from "@/lib/chats/cloud-chat-list-cache";
import { cloudDraftsDirectoryIsVisible } from "@/lib/drafts/cloud-drafts-visibility";

const EMPTY_CLOUD_DRAFTS: ReadonlyArray<CloudChatSummary> = [];

/**
 * The cached directory carries the cloud ingest sequence captured at the
 * DISPATCH of the request that produced it (`captureRequestContext` runs
 * inside the queryFn immediately before the request leaves). Stored WITH
 * the data, so a snapshot can never be paired with another request's
 * fence: a background refetch that starts while stale data is showing
 * leaves the old data's fence untouched until its own response lands.
 */
interface CloudDraftsDirectoryData extends ListCloudChatsResponse {
  readonly fenceSeq: number;
}

export interface CloudDraftsDirectory {
  /**
   * False for free-tier, old-host, or publication-not-ready. The
   * cloud-chat "absent section, not a broken tab" contract.
   */
  readonly visible: boolean;
  /** The list has been fetched at least once; `chats` is the directory. */
  readonly settled: boolean;
  readonly scopeId: string | null;
  readonly chats: ReadonlyArray<CloudChatSummary>;
  /**
   * The cloud ingest sequence current when the request that produced
   * `chats` was dispatched. An absence in `chats` says nothing about a row
   * ingested after that, so the sweep fences on it.
   */
  readonly snapshotIngestSeq: () => number;
}

function useDraftsCloudScopeId(hostId: string | null): string | null {
  return useSyncExternalStore(
    subscribeDraftsCloudScope,
    () => (hostId === null ? null : draftsCloudScopeId(hostId)),
    () => null,
  );
}

/**
 * Whether the personal-drafts cloud directory may render. Hidden when
 * the connected host cannot list published drafts — never a failure
 * surface.
 */
export function useCloudDraftsDirectory(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
): CloudDraftsDirectory {
  const viewerUserId = useCloudChatViewerId();
  const scopeId = useDraftsCloudScopeId(hostId);
  const query = useHostQueryWithResponseMap<
    HostRpcRegistry,
    "epic.listCloudChats",
    CloudDraftsDirectoryData,
    number
  >({
    cacheKeyIdentity: cloudChatListCacheKeyIdentity(viewerUserId),
    client,
    method: "epic.listCloudChats",
    params: { taskId: scopeId ?? "" },
    captureRequestContext: cloudDraftIngestSeq,
    mapResponse: ({ response, requestContext }) => ({
      ...response,
      fenceSeq: requestContext ?? 0,
    }),
    options: {
      enabled:
        client !== null &&
        scopeId !== null &&
        scopeId.length > 0 &&
        viewerUserId.length > 0,
      staleTime: 30_000,
      retry: false,
    },
  });
  const visible = useMemo(
    () =>
      cloudDraftsDirectoryIsVisible({
        scopeId,
        error: query.error,
        isPending: query.isPending,
        isSuccess: query.isSuccess,
      }),
    [query.error, query.isPending, query.isSuccess, scopeId],
  );
  const chats = visible
    ? (query.data?.chats ?? EMPTY_CLOUD_DRAFTS)
    : EMPTY_CLOUD_DRAFTS;
  const fenceSeq = visible ? (query.data?.fenceSeq ?? 0) : 0;
  const snapshotIngestSeq = useCallback(() => fenceSeq, [fenceSeq]);
  return {
    visible,
    settled: visible && query.isSuccess,
    scopeId,
    chats,
    snapshotIngestSeq,
  };
}
