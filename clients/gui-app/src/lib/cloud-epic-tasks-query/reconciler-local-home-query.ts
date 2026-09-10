import { queryOptions } from "@tanstack/react-query";
import type { ListTasksResponse } from "@traycer/protocol/host/epic/unary-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { queryKeys } from "@/lib/query-keys";
import {
  fetchCloudEpicTasksFirstPageByHostId,
  type ListCloudTasksRequest,
} from "@/lib/cloud-epic-tasks-query/query";

const LOCAL_HOME_LIST_METHOD = "epic.listTasks" as const;

interface EpicTabLocalHomeListQueryArgs {
  readonly hostId: string;
  readonly userId: string;
  readonly params: ListCloudTasksRequest;
  readonly cacheKeyIdentity: string;
}

/**
 * The destructive tab reconciler reads its local-home exemption through the
 * same identity-bound list boundary as History. Its query key is captured from
 * a reconciliation run, so its eventual request must fail closed rather than
 * send a later principal's page into that run's cache entry.
 */
export function epicTabLocalHomeListQueryOptions(
  args: EpicTabLocalHomeListQueryArgs,
) {
  return queryOptions<ListTasksResponse>({
    queryKey: [
      ...queryKeys.hostMethod<HostRpcRegistry, typeof LOCAL_HOME_LIST_METHOD>(
        args.hostId,
        LOCAL_HOME_LIST_METHOD,
        args.params,
      ),
      args.userId,
      args.cacheKeyIdentity,
      "local-home",
    ],
    queryFn: ({ signal }) =>
      fetchCloudEpicTasksFirstPageByHostId(args.hostId, args.userId, {
        request: args.params,
        abortSignal: signal,
        localFirstPhase: undefined,
        requestContextPolicy: "require-current",
      }),
  });
}

/**
 * The same local-first list boundary, read for a PIN READING rather than for the
 * reconciler's exemption.
 *
 * Why the list and not `epic.getTaskContexts`: the context batch is gated on the
 * cloud verdict (it can reach the account's servers), so under an unverified
 * session it answers nothing - and an unverified session with a local-homed epic
 * is exactly the population whose pin this has to report. `epic.listTasks` is
 * the local-first line the same session is already admitted on.
 *
 * Why the FIRST page is sufficient, and not a guess: a `@1.6` host injects its
 * synthesized local rows on the **cursorless page only**, exempt from cursor
 * paging and from the cloud `limit`, deduped by epic id
 * (`epic-list-tasks-resolver.ts`). So one cursorless request per host returns
 * every local-homed row that host has, whatever the account's history size.
 *
 * Separate from {@link epicTabLocalHomeListQueryOptions} in key and in purpose.
 * The reconciler's entry is keyed to one destructive run and must fail closed
 * against a later principal; this one is an ordinary reactive read whose
 * staleness costs a stale pin glyph. Sharing its cache entry would tie a
 * tab-strip render to a reconciliation run's lifetime.
 */
export function epicPinReadingListQueryOptions(args: {
  readonly hostId: string;
  readonly userId: string;
  readonly params: ListCloudTasksRequest;
}) {
  return queryOptions<ListTasksResponse>({
    queryKey: queryKeys.cloudEpicPinReading(
      args.hostId,
      args.userId,
      args.params,
    ),
    queryFn: ({ signal }) =>
      fetchCloudEpicTasksFirstPageByHostId(args.hostId, args.userId, {
        request: args.params,
        abortSignal: signal,
        // `"initial"` and NOT `undefined`, which is what this passed first and
        // is the one value that cannot work here. `cloudLegAdmittedAtDispatch`
        // refuses a phase-less page outright under an unverified verdict - a
        // page with no local-first directive is an ordinary cloud call, and an
        // unverified session may not spend one. So the exact cohort this query
        // exists for (R1: a cold unverified tab) got no RPC at all and kept
        // `pinnedKnown: false`, which is the defect it was written to fix.
        //
        // `"initial"` is also the honest description: this IS the first (and
        // only) leg of a local-first read, and under `local-first-only`
        // admission the dispatch attaches the `@1.6` floor as a requirement
        // answered by the connection carrying the frame - which is precisely
        // the guarantee the local rows depend on. A host that restarted below
        // `@1.6` refuses rather than silently running the released cloud list
        // on a retained credential.
        //
        // No local-first revalidation EPISODE is begun for this key, unlike
        // `cloudEpicTasksFirstPageQueryOptions`: that coordinator exists to
        // order a follow-up `"revalidate"` leg against the same cache entry,
        // and this query issues none (`staleTime: Infinity`, one shot). The
        // phase is a request directive, not an obligation to revalidate.
        localFirstPhase: "initial",
        requestContextPolicy: "require-current",
      }),
  });
}
