import { useCallback, useRef, useSyncExternalStore } from "react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { useHostBinding } from "@/lib/host";
import { hostDirectoryEntryEquals } from "@/hooks/host/use-host-directory-entry";

/** This machine's directory entry, not the active or tab host. Field-equal snapshots keep the previous reference. */
export function useReactiveLocalHostEntry(): HostDirectoryEntry | null {
  const binding = useHostBinding();
  const directory = binding?.directory ?? null;
  const cacheRef = useRef<HostDirectoryEntry | null>(null);
  const subscribe = useCallback(
    (callback: () => void) => {
      if (directory === null) {
        return () => undefined;
      }
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
    const next = directory === null ? null : directory.getLocalEntry();
    if (hostDirectoryEntryEquals(cacheRef.current, next)) {
      return cacheRef.current;
    }
    cacheRef.current = next;
    return next;
  }, [directory]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
