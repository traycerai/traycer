import { useEffect, useMemo, useRef, useState } from "react";
import {
  useQueryClient,
  type Query,
  type QueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  HostRpcError,
  type ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import {
  useHostQueryEntryHash,
  useHostQueryWithResponseMap,
} from "@/hooks/host/use-host-query";
import { queryKeys } from "@/lib/query-keys";
import { appLogger } from "@/lib/logger";
import { cloudRowIsViewersOwn } from "@/lib/chats/unified-chat-list";

const PUBLICATION_TARGETS_METHOD = "epic.listChatPublicationTargets" as const;
const UNEXPLAINED_ROW_RECHECK_MS = 60_000;
const MAX_FAILED_ROW_RECHECKS = 3;

interface PublicationTargetsRefreshState {
  mounts: number;
  lastRefresh: string | null;
  readonly seenRows: Set<string>;
  readonly pendingRows: Map<string, number>;
  readonly recheckedRows: Set<string>;
  readonly failedRechecks: Map<string, number>;
  inFlight: {
    readonly rows: ReadonlySet<string>;
    readonly dataUpdateCount: number;
  } | null;
}

// Share claims between observers without retaining a query after cache GC.
// The last observer's cleanup resets the limits for the next task mount.
const refreshStates = new WeakMap<Query, PublicationTargetsRefreshState>();

function publicationTargetsRefreshState(
  query: Query,
): PublicationTargetsRefreshState {
  const held = refreshStates.get(query);
  if (held !== undefined) return held;
  const state: PublicationTargetsRefreshState = {
    mounts: 0,
    lastRefresh: null,
    seenRows: new Set(),
    pendingRows: new Map(),
    recheckedRows: new Set(),
    failedRechecks: new Map(),
    inFlight: null,
  };
  refreshStates.set(query, state);
  return state;
}

function settlePublicationTargetsRecheck(
  query: Query,
  state: PublicationTargetsRefreshState,
): void {
  const inFlight = state.inFlight;
  if (inFlight === null || query.state.fetchStatus !== "idle") return;
  // Query's write count also detects answers landing in the same millisecond.
  if (query.state.dataUpdateCount > inFlight.dataUpdateCount) {
    for (const id of inFlight.rows) state.recheckedRows.add(id);
  } else if (
    !(
      query.state.error instanceof HostRpcError &&
      query.state.error.code === "E_HOST_UNSUPPORTED"
    )
  ) {
    const deadline = Date.now() + UNEXPLAINED_ROW_RECHECK_MS;
    for (const id of inFlight.rows) {
      const failures = (state.failedRechecks.get(id) ?? 0) + 1;
      state.failedRechecks.set(id, failures);
      if (failures < MAX_FAILED_ROW_RECHECKS)
        state.pendingRows.set(id, deadline);
    }
  }
  state.inFlight = null;
}

interface PublicationTargetsAnswer extends ResponseOfMethod<
  HostRpcRegistry,
  typeof PUBLICATION_TARGETS_METHOD
> {
  readonly chatIdsAuthoritative: boolean;
  readonly unexplainedCloudChatIdsKey: string;
}

/**
 * Which cloud row each of this task's local chats publishes into.
 *
 * The sidebar folds a task's cloud list against its local tree, and after a
 * fork the two disagree about which row is which: the local lineage steps aside
 * into a derived clone row, while the row still carrying its `chatId` belongs
 * to the other host's lineage. This is the mapping that tells them apart -
 * the clone id is a server-side digest of content no client holds, so it cannot
 * be derived here. See `lib/chats/unified-chat-list.ts` for what the fold does
 * with it.
 *
 * Scoped to the task's session host: redirects describe that host's local
 * chats, the same source the sidebar and chat opener fold.
 *
 * Degradation is the whole reason this is a separate optional call rather than
 * a field on the cloud list: a host that predates it answers
 * `E_HOST_UNSUPPORTED`, the map comes back empty, and the fold falls back to
 * `chatId` equality - which is right for every chat that has not forked. The
 * retry gate stops a doomed loop; the first request still happens, and a
 * settled refusal is the answer.
 */

export interface UseChatPublicationTargetsArgs {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  /**
   * The full current local id set, sent at dispatch rather than keyed.
   */
  readonly chatIds: readonly string[];
  readonly cloudChats: readonly CloudChatSummary[];
  readonly chatIdsAuthoritative: boolean;
  readonly chatRecordListFailed: boolean;
  readonly enabled: boolean;
}

export function useChatPublicationTargets(
  args: UseChatPublicationTargetsArgs,
): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "epic.listChatPublicationTargets">,
  HostRpcError
> {
  const query = useChatPublicationTargetsQuery(args);
  useLogUnsupportedDegrade(args.epicId, query.error);
  return query;
}

/**
 * Drops every cached redirect map for `hostId`, across all its tasks.
 *
 * The five-minute `staleTime` below is the reason this exists rather than a
 * comment saying the answer is immutable. A redirect is minted ONCE - but it is
 * minted by a fork, which is precisely the event that happens while a sidebar is
 * already mounted and already holding the pre-fork answer. Without this, the
 * fold can keep matching cloud rows against the old `chatId` until remount or
 * the next refresh trigger: the forked chat's own lineage renders as a phantom row -
 * the exact symptom `useLogUnsupportedDegrade` describes for a host that cannot
 * answer at all.
 *
 * Host-scoped rather than epic-scoped on purpose. A fork episode names chats,
 * not their tasks. Re-reading the host's handful of maps avoids deriving a
 * task set from an episode and missing a task it touched.
 *
 * The owner of this key format is {@link useChatPublicationTargetsQuery} below,
 * through `queryKeys.hostMethod`; this uses the same builder's method SCOPE so
 * the two cannot drift into two spellings of one key.
 */
export function invalidateChatPublicationTargets(
  queryClient: QueryClient,
  hostId: string,
): void {
  void queryClient.invalidateQueries({
    queryKey: queryKeys.hostMethodScope(hostId, PUBLICATION_TARGETS_METHOD),
  });
}

/** Capture the publication identity before deletion removes the local row. */
export function readCachedChatPublicationId(
  queryClient: QueryClient,
  hostId: string | null,
  epicId: string,
  chatId: string,
): string | null {
  if (hostId === null) return null;
  const data = queryClient.getQueryData<
    ResponseOfMethod<HostRpcRegistry, typeof PUBLICATION_TARGETS_METHOD>
  >(
    queryKeys.hostMethod<HostRpcRegistry, typeof PUBLICATION_TARGETS_METHOD>(
      hostId,
      PUBLICATION_TARGETS_METHOD,
      { epicId, chatIds: [] },
    ),
  );
  return (
    data?.redirected.find((entry) => entry.chatId === chatId)
      ?.publicationChatId ?? null
  );
}

/**
 * States the degrade ONCE per epic, at `info`.
 *
 * A degrade that is correct and invisible is still a trap: the fold silently
 * falls back to `chatId` equality, and the symptom - a forked chat rendering
 * its own backup as a phantom second row - looks like a de-duplication bug in
 * the sidebar rather than a missing host capability. Whoever chases that
 * deserves to find the reason in the log instead of deriving it.
 *
 * `info`, not `warn`: an older host is an expected, designed state, not a
 * fault. Once per epic rather than per render, and never a toast - there is
 * nothing for a user to do about it.
 */
function useLogUnsupportedDegrade(
  epicId: string,
  error: HostRpcError | null,
): void {
  const loggedFor = useRef<string | null>(null);
  useEffect(() => {
    if (error === null || error.code !== "E_HOST_UNSUPPORTED") return;
    if (loggedFor.current === epicId) return;
    loggedFor.current = epicId;
    appLogger.info(
      "chat publication targets unsupported; folding the cloud list on chatId equality (a forked chat may render its backup as a second row)",
      { epicId },
    );
  }, [epicId, error]);
}

function useChatPublicationTargetsQuery(
  args: UseChatPublicationTargetsArgs,
): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "epic.listChatPublicationTargets">,
  HostRpcError
> {
  const params = useMemo(
    () => ({ epicId: args.epicId, chatIds: [] }),
    [args.epicId],
  );
  const queryClient = useQueryClient();
  const ownCloudChatIds = useMemo(
    () =>
      args.cloudChats
        .filter(cloudRowIsViewersOwn)
        .map((chat) => chat.identity.chatId),
    [args.cloudChats],
  );
  const entry = {
    cacheKeyIdentity: undefined,
    client: args.client,
    method: PUBLICATION_TARGETS_METHOD,
    params,
  };
  const queryHash = useHostQueryEntryHash(entry);
  const query = useHostQueryWithResponseMap<
    HostRpcRegistry,
    typeof PUBLICATION_TARGETS_METHOD,
    PublicationTargetsAnswer,
    boolean
  >({
    ...entry,
    buildRequest: (base) => ({ ...base, chatIds: [...args.chatIds] }),
    captureRequestContext: () => args.chatIdsAuthoritative,
    mapResponse: ({ response, requestContext }) => ({
      ...response,
      chatIdsAuthoritative: requestContext === true,
      unexplainedCloudChatIdsKey: JSON.stringify(
        unexplainedCloudChatIds(args.chatIds, ownCloudChatIds, response),
      ),
    }),
    options: {
      // Wait for the initial full list, except when its read has failed.
      enabled:
        args.enabled &&
        (args.chatIdsAuthoritative || args.chatRecordListFailed) &&
        args.epicId.length > 0 &&
        args.chatIds.length > 0,
      // Reuse successful maps across mounts for five minutes. Mounted changes
      // use the explicit refresh/re-check triggers below; the policy stays
      // `poll: null`.
      staleTime: 5 * 60_000,
      retry: (failureCount, error) =>
        error.code !== "E_HOST_UNSUPPORTED" && failureCount < 2,
    },
  });
  const {
    data,
    dataUpdatedAt,
    errorUpdatedAt,
    isEnabled,
    isFetching,
    refetch,
  } = query;
  const unexplained = useMemo(() => {
    const ids = unexplainedCloudChatIds(args.chatIds, ownCloudChatIds, data);
    return { ids, key: JSON.stringify(ids) };
  }, [args.chatIds, ownCloudChatIds, data]);
  const recheckTimer = useRef<number | null>(null);
  const [recheckTick, setRecheckTick] = useState(0);
  const unsupported = query.error?.code === "E_HOST_UNSUPPORTED";
  const partial =
    data !== undefined &&
    args.chatIdsAuthoritative &&
    !data.chatIdsAuthoritative;
  const changed =
    data !== undefined &&
    (partial || unexplained.key !== data.unexplainedCloudChatIdsKey);

  useEffect(() => {
    const cached = queryClient.getQueryCache().get(queryHash);
    if (cached === undefined) return;
    const state = publicationTargetsRefreshState(cached);
    state.mounts += 1;
    return () => {
      if (recheckTimer.current !== null)
        window.clearTimeout(recheckTimer.current);
      state.mounts -= 1;
      if (state.mounts === 0) {
        state.seenRows.clear();
        state.pendingRows.clear();
        state.recheckedRows.clear();
        state.failedRechecks.clear();
        state.inFlight = null;
        state.lastRefresh = null;
      }
    };
  }, [queryClient, queryHash]);

  useEffect(() => {
    if (recheckTimer.current !== null)
      window.clearTimeout(recheckTimer.current);
    recheckTimer.current = null;
    const cached = queryClient.getQueryCache().get(queryHash);
    if (cached === undefined) return;
    const state = publicationTargetsRefreshState(cached);
    settlePublicationTargetsRecheck(cached, state);
    if (!isEnabled || unsupported) return;
    const now = Date.now();
    const current = new Set(unexplained.ids);
    for (const id of state.pendingRows.keys()) {
      if (!current.has(id)) state.pendingRows.delete(id);
    }
    for (const id of unexplained.ids) {
      if (state.seenRows.has(id)) continue;
      state.seenRows.add(id);
      state.pendingRows.set(id, now + UNEXPLAINED_ROW_RECHECK_MS);
    }
    let next = Infinity;
    for (const deadline of state.pendingRows.values()) {
      if (deadline > now) next = Math.min(next, deadline);
    }
    if (next !== Infinity) {
      recheckTimer.current = window.setTimeout(() => {
        recheckTimer.current = null;
        setRecheckTick((tick) => tick + 1);
      }, next - now);
    }
    return () => {
      if (recheckTimer.current !== null)
        window.clearTimeout(recheckTimer.current);
    };
  }, [
    dataUpdatedAt,
    errorUpdatedAt,
    isEnabled,
    isFetching,
    queryClient,
    queryHash,
    recheckTick,
    unexplained,
    unsupported,
  ]);

  // Refresh when the unexplained own-row set differs from the last answer's
  // set. A newly unexplained row gets one successful re-check per mount about
  // 60 s later. Failed or reverted reads wait another 60 s, capped at three
  // failures per row per mount; other refresh triggers remain available.
  // Until the clone is listed, the other host's row can remain folded under
  // the local id; listing the clone triggers refresh. Fork edges on the
  // addressable host can refresh the map sooner.
  useEffect(() => {
    const cached = queryClient.getQueryCache().get(queryHash);
    if (cached === undefined) return;
    const state = publicationTargetsRefreshState(cached);
    settlePublicationTargetsRecheck(cached, state);
    if (!isEnabled || isFetching) {
      return;
    }
    // Check the shared entry too: another observer's effect can start the
    // refresh before this observer renders its fetching state. Unsupported
    // hosts do not retry; other failures can recover on a new trigger.
    if (
      cached.state.fetchStatus !== "idle" ||
      (cached.state.error instanceof HostRpcError &&
        cached.state.error.code === "E_HOST_UNSUPPORTED") ||
      cached.state.dataUpdatedAt !== dataUpdatedAt
    ) {
      return;
    }
    const now = Date.now();
    const dueRows = unexplained.ids.filter((id) => {
      const deadline = state.pendingRows.get(id);
      return (
        deadline !== undefined &&
        deadline <= now &&
        !state.recheckedRows.has(id)
      );
    });
    if (!changed && dueRows.length === 0) return;
    const refreshKey = JSON.stringify([
      queryHash,
      dataUpdatedAt,
      unexplained.key,
      partial,
    ]);
    if (state.lastRefresh === refreshKey && dueRows.length === 0) return;
    state.lastRefresh = refreshKey;
    if (dueRows.length > 0) {
      state.inFlight = {
        rows: new Set(dueRows),
        dataUpdateCount: cached.state.dataUpdateCount,
      };
    }
    for (const id of dueRows) {
      state.pendingRows.delete(id);
    }
    // Settling an in-flight partial read re-arms this effect even when Query's
    // structural sharing preserves `data`. Never join that read as recovery.
    void refetch({ cancelRefetch: false });
  }, [
    changed,
    dataUpdatedAt,
    isEnabled,
    isFetching,
    partial,
    queryClient,
    queryHash,
    recheckTick,
    refetch,
    unexplained,
  ]);
  return query;
}

function unexplainedCloudChatIds(
  chatIds: readonly string[],
  cloudChatIds: readonly string[],
  data:
    | ResponseOfMethod<HostRpcRegistry, typeof PUBLICATION_TARGETS_METHOD>
    | undefined,
): readonly string[] {
  const explained = new Set(chatIds);
  for (const entry of data?.redirected ?? []) {
    explained.add(entry.publicationChatId);
  }
  return [...new Set(cloudChatIds)].filter((id) => !explained.has(id)).sort();
}

/**
 * The response as the fold wants it: chat id -> the row it publishes into.
 *
 * An empty map for an absent, failed or in-flight answer, which is exactly the
 * degraded input `selectUnfoldedCloudChats` documents - so no caller needs a
 * second branch for "we do not know yet".
 */
export function publicationTargetMap(
  data:
    | ResponseOfMethod<HostRpcRegistry, "epic.listChatPublicationTargets">
    | undefined,
): ReadonlyMap<string, string> {
  if (data === undefined) return new Map();
  return new Map(
    data.redirected.map((entry) => [entry.chatId, entry.publicationChatId]),
  );
}
