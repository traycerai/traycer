import { useLayoutEffect } from "react";
import { useStore } from "zustand";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { soleSignedInProfileForSignedOutTerminal } from "@traycer-clients/shared/providers/provider-ambient-auth";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import type { HostRpcRegistry } from "@/lib/host";
import { providerCliIdForHarness } from "@/lib/provider-ordering";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";

/**
 * The list decides only while current: last fetch succeeded, not stale, nothing
 * fetching. TanStack keeps old data through a failed fetch, which may no longer fit the host.
 */
export function useSignedOutTerminalDefaultAccount(
  toolbarStore: ComposerToolbarStore,
  active: boolean,
  client: HostClient<HostRpcRegistry> | null,
): void {
  const harnessId = useStore(
    toolbarStore,
    (state) => state.values.selection.harnessId,
  );
  const unchosenTerminal = useStore(
    toolbarStore,
    (state) =>
      !state.accountChosen && state.values.selection.profileId === null,
  );
  const enabled = active && unchosenTerminal && client !== null;
  const providersQuery = useProvidersListForClient(client, {
    enabled,
    subscribed: enabled,
  });
  const current =
    providersQuery.status === "success" &&
    !providersQuery.isStale &&
    providersQuery.fetchStatus === "idle";
  const providerId = providerCliIdForHarness(harnessId);
  const provider =
    current && providerId !== null
      ? providersQuery.data.providers.find(
          (entry) => entry.providerId === providerId,
        )
      : undefined;
  const profileId =
    provider === undefined
      ? null
      : soleSignedInProfileForSignedOutTerminal(provider);
  // A layout effect, like the seed's: a Send right after the list lands must
  // read the account the chip shows.
  useLayoutEffect(() => {
    toolbarStore
      .getState()
      .setDefaultAccount(profileId === null ? null : { harnessId, profileId });
  }, [harnessId, profileId, toolbarStore]);
}
