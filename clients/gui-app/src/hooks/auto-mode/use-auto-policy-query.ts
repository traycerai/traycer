import type { UseQueryResult } from "@tanstack/react-query";
import type { AutoPolicyGetResponse } from "@traycer/protocol/host/auto-mode/contracts";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

// Stable params identity so the host-scoped query key stays referentially
// constant across renders.
const AUTO_POLICY_GET_PARAMS = {};

/**
 * The account's auto-mode policy, as the surface's host sees it.
 *
 * ACCOUNT data over a HOST call, deliberately: the record lives on
 * traycer-server so it follows the user across machines, and the host proxies
 * it so what the panel edits is what the judge on that machine will actually
 * apply (a host that could not refresh its cached copy answers with the copy it
 * has, and `readState: "stale"` to say so).
 *
 * The response is three answers, not one: `body`/`updatedAt` say what the
 * policy is, `readState` says how far that can be trusted - including the case
 * where `body: null` means "could not look" rather than "never saved" - and
 * `shippedDefaults` carries the host's own bundled judge policy, which is
 * readable even when the account record is not. Both of the latter are optional
 * on the wire; `autoPolicyReadStateFor` is where the absent-`readState`
 * fallback is spelled.
 *
 * `refetchOnMount: "always"` because the record is shared: another device may
 * have saved since this window last looked, and `updatedAt` is what the editor
 * warns a stale edit against - a cached answer would make that warning
 * unreliable in exactly the case it exists for. There is no polling (see the
 * method policy table): a person editing on another device is not an event a
 * timer can catch, and every open settings tab waking the host - and through it
 * the cloud - for it would be worse than the warning being one save behind.
 *
 * An OPTIONAL capability; callers gate on
 * `useHostSupportsMethod(hostId, "autoPolicy.get")`.
 */
export function useAutoPolicyQuery(): UseQueryResult<
  AutoPolicyGetResponse,
  HostRpcError
> {
  const client = useHostClient();
  return useHostQuery({
    cacheKeyIdentity: undefined,
    client,
    method: "autoPolicy.get",
    params: AUTO_POLICY_GET_PARAMS,
    options: { refetchOnWindowFocus: false, refetchOnMount: "always" },
  });
}
