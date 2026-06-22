import type { RuntimeCapabilitiesRequest } from "@traycer/protocol/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";

const RUNTIME_CAPABILITIES_REQUEST: RuntimeCapabilitiesRequest = {};
const RUNTIME_CAPABILITIES_STALE_MS = 15 * 60 * 1000;

/**
 * Runtime capabilities are default-host scoped app configuration. Chat
 * transcript/session state remains tab-scoped through `useTabHostId()`.
 */
export function useHostRuntimeCapabilitiesQuery() {
  const client = useHostClient();
  return useHostQuery<HostRpcRegistry, "host.getRuntimeCapabilities">({
    client,
    method: "host.getRuntimeCapabilities",
    params: RUNTIME_CAPABILITIES_REQUEST,
    options: {
      retry: false,
      staleTime: RUNTIME_CAPABILITIES_STALE_MS,
    },
  });
}
