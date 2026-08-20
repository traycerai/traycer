import { createContext, use } from "react";
import type { ChatSessionAnchor } from "@traycer/protocol/persistence/epic/schemas";

/**
 * What a session anchor's profile snapshot is worth saying about, once the
 * anchor's ORIGIN host has been compared against the host whose
 * `providers.list` produced the verdict.
 *
 * The two arms exist because "no matching row in this host's providers.list"
 * answers two different questions, and only one of them is an accusation:
 *
 * - `removedOnThisHost: true` - the anchor was minted on THIS host, so this
 *   host's own list is authoritative evidence: the profile was genuinely
 *   deleted here. History renders "Ran on <label> (removed)".
 * - `removedOnThisHost: false` - the anchor was minted somewhere else (a fork
 *   or clone carries message bodies verbatim, so a carried anchor still names
 *   its origin host). Profile ids are host-local: they name a managed config
 *   dir on one machine, so an id from another machine can never match here and
 *   its absence proves nothing. The provenance is still worth keeping - which
 *   account a past turn ran on is useful - so history renders "Ran on <label>"
 *   with no removal claim.
 */
export type TombstonedProfileVerdict = {
  /** `labelSnapshot`, or a generic `"profile"` when the snapshot has none. */
  readonly label: string;
  /**
   * Whether this host's `providers.list` is entitled to call the profile
   * removed - true only for an anchor MINTED here. See the type doc above:
   * for a foreign anchor the absence proves nothing, so the footer renders the
   * provenance without the removal claim.
   */
  readonly removedOnThisHost: boolean;
};

/**
 * Judges one anchor against a single host's live profile list.
 *
 * `null` is a real answer rather than a failure - it means there is nothing
 * worth saying (ambient login, profile still active, or this host has not
 * enumerated the provider at all) - which is why the inert default below can
 * BE this function without any caller special-casing the unmounted case.
 *
 * Necessarily host-scoped: the verdict is a statement about one machine's
 * profile registry, so a resolver built from host A's list must never be asked
 * about host B's. `TombstonedProfileProvider` closes over both halves together
 * for exactly that reason.
 */
export type TombstonedProfileResolver = (
  anchor: ChatSessionAnchor,
) => TombstonedProfileVerdict | null;

/**
 * Inert by default: nothing renders a tombstone until a real provider (see
 * `TombstonedProfileProvider`) is mounted with live `providers.list` data.
 *
 * This lets `UserMessageBody` read the resolver unconditionally - no
 * `<TabHostProvider>` / `QueryClientProvider` ancestor is required to render a
 * user message, matching every existing message-rendering test. The default
 * must stay `() => null`: a message rendered outside a tab has no host to judge
 * against, and inventing one would be the cross-host mislabelling this module
 * exists to prevent.
 */
export const TombstonedProfileContext =
  createContext<TombstonedProfileResolver>(() => null);

/**
 * A user message's session anchor snapshots which profile (subscription)
 * owned it at mint time (multi-profile decision log's "PII in synced
 * artifacts" - `profileId` + `labelSnapshot`, never email). This resolves
 * whether that profile is STILL active on the provider today, so history can
 * render "ran on <label> (removed)" for a since-tombstoned/removed profile
 * without ever mutating the anchor itself - and, for an anchor carried here
 * from ANOTHER host, renders the provenance without the removal claim (see
 * {@link TombstonedProfileVerdict}).
 *
 * Returns `null` for every case with nothing to show: no anchor, no
 * `TombstonedProfileProvider` mounted (context default), the ambient login
 * (`profileId: null`), or the profile is still active.
 */
export function useTombstonedProfileLabel(
  sessionAnchor: ChatSessionAnchor | null,
): TombstonedProfileVerdict | null {
  const resolve = use(TombstonedProfileContext);
  if (sessionAnchor === null) return null;
  return resolve(sessionAnchor);
}
