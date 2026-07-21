import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  HostNotificationsIndicatorStateRequest,
  HostNotificationsIndicatorStateResponse,
} from "@traycer/protocol/host/notifications/contracts";
import { HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP } from "@traycer/protocol/host/notifications/contracts";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostQueries } from "@/hooks/host/use-host-queries";
import { notificationsQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

const EMPTY_INDICATOR_STATE: HostNotificationsIndicatorStateResponse = {
  epics: {},
  chats: {},
};
const INDICATOR_ERROR_REFETCH_INTERVAL_MS = 30_000;

export interface UseHostNotificationIndicatorsArgs {
  readonly epicIds: ReadonlyArray<string>;
  readonly chatIds: ReadonlyArray<string>;
  readonly enabled: boolean;
}

export interface HostNotificationIndicatorsQuery {
  readonly data: HostNotificationsIndicatorStateResponse;
  readonly isPending: boolean;
  readonly isFetching: boolean;
  readonly error: HostRpcError | null;
  readonly refetch: () => Promise<void>;
}

/**
 * One surface-level indicator observer. The visible ids are canonicalized and
 * paired into cap-sized requests, so normal surfaces issue one RPC and very
 * large surfaces grow only by 500-id pages rather than one observer per row.
 */
export function useHostNotificationIndicators(
  args: UseHostNotificationIndicatorsArgs,
): HostNotificationIndicatorsQuery {
  const client = useHostClient();
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const requests = useMemo(
    () => indicatorRequests(args.epicIds, args.chatIds),
    [args.epicIds, args.chatIds],
  );
  const combined = useHostQueries<
    HostRpcRegistry,
    "host.notifications.indicatorState",
    HostNotificationIndicatorsQuery
  >({
    client,
    requests: requests.map((params) => ({
      method: "host.notifications.indicatorState",
      params,
    })),
    cacheKeyIdentity:
      userId === null
        ? undefined
        : notificationsQueryKeys.indicatorIdentity(userId),
    options: {
      enabled: args.enabled && userId !== null,
      refetchInterval: (query) =>
        query.state.status === "error"
          ? INDICATOR_ERROR_REFETCH_INTERVAL_MS
          : false,
    },
    combine: (results) => ({
      data: mergeIndicatorResponses(results),
      isPending: results.some((result) => result.isPending),
      isFetching: results.some((result) => result.isFetching),
      error: firstSupportedHostError(results),
      refetch: async (): Promise<void> => {
        await Promise.all(results.map((result) => result.refetch()));
      },
    }),
  });
  return combined;
}

export function indicatorRequests(
  epicIds: ReadonlyArray<string>,
  chatIds: ReadonlyArray<string>,
): ReadonlyArray<HostNotificationsIndicatorStateRequest> {
  const epicChunks = chunkIds(epicIds);
  const chatChunks = chunkIds(chatIds);
  const count = Math.max(epicChunks.length, chatChunks.length);
  return Array.from({ length: count }, (_value, index) => ({
    epicIds: [...(epicChunks[index] ?? [])],
    chatIds: [...(chatChunks[index] ?? [])],
  }));
}

function chunkIds(
  ids: ReadonlyArray<string>,
): ReadonlyArray<ReadonlyArray<string>> {
  const sorted = [...new Set(ids)].sort((left, right) =>
    left.localeCompare(right),
  );
  return Array.from(
    {
      length: Math.ceil(sorted.length / HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP),
    },
    (_value, index) =>
      sorted.slice(
        index * HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP,
        (index + 1) * HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP,
      ),
  );
}

function mergeIndicatorResponses(
  results: ReadonlyArray<
    UseQueryResult<HostNotificationsIndicatorStateResponse, HostRpcError>
  >,
): HostNotificationsIndicatorStateResponse {
  const responses = results
    .map((result) => result.data)
    .filter(
      (response): response is HostNotificationsIndicatorStateResponse =>
        response !== undefined,
    );
  if (responses.length === 0) return EMPTY_INDICATOR_STATE;
  return responses.reduce<HostNotificationsIndicatorStateResponse>(
    (combined, response) => ({
      epics: { ...combined.epics, ...response.epics },
      chats: { ...combined.chats, ...response.chats },
    }),
    EMPTY_INDICATOR_STATE,
  );
}

function firstSupportedHostError(
  results: ReadonlyArray<
    UseQueryResult<HostNotificationsIndicatorStateResponse, HostRpcError>
  >,
): HostRpcError | null {
  const error = results
    .map((result) => result.error)
    .find(
      (candidate) =>
        candidate !== null && candidate.code !== "E_HOST_UNSUPPORTED",
    );
  return error ?? null;
}
