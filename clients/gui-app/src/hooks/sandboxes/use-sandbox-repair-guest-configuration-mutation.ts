import {
  useMutationState,
  useQueryClient,
  hashKey,
  type UseMutationResult,
} from "@tanstack/react-query";
import { v4 as uuidv4 } from "uuid";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostMethodSchemaVersion } from "@/hooks/host/use-host-supports-method";
import { toastFromHostError } from "@/lib/host-error-toast";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostMutation } from "@/hooks/host/use-host-query";
import {
  sandboxMutationKeys,
  hostQueryKeys,
  sandboxQueryKeys,
} from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

const REPAIR_METHOD = "host.sandbox.repairGuestConfiguration";
type RepairVariables = Record<string, never>;
type RepairMutation = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, typeof REPAIR_METHOD>,
  HostRpcError,
  RepairVariables
>;
const applyingOperationIds = new Map<string, string>();

/** Settings retry was introduced in 1.1; a method name alone proves no version. */
export function useSandboxRetryApplyingSupported(hostId: string): boolean {
  const version = useHostMethodSchemaVersion(hostId, REPAIR_METHOD);
  return version !== null && version.major === 1 && version.minor >= 1;
}

/** The guest-only fallback is offered only on the known 1.0 contract. */
export function useSandboxGuestSetupRepairSupported(hostId: string): boolean {
  const version = useHostMethodSchemaVersion(hostId, REPAIR_METHOD);
  return version !== null && version.major === 1 && version.minor === 0;
}

export function useSandboxSettingsOperation(
  hostId: string,
): "pending" | "failed" | null {
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const key = hashKey(sandboxMutationKeys.repairGuestConfigurationOn(hostId));
  const operations = useMutationState({
    filters: {
      predicate: (mutation) =>
        hashKey(mutation.options.mutationKey ?? []) === key &&
        typeof mutation.state.context === "object" &&
        mutation.state.context !== null &&
        "userId" in mutation.state.context &&
        mutation.state.context.userId === userId,
    },
    select: (mutation) => ({
      order: mutation.mutationId,
      status: mutation.state.status,
      data: mutation.state.data,
    }),
  });
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
      "settingsApplied" in latest.data &&
      latest.data.settingsApplied !== true)
  )
    return "failed";
  return null;
}

/** Guest setup repair on the surface's scoped host; it never acknowledges settings. */
export function useSandboxRepairGuestConfiguration(): RepairMutation {
  const client = useHostClient();
  return useGuestSetupRepair(
    client,
    sandboxMutationKeys.repairGuestConfiguration(),
  );
}

/** The legacy repair on a named host, isolated from combined settings operations. */
export function useSandboxRepairGuestSetupOnHost(
  hostId: string,
): RepairMutation {
  const client = useHostClientForHostId(hostId);
  return useGuestSetupRepair(
    client,
    sandboxMutationKeys.repairGuestSetupOn(hostId),
  );
}

function useGuestSetupRepair(
  client: HostRequester<HostRpcRegistry> | null,
  mutationKey: readonly unknown[],
): RepairMutation {
  return useHostMutation<
    HostRpcRegistry,
    typeof REPAIR_METHOD,
    unknown,
    RepairVariables
  >({
    client,
    method: REPAIR_METHOD,
    mapVariables: () => ({ operationId: null }),
    // A peer upgraded since render may serve 1.1; this action still proves only guest setup.
    resolveResponse: (response) =>
      Promise.resolve({ ...response, settingsApplied: false }),
    requiredHostMethodVersion: () => ({
      method: REPAIR_METHOD,
      version: { major: 1, minor: 0 },
    }),
    options: {
      mutationKey,
      onError: (error) =>
        toastFromHostError(error, "Couldn't repair this sandbox's setup."),
    },
  });
}

/**
 * Combined settings retry on the named sandbox host. The dispatch itself
 * requires 1.1, even if a render read a newer manifest before a host rollback.
 */
export function useSandboxRepairGuestConfigurationOnHost(
  hostId: string,
): RepairMutation {
  const client = useHostClientForHostId(hostId);
  const queryClient = useQueryClient();
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const operationKey = `${userId}:${hostId}`;
  return useHostMutation<
    HostRpcRegistry,
    typeof REPAIR_METHOD,
    unknown,
    RepairVariables
  >({
    client,
    method: REPAIR_METHOD,
    requiredHostMethodVersion: () => ({
      method: REPAIR_METHOD,
      version: { major: 1, minor: 1 },
    }),
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
    mapVariables: () => {
      let operationId = applyingOperationIds.get(operationKey);
      if (operationId === undefined) {
        operationId = uuidv4();
        applyingOperationIds.set(operationKey, operationId);
      }
      return { operationId };
    },
  });
}
