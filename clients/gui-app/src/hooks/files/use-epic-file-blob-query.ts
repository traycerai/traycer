import {
  queryOptions,
  useQuery,
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
import { hostQueryKeys } from "@/lib/query-keys";

/** How often a not-yet-available answer is asked again (see the text query). */
const UNAVAILABLE_RECHECK_MS = 15_000;

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
    // Content-addressed: a sha's bytes never change.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: BLOB_GC_MS,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.kind === "unavailable" ? UNAVAILABLE_RECHECK_MS : false,
  });
}

/** A file's bytes as one Blob, read in spans through `epic.readFile`. */
export function useEpicFileBlobQuery(
  hostId: string,
  address: EpicFileAddress,
  maxBytes: number | null,
): UseQueryResult<ByteSourceResult, HostRpcError> {
  const rpc = useEpicFileRpc();
  return useQuery(epicFileBlobQueryOptions(hostId, rpc, address, maxBytes));
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
    enabled,
    // A signed URL is only good for its lifetime. Renewal is the interval
    // below; `staleTime: 0` keeps a remount from serving a lapsed one.
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchInterval: (query) => {
      const answer = query.state.data;
      if (answer === undefined) return false;
      if (answer.result.kind === "unavailable") return UNAVAILABLE_RECHECK_MS;
      return urlRenewalDelayMs(answer.result.expiresAt, answer.receivedAt);
    },
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
  return useQuery(epicFileSignedUrlQueryOptions(hostId, rpc, address, enabled));
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
