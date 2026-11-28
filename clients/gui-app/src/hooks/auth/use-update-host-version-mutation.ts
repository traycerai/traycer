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
import { useHostPolicyWriteRoute } from "@/hooks/auth/use-host-policy-write-route";
import { sandboxFailureMessage } from "@/hooks/sandboxes/sandbox-failure-copy";

interface UpdateHostVersionPolicyMutationContext {
  readonly auth: AuthService | null;
  readonly userId: string | null;
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
 * (T16): `PATCH /api/v3/hosts/:hostId`, or for a team's sandbox the control
 * plane's `PATCH /api/sandboxes/:id/update-policy` (see
 * {@link useHostPolicyWriteRoute}), scoped to one host (mirrors `HostRow`
 * being keyed by `host.hostId`, so a fresh hook instance is bound per row). All three affordances share this single
 * mutation — they differ only in which tri-state field of
 * {@link UpdateHostVersionPolicyInput} they set:
 *   - "Update now"     → `{ desiredVersion }`
 *   - auto-policy toggle → `{ updatePolicy }`
 *   - "Apply now"       → `{ force: true }`
 *
 * On settling, success or not, invalidates the My Hosts list query so the
 * row's `desiredVersion` / `updatePolicy` / `updateState` show what the
 * registry holds promptly instead of waiting out the ~15s poll: the switch
 * renders the stored value, never the one it asked for.
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
  const route = useHostPolicyWriteRoute(hostId);

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
      // No control offers the write in either state; a dispatch that gets
      // here anyway is answered as the refused write would be.
      if (route.kind === "denied" || route.kind === "unknown") {
        throw new Error("This host is no longer available.");
      }
      if (route.kind === "sandbox") {
        const result = await binding.auth.updateSandboxVersionPolicy(
          route.sandboxId,
          input,
        );
        if (result.kind === "ok") return result.result;
        throw new Error(sandboxFailureMessage(result));
      }
      const result = await binding.auth.updateHostVersionPolicy(hostId, input);
      return unwrapUpdateHostVersionPolicyResult(result);
    },
    onSettled: (_data, _error, _variables, context) => {
      if (context === undefined || context.auth === null) {
        return;
      }
      void queryClient.invalidateQueries({
        queryKey: authQueryKeys.registeredHosts(context.auth, context.userId),
      });
    },
    onError: (error) => toastFromAuthError(error, "Couldn't update this host."),
  });
}
