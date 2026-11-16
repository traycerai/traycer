import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import {
  HostRequestAbortedError,
  HostRpcError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ProviderKeyProviderId,
  ProviderKeyRecordChangeResult,
} from "@traycer-clients/shared/host-client/provider-api-key-change";
import { usePressCapturedMutation } from "@/hooks/use-press-captured-mutation";
import type { CloudProviderKeyScope } from "@/hooks/providers/use-cloud-provider-api-key-query";
import { useAuthService } from "@/lib/host";
import { toastFromHostError } from "@/lib/host-error-toast";
import { cloudProviderKeyKeys } from "@/lib/query-keys/cloud-provider-key-keys";

export interface CloudProviderKeyChange {
  readonly action: "set" | "clear";
}

interface CapturedKeyChange {
  readonly action: CloudProviderKeyChange["action"];
  readonly environmentId: string;
  readonly providerId: ProviderKeyProviderId;
  readonly onOriginSignIn: () => boolean;
  readonly readValue: () => string;
}

function abandonedKeyChange(
  mayHaveDispatched: boolean,
): HostRequestAbortedError {
  return new HostRequestAbortedError({
    message: "Couldn't save the API key.",
    requestId: "",
    method: "provider-keys.change",
    mayHaveDispatched,
  });
}

export function useCloudProviderApiKeyMutation(
  scope: CloudProviderKeyScope,
  providerId: ProviderKeyProviderId,
  readValue: () => string,
  clearValueInput: () => void,
): UseMutationResult<
  ProviderKeyRecordChangeResult,
  HostRpcError,
  CloudProviderKeyChange
> {
  const auth = useAuthService();
  const queries = useQueryClient();
  const recordsKey = cloudProviderKeyKeys.records(
    scope.viewerId,
    scope.identityGeneration,
    scope.environmentId,
  );
  return usePressCapturedMutation<
    ProviderKeyRecordChangeResult,
    HostRpcError,
    CloudProviderKeyChange,
    CapturedKeyChange
  >(
    (variables) => {
      const chosen = auth.chosenSignIn();
      if (
        !scope.canEdit ||
        scope.environmentId === "" ||
        scope.viewerId === "" ||
        chosen.userId !== scope.viewerId ||
        chosen.identityGeneration !== scope.identityGeneration
      ) {
        throw abandonedKeyChange(false);
      }
      return {
        action: variables.action,
        environmentId: scope.environmentId,
        providerId,
        onOriginSignIn: auth.environmentCloud().onOriginSignIn,
        readValue,
      };
    },
    {
      mutationKey: cloudProviderKeyKeys.change(
        scope.viewerId,
        scope.identityGeneration,
        scope.environmentId,
        providerId,
      ),
      retry: false,
      mutationFn: async (_variables, captured) => {
        if (!captured.onOriginSignIn()) throw abandonedKeyChange(false);
        let apiKey = "";
        if (captured.action === "set") {
          try {
            apiKey = captured.readValue();
          } catch {
            throw abandonedKeyChange(false);
          }
        }
        // No await between the captured-person check and the verified-bearer leaf.
        if (!captured.onOriginSignIn()) throw abandonedKeyChange(false);
        try {
          const result = await auth.changeProviderKeyRecord(
            captured.environmentId,
            captured.providerId,
            captured.action === "set"
              ? { action: "set", apiKey }
              : { action: "clear" },
            null,
          );
          if (!captured.onOriginSignIn()) throw abandonedKeyChange(true);
          if (result.kind === "refused" || result.kind === "legacy") {
            throw new HostRpcError({
              code: result.kind === "refused" ? result.code : "RPC_ERROR",
              message:
                captured.action === "set"
                  ? "Couldn't save the API key."
                  : "Couldn't clear the API key.",
              requestId: "",
              method: "provider-keys.change",
              fatalDetails: null,
            });
          }
          return result;
        } finally {
          apiKey = "";
          // A lost reply may still have applied. Keep Save pending through this reread.
          if (captured.onOriginSignIn())
            await queries.invalidateQueries({
              queryKey: recordsKey,
              exact: true,
            });
        }
      },
      onError: (error, variables) =>
        toastFromHostError(
          error,
          variables.action === "set"
            ? "Couldn't save the API key."
            : "Couldn't clear the API key.",
        ),
      onSettled: clearValueInput,
    },
  );
}
