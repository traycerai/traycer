import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import {
  SECRET_REQUEST_CODE_SECRET_REQUIRED,
  type SecretRequestDecision,
} from "@traycer/protocol/host/sandbox-secrets";
import { toastFromAuthError } from "@/lib/auth-error-toast";
import { useHostBinding } from "@/lib/host";
import { sandboxMutationKeys, sandboxQueryKeys } from "@/lib/query-keys";

/**
 * How a decision ended:
 *
 *  - `decided`: the request now stands at `status`, by this decision (or by
 *    the same one made a moment ago).
 *  - `already`: it had been decided otherwise, or had expired; `status` is
 *    where it stands and `decidedBy` names who settled it, when the broker
 *    says. Nothing this click did changed it.
 *  - `secret-required`: the request names only a destination, and there is no
 *    secret to grant until one is stored on the dashboard.
 *  - `gone`: the broker has no such request for this user any more.
 */
export type SecretRequestDecideOutcome =
  | { readonly kind: "decided"; readonly status: string }
  | {
      readonly kind: "already";
      readonly status: string;
      readonly decidedBy: string | null;
    }
  | { readonly kind: "secret-required" }
  | { readonly kind: "gone" };

/**
 * `POST /api/v3/environments/:environmentId/secrets/requests/:id/decide` for
 * one grant request, in the environment the request names (`null` resolves
 * Personal): the approval card's three answers. Bound to the request at
 * hook level, so a re-render cannot re-point a decision already in flight,
 * and one mutation key per request, so the card holds all three buttons
 * while any one runs.
 *
 * Only a transport or sign-in failure is an error (toasted here). Every
 * answer the broker gives about the request itself is an outcome the card
 * words. A decision that landed refreshes every sandbox's grants summary.
 */
export function useSecretRequestDecide(
  environmentId: string | null,
  requestId: string,
): UseMutationResult<SecretRequestDecideOutcome, Error, SecretRequestDecision> {
  const binding = useHostBinding();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: sandboxMutationKeys.decideSecretRequest(requestId),
    mutationFn: async (
      decision: SecretRequestDecision,
    ): Promise<SecretRequestDecideOutcome> => {
      if (binding === null) {
        throw new Error("Sign in to answer this request.");
      }
      const result = await binding.auth.decideSecretRequest(
        environmentId,
        requestId,
        decision,
      );
      switch (result.kind) {
        case "ok":
          return { kind: "decided", status: result.status };
        case "conflict":
          return result.code === SECRET_REQUEST_CODE_SECRET_REQUIRED
            ? { kind: "secret-required" }
            : {
                kind: "already",
                status: result.status,
                decidedBy: result.decidedBy,
              };
        case "not-found":
          return { kind: "gone" };
        case "unauthorized":
          throw new Error("Sign in again to answer this request.");
        case "network-error":
          throw new Error("Couldn't reach Traycer. Try again in a moment.");
      }
    },
    onSuccess: (outcome) => {
      if (outcome.kind !== "decided") return;
      void queryClient.invalidateQueries({
        queryKey: sandboxQueryKeys.grantsAll(),
      });
    },
    onError: (error) => {
      toastFromAuthError(error, "Couldn't record your decision.");
    },
  });
}
