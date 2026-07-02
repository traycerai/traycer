import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { runnerQueryKeys } from "@/lib/query-keys/runner-mutation-keys";
import { resolveDesktopHostOperationStatusBridge } from "@/lib/windows/desktop-capabilities";
import { useRunnerHost } from "@/providers/use-runner-host";

/**
 * Pipes the canonical cross-surface `HostOperationStatus` push (main process
 * -> every renderer window) into the shared TanStack Query cache entry that
 * the landing-page banner and Settings → Host both read. Mirrors
 * `HostRegistryUpdateListener`'s pattern exactly. Mounted once at the app
 * root (see `traycer-app.tsx`) so both surfaces - and a second open window -
 * observe the same status regardless of which one started the operation.
 */
export function HostOperationStatusListener(): null {
  const runnerHost = useRunnerHost();
  const management = runnerHost.hostManagement;
  const queryClient = useQueryClient();

  useEffect(() => {
    if (management === null) return;
    const bridge = resolveDesktopHostOperationStatusBridge(runnerHost);
    if (bridge === null) return;
    const subscription = bridge.onChange((status) => {
      queryClient.setQueryData(
        runnerQueryKeys.hostOperationStatus(management),
        status,
      );
    });
    return () => {
      subscription.dispose();
    };
  }, [runnerHost, management, queryClient]);

  return null;
}
