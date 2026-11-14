import { useMemo, useRef, useState, type ReactNode } from "react";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import { hostIsLocalForLoginAutoOpen } from "@/components/providers/provider-signin-availability";
import {
  AddProviderProfileDialog,
  SwitchAccountSignInDialog,
} from "@/components/settings/panels/add-provider-profile-dialog";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { SwitchAccountMoveDialog } from "./switch-account-move-dialog";
import { listOffersSignIns } from "./provider-profile-model";
import { guiHarnessIdToProviderId } from "@/lib/provider-ordering";
import { useProviderProfileAddFlowStore } from "@/stores/settings/provider-profile-add-flow-store";

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
  /** The host scope captured when "Add a profile" was clicked - a tab's
   *  host id, or `null` for the app-wide default. This host mounts outside
   *  any `<TabHostProvider>` (it's rendered once at the app root), so a
   *  non-null `hostId` is resolved into a transient client the same way
   *  `useTabHostClient()` does, rather than read from tab context. */
  readonly hostId: string | null;
  /** The opening picker's own callback, captured alongside `harnessId`/
   *  `hostId` at the same "Add a profile" click. */
  readonly onProfileCreated: (profileId: string) => void;
}): ReactNode {
  const switchSource = useProviderProfileAddFlowStore(
    (state) => state.switchSource,
  );
  const [destinationId, setDestinationId] = useState<string | null>(null);
  const signedIn = useRef(false);
  const close = useProviderProfileAddFlowStore((state) => state.close);
  const client = useHostClientForHostId(hostId);
  const directory = useHostDirectoryList();
  const defaultActiveHostId = useAddressableHostId();
  const isLocalHost = hostIsLocalForLoginAutoOpen(
    directory.data ?? [],
    hostId,
    defaultActiveHostId,
  );
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

  const destination = state.profiles.find(
    (profile) => profile.profileId === destinationId,
  );
  const switching =
    switchSource !== null && listOffersSignIns(providersQuery.data);
  if (switching && destination !== undefined) {
    return (
      <SwitchAccountMoveDialog
        providerId={state.providerId}
        source={switchSource}
        destination={destination}
        moveHostId={hostId}
        teamName={null}
        onDone={close}
      />
    );
  }
  const signInProps = {
    state,
    client,
    isLocalHost,
    open: true,
    target: null,
    targetResult: null,
    onOpenChange: (open: boolean) => {
      if (!open && !signedIn.current) close();
    },
    onFailedAttempt: () => {},
    onProfileCreated: (profileId: string) => {
      onProfileCreated(profileId);
      if (switching) {
        signedIn.current = true;
        setDestinationId(profileId);
      }
    },
  };
  return switching ? (
    <SwitchAccountSignInDialog
      {...signInProps}
      switchSourceProfileId={switchSource.profileId}
    />
  ) : (
    <AddProviderProfileDialog {...signInProps} />
  );
}
