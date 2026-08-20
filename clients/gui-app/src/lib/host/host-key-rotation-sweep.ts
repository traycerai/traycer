import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { isRemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";

/**
 * R-1: a remote host that rotated its public key under the SAME host id was
 * rebuilt, and everything cached under that id describes a machine that no
 * longer exists. This turns each directory emit into "which hosts rotated",
 * and hands those ids to a host-scope sweep.
 *
 * ## Why this exists again
 *
 * It used to be a side effect of `HostClient.bind()`, which force-refetched
 * the whole incoming host's scope (`refetchActive: true`) on every switch and
 * therefore swept a rotated host as a by-product of pointing at it. P4.2
 * deleted the slot and the sweep went with it: the connection registry
 * detects the rotation (`hostDirectoryEntryEquals` compares `publicKey`
 * precisely so a rotation reports as a row change) but a row-changed signal
 * only tells React consumers to re-READ - it touches no query cache. So
 * nothing swept, and a fresh dial after a rebuild emits no availability
 * evidence either: `WsStreamClient` reports recovery on a reconnect-reopen or
 * a pong after a stall, and a first dial is neither.
 *
 * What is restored here is the GUARANTEE, not the bytes. The sweep runs
 * through `HostClient.invalidateHostScopeUnannounced`, which honours the
 * query invalidator's two documented carve-outs (harness catalogs, the cloud
 * epic-tasks history) - `bind()`'s sweep ignored both, and force-refetching
 * the epic-tasks list drops optimistically-inserted local-first epics.
 *
 * ## Why the DIRECTORY, and not the connection registry
 *
 * The registry already compares the key, so detecting the rotation there
 * would be a smaller edit - and it would see fewer rotations. A registry
 * record exists only for a host some consumer NAMED, and it is dropped
 * `HOST_CONNECTION_LINGER_MS` after the last holder lets go, so a host with a
 * populated query scope and no live transport or subscriber - exactly the
 * case a sweep is for - has no record to compare against. The directory
 * listener carries the whole entry list on every emit, so this sees every
 * rotation the app can observe at all.
 *
 * ## What it still cannot see, stated rather than implied
 *
 *  - A rotation while the app was not running. The first snapshot after
 *    launch is the baseline, which costs nothing: the query cache is
 *    in-memory and empty at that point.
 *  - A rotate-and-rotate-back inside one directory refresh window. The key
 *    returns to its remembered value, no diff exists, and the scope stays
 *    stale. Two rebuilds inside one poll interval.
 *  - LOCAL hosts, which carry no `publicKey` at all. R-1 is a remote-host
 *    fact by construction; a local host rebuilt in place is a different
 *    class and is not addressed here.
 *  - A rotation spanning a re-subscription. The baseline belongs to the
 *    WATCHER, not to the module, so a fresh subscription starts from a fresh
 *    baseline - which is what a StrictMode double-mount produces in dev, and
 *    a runtime-provider remount in any build. Deliberate: the alternative is
 *    module-scoped state whose lifetime no longer matches the directory it
 *    describes, and the window it opens is bounded by a remount rather than
 *    by anything a user can do.
 */
export function buildHostKeyRotationSweep(deps: {
  /** Invalidates one host's query scope. Announcing forms need not apply. */
  readonly sweepHostScope: (hostId: string) => void;
}): (entries: readonly HostDirectoryEntry[]) => void {
  /**
   * Last key seen per host, NEVER pruned - and that is the load-bearing half
   * of the disappear/reappear case rather than a leak.
   *
   * The directory empties and refills for reasons that have nothing to do
   * with a host being rebuilt: an auth-era refresh, a fetch that failed and
   * retried, a sign-out clear. Forgetting a key on the way out would make
   * every such re-arrival unclassifiable, and a host that really did rotate
   * while it was absent would read as a first sighting and sweep nothing.
   * Remembering costs one string per remote host this window ever saw.
   *
   * The signed-out case needs nothing from here regardless:
   * `setRequestContext` invalidates every host scope on an identity
   * transition, whatever any key did.
   */
  const lastKeyByHost = new Map<string, string>();
  return (entries) => {
    for (const entry of entries) {
      if (!isRemoteHostDirectoryEntry(entry)) {
        continue;
      }
      const previous = lastKeyByHost.get(entry.hostId);
      lastKeyByHost.set(entry.hostId, entry.publicKey);
      // A host seen for the FIRST time is an arrival, not a rotation: there is
      // no previous key, and nothing cached under an id the window has never
      // addressed.
      if (previous === undefined || previous === entry.publicKey) {
        continue;
      }
      deps.sweepHostScope(entry.hostId);
    }
  };
}
