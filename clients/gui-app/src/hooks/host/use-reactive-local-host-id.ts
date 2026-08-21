import { useCallback, useSyncExternalStore } from "react";
import { useHostBinding } from "@/lib/host";

/**
 * Reactively projects THIS MACHINE's host id - the directory's retained
 * identity, not the identity of whatever local entry happens to exist right
 * now.
 *
 * ⚠ NOT `useReactiveLocalHostEntry()?.hostId`, and the difference is the whole
 * reason this hook exists. `getLocalEntry()` is rebuilt from the runner host's
 * snapshot, and `onLocalHostChange(null)` - which is what a local host
 * RESTARTING looks like - sets it to null. So the entry loses the id for
 * exactly the interval a caller asking "is this machine the one cycling?"
 * needs it, and answers `null` at the moment it matters. `getLocalHostId()` is
 * the durable answer: seeded from the shell's pid metadata and re-adopted from
 * every local snapshot, it survives the gap by design.
 *
 * `null` on shells with no local host (browser/mobile) and before the runtime
 * has resolved a binding - genuinely "there is no local machine here", rather
 * than "the local machine is between lives".
 *
 * No field-equality cache, unlike the entry hook: this is a string, so
 * `useSyncExternalStore`'s own `Object.is` check is already exact and a
 * benign re-emit cannot churn consumers.
 */
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
