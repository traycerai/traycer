import { useMemo } from "react";
import {
  buildHostProgressView,
  type HostProgressView,
} from "@/lib/host/host-progress-copy";
import { useRunnerHostControllerStatusQuery } from "@/hooks/runner/use-runner-host-controller-status-query";

/** Read the HostController mutation lane, not a renderer mutation observer. null means no lane is running, not "no progress yet". */
export function useHostProvisioningProgress(): HostProgressView | null {
  const status = useRunnerHostControllerStatusQuery();
  const lane = status.data?.mutation ?? null;
  return useMemo(() => buildHostProgressView(lane), [lane]);
}
