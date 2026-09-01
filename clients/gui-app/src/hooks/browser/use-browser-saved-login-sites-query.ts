import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { BrowserSavedLoginSitesResponse } from "@traycer/protocol/host/browser/contracts";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostClient } from "@/lib/host";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useHostQuery } from "@/hooks/host/use-host-query";

export const BROWSER_SAVED_LOGIN_SITES_METHOD = "browser.savedLoginSites";

/**
 * Which sites this surface's host still holds saved logins for (spec section
 * 7.3). Names and last-seen times only - the host never puts a cookie value on
 * this path, so nothing here can leak one.
 *
 * Scoped to the SURFACE's host, like every other host read in Settings: the
 * store is per host, and each keeps its own key and its own slice.
 *
 * `browser.savedLoginSites` is an optional (non-floor) method, so the query is
 * gated on the host having advertised it. A host that has not is not a host
 * with no saved logins - the group renders without the list rather than
 * claiming an empty jar.
 */
export function useBrowserSavedLoginSitesQuery(args: {
  readonly enabled: boolean;
}): UseQueryResult<BrowserSavedLoginSitesResponse, HostRpcError> {
  const client = useHostClient();
  const hostId = useAddressableHostId();
  const supported = useHostSupportsMethod(
    hostId,
    BROWSER_SAVED_LOGIN_SITES_METHOD,
  );
  return useHostQuery<HostRpcRegistry, "browser.savedLoginSites">({
    cacheKeyIdentity: undefined,
    client,
    method: BROWSER_SAVED_LOGIN_SITES_METHOD,
    params: {},
    options: {
      enabled: args.enabled && supported,
      // The list moves when a site writes a cookie in a browser tile, which
      // this page cannot observe; a short window keeps a revisit honest
      // without polling a settings page.
      staleTime: 30 * 1000,
    },
  });
}
