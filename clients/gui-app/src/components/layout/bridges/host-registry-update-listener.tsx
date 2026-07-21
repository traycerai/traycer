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
      // File the push under the channel main resolved it against, never
      // against whatever channel this window currently believes is active. A
      // channel change emits the app-update snapshot and this state as two
      // separate IPC events, so this callback can run before React has
      // re-rendered with the new channel - keying off a captured renderer
      // value would then write fresh state under the retired key and leave
      // the live one stale.
      queryClient.setQueryData(
        runnerQueryKeys.hostRegistryUpdate(
          management,
          state.includePreReleases,
        ),
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
