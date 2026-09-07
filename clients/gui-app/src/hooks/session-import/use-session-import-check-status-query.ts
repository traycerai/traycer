import { useId } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { SessionImportStatusResponse } from "@traycer/protocol/host/session-import/contracts";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostQuery } from "@/hooks/host/use-host-query";
import type { StreamRuntimeBinding } from "@/lib/host/stream-runtime-context";

/** A fresh check for each wizard opening and transport, before submission. */
export function useSessionImportCheckStatus(
  binding: StreamRuntimeBinding | null,
  enabled: boolean,
): UseQueryResult<SessionImportStatusResponse, HostRpcError> {
  const checkId = useId();
  const hostId = binding?.hostId ?? null;
  const client = useHostClientForHostId(hostId);
  return useHostQuery({
    client: hostId === null ? null : client,
    method: "sessionImport.status",
    params: {},
    // A Settings snapshot must not enable a newly opened wizard. A new
    // transport must also answer for itself after reconnecting. These keys
    // still live beneath status(hostId), so completion invalidates them.
    cacheKeyIdentity: [checkId, binding?.wsStreamClient.instanceId ?? null],
    options: { enabled, staleTime: 0, gcTime: 0, retry: false },
  });
}
