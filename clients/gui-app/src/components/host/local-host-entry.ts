import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";

/*
 * Resolving THIS machine's host entry, shared by every surface that must act
 * on the local host and never on the app-wide active one (which can be a
 * remote machine): the restart flow, the host quit modal and the `→ none`
 * confirm.
 */

/**
 * Which host id this machine's local host currently has, from the two sources
 * that answer it - each covering the other's blind spot.
 *
 * The LIVE entry wins. `HostDirectoryService` assigns it inside the
 * `onLocalHostChange` callback, so it is correct the instant this machine's
 * host identity changes. The directory query deliberately RETAINS its previous
 * data across a refetch (so consumers never flash a loading state), which means
 * it can still be serving the PREVIOUS local id in that window - and if that id
 * still resolves, dispatching there would ask one host to stand down while the
 * force leg kills another.
 *
 * The query is still needed: it keeps presenting this machine as a
 * `kind: "local"` entry while the host is DOWN, where the live snapshot is
 * `null` - the case a restart most needs to serve.
 */
export function resolveLocalEntry(
  liveLocalEntry: HostDirectoryEntry | null,
  directoryEntries: readonly HostDirectoryEntry[] | undefined,
): HostDirectoryEntry | null {
  if (liveLocalEntry !== null) return liveLocalEntry;
  const fromDirectory = (directoryEntries ?? []).find(
    (entry) => entry.kind === "local",
  );
  return fromDirectory === undefined ? null : fromDirectory;
}

/**
 * Whether this host is one we should have been able to DIAL - which is what
 * separates "no local host to ask" from "we could not ask the one that is
 * there". `useHostClientForHostId` also answers `null` when the renderer has
 * no authenticated request context (signed out, or the credential lease was
 * released), and that must never read as absence: the process is alive and
 * possibly busy, we simply have no way to put the question to it.
 *
 * Reading `transportDialability` for a DIALING decision is its sanctioned use;
 * it is the reason field (`useHostReachability`) that user-facing copy wants.
 */
export function looksDialable(entry: HostDirectoryEntry | null): boolean {
  return (
    entry !== null &&
    entry.websocketUrl !== null &&
    entry.transportDialability === "dialable"
  );
}
