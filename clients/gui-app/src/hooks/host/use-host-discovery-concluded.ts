import { useCallback, useSyncExternalStore } from "react";
import { useHostBinding } from "@/lib/host";

/**
 * Whether an attempt to read the host registry has CONCLUDED for this window.
 *
 * `HostDirectoryService.hasConcludedDiscovery()` is the whole signal: true once
 * an attempt has finished under the current identity, whatever it said, and
 * false again when a `signed-out` outcome withdraws it - the fetcher reporting
 * it had no bearer to ask WITH, which on a shell whose auth is still settling
 * is a race rather than an answer. Not a latch: it re-arms wherever the
 * observation does.
 *
 * The invariant a caller depends on: a surface that narrates ∅ before any
 * attempt has concluded reports "nobody has asked" as "no host is available".
 * The authority derives its leases from the fleet it has been given, so an
 * unanswered fleet and an account that owns no hosts are the same value - an
 * empty lease list, and therefore ∅.
 *
 * ⚠ NOT `hasSettledFleet()`. That flag is about the fleet's CONTENTS, so a
 * registry that cannot be reached never sets it, and a wait gated on it lasts
 * as long as the outage. A wait ends at the first CONCLUSION; what that
 * conclusion means is the caller's verdict to narrate, not this hook's.
 *
 * SUBSCRIBED, never derived from the directory ROWS: the rows an emit carries
 * can be deeply equal to the previous ones, so a derivation keyed on them never
 * sees the flag move. `useSyncExternalStore` rather than a subscribe-and-
 * `setState` effect, in the image of `useReactiveLocalHostId` next door - the
 * value is a boolean, so the store's own `Object.is` check is already exact,
 * and the first answer stays out of a second render pass.
 *
 * `false` before the runtime has resolved a binding: an absent directory has
 * concluded nothing. That arm cannot strand a caller that waits on this, for a
 * structural reason - `HostRuntimeProvider` renders its fallback instead of its
 * children while `binding === null`, so nothing below it exists yet, including
 * `mountSelectionAuthorityBridge`, the one writer of the authority store's
 * `attached`. A window cannot be attached and binding-less at once, which is
 * the pairing a caller gating on both would need in order to wait forever.
 */
export function useHostDiscoveryConcluded(): boolean {
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
    () => (directory === null ? false : directory.hasConcludedDiscovery()),
    [directory],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
