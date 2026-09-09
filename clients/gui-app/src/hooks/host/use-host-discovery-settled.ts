import { useCallback, useSyncExternalStore } from "react";
import { useHostBinding } from "@/lib/host";

/**
 * Whether host discovery has produced an ANSWER for this window yet.
 *
 * `HostDirectoryService.hasSettledFleet()` is the whole signal: true once a
 * fetch has actually delivered a registry listing - empty or not - and false
 * again whenever that observation is withdrawn (a `signed-out` outcome, whose
 * own doc calls it "the fetcher reporting it had no bearer to ask WITH", and
 * the foreign-identity drop). So it is not a launch latch: it re-arms on every
 * identity transition, which is exactly the edge the authority answers with
 * `reattachRequired` and a wiped fleet.
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
    () => (directory === null ? false : directory.hasSettledFleet()),
    [directory],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
