import type { UseMutationResult } from "@tanstack/react-query";
import type {
  HostVersionPolicyResult,
  UpdateHostVersionPolicyInput,
} from "@traycer-clients/shared/host-client/host-version-policy-fetcher";
import { useUpdateHostVersionPolicy } from "@/hooks/auth/use-update-host-version-mutation";

export type UpdateHostVersionPolicyMutation = UseMutationResult<
  HostVersionPolicyResult,
  Error,
  UpdateHostVersionPolicyInput
>;

/**
 * The ONE policy-mutation instance the auto-update switch and the drain-gate
 * force share.
 *
 * A named hook rather than a note telling callers to remember, because the
 * sharing is a correctness property: both rows write the same registry record,
 * and two `useUpdateHostVersionPolicy` instances do not serialize against each
 * other. It used to be guaranteed structurally, by the two rows living inside
 * one component. Splitting them — so the Overview could put the policy switch
 * inside its Advanced disclosure while the drain gate stayed visible in the card
 * body — is what turned an invariant into something a caller can get wrong.
 *
 * Its own module rather than a second export beside those components: a `.tsx`
 * that exports both components and a hook loses Fast Refresh for the whole file.
 */
export function useHostRegistryUpdateMutation(
  hostId: string | null,
): UpdateHostVersionPolicyMutation {
  return useUpdateHostVersionPolicy(hostId ?? UNRESOLVED_HOST_ID);
}

/**
 * Stands in for a host id the page does not have yet.
 *
 * `string | null` above is not defensive typing: the Overview instantiates this
 * hook before its own "no host" guard, because hooks cannot run after an early
 * return. Nothing renders a control that could fire the mutation in that state —
 * both writers need an account registry row — so this value is never dispatched.
 *
 * It is a nameable sentinel rather than `""` for when that stops being true. An
 * empty id builds `PATCH /api/v3/hosts/`, which is a DIFFERENT endpoint and not
 * one this mutation means to call; this one resolves to `not-found` and surfaces
 * "This host is no longer available."
 */
const UNRESOLVED_HOST_ID = "unresolved-host";
