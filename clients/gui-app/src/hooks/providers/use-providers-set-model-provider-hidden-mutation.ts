import type { UseMutationResult } from "@tanstack/react-query";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import {
  providerModelProviderVisibilityWriteScope,
  providersMutationKeys,
} from "@/lib/query-keys";
import { useRequesterHostId } from "@/hooks/host/use-requester-host-id";

// The list lands in `provider-overrides.json` and is echoed back by
// `providers.list`, which is also what every model picker reads it from, so
// that read is the only one to refresh: the model catalog itself is unchanged.
const MODEL_PROVIDER_VISIBILITY_INVALIDATIONS: ReadonlyArray<
  keyof HostRpcRegistry & string
> = ["providers.list"];

/**
 * Shows or hides one OpenCode model provider in Traycer's model pickers.
 *
 * An OPTIONAL host capability (`providers.setModelProviderHidden` is
 * registered `degrade: { kind: "unsupported" }`), so the rows that call this
 * gate on `useHostMethodSupport` and draw no switch for a host without it.
 */
export function useProvidersSetModelProviderHidden(
  harnessId: GuiHarnessId,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.setModelProviderHidden">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.setModelProviderHidden">,
  { readonly hostId: string | null }
> {
  const client = useHostClient();
  const requesterHostId = useRequesterHostId(client);
  return useHostScopedMutationForClient(client, {
    method: "providers.setModelProviderHidden",
    mutationKey: providersMutationKeys.setModelProviderHidden(),
    errorMessage: "Couldn't change which providers show in the model picker.",
    invalidateMethods: MODEL_PROVIDER_VISIBILITY_INVALIDATIONS,
    scope: providerModelProviderVisibilityWriteScope(
      requesterHostId,
      harnessId,
    ),
  });
}
