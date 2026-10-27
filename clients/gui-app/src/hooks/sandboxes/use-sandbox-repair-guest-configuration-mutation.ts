import { useCallback } from "react";
import {
  useQueryClient,
  hashKey,
  type Mutation,
  type MutationStatus,
  type UseMutationResult,
} from "@tanstack/react-query";
import { v4 as uuidv4 } from "uuid";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostScopedMutation } from "@/hooks/host/use-host-scoped-mutation";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useMutationStateOf } from "@/hooks/use-mutation-state-of";
import {
  sandboxMutationKeys,
  hostQueryKeys,
  sandboxQueryKeys,
} from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

const NO_INVALIDATIONS: readonly [] = [];
const applyingOperationIds = new Map<string, string>();

function selectSettingsOperation(mutation: Mutation): {
  order: number;
  status: MutationStatus;
  data: unknown;
} {
  return {
    order: mutation.mutationId,
    status: mutation.state.status,
    data: mutation.state.data,
  };
}

export function useSandboxSettingsOperation(
  hostId: string,
): "pending" | "failed" | null {
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const key = hashKey(sandboxMutationKeys.repairGuestConfigurationOn(hostId));
  const predicate = useCallback(
    (mutation: Mutation) =>
      hashKey(mutation.options.mutationKey ?? []) === key &&
      typeof mutation.state.context === "object" &&
      mutation.state.context !== null &&
      "userId" in mutation.state.context &&
      mutation.state.context.userId === userId,
    [key, userId],
  );
  const operations = useMutationStateOf({ predicate }, selectSettingsOperation);
  const latest = operations.reduce<(typeof operations)[number] | null>(
    (best, operation) =>
      best === null || operation.order > best.order ? operation : best,
    null,
  );
  if (latest?.status === "pending") return "pending";
  if (
    latest?.status === "error" ||
    (latest?.status === "success" &&
      typeof latest.data === "object" &&
      latest.data !== null &&
      "guestConfigured" in latest.data &&
      latest.data.guestConfigured === false)
  )
    return "failed";
  return null;
}

/**
 * `host.sandbox.repairGuestConfiguration` on the surface's host: re-applies a
 * sandbox's guest configuration (trust files, hosts aliases, the env layer,
 * git setup) and refetches it. The card's repair action, so it runs on the
 * host the card describes - the Settings scope.
 *
 * Nothing is invalidated here: the outcome reaches the card on the sandbox
 * row's next read (`guestConfigured` rides the host's heartbeat), which the
 * caller asks for once this settles.
 */
export function useSandboxRepairGuestConfiguration(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "host.sandbox.repairGuestConfiguration">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "host.sandbox.repairGuestConfiguration">,
  { readonly hostId: string | null }
> {
  return useHostScopedMutation({
    method: "host.sandbox.repairGuestConfiguration",
    mutationKey: sandboxMutationKeys.repairGuestConfiguration(),
    errorMessage: "Couldn't repair this sandbox's setup.",
    invalidateMethods: NO_INVALIDATIONS,
  });
}

/**
 * The same repair on a named sandbox host, for a surface that lists many
 * (Settings › Sandboxes' `Retry applying`): addressed to that host's own
 * client, never the window's.
 */
export function useSandboxRepairGuestConfigurationOnHost(
  hostId: string,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "host.sandbox.repairGuestConfiguration">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "host.sandbox.repairGuestConfiguration">
> {
  const client = useHostClientForHostId(hostId);
  const queryClient = useQueryClient();
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const operationKey = `${userId}:${hostId}`;
  return useHostMutation<
    HostRpcRegistry,
    "host.sandbox.repairGuestConfiguration"
  >({
    client,
    method: "host.sandbox.repairGuestConfiguration",
    options: {
      mutationKey: sandboxMutationKeys.repairGuestConfigurationOn(hostId),
      onMutate: () => ({ userId }),
      onSettled: () => {
        applyingOperationIds.delete(operationKey);
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(hostId, "environment.status"),
        });
        void queryClient.invalidateQueries({
          queryKey: sandboxQueryKeys.listAll(),
        });
      },
    },
    mapVariables: (variables) => {
      let operationId = applyingOperationIds.get(operationKey);
      if (operationId === undefined) {
        operationId = uuidv4();
        applyingOperationIds.set(operationKey, operationId);
      }
      return {
        ...variables,
        operationId: variables.operationId ?? operationId,
      };
    },
  });
}
