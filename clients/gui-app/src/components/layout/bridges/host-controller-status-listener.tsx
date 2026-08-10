import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
    const subscription = bridge.onChange((status) => {
      queryClient.setQueryData(
        runnerQueryKeys.hostControllerStatus(management),
        status,
      );
    });
    return () => {
      subscription.dispose();
    };
  }, [runnerHost, management, queryClient]);

  return null;
}
