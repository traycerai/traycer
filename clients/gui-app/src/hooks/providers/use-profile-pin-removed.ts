import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  removedProfilesForProvider,
  resolveProfilePin,
} from "@/components/providers/provider-profile-model";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import type { HostRpcRegistry } from "@/lib/host";
import { providerCliIdForHarness } from "@/lib/provider-ordering";

/**
 * Whether `profileId` names an account a person removed on the host `client`
 * reaches. A seed keeps such an id (`resolveSeededProfileId`), so a surface
 * with no send-time gate of its own holds its start until the person picks an
 * account.
 */
export function useProfilePinRemoved(
  client: HostClient<HostRpcRegistry> | null,
  harnessId: GuiHarnessId,
  profileId: string | null,
  active: boolean,
): boolean {
  const providerId = providerCliIdForHarness(harnessId);
  const enabled = active && providerId !== null && profileId !== null;
  const query = useProvidersListForClient(client, {
    enabled,
    subscribed: enabled,
  });
  const state = query.data?.providers.find(
    (provider) => provider.providerId === providerId,
  );
  if (!enabled || state === undefined) return false;
  return (
    resolveProfilePin(
      state.profiles,
      removedProfilesForProvider(query.data, providerId),
      profileId,
    ).kind === "removed"
  );
}
