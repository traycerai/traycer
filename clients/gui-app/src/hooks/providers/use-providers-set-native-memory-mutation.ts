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
  providerNativeMemoryWriteScope,
  providersMutationKeys,
} from "@/lib/query-keys";
import { useRequesterHostId } from "@/hooks/host/use-requester-host-id";

// The choice lands in `provider-overrides.json` and is echoed back by
// `providers.list`, so that read is what needs refreshing and nothing else
// does: the switch changes neither availability nor credentials nor the model
// catalog - the same reasoning as `useProvidersSetNativeSubagents`.
const NATIVE_MEMORY_INVALIDATIONS: ReadonlyArray<
  keyof HostRpcRegistry & string
> = ["providers.list"];

/**
 * Leaves one provider's own memory as it ships, or has Traycer turn it off for
 * the sessions it launches.
 *
 * An OPTIONAL host capability (`providers.setNativeMemory` is registered
 * `degrade: { kind: "unsupported" }`), so the row that calls this gates on
 * `useHostMethodSupport(hostId, "providers.setNativeMemory")` and draws
 * nothing for a host without it. Takes the `harnessId` it will write up front
 * because the write's `MutationScope` is fixed for the life of the observer
 * (see `providerNativeMemoryWriteScope`).
 */
export function useProvidersSetNativeMemory(
  harnessId: GuiHarnessId,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.setNativeMemory">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.setNativeMemory">,
  { readonly hostId: string | null }
> {
  const client = useHostClient();
  const requesterHostId = useRequesterHostId(client);
  return useHostScopedMutationForClient(client, {
    method: "providers.setNativeMemory",
    mutationKey: providersMutationKeys.setNativeMemory(),
    errorMessage: "Couldn't save the memories setting.",
    invalidateMethods: NATIVE_MEMORY_INVALIDATIONS,
    scope: providerNativeMemoryWriteScope(requesterHostId, harnessId),
  });
}
