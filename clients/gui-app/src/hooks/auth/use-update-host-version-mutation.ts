import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type {
  HostVersionPolicyResult,
  UpdateHostVersionPolicyFetchResult,
  UpdateHostVersionPolicyInput,
} from "@traycer-clients/shared/host-client/host-version-policy-fetcher";
import { toastFromAuthError } from "@/lib/auth-error-toast";
import type { AuthService } from "@/lib/auth/auth-service";
import { useHostBinding } from "@/lib/host";
import { authMutationKeys, authQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

interface UpdateHostVersionPolicyMutationContext {
  readonly auth: AuthService | null;
  readonly userId: string | null;
}

/** Unwraps the discriminated `PATCH /api/v3/hosts/:hostId` result into the applied policy or a user-facing `Error`, so the mutation's success data is the meaningfully-typed payload rather than a `kind` union callers must re-branch on. */
function unwrapUpdateHostVersionPolicyResult(
  result: UpdateHostVersionPolicyFetchResult,
): HostVersionPolicyResult {
  if (result.kind === "ok") {
    return result.result;
  }
  if (result.kind === "not-found") {
    throw new Error("This host is no longer available.");
  }
  if (result.kind === "invalid") {
    throw new Error("That update wasn't valid.");
  }
  if (result.kind === "unauthorized") {
    throw new Error("Sign in again to try that.");
  }
  throw new Error("Couldn't reach Traycer to update this host.");
}

/**
 * One-host `PATCH /api/v3/hosts/:hostId` for desiredVersion, updatePolicy, or force. Invalidates the My Hosts list so the row does not wait out the poll.
 */
export function useUpdateHostVersionPolicy(
  hostId: string,
): UseMutationResult<
  HostVersionPolicyResult,
  Error,
  UpdateHostVersionPolicyInput,
  UpdateHostVersionPolicyMutationContext
> {
  const binding = useHostBinding();
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: authMutationKeys.updateHostVersionPolicy(hostId),
    onMutate: (): UpdateHostVersionPolicyMutationContext => ({
      auth: binding === null ? null : binding.auth,
      userId: useAuthStore.getState().contextMetadata?.userId ?? null,
    }),
    mutationFn: async (
      input: UpdateHostVersionPolicyInput,
    ): Promise<HostVersionPolicyResult> => {
      if (binding === null) {
        throw new Error("Sign in to update this host.");
      }
      const result = await binding.auth.updateHostVersionPolicy(hostId, input);
      return unwrapUpdateHostVersionPolicyResult(result);
    },
    onSuccess: (_data, _variables, context) => {
      if (context.auth === null) {
        return;
      }
      void queryClient.invalidateQueries({
        queryKey: authQueryKeys.registeredHosts(context.auth, context.userId),
      });
    },
    onError: (error) => toastFromAuthError(error, "Couldn't update this host."),
  });
}
