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

interface UpdateHostVersionPolicyMutationContext {
  readonly auth: AuthService | null;
}

/**
 * Unwraps the discriminated `PATCH /api/v3/hosts/:hostId` result into the
 * applied policy or a user-facing `Error`, so the mutation's success data is
 * the meaningfully-typed payload rather than a `kind` union callers must
 * re-branch on.
 */
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
 * "Update now" / auto-update policy toggle / "Apply now — ends N sessions"
 * (Remote Host Support §13, T16): `PATCH /api/v3/hosts/:hostId`, scoped to
 * one host (mirrors `HostRow` being keyed by `host.hostId`, so a fresh hook
 * instance is bound per row). All three affordances share this single
 * mutation — they differ only in which tri-state field of
 * {@link UpdateHostVersionPolicyInput} they set:
 *   - "Update now"     → `{ desiredVersion }`
 *   - auto-policy toggle → `{ updatePolicy }`
 *   - "Apply now"       → `{ force: true }`
 *
 * On success, invalidates the My Hosts list query so the row's
 * `desiredVersion` / `updatePolicy` / `updateState` reflect the write
 * promptly instead of waiting out the ~15s poll.
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
        queryKey: authQueryKeys.registeredHosts(context.auth),
      });
    },
    onError: (error) => toastFromAuthError(error, "Couldn't update this host."),
  });
}
