import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type { DeregisterHostFetchResult } from "@traycer-clients/shared/host-client/host-deregister-fetcher";
import { toastFromAuthError } from "@/lib/auth-error-toast";
import type { AuthService } from "@/lib/auth/auth-service";
import { useHostBinding, type HostDirectoryService } from "@/lib/host";
import { authMutationKeys, authQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import { requestFleetRefresh } from "@/lib/host/fleet-refresh";
import { useRunnerHost } from "@/providers/use-runner-host";

interface DeregisterHostMutationContext {
  readonly auth: AuthService | null;
  readonly directory: HostDirectoryService | null;
  readonly userId: string | null;
}

/**
 * `not-found` resolves: the host is already gone. `revoked` must throw; a tombstone is not a benign removal.
 */
function unwrapDeregisterHostResult(result: DeregisterHostFetchResult): void {
  if (result.kind === "ok" || result.kind === "not-found") {
    return;
  }
  if (result.kind === "revoked") {
    throw new Error("This host was revoked and can't be removed this way.");
  }
  if (result.kind === "unauthorized") {
    throw new Error("Sign in again to try that.");
  }
  throw new Error("Couldn't reach Traycer to remove this host.");
}

/** Registry-only write; does not uninstall or re-enrol. Invalidate both registry and directory caches on success. */
export function useDeregisterHostFromAccount(
  hostId: string,
): UseMutationResult<void, Error, void, DeregisterHostMutationContext> {
  const binding = useHostBinding();
  const queryClient = useQueryClient();
  // A SHELL capability, deliberately not the authority client - see
  // `lib/host/fleet-refresh.ts`.
  const runnerHost = useRunnerHost();

  return useMutation({
    mutationKey: authMutationKeys.deregisterHostFromAccount(hostId),
    onMutate: (): DeregisterHostMutationContext => ({
      auth: binding === null ? null : binding.auth,
      directory: binding === null ? null : binding.directory,
      userId: useAuthStore.getState().contextMetadata?.userId ?? null,
    }),
    mutationFn: async (): Promise<void> => {
      if (binding === null) {
        throw new Error("Sign in to remove this host.");
      }
      unwrapDeregisterHostResult(
        await binding.auth.deregisterHostFromAccount(hostId),
      );
    },
    onSuccess: (_data, _variables, context) => {
      // Arm-time captures, not the live binding: a scope change during the
      // request must not re-point either refresh at another host's caches.
      void context.directory?.refresh();
      // Renderer state alone is not enough (F6): the selection authority derives `effectiveHostId` from ITS OWN fleet, in the desktop main process, and would keep deriving onto the host just removed.
      requestFleetRefresh(runnerHost);
      if (context.auth === null) {
        return;
      }
      void queryClient.invalidateQueries({
        queryKey: authQueryKeys.registeredHosts(context.auth, context.userId),
      });
    },
    onError: (error) => toastFromAuthError(error, "Couldn't remove this host."),
  });
}
