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
  /**
   * `null` means the answer carried NO rows to apply - the `@1.3` `unchanged`
   * arm. Distinct from `[]`, which is the positive claim that this epic has
   * no terminal agents and retracts everything the fence allows.
   */
  readonly tuiAgents: readonly TuiAgentRecordSummaryV12[] | null;
  /**
   * Always this store's own counter - see the chat twin
   * (`ChatRecordListAnswer.issuedAtSeq`): the store generation is part of the
   * cache key, so an entry belongs to exactly one session and no fence from
   * another generation can reach the applying effect. The cross-generation
   * check that used to sit at apply is gone with it, deliberately: it could
   * not fire, and an unreachable guard reads as protection without being any.
   */
  readonly issuedAtSeq: number | null;
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
  //
  // `knownRevision` is pinned to `null` - "I hold no list stamp" - so the host
  // always answers with a full `snapshot`, exactly as it did before `@1.3`.
  // Sending a held stamp needs a dispatch-time request seam, because `params`
  // is both the query KEY and the wire payload today and the stamp has to
  // vary per dispatch without changing the key; that is the revision-gated
  // polling change, not this one.
  const params = useMemo(
    () => ({
      epicId,
      hasDocReplica: GUI_PROJECTS_EPIC_DOC_REPLICA,
      knownRevision: null,
    }),
    [epicId],
  );
  // Viewer-scoped: the response is one identity's own terminal agents, so two
  // users on one installation must never share a cache slot.
  const viewerUserId = useCloudChatViewerId();
  const store = handle?.store ?? null;
  // The session GENERATION in the cache key, for the reason spelled out on the
  // chat twin: renderer parking unmounts this hook, releases the session, and
  // remounts it against a FRESH store on show - and inside `staleTime` that
  // remount would otherwise be served whole from the pre-park answer, with no
  // request issued and a terminal agent deleted at the host while parked still
  // rendering a row. Read straight through rather than memoized: minted once
  // per store construction, so it is a constant for a given `store`.
  const fenceIdentity = store?.getState().ingestFenceIdentity ?? null;
  const query = useHostQueryWithResponseMap<
    HostRpcRegistry,
    "epic.listTuiAgents",
    TuiAgentListAnswer,
    { readonly seq: number } | null
  >({
    cacheKeyIdentity: [viewerUserId, fenceIdentity],
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
      return { seq: store.getState().peekTuiAgentIngestSeq() };
    },
    mapResponse: ({ response, requestContext }) => {
      const context = requestContext ?? null;
      return {
        // `unchanged` is UNREACHABLE while `knownRevision` is `null` above -
        // the host emits that arm only when a stamp the caller SENT matched -
        // and it maps to `null`, never to `[]`: the store merges omissions
        // against the dispatch fence, so an empty answer would RETRACT every
        // row that landed before it. See the chat twin.
        tuiAgents: response.kind === "snapshot" ? response.tuiAgents : null,
        issuedAtSeq: context === null ? null : context.seq,
      };
    },
  });

  const answer = query.data ?? null;
  useEffect(() => {
    if (answer === null || answer.tuiAgents === null || store === null) return;
    // The fence is used as captured - it was read from THIS store, because the
    // generation is in the cache key. See `TuiAgentListAnswer.issuedAtSeq`.
    store.getState().applyTuiAgentRecords(answer.tuiAgents, answer.issuedAtSeq);
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
