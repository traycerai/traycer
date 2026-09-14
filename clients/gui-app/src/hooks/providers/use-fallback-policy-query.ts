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
 * so is only as fresh as the last one. The panel shows the polled count from
 * `useFallbackInFlightCountQuery` instead, and this one only until that
 * answers.
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
    // (`lib/query-client.ts`) - and no `poll: true`, so the table's fixed
    // cadence for this method is NOT this query's. It belongs to
    // `useFallbackInFlightCountQuery`, which polls the same method under its
    // own cache entry. This entry must stay out of it: `set` and
    // `restoreTierGroups` write their responses into it in place
    // (`setQueriesData`), and a poll landing after one of those writes would
    // put the pre-save policy back for the next mount to seed from.
    //
    // Nothing AMBIENT re-reads this row, but that is narrower than "nothing
    // refetches it", and the difference is not academic - earlier versions of
    // this comment made the wider claim and were wrong. The host-scope sweep
    // (`lib/host/query-invalidator.ts`) refetches every ACTIVE host query on
    // availability recovery and on a key-rotation sweep, this one included.
    // Among this surface's own writers, `set` and `restoreTierGroups` never
    // invalidate, and `reset` invalidates with `refetchType: "none"` on
    // purpose (its own caller does the read, because a refetch started by an
    // invalidation cannot report whether it succeeded). That is call sites
    // agreeing, not a property of the defaults - a writer invalidating
    // normally would refetch this query and nothing here would change.
    //
    // So the re-reads to expect are the panel's own two, both deliberate - the
    // read-back after a save whose reply was lost, and the read after a reset -
    // plus a sweep. And the panel does not treat a post-mount error as "one of
    // those failed" - it keeps the editor mounted through ANY failed fetch once
    // there is a policy to edit and reports the failure in place, rather than
    // replacing the page - see `FallbackSettingsPanelBody`.
    options: null,
  });
}
