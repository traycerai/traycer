import {
  queryOptions,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  EpicFileUnavailableReason,
  EpicFileVia,
  EpicReadFileResponse,
} from "@traycer/protocol/host/epic/files";
import { useEpicFileRpc, type EpicFileRpc } from "@/lib/files/epic-file-rpc";
import { stampHostRpcMethod } from "@/lib/host-rpc-policy/host-method-policy-table";
import { getConditionPollEpisodeCoordinator } from "@/lib/query/condition-poll-episode-coordinator";
import { hostQueryKeys } from "@/lib/query-keys";

/** One file version, and the transcript row it is opened from (if any). */
export interface EpicFileAddress {
  readonly epicId: string;
  readonly path: string;
  readonly sha256: string;
  /** The row the host decides the page's network policy from (§2.3). */
  readonly via: EpicFileVia | null;
}

export function epicFileTextQueryOptions(
  hostId: string,
  rpc: EpicFileRpc,
  address: EpicFileAddress,
) {
  const params = {
    epicId: address.epicId,
    path: address.path,
    sha256: address.sha256,
    via: address.via,
    want: { kind: "text" as const },
  };
  return queryOptions<EpicReadFileResponse, HostRpcError>({
    queryKey: [...hostQueryKeys.methodScope(hostId, "epic.readFile"), params],
    queryFn: ({ signal }) => rpc.readFile(params, signal),
    meta: stampHostRpcMethod(undefined, "epic.readFile"),
    // Content-addressed: a sha's bytes never change, so a hit never goes
    // stale. Only an unavailable answer is worth asking again (the table's
    // `epic.readFile` lanes): the bytes usually arrive on their own, and the
    // row promises to show the page when they do.
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

/** A text file's contents (a page's HTML) and the network policy it runs with. */
export function useEpicFileTextQuery(
  hostId: string,
  address: EpicFileAddress,
): UseQueryResult<EpicReadFileResponse, HostRpcError> {
  const rpc = useEpicFileRpc();
  const poll = getConditionPollEpisodeCoordinator(useQueryClient());
  return useQuery({
    ...epicFileTextQueryOptions(hostId, rpc, address),
    refetchInterval: poll.refetchIntervalFor("epic.readFile"),
  });
}

/** The line under a file the host cannot serve yet, per reason. */
export function epicFileUnavailableMessage(
  reason: EpicFileUnavailableReason,
): string {
  switch (reason) {
    case "upload-pending":
    case "missing":
      return "Still uploading from the host that made it. It shows here when it lands.";
    case "not-downloaded":
      return "Not on this device yet. Download it to show it here.";
    case "local-only":
      return "Its task keeps files on the host that made it. Open it there.";
    case "failed":
      return "Copying it to this device failed.";
  }
}
