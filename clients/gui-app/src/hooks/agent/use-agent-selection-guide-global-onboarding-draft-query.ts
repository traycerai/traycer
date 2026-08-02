import type { UseQueryResult } from "@tanstack/react-query";
import type { AgentSelectionGuideGlobalOnboardingDraftGetResponse } from "@traycer/protocol/host/agent/shared";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

const GLOBAL_ONBOARDING_DRAFT_PARAMS = {};

/**
 * Reads the global guide for onboarding without creating the file when it is
 * missing. Null content means onboarding should keep the provider-derived
 * default as an in-memory draft until the user exits the flow.
 */
export function useAgentSelectionGuideGlobalOnboardingDraftQuery(): UseQueryResult<
  AgentSelectionGuideGlobalOnboardingDraftGetResponse,
  HostRpcError
> {
  const client = useHostClient();
  return useHostQuery({
    cacheKeyIdentity: undefined,
    client,
    method: "agent.selectionGuide.getGlobalOnboardingDraft",
    params: GLOBAL_ONBOARDING_DRAFT_PARAMS,
    options: {
      refetchOnMount: "always",
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: false,
    },
  });
}
