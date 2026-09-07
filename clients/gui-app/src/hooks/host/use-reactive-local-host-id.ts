import { useCallback, useSyncExternalStore } from "react";
import { useHostBinding } from "@/lib/host";

/** Durable local host id via getLocalHostId(), not useReactiveLocalHostEntry()?.hostId (that is null while restarting). */
export function useReactiveLocalHostId(): string | null {
  const binding = useHostBinding();
  const directory = binding?.directory ?? null;
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
  const getSnapshot = useCallback(
    () => (directory === null ? null : directory.getLocalHostId()),
    [directory],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
