import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { AgentActivityCoverage } from "@/lib/agent-activity";
import { useHostBinding } from "@/lib/host";
import {
  selectKnownHostsActivityCoverage,
  useAgentActivityStore,
} from "@/stores/agent-activity-store";

/**
 * What the activity plane can say about anything whose agents may be on any
 * of the account's machines: a task hover card, a rail meter. The rule is {@link selectKnownHostsActivityCoverage}; this
 * pairs it with the directory's settled host list.
 *
 * The directory is SUBSCRIBED like `useHostDiscoveryConcluded` next door, and
 * its answer is flattened to one string (`null` until the fleet settles) so
 * `useSyncExternalStore`'s `Object.is` check is exact with no snapshot cache.
 * No binding - a shell before its runtime resolves, or a test that mounts
 * none - is an unsettled fleet, and so `indeterminate`.
 */
export function useAccountActivityCoverage(): AgentActivityCoverage {
  const binding = useHostBinding();
  const directory = binding?.directory ?? null;
  const subscribe = useCallback(
    (callback: () => void) => {
      if (directory === null) return () => undefined;
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
    () => directory?.knownHostIds()?.join("\n") ?? null,
    [directory],
  );
  const key = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const knownHostIds = useMemo(
    () => (key === null ? null : key.split("\n").filter((id) => id !== "")),
    [key],
  );
  return useAgentActivityStore((state) =>
    selectKnownHostsActivityCoverage(state.byHost, knownHostIds),
  );
}
