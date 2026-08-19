import { useCallback, useRef, useSyncExternalStore } from "react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  hostDirectoryEntryEquals,
  subscribeHostRowChanged,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import { useHostDirectory } from "@/lib/host";

/**
 * Re-exported from the connection registry, which OWNS this predicate now
 * (redesign P4.1): it is the rule the registry uses to decide whether a
 * host's row actually moved, and a second copy here would let the hook and
 * the registry disagree about what "changed" means for the same row. Kept as
 * a named export from this module because `useReactiveLocalHostEntry` imports
 * it from here.
 */
export { hostDirectoryEntryEquals };

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
      // The registry's PER-HOST arm (redesign P4.1). It answers the question
      // this hook is actually asking - "did host X's row move" - and it is
      // the arm that survives P4.2. The directory arm below stays because
      // this hook's own `getSnapshot` reads the directory directly, so a
      // harness that supplies a directory without installing a registry
      // source keeps working unchanged.
      const unsubscribeRegistry = subscribeHostRowChanged(hostId, callback);
      const subscription = directory.onChange(() => {
        callback();
      });
      return () => {
        subscription.dispose();
        unsubscribeRegistry();
      };
    },
    [directory, hostId],
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
