import { useCallback, useSyncExternalStore } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { readDoorReason } from "@traycer/protocol/framework/door-reason";
import {
  HOST_DOOR_STATE_POLICY,
  hostRefusalOf,
  type HostDoorState,
} from "@traycer-clients/shared/host-transport/host-door-state";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { queryKeys } from "@/lib/query-keys";
import { redialHostForRetry } from "@/lib/host/session-connectivity";
import { useHostDoorState } from "@/stores/host/host-door-state-store";
import { useHostNegotiatedMethodVersions } from "@/hooks/host/use-host-negotiated-method-version";

export interface HostReadRefusal {
  /**
   * The host's door raised a state nothing retries, or its
   * `environment.status` read settled on an error that ends waiting.
   */
  readonly refused: boolean;
  /**
   * The door says the host is too old for this app (`older-host`): only an
   * update clears it, so reading it again cannot.
   */
  readonly outdated: boolean;
  /** Reads the host's status again by its own key. */
  readonly retryStatus: () => void;
}

/**
 * Whether this app's read of `hostId` has conclusively failed: its door raised
 * a state nothing retries, or its `environment.status` read settled on an
 * error, prior data or not, on a host whose handshake has not ruled the
 * method out (a host without it is read on the legacy path, as the Settings
 * entry does). Still waiting: a read in flight, a refusal the
 * host marked retryable, and a first `not_admitted`, since token recovery
 * tries one fresh token and only the door's terminal state says that one was
 * refused too.
 */
export function useHostReadRefusal(hostId: string | null): HostReadRefusal {
  const door = useHostDoorState(hostId);
  const doorRefused = door !== null && doorStateRefusesForGood(door);
  const queryClient = useQueryClient();
  const subscribe = useCallback(
    (onChange: () => void) => queryClient.getQueryCache().subscribe(onChange),
    [queryClient],
  );
  const readStatusFailed = useCallback(
    () => hostStatusReadFailed(queryClient, hostId),
    [queryClient, hostId],
  );
  const versions = useHostNegotiatedMethodVersions(
    hostId === null ? [] : [hostId],
    "environment.status",
  );
  const statusAbsent = hostId !== null && versions.get(hostId) === false;
  const statusFailed =
    useSyncExternalStore(subscribe, readStatusFailed) && !statusAbsent;
  const retryStatus = useCallback(() => {
    if (hostId === null) return;
    redialHostForRetry(hostId);
    void queryClient.refetchQueries({ queryKey: statusQueryKey(hostId) });
  }, [queryClient, hostId]);
  return {
    refused: doorRefused || statusFailed,
    outdated: door?.kind === "older-host",
    retryStatus,
  };
}

/** Whether `hostId`'s `environment.status` read is in flight, from the cache. */
export function useHostStatusReading(hostId: string | null): boolean {
  const queryClient = useQueryClient();
  const subscribe = useCallback(
    (onChange: () => void) => queryClient.getQueryCache().subscribe(onChange),
    [queryClient],
  );
  const readFetching = useCallback(
    () =>
      hostId !== null &&
      queryClient.getQueryState(statusQueryKey(hostId))?.fetchStatus ===
        "fetching",
    [queryClient, hostId],
  );
  return useSyncExternalStore(subscribe, readFetching);
}

function doorStateRefusesForGood(state: HostDoorState): boolean {
  const policy = HOST_DOOR_STATE_POLICY[state.kind];
  return policy.blocks && policy.retry === "none";
}

function statusQueryKey(hostId: string) {
  return queryKeys.hostMethod<HostRpcRegistry, "environment.status">(
    hostId,
    "environment.status",
    {},
  );
}

function hostStatusReadFailed(
  queryClient: QueryClient,
  hostId: string | null,
): boolean {
  if (hostId === null) return false;
  const state = queryClient.getQueryState<
    ResponseOfMethod<HostRpcRegistry, "environment.status">,
    HostRpcError
  >(statusQueryKey(hostId));
  if (state?.status !== "error" || state.fetchStatus !== "idle") return false;
  const refusal = state.error === null ? null : hostRefusalOf(state.error);
  if (refusal?.retryable === true) return false;
  return readDoorReason(refusal?.doorReason) !== "not_admitted";
}
