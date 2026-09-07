import { createContext, use } from "react";
import type { ChatSessionAnchor } from "@traycer/protocol/persistence/epic/schemas";

/** Profile ids are host-local: they name a managed config dir on one machine, so an id from another machine can never match here and its absence proves nothing. */
export type TombstonedProfileVerdict = {
  /** `labelSnapshot`, or a generic `"profile"` when the snapshot has none. */
  readonly label: string;
  /** Whether this host's `providers.list` is entitled to call the profile removed - true only for an anchor MINTED here. See the type doc above: for a foreign anchor the absence proves nothing, so the footer renders the provenance without the removal claim. */
  readonly removedOnThisHost: boolean;
};

/** `null` is a real answer rather than a failure - it means there is nothing worth saying (ambient login, profile still active, or this host has not enumerated the provider at all) - which is why the inert default below can BE this function without any caller special-casing the unmounted case. Necessarily host-scoped: the verdict is a statement about one machine's profile registry, so a resolver built from host A's list must never be asked about host B's. */
export type TombstonedProfileResolver = (
  anchor: ChatSessionAnchor,
) => TombstonedProfileVerdict | null;

/** The default must stay `() => null`: a message rendered outside a tab has no host to judge against, and inventing one would be the cross-host mislabelling this module exists to prevent. */
export const TombstonedProfileContext =
  createContext<TombstonedProfileResolver>(() => null);

/** A user message's session anchor snapshots which profile (subscription) owned it at mint time (multi-profile decision log's "PII in synced artifacts" - `profileId` + `labelSnapshot`, never email). */
export function useTombstonedProfileLabel(
  sessionAnchor: ChatSessionAnchor | null,
): TombstonedProfileVerdict | null {
  const resolve = use(TombstonedProfileContext);
  if (sessionAnchor === null) return null;
  return resolve(sessionAnchor);
}
