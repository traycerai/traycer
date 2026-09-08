import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useHostClient } from "@/lib/host";
import { PROVIDER_INVALIDATIONS } from "@/hooks/providers/invalidations";
import { hostQueryKeys, providersMutationKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";

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
 * the degrade agree, and the toast below is a backstop rather than the UX.
 *
 * The key is write-only across the wire - nothing echoes it back, and the
 * response carries only `{ supported, configured }`.
 *
 * No `…ForClient` variant: unlike the rename/recolor/remove profile mutations,
 * this one has no host-scoped caller (the add-profile dialog does not paste a
 * key), and an exported wrapper with no call site is dead code.
 */
type SetProviderProfileApiKeyMutationResult = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.setProfileApiKey">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.setProfileApiKey">,
  { readonly hostId: string | null }
>;

export function useSetProviderProfileApiKey(): SetProviderProfileApiKeyMutationResult {
  // No `| null` widening here, unlike the `…ForClient` siblings: those take a
  // nullable client as a PARAMETER, so their `client?.` is real. Annotating
  // this one nullable does not make it so - the lint rule is type-aware and
  // reads through the annotation to what `useHostClient()` actually returns.
  // `useHostMutation` still accepts a nullable client; it just never gets one
  // from here.
  const client = useHostClient();
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "providers.setProfileApiKey",
    { readonly hostId: string | null }
  >({
    client,
    method: "providers.setProfileApiKey",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: providersMutationKeys.setProfileApiKey(),
      onMutate: () => ({ hostId: client.getActiveHostId() }),
      onSuccess: (_data, _variables, context) => {
        if (context.hostId === null) return;
        // The full provider set, not just `providers.list`: a credential is
        // exactly the kind of change that flips whether a profile can run, so
        // the harness selectors and the generated selection-guide default have
        // to re-derive (the reason `PROVIDER_INVALIDATIONS` exists - see its
        // comment, which names API keys). Rename narrows to `providers.list`
        // because a label cannot flip availability; a key can.
        //
        // The response echoes the new `{ supported, configured }` state, and it
        // is deliberately NOT written into the cache: `providers.list` is the
        // one source of truth for `configured`, and seeding it from the echo
        // would make two.
        for (const method of PROVIDER_INVALIDATIONS) {
          void queryClient.invalidateQueries({
            queryKey: hostQueryKeys.methodScope(context.hostId, method),
          });
        }
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't save the API key."),
    },
  });
}
