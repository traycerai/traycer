import type { UseQueryResult } from "@tanstack/react-query";
import type {
  ProvidersFallbackPolicyPreviewTierGroupsResponse,
  TierGroup,
  TierPreviewBlockedTuple,
} from "@traycer/protocol/host/fallback-policy";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostClient } from "@/lib/host";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useFallbackPolicyPatternLines } from "@/hooks/providers/use-fallback-policy-pattern-lines";
import { FALLBACK_PREVIEW_TIER_GROUPS_METHOD } from "@/hooks/providers/use-fallback-policy-preview-tier-groups-query";

/** The request's own empty value, so a disabled query still has a stable key. */
const NO_GROUPS: readonly TierGroup[] = [];

/**
 * What the Test a model panel asks: the tiers as last committed, their default
 * tier, and the hypothetical blocked run tuple.
 */
export interface FallbackPolicyTestTierGroupsRequest {
  readonly groups: readonly TierGroup[];
  readonly defaultTierGroupId: string | null;
  readonly blocked: TierPreviewBlockedTuple;
}

/**
 * The Test a model panel's dry run: the host runs the live walk as if
 * `blocked` had just failed - routing, same-as-failed, permission-mode fit and
 * the sibling-after-rate-limit rule - over the tiers the panel sends.
 *
 * The sibling of the editor's preview (`useFallbackPolicyPreviewTierGroupsQuery`),
 * on the same host, method and cadence, and a separate hook only because the
 * question is different: that one enumerates every draft row with no failed
 * tuple, this one walks the one tier a failure routes to.
 *
 * Asks only on a host whose NEGOTIATED `previewTierGroups` line is 1.1 or later
 * (`blankPreviewRows`, which is exactly that line), and the gate is here rather
 * than only in the caller: below 1.1 the request projection strips `blocked`,
 * and the host would then answer the editor's question - an unscoped preview -
 * under a key that reads as a dry run. Never inferred from a response either,
 * because the 1.0 → 1.1 upgrade synthesises `matches`. `request === null` asks
 * nothing.
 *
 * The whole request is the cache identity - tuple, tiers and default tier - so
 * an answer is never drawn under a tuple or tiers it was not computed for. No
 * `placeholderData` for the same reason the editor's preview has none.
 */
export function useFallbackPolicyTestTierGroupsQuery(
  request: FallbackPolicyTestTierGroupsRequest | null,
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
  const walksBlocked = useFallbackPolicyPatternLines().blankPreviewRows;
  return useHostQuery<
    HostRpcRegistry,
    "providers.fallbackPolicy.previewTierGroups"
  >({
    cacheKeyIdentity: undefined,
    client,
    method: FALLBACK_PREVIEW_TIER_GROUPS_METHOD,
    params:
      request === null
        ? // Not the editor's own disabled key (`{ groups: [] }`): an editor
          // with no tiers ENABLES that key, and this disabled observer must not
          // read its answer as a dry run.
          { groups: [...NO_GROUPS], defaultTierGroupId: null }
        : {
            groups: [...request.groups],
            defaultTierGroupId: request.defaultTierGroupId,
            blocked: request.blocked,
          },
    options: {
      enabled: request !== null && supported && walksBlocked,
      // Same window and the same reason as the editor's preview: the answer
      // moves with catalogs, accounts and gauges this page cannot observe, and
      // the walk is not worth a poll.
      staleTime: 30 * 1000,
    },
  });
}
