import type { UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostScopedMutation } from "@/hooks/host/use-host-scoped-mutation";
import {
  PROFILE_API_KEY_MUTATION_SCOPE,
  PROVIDER_INVALIDATIONS,
} from "@/hooks/providers/invalidations";
import { providersMutationKeys } from "@/lib/query-keys";

/**
 * Store an API key against ONE profile.
 *
 * `providers.setProfileApiKey` is a standalone method rather than a `profileId`
 * on the released `providers.setApiKey` - see that method's contract note in
 * `provider-schemas.ts`. It sits OFF the released floor with
 * `degrade: { kind: "unsupported" }`, so a host that predates it answers
 * `E_HOST_UNSUPPORTED` rather than storing the key provider-wide. Callers must
 * still gate the affordance on `profile.apiKey?.supported === true`: that field
 * is null/absent on exactly the hosts that lack these methods, so the gate and
 * the degrade agree, and the toast is a backstop rather than the UX.
 *
 * The key is write-only across the wire - nothing echoes it back, and the
 * response carries only `{ supported, configured }`.
 *
 * `PROVIDER_INVALIDATIONS` in full, not just `providers.list`: a credential is
 * exactly the kind of change that flips whether a profile can run, so the
 * harness selectors and the generated selection-guide default have to
 * re-derive. Rename narrows to `providers.list` because a label cannot flip
 * availability; a key can. The response's echoed `{ supported, configured }`
 * is deliberately NOT written into the cache - `providers.list` is the one
 * source of truth for `configured`, and seeding it from the echo would make
 * two.
 *
 * No `…ForClient` variant: unlike the rename/recolor/remove profile mutations,
 * this one has no host-scoped caller (the add-profile dialog does not paste a
 * key), and an exported wrapper with no call site is dead code.
 */
export function useSetProviderProfileApiKey(
  // Mutation-level for the reason spelled out on the clear hook: the form
  // unmounts behind the reauth panel, and a per-`mutate` callback would be
  // dropped exactly when the draft most needs clearing.
  onSuccess: (() => void) | undefined,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.setProfileApiKey">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.setProfileApiKey">,
  { readonly hostId: string | null }
> {
  return useHostScopedMutation({
    method: "providers.setProfileApiKey",
    mutationKey: providersMutationKeys.setProfileApiKey(),
    errorMessage: "Couldn't save the API key.",
    invalidateMethods: PROVIDER_INVALIDATIONS,
    // Serializes this pair against each other - see the scope's own note for
    // why `fifo` in the policy table cannot.
    scope: PROFILE_API_KEY_MUTATION_SCOPE,
    onSuccess: onSuccess === undefined ? undefined : () => onSuccess(),
  });
}
