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
  providerNativeSubagentsWriteScope,
  providersMutationKeys,
} from "@/lib/query-keys";

// The choice lands in `provider-overrides.json` and is echoed back by
// `providers.list`, so that read is what needs refreshing and nothing else
// does: the switch changes neither availability nor credentials nor the model
// catalog - the same reasoning as `useProvidersSetAutoJudge`.
const NATIVE_SUBAGENTS_INVALIDATIONS: ReadonlyArray<
  keyof HostRpcRegistry & string
> = ["providers.list"];

/**
 * Turns one provider's built-in subagents on or off.
 *
 * An OPTIONAL host capability (`providers.setNativeSubagents` is registered
 * `degrade: { kind: "unsupported" }`), so the row that calls this gates on
 * `useHostMethodSupport(hostId, "providers.setNativeSubagents")` and draws
 * nothing for a host without it. Takes the `harnessId` it will write up front
 * because the write's `MutationScope` is fixed for the life of the observer
 * (see `providerNativeSubagentsWriteScope`).
 */
export function useProvidersSetNativeSubagents(
  harnessId: GuiHarnessId,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.setNativeSubagents">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.setNativeSubagents">,
  { readonly hostId: string | null }
> {
  const client = useHostClient();
  return useHostScopedMutationForClient(client, {
    method: "providers.setNativeSubagents",
    mutationKey: providersMutationKeys.setNativeSubagents(),
    errorMessage: "Couldn't save the native subagents setting.",
    invalidateMethods: NATIVE_SUBAGENTS_INVALIDATIONS,
    scope: providerNativeSubagentsWriteScope(
      client.getActiveHostId(),
      harnessId,
    ),
  });
}
