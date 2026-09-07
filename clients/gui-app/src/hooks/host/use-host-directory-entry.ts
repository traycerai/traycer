import { useCallback, useRef, useSyncExternalStore } from "react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  hostDirectoryEntryEquals,
  subscribeHostRowChanged,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import { useHostDirectory } from "@/lib/host";

/** Kept as a named export from this module because `useReactiveLocalHostEntry` imports it from here. */
export { hostDirectoryEntryEquals };

/** Field-equal directory emits keep the previous reference. pid is not part of the entry. */
export function useHostDirectoryEntry(
  hostId: string | null,
): HostDirectoryEntry | null {
  const directory = useHostDirectory();
  const cacheRef = useRef<HostDirectoryEntry | null>(null);
  const subscribe = useCallback(
    (callback: () => void) => {
      // The directory arm below stays because this hook's own `getSnapshot` reads the directory directly, so a harness that supplies a directory without installing a registry source keeps working unchanged.
      const unsubscribeRegistry =
        hostId === null
          ? () => undefined
          : subscribeHostRowChanged(hostId, callback);
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
    const next = hostId === null ? null : directory.findById(hostId);
    if (hostDirectoryEntryEquals(cacheRef.current, next)) {
      return cacheRef.current;
    }
    cacheRef.current = next;
    return next;
  }, [hostId, directory]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
