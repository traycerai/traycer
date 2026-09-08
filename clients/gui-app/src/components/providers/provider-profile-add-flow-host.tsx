import { useMemo, type ReactNode } from "react";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import { AddProfileDialog } from "@/components/settings/panels/add-profile-dialog";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { useProviderProfileAddFlowStore } from "@/stores/settings/provider-profile-add-flow-store";
import { guiHarnessIdToProviderId } from "@/lib/provider-ordering";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";

export function ProviderProfileAddFlowHost(): ReactNode {
  const harnessId = useProviderProfileAddFlowStore((state) => state.harnessId);
  const hostId = useProviderProfileAddFlowStore((state) => state.hostId);
  const onProfileCreated = useProviderProfileAddFlowStore(
    (state) => state.onProfileCreated,
  );

  if (harnessId === null || onProfileCreated === null) return null;

  return (
    <ProviderProfileAddFlowSession
      key={`${harnessId}:${hostId}`}
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
  const effectiveHostId = useEffectiveHostId();
  // `hostId` is the captured scope - `null` means "app-wide default", which
  // resolves to whatever host is effective right now (same rule
  // `useHostClientForHostId` uses for its own `null` branch).
  const resolvedHostId = hostId ?? effectiveHostId;
  const isSelectedHostLocal =
    useHostDirectoryEntry(resolvedHostId)?.kind === "local";
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
    <AddProfileDialog
      key={state.providerId}
      state={state}
      client={client}
      hostId={resolvedHostId}
      isSelectedHostLocal={isSelectedHostLocal}
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      onFailedAttempt={() => {}}
      onProfileCreated={onProfileCreated}
    />
  );
}
