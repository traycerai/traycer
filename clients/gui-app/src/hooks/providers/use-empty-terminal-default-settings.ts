import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { soleSignedInProfileForEmptyTerminal } from "@traycer-clients/shared/providers/provider-ambient-auth";
import { useMemo } from "react";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import type { HostRpcRegistry } from "@/lib/host";
import { providerCliIdForHarness } from "@/lib/provider-ordering";

/**
 * A new chat's DEFAULT settings (a seed nobody chose) moved off an empty
 * Terminal login: when they name the Terminal login (`profileId: null`) and
 * the `providers.list` of the host the chat is created on says that login
 * definitely holds no credential while exactly one profile of the provider is
 * signed in there, the default names that profile instead. Anything else -
 * settings someone chose, a named profile, a list still loading - passes
 * through untouched.
 *
 * `client` is the host the chat is created on, for the reason
 * `useResolvedSeededProfileId` takes one.
 */
export function useEmptyTerminalDefaultSettings(
  settings: ChatRunSettings | null,
  isDefault: boolean,
  active: boolean,
  client: HostClient<HostRpcRegistry> | null,
): ChatRunSettings | null {
  const providerId =
    settings === null ? null : providerCliIdForHarness(settings.harnessId);
  const applies =
    isDefault &&
    settings !== null &&
    settings.profileId === null &&
    providerId !== null;
  const providersQuery = useProvidersListForClient(client, {
    enabled: active && applies,
    subscribed: active && applies,
  });
  const provider = applies
    ? providersQuery.data?.providers.find(
        (entry) => entry.providerId === providerId,
      )
    : undefined;
  const profileId =
    provider === undefined
      ? null
      : soleSignedInProfileForEmptyTerminal(provider);
  return useMemo(
    () =>
      settings === null || profileId === null
        ? settings
        : { ...settings, profileId },
    [settings, profileId],
  );
}
