import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { hostQueryKeys, providersMutationKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";

type AnswerProfileNameRequest = RequestOfMethod<
  HostRpcRegistry,
  "providers.answerProfileName"
>;
type AnswerProfileNameResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.answerProfileName"
>;
type ProvidersListResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.list"
>;

type AnswerProfileNameMutationResult = UseMutationResult<
  AnswerProfileNameResponse,
  HostRpcError,
  AnswerProfileNameRequest,
  { readonly hostId: string | null }
>;

/** Settled at once, not on the list's re-read; if two people pick together the re-read shows the winner. */
function settleRowName(
  previous: ProvidersListResponse | undefined,
  request: AnswerProfileNameRequest,
  label: string,
): ProvidersListResponse | undefined {
  if (previous === undefined) return previous;
  return {
    ...previous,
    providers: previous.providers.map((provider) =>
      provider.providerId !== request.providerId
        ? provider
        : {
            ...provider,
            profiles: provider.profiles.map((profile) =>
              profile.profileId === request.profileId
                ? { ...profile, label, otherNames: [] }
                : profile,
            ),
          },
    ),
  };
}

/** Rename sends it too on a row with other names, so its failure reads as a rename's. */
export function useProvidersAnswerProfileNameForClient(
  client: HostClient<HostRpcRegistry> | null,
): AnswerProfileNameMutationResult {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "providers.answerProfileName",
    { readonly hostId: string | null }
  >({
    client,
    method: "providers.answerProfileName",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: providersMutationKeys.answerProfileName(),
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onSuccess: (data, variables, context) => {
        if (context.hostId === null) return;
        queryClient.setQueryData<ProvidersListResponse>(
          hostQueryKeys.method<HostRpcRegistry, "providers.list">(
            context.hostId,
            "providers.list",
            { native: null },
          ),
          (previous) => settleRowName(previous, variables, data.label),
        );
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(context.hostId, "providers.list"),
        });
      },
      onError: (error) => toastFromHostError(error, "Couldn't rename profile."),
    },
  });
}
