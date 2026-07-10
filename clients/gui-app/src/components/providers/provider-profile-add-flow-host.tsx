import { useMemo, type ReactNode } from "react";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import { AddProviderProfileDialog } from "@/components/settings/panels/add-provider-profile-dialog";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { useProviderProfileAddFlowStore } from "@/stores/settings/provider-profile-add-flow-store";
import { guiHarnessIdToProviderId } from "@/lib/provider-ordering";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";

export function ProviderProfileAddFlowHost(): ReactNode {
  const harnessId = useProviderProfileAddFlowStore((state) => state.harnessId);
  const hostId = useProviderProfileAddFlowStore((state) => state.hostId);
  const onProfileCreated = useProviderProfileAddFlowStore(
    (state) => state.onProfileCreated,
  );

  if (harnessId === null || onProfileCreated === null) return null;

  return (
    <ProviderProfileAddFlowSession
      harnessId={harnessId}
      hostId={hostId}
      onProfileCreated={onProfileCreated}
    />
  );
}

function ProviderProfileAddFlowSession({
  harnessId,
  hostId,
  onProfileCreated,
}: {
  readonly harnessId: GuiHarnessId;
  /** The host scope captured when "Create new profile" was clicked - a tab's
   *  host id, or `null` for the app-wide default. This host mounts outside
   *  any `<TabHostProvider>` (it's rendered once at the app root), so a
   *  non-null `hostId` is resolved into a transient client the same way
   *  `useTabHostClient()` does, rather than read from tab context. */
  readonly hostId: string | null;
  /** The opening picker's own callback, captured alongside `harnessId`/
   *  `hostId` at the same "Create new profile" click. */
  readonly onProfileCreated: (profileId: string) => void;
}): ReactNode {
  const close = useProviderProfileAddFlowStore((state) => state.close);
  const client = useHostClientForHostId(hostId);
  const providersQuery = useProvidersListForClient(client, {
    enabled: true,
    subscribed: true,
  });
  const providerId = useMemo(
    () => guiHarnessIdToProviderId(harnessId),
    [harnessId],
  );
  const state =
    providersQuery.data?.providers.find(
      (provider) => provider.providerId === providerId,
    ) ?? null;

  if (state === null) return null;

  return (
    <AddProviderProfileDialog
      state={state}
      client={client}
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      onFailedAttempt={() => {}}
      onProfileCreated={onProfileCreated}
    />
  );
}
