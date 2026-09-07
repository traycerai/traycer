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
 * Names and last-seen only; no cookie values. Gated on advertised `browser.savedLoginSites` - a host without the method is not an empty jar.
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
