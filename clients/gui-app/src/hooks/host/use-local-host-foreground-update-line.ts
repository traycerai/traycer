import { useRunnerHostLifecycleQuery } from "@/hooks/runner/use-runner-host-lifecycle-query";
import { hostForegroundUpdateLine } from "@/lib/host/host-lifecycle-copy";

/**
 * {@link hostForegroundUpdateLine} for this machine's lifecycle view: what
 * this machine's update surfaces say in place of their controls during a
 * foreground run. `null` otherwise, and `null` until the view is read, like
 * `useLocalHostForegroundRun`.
 */
export function useLocalHostForegroundUpdateLine(): string | null {
  return hostForegroundUpdateLine(useRunnerHostLifecycleQuery().data);
}
