import type { ReactNode } from "react";
import type { ChatSessionAnchor } from "@traycer/protocol/persistence/epic/schemas";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { providerCliIdForHarness } from "@/lib/provider-ordering";
import { TombstonedProfileContext } from "@/components/chat/use-tombstoned-profile-label";

function resolveTombstonedProfileLabel(
  anchor: ChatSessionAnchor,
  providers: ReadonlyArray<ProviderCliState>,
): string | null {
  if (anchor.profileId === null) return null;
  const providerId = providerCliIdForHarness(anchor.harnessId);
  if (providerId === null) return null;
  const state = providers.find((p) => p.providerId === providerId);
  if (state === undefined || state.profiles.length === 0) return null;
  const stillActive = state.profiles.some(
    (p) => p.profileId === anchor.profileId,
  );
  if (stillActive) return null;
  return anchor.labelSnapshot ?? "profile";
}

/**
 * Mounts the live resolver from the tab's own `providers.list` read. Must sit
 * inside `<TabHostProvider>` (chat tiles always do) - callers outside that
 * boundary simply don't mount this, and every consumer stays on the inert
 * default (`use-tombstoned-profile-label.ts`).
 */
export function TombstonedProfileProvider({
  providers,
  children,
}: {
  readonly providers: ReadonlyArray<ProviderCliState>;
  readonly children: ReactNode;
}) {
  const resolve = (anchor: ChatSessionAnchor): string | null =>
    resolveTombstonedProfileLabel(anchor, providers);
  return (
    <TombstonedProfileContext.Provider value={resolve}>
      {children}
    </TombstonedProfileContext.Provider>
  );
}
