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
  // The provider-enumeration gate stays FIRST, ahead of the host check below.
  // A provider this host has not enumerated (not installed, or `providers.list` still loading) is not evidence of anything, and speaking here would mean footers appearing on messages that render nothing today - including for the whole async window before the query resolves.
  const state = providers.find((p) => p.providerId === providerId);
  if (state === undefined || state.profiles.length === 0) return null;
  const label = anchor.labelSnapshot ?? "profile";
  // Checked BEFORE the local profile match, not after, so "minted elsewhere" is decided structurally rather than resting on ids never colliding across machines.
  // Do not "simplify" it back below the match.
  if (anchor.hostId !== hostId) return { label, removedOnThisHost: false };
  const stillActive = state.profiles.some(
    (p) => p.profileId === anchor.profileId,
  );
  if (stillActive) return null;
  return { label, removedOnThisHost: true };
}

/** Must sit inside `<TabHostProvider>` (chat tiles always do) - callers outside that boundary simply don't mount this, and every consumer stays on the inert default (`use-tombstoned-profile-label.ts`). */
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
