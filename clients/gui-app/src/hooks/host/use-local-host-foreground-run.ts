import { useRunnerHostLifecycleQuery } from "@/hooks/runner/use-runner-host-lifecycle-query";
import { isForegroundHostRun } from "@/lib/host/host-foreground-run";

/**
 * {@link isForegroundHostRun} for this machine's lifecycle view. `false` on a
 * shell with no lifecycle bridge and until the view is read, so a control is
 * never disabled on a fact nobody has reported.
 */
export function useLocalHostForegroundRun(): boolean {
  return isForegroundHostRun(useRunnerHostLifecycleQuery().data);
}
