import { createContext, use } from "react";
import type { ChatSessionAnchor } from "@traycer/protocol/persistence/epic/schemas";

export type TombstonedProfileResolver = (
  anchor: ChatSessionAnchor,
) => string | null;

// Inert by default: nothing renders a tombstone until a real provider (see
// `TombstonedProfileProvider`) is mounted with live `providers.list` data.
// This lets `UserMessageBody` read the resolver unconditionally - no
// `<TabHostProvider>` / `QueryClientProvider` ancestor is required to render
// a user message, matching every existing message-rendering test.
export const TombstonedProfileContext =
  createContext<TombstonedProfileResolver>(() => null);

/**
 * A user message's session anchor snapshots which profile (subscription)
 * owned it at mint time (multi-profile decision log's "PII in synced
 * artifacts" - `profileId` + `labelSnapshot`, never email). This resolves
 * whether that profile is STILL active on the provider today, so history can
 * render "ran on <label> (removed)" for a since-tombstoned/removed profile
 * without ever mutating the anchor itself.
 *
 * Returns `null` for every case with nothing to show: no anchor, no
 * `TombstonedProfileProvider` mounted (context default), the ambient login
 * (`profileId: null`), or the profile is still active.
 */
export function useTombstonedProfileLabel(
  sessionAnchor: ChatSessionAnchor | null,
): string | null {
  const resolve = use(TombstonedProfileContext);
  if (sessionAnchor === null) return null;
  return resolve(sessionAnchor);
}
