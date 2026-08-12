import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type { DeregisterHostFetchResult } from "@traycer-clients/shared/host-client/host-deregister-fetcher";
import { toastFromAuthError } from "@/lib/auth-error-toast";
import type { AuthService } from "@/lib/auth/auth-service";
import { useHostBinding } from "@/lib/host";
import { authMutationKeys, authQueryKeys } from "@/lib/query-keys";

interface DeregisterHostMutationContext {
  readonly auth: AuthService | null;
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
 * already in flight. On success the My Hosts list is invalidated: the removed
 * row must leave the registry-backed list promptly rather than waiting out the
 * ~15s poll, since the whole visible effect of this action is its absence.
 *
 * A registry-only write — no route to the machine is required, nothing is
 * uninstalled, and a host that is still running re-enrolls on its next
 * reconcile. The confirmation copy at the call site says so.
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
