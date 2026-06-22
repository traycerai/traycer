import { useCallback, useSyncExternalStore } from "react";
import { useHostBinding } from "@/lib/host";

/**
 * Reactively projects the currently bound host id from `HostClient`.
 *
 * `HostClient` stores the active host outside React and only exposes
 * change notifications through `onChange(...)`, so consumers that need to
 * react to host swaps must subscribe explicitly rather than reading
 * `getActiveHostId()` once at render time.
 */
export function useReactiveActiveHostId(): string | null {
  const binding = useHostBinding();
  const client = binding?.hostClient ?? null;
  const subscribe = useCallback(
    (callback: () => void) => {
      if (client === null) {
        return () => undefined;
      }
      const unsubscribe = client.onChange(() => {
        callback();
      });
      return () => {
        unsubscribe();
      };
    },
    [client],
  );
  const getSnapshot = useCallback(
    () => (client === null ? null : client.getActiveHostId()),
    [client],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
