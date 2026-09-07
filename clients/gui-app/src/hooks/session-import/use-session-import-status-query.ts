import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { SessionImportStatusResponse } from "@traycer/protocol/host/session-import/contracts";
import { useHostClient } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

const STATUS_PARAMS = {} as const;

/** The only thing this answers that the store cannot is what happened BEFORE this app session - a run left going by a quit, or the summary of one that finished last week. */
export function useSessionImportStatus(
  enabled: boolean,
): UseQueryResult<SessionImportStatusResponse, HostRpcError> {
  const client = useHostClient();
  return useHostQuery({
    cacheKeyIdentity: undefined,
    client,
    method: "sessionImport.status",
    params: STATUS_PARAMS,
    options: { enabled, staleTime: 5_000 },
  });
}
