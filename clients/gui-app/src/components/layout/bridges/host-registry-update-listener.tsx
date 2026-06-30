import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { runnerQueryKeys } from "@/lib/query-keys/runner-mutation-keys";
import { resolveDesktopHostRegistryUpdatesBridge } from "@/lib/windows/desktop-capabilities";
import { useRunnerHost } from "@/providers/use-runner-host";

export function HostRegistryUpdateListener(): null {
  const runnerHost = useRunnerHost();
  const management = runnerHost.hostManagement;
  const queryClient = useQueryClient();

  useEffect(() => {
    if (management === null) return;
    const bridge = resolveDesktopHostRegistryUpdatesBridge(runnerHost);
    if (bridge === null) return;
    const subscription = bridge.onChange((state) => {
      queryClient.setQueryData(
        runnerQueryKeys.hostRegistryUpdate(management),
        state,
      );
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.hostInstalledRecord(management),
      });
    });
    return () => {
      subscription.dispose();
    };
  }, [runnerHost, management, queryClient]);

  return null;
}
