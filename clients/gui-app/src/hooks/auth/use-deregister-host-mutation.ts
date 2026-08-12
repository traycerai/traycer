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

interface DeregisterHostMutationContext {
  readonly auth: AuthService | null;
  readonly directory: HostDirectoryService | null;
}

/**
 * Turns the discriminated result into "done" or a user-facing `Error`.
 *
 * `not-found` resolves rather than throwing, and that is deliberate: the route
 * is idempotent, and the only ways to reach a 404 from this button are that the
 * host was already removed or was removed from another window. Both mean the
 * user's intent — "this host should not be on my account" — already holds, so
 * reporting a failure would be false. `revoked` is the one refusal that must be
 * said out loud: a revoked row is a dead tombstone, not a benign removal.
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

/**
 * "Remove from account" — `POST /api/v3/hosts/:hostId/deregister`, scoped to
 * one host so concurrent removals never share a pending state.
 *
 * `hostId` is bound at HOOK level, and the caller arms the confirmation against
 * the same captured id, so a scope change cannot re-point a removal that is
 * already in flight.
 *
 * On success BOTH caches are refreshed, and it takes both: the settings list is
 * a union of the registry query and the runtime directory's independently
 * cached entries (`buildHostScopeOptions`), so invalidating the registry alone
 * leaves the removed host on screen as a directory-only row until the
 * directory's own ~15s poll. The whole visible effect of this action is its
 * absence, so a row that survives the success toast reads as a failed removal.
 *
 * A registry-only write — no route to the machine is required and nothing is
 * uninstalled. It does NOT re-enrol on its own: `registerHost()` is reachable
 * only through `enroll()`, and reconcile returns at `adoptActiveCredential()`
 * while the on-box credential still matches. The confirmation copy at the call
 * site says exactly that.
 */
export function useDeregisterHostFromAccount(
  hostId: string,
): UseMutationResult<void, Error, void, DeregisterHostMutationContext> {
  const binding = useHostBinding();
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: authMutationKeys.deregisterHostFromAccount(hostId),
    onMutate: (): DeregisterHostMutationContext => ({
      auth: binding === null ? null : binding.auth,
      directory: binding === null ? null : binding.directory,
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
      if (context.auth === null) {
        return;
      }
      void queryClient.invalidateQueries({
        queryKey: authQueryKeys.registeredHosts(context.auth),
      });
    },
    onError: (error) => toastFromAuthError(error, "Couldn't remove this host."),
  });
}
