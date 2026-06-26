import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type {
  AgentSelectionGuideGlobalGetResponse,
  AgentSelectionGuideGlobalOnboardingDraftGetResponse,
  AgentSelectionGuideGlobalSetRequest,
  AgentSelectionGuideGlobalSetResponse,
} from "@traycer/protocol/host/agent/shared";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { agentMutationKeys, hostQueryKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";

type SetGlobalContext = {
  readonly hostId: string | null;
};

function recognizedDefaultsWithGeneratedDefault(
  previous: readonly string[] | undefined,
  generatedDefaultContent: string,
): string[] {
  return [...new Set([...(previous ?? []), generatedDefaultContent])];
}

/**
 * Writes the global agent selection guide for the active host. Backs both the
 * debounced auto-save and explicit user edits. The read query is updated
 * in-place instead of refetched so active editor drafts stay local.
 */
export function useAgentSelectionGuideSetGlobalMutation(): UseMutationResult<
  AgentSelectionGuideGlobalSetResponse,
  HostRpcError,
  AgentSelectionGuideGlobalSetRequest,
  SetGlobalContext
> {
  const client = useHostClient();
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "agent.selectionGuide.setGlobal",
    SetGlobalContext
  >({
    client,
    method: "agent.selectionGuide.setGlobal",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: agentMutationKeys.setGlobalSelectionGuide(),
      onMutate: () => ({ hostId: client.getActiveHostId() ?? null }),
      onSuccess: (data, _variables, ctx) => {
        if (ctx.hostId === null) return;
        queryClient.setQueriesData<AgentSelectionGuideGlobalGetResponse>(
          {
            queryKey: hostQueryKeys.methodScope(
              ctx.hostId,
              "agent.selectionGuide.getGlobal",
            ),
          },
          (previous) => ({
            content: data.content,
            generatedDefaultContent: data.generatedDefaultContent,
            providersSettled: previous?.providersSettled ?? true,
            recognizedDefaultContents: recognizedDefaultsWithGeneratedDefault(
              previous?.recognizedDefaultContents,
              data.generatedDefaultContent,
            ),
          }),
        );
        queryClient.setQueriesData<AgentSelectionGuideGlobalOnboardingDraftGetResponse>(
          {
            queryKey: hostQueryKeys.methodScope(
              ctx.hostId,
              "agent.selectionGuide.getGlobalOnboardingDraft",
            ),
          },
          (previous) => ({
            content: data.content,
            generatedDefaultContent: data.generatedDefaultContent,
            providersSettled: previous?.providersSettled ?? true,
            recognizedDefaultContents: recognizedDefaultsWithGeneratedDefault(
              previous?.recognizedDefaultContents,
              data.generatedDefaultContent,
            ),
          }),
        );
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't save agent instructions."),
    },
  });
}
