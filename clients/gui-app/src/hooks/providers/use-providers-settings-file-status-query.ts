import type { UseQueryResult } from "@tanstack/react-query";
import type { ProvidersSettingsFileStatusResponseV11 } from "@traycer/protocol/host/provider-settings-file/contracts";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

// Stable params identity so the host-scoped query key stays referentially
// constant across renders.
const SETTINGS_FILE_STATUS_PARAMS = {};

/**
 * Whether the scoped host's provider settings document is unusable AS A WHOLE
 * - the one state the Providers panel offers "Reset provider settings" for -
 * and, from 1.1, which providers' own rows cannot be read, each of which gets
 * "Reset <provider> settings" (`unreadableProviderIds`; an older host's
 * answer is upgraded to an empty list).
 *
 * Needed beside `providers.list` because that list does not fail in this
 * state: a document whose bytes do not parse is answered with every provider
 * at its default, which looks exactly like a user who switched them off. Only
 * a READ fault fails the list (see `isProviderSettingsUnreadableError`).
 *
 * An OPTIONAL capability; `enabled` is the caller's
 * `useHostSupportsMethod(hostId, "providers.settingsFile.status")` together
 * with support for one of the two resets, so a host that predates them is
 * never asked. No poll: the state it reports comes
 * from a file going bad outside the app. It is read on mount, on window focus
 * (opted into here, against the app-wide `false` in `lib/query-client.ts`,
 * and regardless of the app-wide `staleTime`),
 * and whenever `PROVIDER_INVALIDATIONS` is invalidated - the Providers
 * refresh, the host's providers-changed stream, the reset and every other
 * provider mutation.
 */
export function useProvidersSettingsFileStatus(
  enabled: boolean,
): UseQueryResult<ProvidersSettingsFileStatusResponseV11, HostRpcError> {
  const client = useHostClient();
  return useHostQuery({
    cacheKeyIdentity: undefined,
    client,
    method: "providers.settingsFile.status",
    params: SETTINGS_FILE_STATUS_PARAMS,
    options: {
      enabled,
      refetchOnMount: "always",
      refetchOnWindowFocus: "always",
    },
  });
}
