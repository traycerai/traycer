import { useCallback, useEffect, useMemo } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import {
  useRecordListStamp,
  useRecordListStreamStamp,
} from "@/hooks/chats/use-record-list-stamp";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { useHostQueryWithResponseMap } from "@/hooks/host/use-host-query";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { hostQueryKeys } from "@/lib/query-keys";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { GUI_PROJECTS_EPIC_DOC_REPLICA } from "@/stores/epics/open-epic/projection-helpers";
import type {
  RecordListRecencyPatch,
  RecordListStamp,
} from "@traycer/protocol/host/epic/record-list-revision";
import type { TuiAgentRecordSummaryV13 } from "@traycer/protocol/host/epic/tui-agent-records";

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
   * The `@1.3` row - the `@1.2` row plus the SESSION FACET (`sessionState` /
   * `lastExit`) - carried all the way into the record table so a reaped agent
   * can read as asleep and resumable rather than as absent. A narrower row
   * type is assignable to this in the wrong direction, so typing it down would
   * silently drop the two keys rather than fail.
   *
   * `null` means the answer carried NO rows to apply - the `@1.3` `unchanged`
   * arm. Distinct from `[]`, which is the positive claim that this epic has
   * no terminal agents and retracts everything the fence allows.
   */
  readonly tuiAgents: readonly TuiAgentRecordSummaryV13[] | null;
  /**
   * The `unchanged` arm's recency patches; empty on the `snapshot` arm. See
   * the chat twin (`ChatRecordListAnswer.touched`).
   */
  readonly touched: readonly RecordListRecencyPatch[];
  /**
   * The stamp this answer carried, sent back verbatim as the next dispatch's
   * `knownRevision`. `null` from a host with no revision to report, which
   * keeps this hook on snapshots - today's behaviour. See the chat twin.
   */
  readonly listStamp: RecordListStamp | null;
  /**
   * Always this store's own counter - see the chat twin
   * (`ChatRecordListAnswer.issuedAtSeq`): the store generation is part of the
   * cache key, so an entry belongs to exactly one session and no fence from
   * another generation can reach the applying effect. The cross-generation
   * check that used to sit at apply is gone with it, deliberately: it could
   * not fire, and an unreachable guard reads as protection without being any.
   */
  readonly issuedAtSeq: number | null;
  /**
   * Where the store's incomplete-apply counter stood at dispatch - see the chat
   * twin (`ChatRecordListAnswer.snapshotIncompleteSeqAtDispatch`). It is what
   * decides whether this answer's `listStamp` may be sent back as a claim about
   * the rows this client holds.
   */
  readonly snapshotIncompleteSeqAtDispatch: number | null;
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
  // `knownRevision: null` here is the QUERY KEY's value; the stamp this hook
  // holds replaces it per dispatch through `buildRequest` below and never
  // reaches the key. See the chat twin for why a stamp in the key would defeat
  // the gating it is there to arm.
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
  // The SESSION's serving host, which is also what `useHostQuery` keys this
  // query on - see the chat twin.
  const hostId = useReactiveHostReadiness(client).hostId;
  // Read at DISPATCH, from the same store the fence comes from - see the chat
  // twin for why it is a getter and why `store` is its only input.
  const readTuiAgentSnapshotIncompleteSeq = useCallback(
    () => store?.getState().tuiAgentSnapshotIncompleteSeq ?? null,
    [store],
  );
  // Keyed on the same four facts the cache entry is, so the stamp dies with
  // the row set it describes - see {@link useRecordListStamp}.
  const stamp = useRecordListStamp({
    epicId,
    viewerUserId,
    hostId,
    storeGeneration: fenceIdentity,
    readSnapshotIncompleteSeq: readTuiAgentSnapshotIncompleteSeq,
  });
  const query = useHostQueryWithResponseMap<
    HostRpcRegistry,
    "epic.listTuiAgents",
    TuiAgentListAnswer,
    {
      readonly seq: number;
      readonly snapshotIncompleteSeq: number;
    } | null
  >({
    cacheKeyIdentity: [viewerUserId, fenceIdentity],
    client,
    method: "epic.listTuiAgents",
    params,
    // What this client holds, read at dispatch. An older host never receives
    // the field: the request is projected onto the negotiated minor, and
    // `@1.2` has nowhere to put it.
    buildRequest: (base) => ({ ...base, knownRevision: stamp.read() }),
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
        snapshotIncompleteSeq: state.tuiAgentSnapshotIncompleteSeq,
      };
    },
    mapResponse: ({ response, requestContext }) => {
      const context = requestContext ?? null;
      return {
        // `unchanged` maps to `null`, never to `[]`: the store merges
        // omissions against the dispatch fence, so an empty answer would
        // RETRACT every row that landed before it. See the chat twin.
        tuiAgents: response.kind === "snapshot" ? response.tuiAgents : null,
        // The `snapshot` arm carries no patches: its rows are the recency.
        touched: response.kind === "unchanged" ? response.touched : [],
        listStamp: response.listStamp,
        issuedAtSeq: context === null ? null : context.seq,
        snapshotIncompleteSeqAtDispatch:
          context === null ? null : context.snapshotIncompleteSeq,
      };
    },
  });

  // Stage 2, the terminal twin - see the chat hook. This plane advances on
  // every applied delta for the epic, INCLUDING a chat one: both lists are
  // answered from the same per-(viewer, epic) composite, so a chat write moves
  // this list's revision even though no terminal-agent row changed.
  useRecordListStreamStamp(epicId, stamp, query.refetch);

  const answer = query.data ?? null;
  useEffect(() => {
    if (answer === null || store === null) return;
    if (answer.tuiAgents !== null) {
      // The fence is used as captured - it was read from THIS store, because
      // the generation is in the cache key. See
      // `TuiAgentListAnswer.issuedAtSeq`.
      store
        .getState()
        .applyTuiAgentRecords(answer.tuiAgents, answer.issuedAtSeq);
    } else if (answer.touched.length > 0) {
      // The `unchanged` arm: no rows, so no fence and no omission to
      // authorize. Empty-guarded because that is a quiet epic's steady state
      // and the apply crosses the runtime worker's command bridge.
      store.getState().applyTuiAgentRecordTouches(answer.touched);
    }
    // AFTER the apply, and only for an answer that reached a store - see the
    // chat twin for why an unapplied stamp is worse than none, and why reaching
    // a store is not yet proof the store took the answer whole.
    stamp.hold(answer.listStamp, answer.snapshotIncompleteSeqAtDispatch);
  }, [answer, stamp, store]);
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
