import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import { soleSignedInProfileForEmptyTerminal } from "@traycer-clients/shared/providers/provider-ambient-auth";
import type { HostRpcRegistry } from "@/lib/host";
import { providerCliIdForHarness } from "@/lib/provider-ordering";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/lib/query-keys";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";

type ProvidersListResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.list"
>;

/**
 * Default settings nobody chose, moved off an empty Terminal login: when they
 * name the Terminal login (`profileId: null`) and `providers` says that login
 * definitely holds no credential while exactly one profile of the provider is
 * signed in, they name that profile instead. Anything else passes through.
 */
export function withEmptyTerminalDefault(
  settings: ChatRunSettings | null,
  providers: ProvidersListResponse["providers"] | undefined,
): ChatRunSettings | null {
  if (settings === null || settings.profileId !== null) return settings;
  const providerId = providerCliIdForHarness(settings.harnessId);
  if (providerId === null) return settings;
  const provider = providers?.find((entry) => entry.providerId === providerId);
  const profileId =
    provider === undefined
      ? null
      : soleSignedInProfileForEmptyTerminal(provider);
  return profileId === null ? settings : { ...settings, profileId };
}

/**
 * What a new landing draft starts from on `hostId`: that host's last-run
 * settings, moved off an empty Terminal login by the host's `providers.list`
 * as the cache holds it. Never a fetch, and the stored last-run settings are
 * never written: the move describes this draft's default, not the person's
 * last choice. A draft's own `profileId: null` is not read here, so a person's
 * Terminal pick in a draft is never moved.
 */
export function newDraftRunSettings(
  hostId: string | null,
): ChatRunSettings | null {
  const lastRun = useComposerRunSettingsStore
    .getState()
    .getGlobalRunSettings(hostId);
  if (hostId === null) return lastRun;
  const cached = queryClient.getQueryData<ProvidersListResponse>(
    queryKeys.hostMethod<HostRpcRegistry, "providers.list">(
      hostId,
      "providers.list",
      { native: null },
    ),
  );
  return withEmptyTerminalDefault(lastRun, cached?.providers);
}
