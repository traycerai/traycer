import { useEffect, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ProvidersChangedStreamClient } from "@traycer-clients/shared/host-transport/providers-changed-stream-client";
import { acquireHostConnection } from "@traycer-clients/shared/host-client/host-connection-registry";
import { isReopenableHostStreamClose } from "@traycer-clients/shared/host-client/host-connection-reconnect-engine";
import type { ProviderId } from "@traycer/protocol/host/provider-ids";
import {
  PROVIDER_CATALOG_INVALIDATIONS,
  PROVIDER_INVALIDATIONS,
} from "@/hooks/providers/invalidations";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
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
    // A provider event names its provider, so only that harness's model and
    // command catalogs are refetched (a cold `listModels` can spawn its
    // server); the catch-up on open names none and refreshes every harness's,
    // since any provider may have changed during the disconnect.
    const invalidateProviderQueries = (changed: ProviderId | null): void => {
      for (const method of PROVIDER_INVALIDATIONS) {
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(hostId, method),
        });
      }
      for (const method of PROVIDER_CATALOG_INVALIDATIONS) {
        const scope = hostQueryKeys.methodScope(hostId, method);
        void queryClient.invalidateQueries({
          queryKey:
            changed === null
              ? scope
              : [...scope, { harnessId: providerIdToGuiHarnessId(changed) }],
        });
      }
    };

    function openClient(): void {
      if (disposed) return;
      let client: ProvidersChangedStreamClient | null = null;
      let openedAtMs = 0;
      client = new ProvidersChangedStreamClient({
        wsStreamClient: streamClient,
        onChanged: (providerId) => {
          if (currentClient !== client) return;
          reopenScheduler.resetBackoff();
          invalidateProviderQueries(providerId);
        },
        onConnectionStatus: (status, reason) => {
          if (currentClient !== client) return;
          if (status === "open") {
            openedAtMs = Date.now();
            // Catch up after any disconnect window even when the host emitted
            // no later provider event to wake this renderer.
            invalidateProviderQueries(null);
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
