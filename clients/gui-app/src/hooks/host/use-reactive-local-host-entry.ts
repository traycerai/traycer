import { useCallback, useRef, useSyncExternalStore } from "react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { useHostBinding } from "@/lib/host";
import { hostDirectoryEntryEquals } from "@/hooks/host/use-host-directory-entry";

/**
 * Reactively projects the LOCAL host's directory entry - the machine this
 * client is running on - independent of whichever host is currently active
 * (`useReactiveActiveHostId`) or tab-bound (`useTabHostId`). This is a third,
 * narrower scope: consumers that must always talk to "this machine"
 * regardless of what the user has selected elsewhere in the app (currently
 * only the notifications stream, per the G8 decision - notifications never
 * follow the active host).
 *
 * `null` on shells with no local host (browser/mobile) and before the host
 * runtime has resolved a binding.
 *
 * Shares `useHostDirectoryEntry`'s field-equality caching: `getLocalEntry()`
 * is rebuilt from scratch on every `onLocalHostChange` snapshot - even when
 * only non-observable metadata (e.g. `pid`) changed - so a naive
 * `useSyncExternalStore` would churn every consumer (rebuilding the stream
 * client below) on each benign event. A genuine change (a fresh
 * `websocketUrl` on respawn) still propagates.
 */
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
