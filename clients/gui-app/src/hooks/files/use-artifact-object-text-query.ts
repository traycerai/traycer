import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { EpicReadArtifactObjectResponse } from "@traycer/protocol/host/epic/files";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostQuery } from "@/hooks/host/use-host-query";

/** A captured HTML object, independent of its former files-plane path. */
export function useArtifactObjectTextQuery(
  hostId: string,
  address: { readonly epicId: string; readonly sha256: string },
): UseQueryResult<EpicReadArtifactObjectResponse, HostRpcError> {
  const client = useHostClientForHostId(hostId);
  return useHostQuery({
    client,
    method: "epic.readArtifactObject",
    params: { ...address, want: { kind: "text" } },
    cacheKeyIdentity: undefined,
    options: {
      // A served sha never changes. Pending and unavailable answers can.
      staleTime: (query) =>
        query.state.data?.kind === "text" ? Number.POSITIVE_INFINITY : 0,
      // useHostQuery supplies the method's condition poller and retry: false.
    },
  });
}
