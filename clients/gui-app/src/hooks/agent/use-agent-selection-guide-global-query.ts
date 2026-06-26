import type { UseQueryResult } from "@tanstack/react-query";
import type { AgentSelectionGuideGlobalGetResponse } from "@traycer/protocol/host/agent/shared";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

// Stable params identity so the host-scoped query key stays referentially
// constant across renders.
const GLOBAL_GUIDE_PARAMS = {};
const GLOBAL_GUIDE_PROVIDER_SETTLE_POLL_MS = 750;

/**
 * Reads the global agent selection guide and the current provider-based
 * default for the active host. Device-scoped: the file lives at ~/.traycer/ on
 * whichever host is active, so the query rebinds when the active host changes.
 */
export function useAgentSelectionGuideGlobalQuery(): UseQueryResult<
  AgentSelectionGuideGlobalGetResponse,
  HostRpcError
> {
  const client = useHostClient();
  return useHostQuery({
    client,
    method: "agent.selectionGuide.getGlobal",
    params: GLOBAL_GUIDE_PARAMS,
    options: {
      refetchInterval: (query) => {
        const data = query.state.data;
        if (data !== undefined && !data.providersSettled) {
          return GLOBAL_GUIDE_PROVIDER_SETTLE_POLL_MS;
        }
        return false;
      },
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: false,
    },
  });
}
