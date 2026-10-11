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
import { invalidateProviderFamilyQueries } from "@/lib/query-keys/providers-query-keys";

const HEALTHY_SESSION_RESET_MS = 30_000;

export function ProvidersChangedStreamMount(): ReactNode {
  const wsStreamClient = useWsStreamClient();
  const unsupported =
    useStreamMethodSupport("providers.changed") === "unsupported";
  const hostId = useStreamHostId();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (wsStreamClient === null || hostId === null || unsupported) {
      return;
    }
    const hostConnection = acquireHostConnection(hostId);
    const streamClient = wsStreamClient;
    let disposed = false;
    let currentClient: ProvidersChangedStreamClient | null = null;
    let everOpened = false;
    const reopenScheduler = hostConnection.reconnect.openReopenLane(() => {
      currentClient?.close();
      currentClient = null;
      openClient();
    }, isReopenableHostStreamClose);
    let invalidationTimer: number | null = null;
    let invalidateAllProviders = false;
    let catchUpReceivedBefore: number | null = null;
    const changedProviders = new Set<string>();
    const flush = (): void => {
      invalidationTimer = null;
      if (catchUpReceivedBefore !== null) {
        invalidateProviderFamilyQueries(
          queryClient,
          hostId,
          PROVIDER_INVALIDATIONS,
          { receivedBy: catchUpReceivedBefore },
        );
      }
      if (invalidateAllProviders || changedProviders.size > 0) {
        invalidateProviderFamilyQueries(
          queryClient,
          hostId,
          PROVIDER_INVALIDATIONS,
          invalidateAllProviders ? [null] : [...changedProviders],
        );
      }
      catchUpReceivedBefore = null;
      invalidateAllProviders = false;
      changedProviders.clear();
    };
    const schedule = (): void => {
      if (invalidationTimer === null) {
        invalidationTimer = window.setTimeout(flush, 50);
      }
    };
    const invalidateProviderQueries = (providerId: string | null): void => {
      if (providerId === null) invalidateAllProviders = true;
      else changedProviders.add(providerId);
      schedule();
    };
    const catchUpReceivedBeforeMs = (receivedBefore: number): void => {
      catchUpReceivedBefore = receivedBefore;
      schedule();
    };

    function openClient(): void {
      if (disposed) return;
      let client: ProvidersChangedStreamClient | null = null;
      let openedAtMs = 0;
      // Reads that land while this subscription is being opened are treated
      // as covered by it.
      const subscribeStartedAtMs = Date.now();
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
            // A re-open catches up the disconnect window, which no event
            // covers. The first open has no such window: only answers received
            // before this subscription started can predate it. Accepted
            // residue: a host change landing between computing a read and
            // registering this subscription, for a read answered during the
            // handshake, waits for that provider's next event or poll.
            if (everOpened) invalidateProviderQueries(null);
            else catchUpReceivedBeforeMs(subscribeStartedAtMs);
            everOpened = true;
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
      if (invalidationTimer !== null) window.clearTimeout(invalidationTimer);
      reopenScheduler.dispose();
      currentClient?.close();
      currentClient = null;
      hostConnection.release();
    };
  }, [hostId, queryClient, unsupported, wsStreamClient]);

  return null;
}
