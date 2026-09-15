import { useCallback, useSyncExternalStore } from "react";
import { useHostBinding } from "@/lib/host";

/**
 * The directory's display name for a host named by something other than this
 * surface's own binding - a draft's owner, a cloud row's device.
 *
 * `null` when the id names no row this device can see, or when no host
 * runtime is mounted at all: `useHostBinding()` is the null-safe read, so a
 * surface that renders bare (and a test that wraps one) still resolves,
 * rather than this hook forcing a provider on every consumer of a host id.
 * Callers render their own copy for `null` - never the raw id, which is a
 * UUID the user has no way to connect to a machine.
 *
 * Returns a string rather than the entry so the snapshot is compared BY
 * VALUE: `findById` allocates a fresh entry on every directory emit, and a
 * `useSyncExternalStore` over that object would re-render every consumer on
 * churn that changed no name.
 */
export function useHostLabel(hostId: string | null): string | null {
  const binding = useHostBinding();
  const directory = binding === null ? null : binding.directory;
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (directory === null) return () => undefined;
      const subscription = directory.onChange(() => {
        onStoreChange();
      });
      return () => {
        subscription.dispose();
      };
    },
    [directory],
  );
  const getSnapshot = useCallback(() => {
    if (directory === null || hostId === null) return null;
    return directory.findById(hostId)?.label ?? null;
  }, [directory, hostId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
