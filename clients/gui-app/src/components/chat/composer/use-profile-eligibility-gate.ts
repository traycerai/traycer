import type { ProvidersListResponse } from "@traycer/protocol/host/provider-schemas";
import type { GuiHarnessId } from "@traycer/protocol/host";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  profileCommitId,
  removedProfilesForProvider,
  resolvedProfileRow,
} from "@/components/providers/provider-profile-model";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import {
  useProviderProfileEnablementPending,
  useProvidersSetProfileEnabledForClient,
} from "@/hooks/providers/use-providers-set-profile-enabled-mutation";
import type { HostRpcRegistry } from "@/lib/host";
import { guiHarnessIdToProviderId } from "@/lib/provider-ordering";

export interface ProfileEligibilityGate {
  readonly disabled: boolean;
  readonly profileLabel: string | null;
  readonly enablePending: boolean;
  readonly enableProfile: () => void;
}

interface ObservedProfileEligibilityGate extends ProfileEligibilityGate {
  readonly providersList: ProvidersListResponse | undefined;
}

export function useProfileEligibilityGate(
  client: HostClient<HostRpcRegistry> | null,
  harnessId: GuiHarnessId,
  profileId: string | null,
  active: boolean,
): ObservedProfileEligibilityGate {
  const providerId = guiHarnessIdToProviderId(harnessId);
  const providersQuery = useProvidersListForClient(client, {
    enabled: active,
    subscribed: active,
  });
  const mutation = useProvidersSetProfileEnabledForClient(client, providerId);
  const profileEnablementPending = useProviderProfileEnablementPending(
    client,
    providerId,
  );
  const provider = providersQuery.data?.providers.find(
    (candidate) => candidate.providerId === providerId,
  );
  // The row the pin or its alias names; a removed or unknown pin has none.
  const profile =
    provider === undefined
      ? undefined
      : (resolvedProfileRow(
          provider.profiles,
          removedProfilesForProvider(providersQuery.data, providerId),
          profileId,
        ) ?? undefined);
  const enablePending = profileEnablementPending(
    profile === undefined ? profileId : profileCommitId(profile),
  );

  return {
    providersList: providersQuery.data,
    disabled: profile?.enabled === false || enablePending,
    profileLabel: profile?.label ?? null,
    enablePending,
    enableProfile: () => {
      if (providerId === null || profile === undefined || enablePending) return;
      mutation.mutate({
        providerId,
        profileId: profile.profileId,
        enabled: true,
      });
    },
  };
}
