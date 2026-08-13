import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  HostNotificationsIndicatorStateRequest,
  HostNotificationsIndicatorStateResponse,
} from "@traycer/protocol/host/notifications/contracts";
import { HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP } from "@traycer/protocol/host/notifications/contracts";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostQueries } from "@/hooks/host/use-host-queries";
import { notificationsQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

const EMPTY_INDICATOR_STATE: HostNotificationsIndicatorStateResponse = {
  epics: {},
  chats: {},
};

export interface UseHostNotificationIndicatorsArgs {
  /**
   * The host to ASK. Required, and required to be explicit: this RPC is
   * computed over ONE host's SQLite rows, so an answer is only about the
   * entities that host owns. A caller that reaches for the app-wide active
   * host because it is the easy one to get is exactly how a chat bound to
   * another host ends up asking a machine that has never heard of it - and how
   * a host-minted id that two hosts happen to share lights the wrong surface.
   *
   * `null` means the app-wide active host, which is the right answer only for
   * a caller whose ids are EPIC ids: an Epic is a shared cloud entity rather
   * than a host-owned record.
   *
   * Resolution stays INSIDE this hook rather than being hoisted to the caller,
   * because this module is the seam every consuming surface's test already
   * replaces. A caller that resolved its own client would reach the host
   * runtime around that seam, and every suite rendering such a surface would
   * have to start providing one.
   */
  readonly hostId: string | null;
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
 * split into cap-sized requests, so normal surfaces issue one RPC and very
 * large surfaces grow by bounded pages rather than one observer per row.
 * Epic chunks are crossed with chat chunks because every task aggregate must
 * receive the complete live-chat whitelist.
 */
export function useHostNotificationIndicators(
  args: UseHostNotificationIndicatorsArgs,
): HostNotificationIndicatorsQuery {
  const client = useHostClientForHostId(args.hostId);
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
  if (epicChunks.length === 0) {
    return chatChunks.map((chatChunk) => ({
      epicIds: [],
      chatIds: [...chatChunk],
    }));
  }
  if (chatChunks.length === 0) {
    return epicChunks.map((epicChunk) => ({
      epicIds: [...epicChunk],
      chatIds: [],
    }));
  }
  return epicChunks.flatMap((epicChunk) =>
    chatChunks.map((chatChunk) => ({
      epicIds: [...epicChunk],
      chatIds: [...chatChunk],
    })),
  );
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
      epics: mergeEntityIndicatorStates(combined.epics, response.epics),
      chats: mergeEntityIndicatorStates(combined.chats, response.chats),
    }),
    EMPTY_INDICATOR_STATE,
  );
}

function mergeEntityIndicatorStates(
  left: HostNotificationsIndicatorStateResponse["epics"],
  right: HostNotificationsIndicatorStateResponse["epics"],
): HostNotificationsIndicatorStateResponse["epics"] {
  const merged = { ...left };
  for (const [entityId, state] of Object.entries(right)) {
    if (!Object.hasOwn(merged, entityId)) {
      merged[entityId] = state;
      continue;
    }
    const prior = merged[entityId];
    merged[entityId] = {
      pendingApproval: prior.pendingApproval || state.pendingApproval,
      pendingInterview: prior.pendingInterview || state.pendingInterview,
      pendingFork: prior.pendingFork || state.pendingFork,
      unreadFailure: prior.unreadFailure || state.unreadFailure,
      unreadDone: prior.unreadDone || state.unreadDone,
    };
  }
  return merged;
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
