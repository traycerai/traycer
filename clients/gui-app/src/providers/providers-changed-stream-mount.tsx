import { useEffect, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ProvidersChangedStreamClient } from "@traycer-clients/shared/host-transport/providers-changed-stream-client";
import { acquireHostConnection } from "@traycer-clients/shared/host-client/host-connection-registry";
import { isReopenableHostStreamClose } from "@traycer-clients/shared/host-client/host-connection-reconnect-engine";
import { PROVIDER_INVALIDATIONS } from "@/hooks/providers/invalidations";
import {
  useStreamHostId,
  useStreamMethodSupport,
  useWsStreamClient,
} from "@/lib/host/stream-runtime-context";
import { hostQueryKeys } from "@/lib/query-keys";

const HEALTHY_SESSION_RESET_MS = 30_000;

export function ProvidersChangedStreamMount(): ReactNode {
  const wsStreamClient = useWsStreamClient();
  const support = useStreamMethodSupport("providers.changed");
  const hostId = useStreamHostId();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (
      wsStreamClient === null ||
      hostId === null ||
      support === "unsupported"
    ) {
      return;
    }
    const hostConnection = acquireHostConnection(hostId);
    const streamClient = wsStreamClient;
    let disposed = false;
    let currentClient: ProvidersChangedStreamClient | null = null;
    const reopenScheduler = hostConnection.reconnect.openReopenLane(() => {
      currentClient?.close();
      currentClient = null;
      openClient();
    }, isReopenableHostStreamClose);
    const invalidateProviderQueries = (): void => {
      for (const method of PROVIDER_INVALIDATIONS) {
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(hostId, method),
        });
      }
    };

    function openClient(): void {
      if (disposed) return;
      let client: ProvidersChangedStreamClient | null = null;
      let openedAtMs = 0;
      client = new ProvidersChangedStreamClient({
        wsStreamClient: streamClient,
        onChanged: () => {
          if (currentClient !== client) return;
          reopenScheduler.resetBackoff();
          invalidateProviderQueries();
        },
        onConnectionStatus: (status, reason) => {
          if (currentClient !== client) return;
          if (status === "open") {
            openedAtMs = Date.now();
            // Catch up after any disconnect window even when the host emitted
            // no later provider event to wake this renderer.
            invalidateProviderQueries();
            return;
          }
          if (status !== "closed") return;
          if (
            openedAtMs !== 0 &&
            Date.now() - openedAtMs >= HEALTHY_SESSION_RESET_MS
          ) {
            reopenScheduler.resetBackoff();
          }
          reopenScheduler.scheduleAfterClose(reason);
        },
      });
      currentClient = client;
    }

    openClient();
    return () => {
      disposed = true;
      reopenScheduler.dispose();
      currentClient?.close();
      currentClient = null;
      hostConnection.release();
    };
  }, [hostId, queryClient, support, wsStreamClient]);

  return null;
}
