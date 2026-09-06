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
    // Refetch on focus is left at its default ON, unlike the agent-guide
    // editor beside it. That editor refuses refetches because its whole
    // content is the draft; here the editable policy is seeded once into a
    // reducer keyed on the host, so a refetch cannot reach a control - it only
    // freshens `inFlightCount`, which is derived per read and is the number
    // the master toggle's helper prints.
    options: null,
  });
}
