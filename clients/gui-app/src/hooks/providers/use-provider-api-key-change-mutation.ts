import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { traycerInfo } from "@traycer-clients/shared/platform/traycer-info";
import {
  changeProviderApiKey,
  type ProviderApiKeyChange,
  type ProviderApiKeyChangeResponse,
} from "@traycer-clients/shared/host-client/provider-api-key-change";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  hostRpcServingTierHostId,
  readProcessHostRpcTierPlan,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import { useHostClient, useAuthService } from "@/lib/host";
import { withHostMutationLifecycleBoundary } from "@/hooks/host/use-host-query";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import { PROVIDER_INVALIDATIONS } from "@/hooks/providers/invalidations";
import { hostQueryKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { CLIENT_UPDATE_SKEW_COPY } from "@/lib/host/version-skew-copy";
import { useOpenLink } from "@/lib/links/open-link";
import { isMobileApp, getMobileAppPlatform } from "@/lib/mobile-app";
import { mobileStoreUpdateNote } from "@/components/host/client-update-copy";

const PARTIAL_CHANGE_MESSAGES = {
  set: "The API key was saved, but this computer is not using it.",
  clear: "The API key was removed, but this computer was not changed.",
} as const;

const UNAVAILABLE_CHANGE_MESSAGES = {
  set: "The API key was saved, but this computer may not be using it.",
  clear: "The API key was removed, but this computer may not have changed.",
} as const;

interface ProviderApiKeyChangeMutationArgs<Variables> {
  readonly method: "providers.setApiKey" | "providers.clearApiKey";
  readonly mutationKey: readonly unknown[];
  readonly errorMessage: string;
  readonly changeOf: (variables: Variables) => {
    readonly providerId: ProviderId;
    readonly change: ProviderApiKeyChange;
  };
}

/** Provider-key edits include the client's broker request in the mutation's lifetime. */
export function useProviderApiKeyChangeMutation<Variables>(
  args: ProviderApiKeyChangeMutationArgs<Variables>,
): UseMutationResult<
  ProviderApiKeyChangeResponse,
  HostRpcError,
  Variables,
  { readonly hostId: string | null }
> {
  const client = useHostClient();
  const queryClient = useQueryClient();
  const auth = useAuthService();
  const openLink = useOpenLink();
  return useMutation<
    ProviderApiKeyChangeResponse,
    HostRpcError,
    Variables,
    { readonly hostId: string | null }
  >(
    withHostMutationLifecycleBoundary(args.method, {
      mutationKey: args.mutationKey,
      retry: false,
      onMutate: () => ({ hostId: client.getActiveHostId() }),
      mutationFn: (variables) =>
        withHostQueryErrorBoundary(args.method, async () => {
          const { providerId, change } = args.changeOf(variables);
          const outcome = await changeProviderApiKey(
            client,
            auth,
            providerId,
            change,
          );
          if (
            outcome.result !== null &&
            outcome.result !== "installed" &&
            outcome.result !== "unchanged"
          ) {
            toastFromHostError(
              new HostRpcError({
                code: "RPC_ERROR",
                requestId: "provider-key-change",
                method: args.method,
                message: "Provider key change did not settle",
                fatalDetails: null,
              }),
              (outcome.result === "unavailable"
                ? UNAVAILABLE_CHANGE_MESSAGES
                : PARTIAL_CHANGE_MESSAGES)[change.action],
            );
          }
          return { ...outcome.response, keyChangeResult: outcome.result };
        }),
      onSuccess: () => {
        Analytics.getInstance().track(
          AnalyticsEvent.ProviderConfigurationChanged,
          { operation: "api_key" },
        );
      },
      onError: (error) => {
        if (error.code === "update-required") {
          if (isMobileApp()) {
            toast.error(CLIENT_UPDATE_SKEW_COPY.title, {
              description: mobileStoreUpdateNote(getMobileAppPlatform()),
            });
          } else {
            toast.error(CLIENT_UPDATE_SKEW_COPY.title, {
              action: {
                label: CLIENT_UPDATE_SKEW_COPY.action,
                onClick: () => {
                  void openLink(traycerInfo.releasesPage, "docs", null);
                },
              },
            });
          }
          return;
        }
        toastFromHostError(error, args.errorMessage);
      },
      onSettled: (_data, _error, _variables, context) => {
        if (context === undefined || context.hostId === null) return;
        for (const method of PROVIDER_INVALIDATIONS) {
          void queryClient.invalidateQueries({
            queryKey: hostQueryKeys.methodScope(
              hostRpcServingTierHostId(
                method,
                context.hostId,
                readProcessHostRpcTierPlan(),
                null,
              ),
              method,
            ),
          });
        }
      },
    }),
  );
}
