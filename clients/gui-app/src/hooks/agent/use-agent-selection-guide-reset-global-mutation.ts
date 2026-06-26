import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type {
  AgentSelectionGuideGlobalGetResponse,
  AgentSelectionGuideGlobalOnboardingDraftGetResponse,
  AgentSelectionGuideGlobalResetRequest,
  AgentSelectionGuideGlobalResetResponse,
} from "@traycer/protocol/host/agent/shared";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { agentMutationKeys, hostQueryKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";

type ResetGlobalContext = {
  readonly hostId: string | null;
};

function recognizedDefaultsWithGeneratedDefault(
  previous: readonly string[] | undefined,
  generatedDefaultContent: string,
): string[] {
  return [...new Set([...(previous ?? []), generatedDefaultContent])];
}

export function useAgentSelectionGuideResetGlobalMutation(): UseMutationResult<
  AgentSelectionGuideGlobalResetResponse,
  HostRpcError,
  AgentSelectionGuideGlobalResetRequest,
  ResetGlobalContext
> {
  const client = useHostClient();
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "agent.selectionGuide.resetGlobalToDefault",
    ResetGlobalContext
  >({
    client,
    method: "agent.selectionGuide.resetGlobalToDefault",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: agentMutationKeys.resetGlobalSelectionGuide(),
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
        toastFromHostError(error, "Couldn't reset agent instructions."),
    },
  });
}
