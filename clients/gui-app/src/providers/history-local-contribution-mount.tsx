import { useEffect, useRef } from "react";
import type { ViewReplicaContributionRegistration } from "@traycer-clients/shared/view-replica/service";
import { useHostClient } from "@/lib/host";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { registerCloudEpicTasksClient } from "@/lib/cloud-epic-tasks-query/client-registry";
import {
  applyHistoryContributionToCachedPage,
  noteUnfilteredHistoryContribution,
  readHistoryHostContribution,
  subscribeUnfilteredHistoryContributions,
  unfilteredHistoryContribution,
} from "@/lib/history-composition/history-local-contribution";
import { historyReplicaService } from "@/lib/view-replica/history-replica";
import { admitsLocalPlane, useAuthStore } from "@/stores/auth/auth-store";

/**
 * Registers History's local contribution on the replica's paint gate, so no
 * cached History page paints without the host's local rows and tombstones.
 *
 * The host is History's own: the app-wide host whose page History lists
 * (`useCloudEpicTasksQuery` reads the same client). When that host or the
 * account changes, a contribution it has not answered for yet holds the
 * paint, and this mount reads it once - History's own fetches refresh it
 * after that.
 */
export function HistoryLocalContributionMount(): null {
  const client = useHostClient();
  const readiness = useReactiveHostReadiness(client);
  const status = useAuthStore((state) => state.status);
  const contextUserId = useAuthStore(
    (state) => state.contextMetadata?.userId ?? null,
  );
  const accountId = admitsLocalPlane(status) ? contextUserId : null;
  const hostId = readiness.hostId;
  const requestContextUserId = readiness.requestContextUserId;
  const hostIdRef = useRef<string | null>(hostId);
  const registrationRef = useRef<ViewReplicaContributionRegistration | null>(
    null,
  );

  useEffect(() => {
    const registration = historyReplicaService.registerLocalContribution({
      apply: (page, address) =>
        applyHistoryContributionToCachedPage(page, address, hostIdRef.current),
    });
    registrationRef.current = registration;
    const unsubscribe = subscribeUnfilteredHistoryContributions(() =>
      registration.changed(),
    );
    return () => {
      unsubscribe();
      registrationRef.current = null;
      registration.unregister();
    };
  }, []);

  useEffect(() => {
    hostIdRef.current = hostId;
    registrationRef.current?.changed();
    if (
      accountId === null ||
      hostId === null ||
      requestContextUserId !== accountId ||
      unfilteredHistoryContribution(accountId, hostId) !== undefined
    ) {
      return;
    }
    registerCloudEpicTasksClient(hostId, client);
    const abort = new AbortController();
    noteUnfilteredHistoryContribution(accountId, hostId, { kind: "pending" });
    void readHistoryHostContribution({
      client,
      filters: null,
      signal: abort.signal,
      onIncomplete: null,
    }).then(
      (contribution) =>
        noteUnfilteredHistoryContribution(accountId, hostId, contribution),
      () => undefined,
    );
    return () => abort.abort();
  }, [accountId, client, hostId, requestContextUserId]);

  return null;
}
