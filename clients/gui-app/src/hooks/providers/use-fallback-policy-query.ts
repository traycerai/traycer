import type { UseQueryResult } from "@tanstack/react-query";
import type { ProvidersFallbackPolicyGetResponse } from "@traycer/protocol/host/fallback-policy";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

// Stable params identity so the host-scoped query key stays referentially
// constant across renders.
const FALLBACK_POLICY_PARAMS = {};

/**
 * Reads this user's fallback policy on the SURFACE's host.
 *
 * `useHostClient()` and not the app-wide client: the settings panel re-provides
 * `HostRuntimeContext` with the scoped client, so this resolves to whichever
 * host the sidebar picker names. The policy is stored per user PER HOST
 * (`provider-accounts.json` is machine-local), so reading it through the active
 * host while the page named another would show one machine's settings under
 * another machine's name - and, worse, save them there.
 *
 * The response carries two things beside the policy: `storedPolicyUnreadable`,
 * which the panel must surface rather than swallow (the host deliberately
 * returns a default policy instead of throwing, precisely so the user can
 * overwrite a corrupt row), and `inFlightCount`, which is derived per read and
 * so is only as fresh as the last one.
 *
 * The first read also SEEDS this user's model groups host-side when they have
 * never been established. That is why the panel always reads before it writes:
 * an explicit save of empty groups after a read sticks as "deliberately
 * emptied", while the same save before any read would be silently re-seeded.
 */
export function useFallbackPolicyQuery(): UseQueryResult<
  ProvidersFallbackPolicyGetResponse,
  HostRpcError
> {
  const client = useHostClient();
  return useHostQuery({
    cacheKeyIdentity: undefined,
    client,
    method: "providers.fallbackPolicy.get",
    params: FALLBACK_POLICY_PARAMS,
    // No options, so this takes the app-wide defaults - which include
    // `refetchOnWindowFocus: false` and `refetchOnReconnect: false`
    // (`lib/query-client.ts`). Nothing AMBIENT re-reads this row, then:
    // `inFlightCount` is as fresh as the last read and no fresher, and it will
    // not silently change under someone who has the page open.
    //
    // That is narrower than "the only refetch is the panel's own", and the
    // difference is not academic - an earlier version of this comment made the
    // wider claim and was wrong. Turning off focus and reconnect refetching
    // says nothing about INVALIDATION, which starts a refetch by a route these
    // flags never see. It happens that no invalidation refetches this row
    // today: `set` and `restoreTierGroups` write the response in place with
    // `setQueriesData`, and `reset` invalidates with `refetchType: "none"` on
    // purpose (its own caller does the read, because a refetch started by an
    // invalidation cannot report whether it succeeded). That is four call sites
    // agreeing, not a property of the defaults - a fifth writer invalidating
    // normally would refetch this query and nothing here would change.
    //
    // So the two re-reads to expect are both the panel's own and both
    // deliberate: the read-back after a save whose reply was lost, and the read
    // after a reset. And the panel does not treat a post-mount error as "one of
    // those failed" - it keeps the editor mounted through ANY failed fetch once
    // there is a policy to edit and reports the failure in place, rather than
    // replacing the page - see `FallbackSettingsPanelBody`.
    options: null,
  });
}
