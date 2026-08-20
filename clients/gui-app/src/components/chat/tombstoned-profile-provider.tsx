import type { ReactNode } from "react";
import type { ChatSessionAnchor } from "@traycer/protocol/persistence/epic/schemas";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { providerCliIdForHarness } from "@/lib/provider-ordering";
import {
  TombstonedProfileContext,
  type TombstonedProfileVerdict,
} from "@/components/chat/use-tombstoned-profile-label";

function resolveTombstonedProfileLabel(
  anchor: ChatSessionAnchor,
  providers: ReadonlyArray<ProviderCliState>,
  hostId: string,
): TombstonedProfileVerdict | null {
  if (anchor.profileId === null) return null;
  const providerId = providerCliIdForHarness(anchor.harnessId);
  if (providerId === null) return null;
  const state = providers.find((p) => p.providerId === providerId);
  if (state === undefined || state.profiles.length === 0) return null;
  const stillActive = state.profiles.some(
    (p) => p.profileId === anchor.profileId,
  );
  if (stillActive) return null;
  return {
    label: anchor.labelSnapshot ?? "profile",
    // The anchor's own `hostId` is the ORIGIN marker: a fork/clone copies
    // non-boundary message bodies VERBATIM, so a carried anchor still names
    // the host it was minted on rather than the host now rendering it. Every
    // anchor variant declares `hostId` as a required string (no `.default`),
    // so legacy anchors carry one too and this never degrades to a guess.
    removedOnThisHost: anchor.hostId === hostId,
  };
}

/**
 * Mounts the live resolver from the tab's own `providers.list` read. Must sit
 * inside `<TabHostProvider>` (chat tiles always do) - callers outside that
 * boundary simply don't mount this, and every consumer stays on the inert
 * default (`use-tombstoned-profile-label.ts`).
 *
 * `hostId` must be the host whose `providers.list` produced `providers` (the
 * TAB host), because that pairing is the whole verdict: this host's list is
 * evidence about a profile only for anchors minted on this host.
 */
export function TombstonedProfileProvider({
  providers,
  hostId,
  children,
}: {
  readonly providers: ReadonlyArray<ProviderCliState>;
  readonly hostId: string;
  readonly children: ReactNode;
}) {
  const resolve = (
    anchor: ChatSessionAnchor,
  ): TombstonedProfileVerdict | null =>
    resolveTombstonedProfileLabel(anchor, providers, hostId);
  return (
    <TombstonedProfileContext.Provider value={resolve}>
      {children}
    </TombstonedProfileContext.Provider>
  );
}
