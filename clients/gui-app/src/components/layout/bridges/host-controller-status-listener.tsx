import { useEffect } from "react";
import { replaceEqualDeep, useQueryClient } from "@tanstack/react-query";
import type { HostControllerStatus } from "@traycer-clients/shared/platform/runner-host";
import { runnerQueryKeys } from "@/lib/query-keys/runner-mutation-keys";
import { resolveDesktopHostControllerStatusBridge } from "@/lib/windows/desktop-capabilities";
import { useRunnerHost } from "@/providers/use-runner-host";

/**
 * Pipes the canonical two-lane `HostControllerStatus` push (main process ->
 * every renderer window) into the shared TanStack Query cache entry that the
 * host gate, update banner, and Settings → Host all read. Mounted once at
 * the app root (see `traycer-app.tsx`) so every surface - and a second open
 * window - observes the same status regardless of which one submitted the
 * mutation that changed it.
 */
export function HostControllerStatusListener(): null {
  const runnerHost = useRunnerHost();
  const management = runnerHost.hostManagement;
  const queryClient = useQueryClient();

  useEffect(() => {
    if (management === null) return;
    const bridge = resolveDesktopHostControllerStatusBridge(runnerHost);
    if (bridge === null) return;
    const key = runnerQueryKeys.hostControllerStatus(management);
    const subscription = bridge.onChange((status) => {
      // The main process re-sends the status every few seconds whether or not
      // it changed, stamped with a fresh `checkedAt` that nothing here reads.
      // Storing it would hand every reader a new object each time and
      // re-render them all, the host gate included, for nothing.
      const previous = queryClient.getQueryData<HostControllerStatus>(key);
      if (
        previous !== undefined &&
        replaceEqualDeep(previous, {
          ...status,
          checkedAt: previous.checkedAt,
        }) === previous
      )
        return;
      queryClient.setQueryData(key, status);
    });
    return () => {
      subscription.dispose();
    };
  }, [runnerHost, management, queryClient]);

  return null;
}
