import type { UseQueryResult } from "@tanstack/react-query";
import type {
  ProvidersFallbackPolicyPreviewTierGroupsResponse,
  TierGroup,
} from "@traycer/protocol/host/fallback-policy";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostClient } from "@/lib/host";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useHostQuery } from "@/hooks/host/use-host-query";

export const FALLBACK_PREVIEW_TIER_GROUPS_METHOD =
  "providers.fallbackPolicy.previewTierGroups";

/** The request's own empty value, so a disabled query still has a stable key. */
const NO_GROUPS: readonly TierGroup[] = [];

/**
 * What each candidate row in "Equivalent models" resolves to, answered by the
 * host.
 *
 * This cannot be computed in the renderer, which is the whole reason it is an
 * RPC: resolving a model FAMILY to a slug needs the live catalog, the provider's
 * enabled and runnable state, and which account would run it. The resolver runs
 * the engine's own `enumerateTierCandidates` walk, so the editor cannot offer a
 * target the engine would then skip.
 *
 * Scoped to the SURFACE's host, like every other host read in Settings: the
 * catalog and the accounts are per host, and a preview resolved on the active
 * host would describe a different machine's catalog than the policy being
 * edited.
 *
 * **It is the same host as the policy `get`/`set`, by construction rather than
 * by coincidence.** `useFallbackPolicyQuery` resolves through `useHostClient()`,
 * which reads the binding the panel re-provides (`hostClient: scope.client`,
 * `hostId: scope.hostId`). `useAddressableHostId` reads that same binding - its
 * own doc states the case: "beneath a host-scoped panel this answers that
 * panel's host, because it resolves through the same hook the panel's RPCs do."
 * There is no second resolution here to drift from the first. It answers `null`
 * until that host is addressable, and `useHostSupportsMethod` fails closed on
 * `null`, so the gate opens only once a handshake has proven the method present
 * on the host the policy is being read from.
 *
 * Two gates, and they are different questions:
 *
 *  - **`groups === null`** - the caller says there is nothing worth previewing.
 *    The panel passes `null` while the draft is INVALID, and it must: the
 *    request schema is `tierGroupSchema[]`, whose `modelFamily` is non-empty, so
 *    a draft holding the empty row that "Add a model" creates cannot even be
 *    encoded. Sending it would produce a malformed-request error for a state the
 *    editor manufactures with one click.
 *  - **the host must advertise the method.** It is optional rather than part of
 *    the released floor, so an older host negotiates it away instead of failing
 *    the handshake. `useHostSupportsMethod` fails closed, and a host that has
 *    not advertised it is not a host whose families resolve to nothing - the
 *    editor renders no verdict line at all rather than a client-side guess.
 */
export function useFallbackPolicyPreviewTierGroupsQuery(
  groups: readonly TierGroup[] | null,
): UseQueryResult<
  ProvidersFallbackPolicyPreviewTierGroupsResponse,
  HostRpcError
> {
  const client = useHostClient();
  const hostId = useAddressableHostId();
  const supported = useHostSupportsMethod(
    hostId,
    FALLBACK_PREVIEW_TIER_GROUPS_METHOD,
  );
  return useHostQuery<
    HostRpcRegistry,
    "providers.fallbackPolicy.previewTierGroups"
  >({
    cacheKeyIdentity: undefined,
    client,
    method: FALLBACK_PREVIEW_TIER_GROUPS_METHOD,
    // The groups themselves are the cache identity, which is what makes a
    // verdict follow an edit: a changed group list is a different key, so a
    // previous answer is never shown against rows it was not computed for.
    // Verdicts are matched to candidates by POSITION (`candidateIndex`), and
    // that is only sound while the list they were computed for is the list on
    // screen - which is also why there is no `placeholderData` carrying the
    // previous answer across a key change.
    params: { groups: [...(groups ?? NO_GROUPS)] },
    options: {
      enabled: groups !== null && supported,
      // The answer moves when the host's catalog or accounts move, neither of
      // which this page can observe. A short window freshens a revisit without
      // putting a settings page on a poll - and the walk costs a catalog read
      // per candidate, so re-asking it on a timer is the thing to avoid.
      staleTime: 30 * 1000,
    },
  });
}
