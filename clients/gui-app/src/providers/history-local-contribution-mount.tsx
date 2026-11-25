import { useEffect, useMemo, useRef } from "react";
import { readProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import type { ViewReplicaContributionRegistration } from "@traycer-clients/shared/view-replica/service";
import { useHostBinding, useHostClient } from "@/lib/host";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { registerCloudEpicTasksClient } from "@/lib/cloud-epic-tasks-query/client-registry";
import {
  applyHistoryContributionToCachedPage,
  noteUnfilteredHistoryContribution,
  noteUnfilteredHistoryContributionPending,
  readHistoryHostContribution,
  startUnfilteredHistoryContributionRead,
  subscribeUnfilteredHistoryContributions,
  unfilteredHistoryContribution,
} from "@/lib/history-composition/history-local-contribution";
import { historyReplicaService } from "@/lib/view-replica/history-replica";
import { admitsLocalPlane, useAuthStore } from "@/stores/auth/auth-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

/**
 * Registers History's local contribution on the replica's paint gate, so no
 * cached History page paints without the host's local rows and tombstones.
 *
 * The local contribution belongs to the computer serving the app. It can
 * be combined with a page that the pool answers.
 */
export function HistoryLocalContributionMount(): null {
  const appClient = useHostClient();
  const runtimeClient = useHostBinding()?.hostClient ?? appClient;
  const servingComputerId = useSelectionAuthorityStore((state) =>
    state.servingPeer?.kind === "computer" ? state.servingPeer.hostId : null,
  );
  const poolBuild = readProcessHostRpcTierPlan().pool !== null;
  const clientRoot = poolBuild ? runtimeClient : appClient;
  const client = useMemo(
    () =>
      poolBuild
        ? clientRoot.createRequesterForHostId(servingComputerId)
        : clientRoot,
    [clientRoot, poolBuild, servingComputerId],
  );
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
      (!poolBuild &&
        unfilteredHistoryContribution(accountId, hostId) !== undefined)
    ) {
      return;
    }
    registerCloudEpicTasksClient(hostId, client);
    const abort = new AbortController();
    const abandonPending = noteUnfilteredHistoryContributionPending(
      accountId,
      hostId,
    );
    const readStartedAt = startUnfilteredHistoryContributionRead();
    void readHistoryHostContribution({
      client,
      filters: null,
      signal: abort.signal,
      onIncomplete: null,
    }).then((contribution) => {
      if (abort.signal.aborted) return;
      noteUnfilteredHistoryContribution(
        accountId,
        hostId,
        contribution,
        readStartedAt,
      );
    }, abandonPending);
    // An unanswered read gives its scope back, so the next mount of this
    // host and account reads it again instead of finding a stale `pending`.
    return () => {
      abort.abort();
      abandonPending();
    };
  }, [accountId, client, hostId, poolBuild, requestContextUserId]);

  return null;
}
