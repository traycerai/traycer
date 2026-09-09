import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  HostNotificationsIndicatorStateRequestV11,
  HostNotificationsIndicatorStateResponse,
} from "@traycer/protocol/host/notifications/contracts";
import { HOST_NOTIFICATIONS_INDICATOR_BATCH_CAP } from "@traycer/protocol/host/notifications/contracts";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useNotificationResolveHostId } from "@/hooks/notifications/use-notification-host";
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
   * `null` means the NOTIFICATION host - the machine whose feed the
   * notification centre renders - which is the right answer only for a caller
   * whose ids are EPIC ids: an Epic is a shared cloud entity rather than a
   * host-owned record, so the question is "what does the centre's machine
   * hold about it". Only when no local host exists does resolution fall back
   * to the app-wide active client.
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
  /** Chat ids do not encode durable home; callers that select a home provide
   * their owning epic for exact partitioning. */
  readonly chatEpicIds?: Readonly<Record<string, string>>;
  readonly home?: "local";
  readonly enabled: boolean;
}

export interface HostNotificationIndicatorsQuery {
  readonly data: HostNotificationsIndicatorStateResponse;
  readonly isPending: boolean;
  readonly isFetching: boolean;
  readonly error: HostRpcError | null;
  readonly refetch: () => Promise<void>;
  /**
   * The host that ANSWERED, so consumers can file the rows under it without
   * repeating the lookup - and, more to the point, without a second lookup
   * that could name a different machine than the one this request went to.
   * `null` when there is no notification host to ask.
   */
  readonly hostId: string | null;
}

/** {@link HostNotificationIndicatorsQuery} minus the field this hook adds
 * around `useHostQueries`, whose `combine` only sees the query results. */
type CombinedIndicatorResults = Omit<HostNotificationIndicatorsQuery, "hostId">;

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
  // The caller-named owner when present; otherwise the NOTIFICATION host,
  // never the app-wide active one. A `null` caller is asking about the feed
  // the notification centre renders (`home: local` is a partition question
  // ABOUT that machine), and that centre is pinned to the local host - asked
  // of a different host it describes that host's local partition instead, so
  // indicators light for rows the feed does not hold and stay dark for rows
  // it does. The id-half hook keeps this null-safe in provider-less trees;
  // only when no local host exists does the resolver fall back to the
  // app-wide client, which is the pre-local-room behaviour.
  const notificationHostId = useNotificationResolveHostId();
  const resolvedHostId = args.hostId ?? notificationHostId;
  const client = useHostClientForHostId(resolvedHostId);
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const requests = useMemo(
    () =>
      indicatorRequests(
        args.epicIds,
        args.chatIds,
        args.chatEpicIds ?? {},
        args.home,
      ),
    [args.epicIds, args.chatIds, args.chatEpicIds, args.home],
  );
  const combined = useHostQueries<
    HostRpcRegistry,
    "host.notifications.indicatorState",
    CombinedIndicatorResults
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
    combine: (
      results: Array<
        UseQueryResult<HostNotificationsIndicatorStateResponse, HostRpcError>
      >,
    ) => ({
      data: mergeIndicatorResponses(results),
      isPending: results.some((result) => result.isPending),
      isFetching: results.some((result) => result.isFetching),
      error: firstSupportedHostError(results),
      refetch: async (): Promise<void> => {
        await Promise.all(results.map((result) => result.refetch()));
      },
    }),
  });
  return useMemo(
    () => ({ ...combined, hostId: resolvedHostId }),
    [combined, resolvedHostId],
  );
}

export function indicatorRequests(
  epicIds: ReadonlyArray<string>,
  chatIds: ReadonlyArray<string>,
  chatEpicIds: Readonly<Record<string, string>>,
  home: "local" | undefined,
): ReadonlyArray<HostNotificationsIndicatorStateRequestV11> {
  const epicChunks = chunkIds(epicIds);
  const chatChunks = chunkIds(chatIds);
  const request = (
    epicChunk: ReadonlyArray<string> | undefined,
    chatChunk: ReadonlyArray<string> | undefined,
  ): HostNotificationsIndicatorStateRequestV11 => {
    const chatIdsForRequest = [...(chatChunk ?? [])];
    const chatEpicIdsForRequest = Object.fromEntries(
      chatIdsForRequest.flatMap((chatId) => {
        // `Object.hasOwn` rather than an `=== undefined` compare: the map is a
        // plain `Record`, which TypeScript treats as TOTAL, so the compare
        // reads as dead code while being the only thing that keeps a chat
        // with no known parent epic out of the request.
        if (!Object.hasOwn(chatEpicIds, chatId)) return [];
        const epicId = chatEpicIds[chatId];
        return [[chatId, epicId]];
      }),
    );
    return {
      epicIds: [...(epicChunk ?? [])],
      chatIds: chatIdsForRequest,
      ...(home === undefined ? {} : { home }),
      ...(Object.keys(chatEpicIdsForRequest).length === 0
        ? {}
        : { chatEpicIds: chatEpicIdsForRequest }),
    };
  };
  if (epicChunks.length === 0) {
    return chatChunks.map((chatChunk) => request(undefined, chatChunk));
  }
  if (chatChunks.length === 0) {
    return epicChunks.map((epicChunk) => request(epicChunk, undefined));
  }
  // Epic chunks are CROSSED with chat chunks rather than paired index-wise:
  // every task aggregate must receive the complete live-chat whitelist, and a
  // chat id landing in a request without its epic would silently narrow that
  // epic's aggregate to the chats that happened to share its page.
  return epicChunks.flatMap((epicChunk) =>
    chatChunks.map((chatChunk) => request(epicChunk, chatChunk)),
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
