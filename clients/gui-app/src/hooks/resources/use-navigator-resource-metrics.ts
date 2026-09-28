import { useMemo } from "react";
import { useRegionValue } from "@/lib/layout-overrides";
import {
  NAVIGATOR_RESOURCE_METRICS,
  type NavigatorResourceMetric,
} from "@/stores/settings/settings-store";

/**
 * Which readings a navigator or sidebar row prints, answered by the Resource
 * monitor's two settings (L-174):
 *
 * - WHETHER rows print at all is its "Readings on agent rows" switch
 *   (`agentRows`, G7). It is independent of the monitor's own Shown: the two
 *   used to be one switch, so the rows could not be turned off without losing
 *   the status bar reading too. `resources-stream-mount.tsx` connects the
 *   stream while either of them wants it.
 * - WHICH readings is the monitor's Metrics selection, the same one its own
 *   reading follows, in chip order. RAM share has no per-row meaning (the
 *   per-owner snapshot carries no host total to divide by), so rows skip it; a
 *   selection that leaves nothing a row can draw draws no chips.
 *
 * Its own module rather than a second export beside the chip components: a
 * file that exports both a hook and components loses fast refresh for the
 * components.
 */
export function useNavigatorResourceMetrics(): ReadonlyArray<NavigatorResourceMetric> {
  const agentRows = useRegionValue("resourceMonitor", "agentRows");
  const cpu = useRegionValue("resourceMonitor", "cpu");
  const memory = useRegionValue("resourceMonitor", "memory");
  const processes = useRegionValue("resourceMonitor", "processes");
  // Memoised on the four booleans, so every row of a list shares one stable
  // array between renders rather than a fresh one each time.
  return useMemo(() => {
    if (!agentRows) return [];
    const on: Record<NavigatorResourceMetric, boolean> = {
      cpu,
      memory,
      processes,
    };
    return NAVIGATOR_RESOURCE_METRICS.filter((metric) => on[metric]);
  }, [agentRows, cpu, memory, processes]);
}
