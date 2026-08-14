import { useCallback, useRef, useSyncExternalStore } from "react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  hostUnavailability,
  isRelayFuseRecoveryCandidate,
  isRemoteHostDirectoryEntry,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import { useHostDirectory } from "@/lib/host";

/**
 * Reactively projects a single host directory entry, returning a
 * REFERENCE-STABLE value across benign directory churn.
 *
 * `directory.findById` allocates a fresh `HostDirectoryEntry` on every
 * directory emit: the local entry is rebuilt by `toLocalEntry`, and on desktop
 * each `onLocalHostChange` snapshot crosses the IPC bridge as a brand-new
 * object - even when the host's fields are byte-identical (e.g. a
 * respawn-in-place whose only delta is `pid`, which is NOT part of the entry).
 *
 * Returning a new reference on each such emit would churn EVERY consumer:
 * per-tab stream clients (`useHostStreamClientFor`), terminal sessions
 * (whose effect depends on this entry and disposes the PTY on re-run),
 * reachability, etc. - tearing down live sockets and locking chats / blanking
 * terminals on an event that changed nothing observable. Fixing it here, at the
 * source, keeps the reference stable for all of them: we cache the last value
 * and return it unchanged whenever the fields match, so `useSyncExternalStore`
 * sees `Object.is`-equal snapshots and nothing downstream re-runs. A genuine
 * change (url/version/reachability/label) is not field-equal, so it still
 * propagates.
 */
export function useHostDirectoryEntry(
  hostId: string,
): HostDirectoryEntry | null {
  const directory = useHostDirectory();
  const cacheRef = useRef<HostDirectoryEntry | null>(null);
  const subscribe = useCallback(
    (callback: () => void) => {
      const subscription = directory.onChange(() => {
        callback();
      });
      return () => {
        subscription.dispose();
      };
    },
    [directory],
  );
  const getSnapshot = useCallback(() => {
    const next = directory.findById(hostId);
    if (hostDirectoryEntryEquals(cacheRef.current, next)) {
      return cacheRef.current;
    }
    cacheRef.current = next;
    return next;
  }, [hostId, directory]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function hostDirectoryEntryEquals(
  a: HostDirectoryEntry | null,
  b: HostDirectoryEntry | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.hostId === b.hostId &&
    a.label === b.label &&
    a.kind === b.kind &&
    a.websocketUrl === b.websocketUrl &&
    a.version === b.version &&
    // The DERIVED verdict, not the coarse bit — this cache decides whether
    // consumers are told anything changed at all, and consumers now render the
    // reason. `indeterminate` → confirmed `offline` leaves the coarse bit at
    // `not-dialable` on both sides, so comparing it would have swallowed the
    // moment a host actually died and pinned every banner on this entry to
    // "we don't know" for the rest of the session. Comparing the verdict
    // strictly subsumes the coarse bit (`dialable` ⇔ `null`).
    hostUnavailability(a) === hostUnavailability(b) &&
    // The recovery-dial window (F7), same reason as the service's twin: it is
    // recomputed from `lastSeenAt` recency at every projection, so an
    // `offline` row whose only change is aging past the 4h fuse cap flips
    // this field while every other compared field (including the derived
    // verdict, still `offline`) stays identical. Swallowing that flip pinned
    // `relayFuseGrace: true` on every consumer of this hook forever -
    // recovery dials permitted indefinitely past the documented cap.
    isRelayFuseRecoveryCandidate(a) === isRelayFuseRecoveryCandidate(b) &&
    // Not part of the base shape (R-1): a same-host public-key rotation
    // (re-enrollment / corruption recovery) would otherwise be swallowed by
    // this cache - every base field can stay byte-identical - permanently
    // hiding the new key from every consumer of this hook (chat/terminal
    // session registries key their durable owners on it).
    remotePublicKeyOf(a) === remotePublicKeyOf(b)
  );
}

function remotePublicKeyOf(entry: HostDirectoryEntry): string | null {
  return isRemoteHostDirectoryEntry(entry) ? entry.publicKey : null;
}
