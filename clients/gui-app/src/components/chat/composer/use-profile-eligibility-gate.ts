import type { GuiHarnessId } from "@traycer/protocol/host";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { profileCommitId } from "@/components/providers/provider-profile-model";
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

export function useProfileEligibilityGate(
  client: HostClient<HostRpcRegistry> | null,
  harnessId: GuiHarnessId,
  profileId: string | null,
  active: boolean,
): ProfileEligibilityGate {
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
  const enablePending = profileEnablementPending(profileId);
  const provider = providersQuery.data?.providers.find(
    (candidate) => candidate.providerId === providerId,
  );
  const profile = provider?.profiles.find(
    (candidate) => profileCommitId(candidate) === profileId,
  );

  return {
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
