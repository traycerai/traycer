import { useEffect, useMemo } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { useHostQueryWithResponseMap } from "@/hooks/host/use-host-query";
import { hostQueryKeys } from "@/lib/query-keys";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { GUI_PROJECTS_EPIC_DOC_REPLICA } from "@/stores/epics/open-epic/projection-helpers";
import type { TuiAgentRecordSummaryV12 } from "@traycer/protocol/host/epic/tui-agent-records";

/**
 * What the cache holds for one `epic.listTuiAgents` answer: the rows, plus
 * where the session's terminal-agent ingest counter stood when the request
 * was DISPATCHED. The store merges omissions against that fence - a row the
 * answer does not carry is retracted only if the answer was issued after the
 * row landed - so the fence has to be captured before the RPC, not when the
 * answer is applied. `null` when no session existed to read at dispatch.
 */
interface TuiAgentListAnswer {
  readonly tuiAgents: readonly TuiAgentRecordSummaryV12[];
  readonly issuedAtSeq: number | null;
  /**
   * WHICH store's counter `issuedAtSeq` was read from - see the chat twin
   * (`ChatRecordListAnswer.fenceIdentity`): a cached answer can outlive the
   * store, and a cross-generation fence is degraded to `null` at apply.
   */
  readonly fenceIdentity: number | null;
}

/**
 * Feeds the epic session's terminal-agent record table from the host's
 * registry (`epic.listTuiAgents`) - the terminal twin of
 * {@link useEpicSyncChatRecords} in `use-epic-chat-records.ts`, mounted
 * beside it in `epic-route-session-body.tsx`.
 *
 * ## What this closes
 *
 * `OpenEpicStore.tuiAgents` used to have exactly one producer: the epic
 * Y.Doc's `tuiAgents` map. The TUI eviction moves the records into the host's
 * own registry - a migrated host stops writing the map and sweeps its own
 * entries - so without this read a terminal agent on such a host would have no
 * tile, no tree row and no rename/archive affordances. This hook is the other
 * producer; the store unions the two, and entries written by OTHER, not-yet-
 * migrated binding hosts keep rendering from the doc arm.
 *
 * ## Doc-only mode is a designed state
 *
 * A host that predates `epic.listTuiAgents` answers `E_HOST_UNSUPPORTED`. The
 * store is then never told about any records and `tuiAgents` stays exactly the
 * doc projection - which is that host's own, correct record table, since a
 * host without this method is a host that still maintains the doc map. The
 * retry predicate stops immediately rather than spending attempts on a
 * permanent answer, and a transport FAILURE keeps the last known rows
 * published rather than deleting tiles on every network blip.
 *
 * ## Change signal
 *
 * Polled (20s, `HOST_METHOD_POLL_TABLE`), plus the push deltas riding
 * `host.chatRecords.subscribe` at 1.1, plus explicit invalidation from this
 * client's own TUI mutations ({@link invalidateEpicTuiAgentRecords}) - which
 * is what keeps the create flow's wait-for-projection fast instead of
 * poll-bound.
 */
export function useEpicSyncTuiAgentRecords(epicId: string): void {
  // The SESSION's host, not the app-wide one - same rationale as the
  // chat-record sync hook: a pinned or retried session runs on a host the
  // app-wide client may no longer answer for, and any other host's registry
  // is not the one this session is projecting. `null` (no serving client
  // yet) gates the query off through `useHostQuery`'s own null handling.
  const client = useEpicSessionHostClient();
  const handle = useMaybeOpenEpicHandle();
  // `hasDocReplica` decides whether the host serves the doc-resident
  // remainder - see `GUI_PROJECTS_EPIC_DOC_REPLICA`. Declared by us because
  // only we know it: the host would have to infer it from `epic.subscribe`'s
  // negotiated major, which this method's own version cannot see.
  const params = useMemo(
    () => ({ epicId, hasDocReplica: GUI_PROJECTS_EPIC_DOC_REPLICA }),
    [epicId],
  );
  // Viewer-scoped: the response is one identity's own terminal agents, so two
  // users on one installation must never share a cache slot.
  const viewerUserId = useCloudChatViewerId();
  const store = handle?.store ?? null;
  const query = useHostQueryWithResponseMap<
    HostRpcRegistry,
    "epic.listTuiAgents",
    TuiAgentListAnswer,
    { readonly seq: number; readonly fenceIdentity: number } | null
  >({
    cacheKeyIdentity: [viewerUserId],
    client,
    method: "epic.listTuiAgents",
    params,
    options: {
      enabled: epicId.length > 0 && viewerUserId.length > 0,
      staleTime: 10_000,
      // Opt in to the table's fixed cadence - `fixed` poll policies are
      // OPT-IN in `useHostQuery`, so without this the 20s the policy table
      // declares is never armed.
      poll: true,
      retry: (failureCount, error) =>
        error.code !== "E_HOST_UNSUPPORTED" && failureCount < 2,
    },
    // Runs immediately before the RPC is dispatched - see
    // `TuiAgentListAnswer`. A push delta that lands while this request is
    // in flight advances the counter past this value, which is exactly how
    // the store knows the answer could not have carried that row.
    captureRequestContext: () => {
      if (store === null) return null;
      const state = store.getState();
      return {
        seq: state.peekTuiAgentIngestSeq(),
        fenceIdentity: state.ingestFenceIdentity,
      };
    },
    mapResponse: ({ response, requestContext }) => {
      const context = requestContext ?? null;
      return {
        tuiAgents: response.tuiAgents,
        issuedAtSeq: context === null ? null : context.seq,
        fenceIdentity: context === null ? null : context.fenceIdentity,
      };
    },
  });

  const answer = query.data ?? null;
  useEffect(() => {
    if (answer === null || store === null) return;
    // A cross-generation fence is degraded to `null`, never trusted - see
    // `TuiAgentListAnswer.fenceIdentity` and the chat twin.
    const fence =
      answer.fenceIdentity === store.getState().ingestFenceIdentity
        ? answer.issuedAtSeq
        : null;
    store.getState().applyTuiAgentRecords(answer.tuiAgents, fence);
  }, [answer, store]);
}

/**
 * Drops this host's cached terminal-agent record list so the next read
 * re-asks - the terminal twin of `invalidateEpicChatRecords`, called by the
 * TUI mutations (create/delete/rename, and the shared archive) after the host
 * commits one. The commit lands in the host's registry and, on a migrated
 * host, in NOTHING the renderer already listens to per-epic - the epic Y.Doc
 * stream is precisely what stopped carrying these facts - so without this the
 * affordance would appear to do nothing for up to one poll interval.
 *
 * Method-scoped rather than epic-scoped, and plain invalidation rather than an
 * explicit fetch, for exactly the reasons documented on
 * `invalidateEpicChatRecords` - TanStack's defaults already refetch an active
 * key immediately and cancel a stale in-flight read.
 */
export function invalidateEpicTuiAgentRecords(
  queryClient: QueryClient,
  hostId: string | null,
): void {
  void queryClient.invalidateQueries({
    queryKey: hostQueryKeys.methodScope(hostId, "epic.listTuiAgents"),
  });
}
