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

/** A named hook rather than a note telling callers to remember, because the sharing is a correctness property. */
export function useHostRegistryUpdateMutation(
  hostId: string | null,
): UpdateHostVersionPolicyMutation {
  return useUpdateHostVersionPolicy(hostId ?? UNRESOLVED_HOST_ID);
}

/** `string | null` above is not defensive typing: the Overview instantiates this hook before its own "no host"
 * guard, because hooks cannot run after an early return. */
const UNRESOLVED_HOST_ID = "unresolved-host";
