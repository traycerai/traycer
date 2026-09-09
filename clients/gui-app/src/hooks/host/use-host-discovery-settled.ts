import { useCallback, useSyncExternalStore } from "react";
import { useHostBinding } from "@/lib/host";

/**
 * Whether host discovery has FINISHED ASKING for this window yet.
 *
 * `HostDirectoryService.hasConcludedDiscovery()` is the whole signal: true once
 * an attempt to read the registry has finished under the current identity,
 * whatever it said, and false again when a `signed-out` outcome withdraws it -
 * the fetcher reporting it had no bearer to ask WITH, which on a shell whose
 * auth is still settling is a race rather than an answer. So it is not a launch
 * latch: it re-arms wherever the observation does.
 *
 * ⚠ NOT `hasSettledFleet()`, and the difference is a lockout. That flag is
 * about the fleet's CONTENTS, so a registry that cannot be reached at all - an
 * offline phone - never sets it: waiting on it would hold a start-in-progress
 * over the whole outage, withholding the offline narration's Retry and Report
 * issue for as long as it lasted, with only the 60s poll to end it. A wait must
 * end at the first CONCLUSION; what that conclusion means is the caller's
 * verdict to narrate, not this hook's.
 *
 * WHY A SURFACE NEEDS IT. The authority derives its leases from the fleet it
 * has been given (`fleet.hosts.map(...)`), so before anything has answered, an
 * unanswered fleet and an account with no hosts are the SAME value: an empty
 * lease list, and therefore ∅. A surface that narrates ∅ as a failure is
 * narrating "nobody has asked yet" as "no host is available" - which is the
 * launch flash this exists to stop.
 *
 * SUBSCRIBED, never derived from the directory ROWS. The flag flips on a
 * committed listing, and the service emits for exactly that reason, but the
 * rows it emits can be deeply equal to the previous ones - so a derivation
 * keyed on the rows would never see the flag move. This is the same reasoning
 * `landing-terminal-tombstone-recovery-bridge` states for its own read of the
 * same predicate.
 *
 * `useSyncExternalStore` rather than a subscribe-and-`setState` effect, in the
 * image of `useReactiveLocalHostId` next door: the value is a boolean, so the
 * store's own `Object.is` check is already exact and a benign re-emit cannot
 * churn consumers - and it keeps the FIRST answer out of a second render pass,
 * which for a launch-time gate is the whole frame this hook is about.
 *
 * `false` before the runtime has resolved a binding: an absent directory has
 * not answered anything, which is also the correct reading for the runtime
 * being rebuilt under this window (browser/dev).
 *
 * That arm cannot strand a caller that waits on this, and the reason is
 * structural rather than defensive. `HostRuntimeProvider` renders its fallback
 * instead of its children while `binding === null`, so nothing below it exists
 * yet - including `mountSelectionAuthorityBridge`, the one writer of the
 * authority store's `attached`. A window therefore cannot be attached and
 * binding-less at the same time, which is the pairing a caller gating on both
 * would need in order to wait forever.
 */
export function useHostDiscoverySettled(): boolean {
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
