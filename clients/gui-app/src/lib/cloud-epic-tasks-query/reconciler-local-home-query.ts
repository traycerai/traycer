import { queryOptions, replaceEqualDeep } from "@tanstack/react-query";
import type { ListTasksResponse } from "@traycer/protocol/host/epic/unary-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { queryKeys } from "@/lib/query-keys";
import {
  fetchHostLocalHistoryPageByHostId,
  isListTasksResponse,
  type ListCloudTasksRequest,
} from "@/lib/cloud-epic-tasks-query/query";
import { admitCloudEpicTasksFirstPage } from "@/lib/cloud-epic-tasks-query/cache";

const LOCAL_HOME_LIST_METHOD = "epic.listTasks" as const;

interface EpicTabLocalHomeListQueryArgs {
  readonly hostId: string;
  readonly userId: string;
  readonly params: ListCloudTasksRequest;
  readonly cacheKeyIdentity: string;
}

/**
 * The destructive tab reconciler reads its local-home exemption from each
 * host's own local History contribution (`epic.localHistory.read`): the rows
 * only that host holds, through the same identity-bound boundary as History.
 * Its query key is captured from a reconciliation run, so its eventual request
 * must fail closed rather than send a later principal's page into that run's
 * cache entry. A host that cannot contribute answers `localRows: "truncated"`,
 * which the reconciler reads as "close nothing".
 */
export function epicTabLocalHomeListQueryOptions(
  args: EpicTabLocalHomeListQueryArgs,
) {
  const { params } = args;
  return queryOptions<ListTasksResponse>({
    queryKey: [
      ...queryKeys.hostMethod<HostRpcRegistry, typeof LOCAL_HOME_LIST_METHOD>(
        args.hostId,
        LOCAL_HOME_LIST_METHOD,
        params,
      ),
      args.userId,
      args.cacheKeyIdentity,
      "local-home",
    ],
    queryFn: ({ signal }) =>
      fetchHostLocalHistoryPageByHostId(args.hostId, args.userId, {
        filters: params.filters,
        abortSignal: signal,
        requestContextPolicy: "require-current",
      }),
  });
}

/**
 * The same host-local read, for a PIN READING rather than for the reconciler's
 * exemption.
 *
 * Why the host's local contribution and not `epic.getTaskContexts`: the
 * context batch is gated on the cloud verdict (it can reach the account's
 * servers), so under an unverified session it answers nothing - and an
 * unverified session with a local-homed epic is exactly the population whose
 * pin this has to report. The local contribution is a read of this host's own
 * disk, which spends no verdict.
 *
 * Why one read is sufficient, and not a guess: the contribution carries EVERY
 * local-homed row the host holds for the account, outside any paging.
 *
 * Separate from {@link epicTabLocalHomeListQueryOptions} in key and in purpose.
 * The reconciler's entry is keyed to one destructive run and must fail closed
 * against a later principal; this one is an ordinary reactive read supplying tab pin glyphs and
 * Current tasks rows. Sharing its cache entry would tie a
 * tab-strip render to a reconciliation run's lifetime.
 *
 * `population` - the local-homed open epic ids this host has to answer for -
 * is in the KEY and deliberately not in the request. The request cannot carry
 * it: the contribution is the host's whole local-homed set either way. What
 * the population decides is whether an already-cached page is still an ANSWER,
 * because the consumer reads membership out of it (R8). One fetch per
 * population, not one per unresolved row - see the call site in
 * `use-epic-task-pinned-states-query.ts` for why that distinction is the whole
 * safety argument.
 */
export function epicPinReadingListQueryOptions(args: {
  readonly hostId: string;
  readonly userId: string;
  readonly params: ListCloudTasksRequest;
  readonly population: ReadonlyArray<string>;
}) {
  const { params } = args;
  return queryOptions<ListTasksResponse>({
    queryKey: queryKeys.cloudEpicPinReading(
      args.hostId,
      args.userId,
      params,
      args.population,
    ),
    structuralSharing: (previous, incoming) =>
      replaceEqualDeep(
        previous,
        isListTasksResponse(incoming)
          ? admitCloudEpicTasksFirstPage(incoming, args)
          : incoming,
      ),
    // COST, stated because it is a consequence of the key and not an oversight:
    // a new population is a new cache entry, so while its page is in flight the
    // rows this host had already answered report `pinnedKnown: false` again for
    // one local list read. They recover when it lands.
    //
    // `placeholderData: (previous) => previous` does NOT fix that here, and the
    // reason is structural rather than a tuning question. The carry-the-previous
    // idiom needs the observer to outlive the key change, which is how
    // `useQuery` behaves; this reading runs under `useQueries`, whose
    // `QueriesObserver` matches observers to queries by `queryHash` ALONE
    // (`#findMatchingObservers`). A changed key matches nothing, so a fresh
    // `QueryObserver` is constructed and destroys the old one - its
    // last-query-with-data is empty, the placeholder function is handed
    // `undefined`, and the option is inert. Verified by pin, not assumed: see
    // "returns an answered row to unknown while the wider page is in flight".
    //
    // Falling back to unknown is also the SAFE direction by this query's own
    // standard: `pinnedKnown: false` withholds the pin action, where carrying a
    // page forward would be rendering one population's answer as another's. The
    // defect this whole line exists to fix is silence presented as an answer.
    queryFn: ({ signal }) =>
      fetchHostLocalHistoryPageByHostId(args.hostId, args.userId, {
        filters: params.filters,
        abortSignal: signal,
        // `"wait"`, not `"require-current"`, and the difference is READINESS
        // rather than principal strictness. The owning host's session can be in
        // the registry before that host's client has a request context - the same
        // window `useCloudEpicTasksQuery` covers with `useReactiveHostReadiness`,
        // which a per-host fan-out cannot call. Under `"require-current"` that
        // moment is permanently fatal: with `staleTime: Infinity` and no refetch
        // trigger, a context arriving later never gets read.
        //
        // Waiting cannot write a later principal's page under this key: the wait
        // resolves only when the context names this query's own user, and the
        // read re-checks the principal after it.
        requestContextPolicy: "wait",
      }),
  });
}
