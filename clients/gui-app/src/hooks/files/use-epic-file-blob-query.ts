import { useEffect } from "react";
import {
  queryOptions,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  readFileBlob,
  readSignedUrl,
  type ByteSourceResult,
  type SignedUrlResult,
  urlRenewalDelayMs,
} from "@/lib/files/byte-source";
import { useEpicFileRpc, type EpicFileRpc } from "@/lib/files/epic-file-rpc";
import type { EpicFileAddress } from "@/hooks/files/use-epic-file-text-query";
import { stampHostRpcMethod } from "@/lib/host-rpc-policy/host-method-policy-table";
import { getConditionPollEpisodeCoordinator } from "@/lib/query/condition-poll-episode-coordinator";
import { hostQueryKeys } from "@/lib/query-keys";

/**
 * A finished Blob stays warm a minute after its viewer unmounts - long enough
 * for a tab switch or a scroll-back - and no longer: a 128 MiB PDF cached for
 * the default five minutes is memory nothing is looking at.
 */
const BLOB_GC_MS = 60_000;

function blobKey(hostId: string, address: EpicFileAddress, cap: number | null) {
  return [
    ...hostQueryKeys.methodScope(hostId, "epic.readFile"),
    {
      epicId: address.epicId,
      path: address.path,
      sha256: address.sha256,
      via: address.via,
      want: { kind: "blob", cap },
    },
  ] as const;
}

export function epicFileBlobQueryOptions(
  hostId: string,
  rpc: EpicFileRpc,
  address: EpicFileAddress,
  maxBytes: number | null,
) {
  return queryOptions<ByteSourceResult, HostRpcError>({
    queryKey: blobKey(hostId, address, maxBytes),
    queryFn: ({ signal }) =>
      readFileBlob((request, s) => rpc.readFile(request, s), address, {
        maxBytes,
        onProgress: null,
        signal,
      }),
    meta: stampHostRpcMethod(undefined, "epic.readFile"),
    // Content-addressed: a sha's bytes never change. An unavailable answer is
    // asked again on the table's `epic.readFile` lanes.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: BLOB_GC_MS,
    retry: false,
  });
}

/** A file's bytes as one Blob, read in spans through `epic.readFile`. */
export function useEpicFileBlobQuery(
  hostId: string,
  address: EpicFileAddress,
  maxBytes: number | null,
): UseQueryResult<ByteSourceResult, HostRpcError> {
  const rpc = useEpicFileRpc();
  const poll = getConditionPollEpisodeCoordinator(useQueryClient());
  return useQuery({
    ...epicFileBlobQueryOptions(hostId, rpc, address, maxBytes),
    refetchInterval: poll.refetchIntervalFor("epic.readFile"),
  });
}

export interface SignedUrlAnswer {
  readonly result: SignedUrlResult;
  /** When this answer arrived: the base the 80 % renewal is measured from. */
  readonly receivedAt: number;
}

export function epicFileSignedUrlQueryOptions(
  hostId: string,
  rpc: EpicFileRpc,
  address: EpicFileAddress,
  enabled: boolean,
) {
  const params = {
    epicId: address.epicId,
    path: address.path,
    sha256: address.sha256,
    via: address.via,
    want: { kind: "url" as const },
  };
  return queryOptions<SignedUrlAnswer, HostRpcError>({
    queryKey: [
      ...hostQueryKeys.methodScope(hostId, "epic.readFile"),
      params,
    ] as const,
    queryFn: async ({ signal }) => ({
      result: await readSignedUrl(
        (request, s) => rpc.readFile(request, s),
        params,
        signal,
      ),
      receivedAt: Date.now(),
    }),
    meta: stampHostRpcMethod(undefined, "epic.readFile"),
    enabled,
    // A signed URL is only good for its lifetime. Renewal is the hook's timer;
    // `staleTime: 0` keeps a remount from serving a lapsed one.
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

/**
 * A published file's signed URL, renewed at 80 % of its lifetime. `refetch` is
 * the second renewal path: the viewer calls it once on a media 403, the case
 * where the clock and the server disagree.
 */
export function useEpicFileSignedUrl(
  hostId: string,
  address: EpicFileAddress,
  enabled: boolean,
): UseQueryResult<SignedUrlAnswer, HostRpcError> {
  const rpc = useEpicFileRpc();
  const poll = getConditionPollEpisodeCoordinator(useQueryClient());
  const query = useQuery({
    ...epicFileSignedUrlQueryOptions(hostId, rpc, address, enabled),
    // Only the unavailable recheck: renewal is not a condition poll.
    refetchInterval: poll.refetchIntervalFor("epic.readFile"),
  });
  const { data: answer, refetch } = query;
  useEffect(() => {
    if (!enabled || answer === undefined || answer.result.kind !== "url") {
      return;
    }
    const timer = window.setTimeout(
      () => void refetch(),
      urlRenewalDelayMs(answer.result.expiresAt, answer.receivedAt),
    );
    return () => window.clearTimeout(timer);
  }, [enabled, answer, refetch]);
  return query;
}

/**
 * Drops every cached `epic.readFile` answer for one file - text, blob and URL -
 * so a viewer that was showing "not downloaded" reads again. Matched on the
 * key's params object, which is always the last element.
 */
export function invalidateEpicFileReads(
  queryClient: QueryClient,
  hostId: string,
  address: Pick<EpicFileAddress, "path" | "sha256">,
): Promise<void> {
  const scope = hostQueryKeys.methodScope(hostId, "epic.readFile");
  return queryClient.invalidateQueries({
    predicate: ({ queryKey }) => {
      if (scope.some((part, index) => queryKey[index] !== part)) return false;
      const params: unknown = queryKey[scope.length];
      return (
        typeof params === "object" &&
        params !== null &&
        "path" in params &&
        "sha256" in params &&
        params.path === address.path &&
        params.sha256 === address.sha256
      );
    },
  });
}
