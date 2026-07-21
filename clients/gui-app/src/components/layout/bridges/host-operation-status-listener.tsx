import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HostOperationStatusEnvelope } from "@traycer-clients/shared/platform/runner-host";
import { selectNewestHostOperationStatusEnvelope } from "@/hooks/runner/use-runner-host-operation-status-query";
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
    let disposed = false;
    let retryTimer: number | null = null;
    let snapshotFailures = 0;
    const applyEnvelope = (envelope: HostOperationStatusEnvelope): void => {
      queryClient.setQueryData<HostOperationStatusEnvelope>(
        runnerQueryKeys.hostOperationStatus(management),
        (previous) =>
          selectNewestHostOperationStatusEnvelope(previous, envelope),
      );
    };
    const subscription = bridge.onChange((envelope) => {
      applyEnvelope(envelope);
    });
    const readSnapshot = (): void => {
      void management.getOperationStatus().then(
        (envelope) => {
          if (disposed) return;
          snapshotFailures = 0;
          applyEnvelope(envelope);
        },
        () => {
          if (disposed) return;
          const retryDelay = Math.min(
            30_000,
            1_000 * 2 ** Math.min(snapshotFailures, 5),
          );
          snapshotFailures += 1;
          retryTimer = window.setTimeout(readSnapshot, retryDelay);
        },
      );
    };
    // Subscribe before the snapshot read. Every application path passes
    // through applyEnvelope, which rejects stale reads by main-authored
    // revision and lets a pushed terminal null win the race.
    readSnapshot();
    return () => {
      disposed = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
      subscription.dispose();
    };
  }, [runnerHost, management, queryClient]);

  return null;
}
