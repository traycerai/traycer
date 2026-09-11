import { useEffect, useMemo } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type { ChatRecordSummaryV12 } from "@traycer/protocol/host/epic/chat-records";
import type {
  RecordListRecencyPatch,
  RecordListStamp,
} from "@traycer/protocol/host/epic/record-list-revision";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useRecordListStamp } from "@/hooks/chats/use-record-list-stamp";
import { useHostQueryWithResponseMap } from "@/hooks/host/use-host-query";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { hostQueryKeys } from "@/lib/query-keys";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { GUI_PROJECTS_EPIC_DOC_REPLICA } from "@/stores/epics/open-epic/projection-helpers";

/**
 * What the cache holds for one `epic.listChatRecords` answer: the rows, plus
 * where the session's chat-record ingest counter stood when the request was
 * DISPATCHED. The store merges omissions against that fence - a row the
 * answer does not carry is retracted only if the answer was issued after the
 * row landed - so the fence has to be captured before the RPC, not when the
 * answer is applied. `null` when no session existed to read at dispatch.
 */
interface ChatRecordListAnswer {
  /**
   * The `@1.2` row, NOT the base one and not `@1.1`'s. A narrower row is
   * assignable to this in the wrong direction, so typing it down is a silent
   * narrowing rather than a type error, and each dropped field fails
   * somewhere different:
   *
   *  - without `docResident` (the `@1.1` field), the request asks for the
   *    doc-resident remainder and the cache then drops the one field that
   *    says which rows those are. What is lost surfaces on the WRITE, not the
   *    render - a rename routed to `epic.renameChat` with an id naming no
   *    registry chat.
   *  - without `head` (the `@1.2` field), a host that serves the cloud
   *    publication stamp never reaches the store with it, and the
   *    published-copy tile is back to one read per mount.
   *
   * A host on an older minor upgrades with `head` absent, which the head
   * plane treats as "nothing to say about the head" rather than as a
   * retraction.
   *
   * `null` means the answer carried NO rows to apply - the `@1.3`
   * `unchanged` arm. Distinct from `[]`, which is the positive claim that
   * this epic has no chats and retracts everything the fence allows.
   */
  readonly chats: readonly ChatRecordSummaryV12[] | null;
  /**
   * What the `unchanged` arm carried instead of rows: the recency facts a
   * QUIET write moved since the stamp this request sent. Empty on the
   * `snapshot` arm, whose rows already carry their own `updatedAt`.
   *
   * Held in the CACHE ENTRY rather than applied straight from `mapResponse`
   * for the same reason the rows are: the applying effect is what knows
   * whether there is a store to apply into, and a cached answer that has not
   * reached one yet is re-offered when it appears.
   */
  readonly touched: readonly RecordListRecencyPatch[];
  /**
   * The list stamp this answer carried, sent back verbatim as the next
   * dispatch's `knownRevision` - see {@link useRecordListStamp}.
   *
   * `null` is the honest answer from a host that has no revision to report (a
   * `@1.2` peer, through the upgrade path), and it keeps this hook asking for
   * a snapshot every tick, which is exactly the behaviour that predates
   * `@1.3`.
   */
  readonly listStamp: RecordListStamp | null;
  /**
   * Always this store's own counter, because the store GENERATION is part of
   * the cache key - see the `cacheKeyIdentity` this hook builds. An entry
   * therefore belongs to exactly one session, and a fence read from another
   * generation (numerically meaningless here, and typically larger, which let
   * the omission pass retract rows the answer never covered) cannot reach the
   * applying effect.
   *
   * This used to carry a `fenceIdentity` beside it and the applying effect
   * compared the two, degrading the fence to `null` on mismatch. That check is
   * gone rather than kept as a second mechanism: with the generation in the
   * key it could not fire, and an unreachable guard is not defence in depth -
   * it is a claim about the code that the next reader would rely on. What
   * holds the guarantee is the key, and the pin that reddens if the key ever
   * stops carrying the generation.
   */
  readonly issuedAtSeq: number | null;
}

/**
 * Feeds the epic session's record table from the host's chat registry.
 *
 * ## What this closes
 *
 * `OpenEpicStore.chats` used to have exactly one producer: the epic Y.Doc's
 * `chats` map. Since chat-sync-v2 nothing maintains that map - a chat created
 * after the upgrade never gets an entry (ticket 19) and the upgrade sweep
 * deletes the entries it can prove published (ticket 20) - so the renderer's
 * record set was a frozen, shrinking remainder. A chat with no record has no
 * tree row, no rename/archive affordances, and (through a record-gated
 * subscribe) opened as its read-only published copy on its own owning host.
 * This hook is the other producer; the store unions the two.
 *
 * ## Doc-only mode is a designed state
 *
 * A host that predates `epic.listChatRecords` answers `E_HOST_UNSUPPORTED`. The
 * store is then never told about any records and `chats` stays exactly the doc
 * projection - which is that host's own, correct, record table, since a host
 * without this method is a host that still maintained the doc. No toast, no
 * empty state: there is nothing for the user to act on, and the retry predicate
 * stops immediately rather than spending attempts on a permanent answer.
 *
 * A transport FAILURE is treated the same way this file treats every partial
 * answer: the last known rows stay published. Clearing them on a failed refetch
 * would make every network blip delete the tree rows the channel exists to
 * restore.
 *
 * ## Change signal
 *
 * Polled (20s, `HOST_METHOD_POLL_TABLE`) plus explicit invalidation from the
 * chat mutations this client makes ({@link invalidateEpicChatRecords}). There is
 * no push edge to ride: these facts are committed to the chat database, which
 * has no per-epic wire channel to this renderer - the epic Y.Doc's update stream
 * is the only one, and it is precisely what stopped carrying them.
 */
export function useEpicSyncChatRecords(epicId: string): void {
  // The EPIC SESSION's host - the one `handle` was acquired against - never the
  // app-wide one. The two used to be read as the same thing ("the session is
  // acquired for the addressable host and rebuilt when it changes"), but the
  // provider keeps the previous session rendered through an A→B re-point while
  // the app-wide client already answers B: this hook then applied B's record
  // list into A's store, and the record gate judged A-bound tiles against it.
  // Asking any host but the session's answers about a registry the session is
  // not projecting.
  const client = useEpicSessionHostClient();
  const handle = useMaybeOpenEpicHandle();
  // `hasDocReplica` decides whether the host serves the doc-resident
  // remainder - see `GUI_PROJECTS_EPIC_DOC_REPLICA`. Declared by us because
  // only we know it: the host would have to infer it from `epic.subscribe`'s
  // negotiated major, which this method's own version cannot see.
  //
  // `knownRevision: null` here is the QUERY KEY's value, not the payload's:
  // the stamp is replaced per dispatch through `buildRequest` below, and it
  // deliberately does not reach the key. A stamp in the key would mint a fresh
  // cache entry on every tick the host's revision moved - so the poll would
  // refetch from scratch forever and the gating it exists for would never
  // fire - and one frozen into the key at mount would be stale by the second
  // tick. `null` is also the truthful value for the one dispatch that really
  // does hold nothing: the first one.
  const params = useMemo(
    () => ({
      epicId,
      hasDocReplica: GUI_PROJECTS_EPIC_DOC_REPLICA,
      knownRevision: null,
    }),
    [epicId],
  );
  // Viewer-scoped, exactly like the cloud-chat reads: the response is one
  // identity's own chats, so two users on one installation have different
  // correct answers and must never share a cache slot.
  const viewerUserId = useCloudChatViewerId();
  const store = handle?.store ?? null;
  // The session GENERATION this answer belongs to, in the CACHE KEY -
  // `OpenEpicState.ingestFenceIdentity`, minted once per store construction.
  //
  // Without it a cached answer outlives the store it was read for and is
  // served to the NEXT one, which is not a hypothetical: renderer parking
  // (plan C, C1) unmounts this hook, releases the session, and remounts it
  // against a fresh store the moment the tab is shown again. Inside
  // `staleTime` that remount is served entirely from cache - no request, and
  // a chat deleted at the host while the epic was parked reappears as though
  // it still existed. `refetchOnMount: "always"` would fix the missing
  // request and not the reappearance, because TanStack hands the observer the
  // cached rows first and refetches behind them.
  //
  // Keying on the generation states the actual relationship: the cached
  // representation of this request is generation-scoped (its fence is read
  // from one specific store), so a new generation is a different cache entry
  // and its first read is a real request. Bounded - the superseded entry is
  // unobserved and is collected on the normal `gcTime`.
  //
  // Read straight through rather than memoized: never written after
  // construction, so for a given `store` it is a constant, and a number needs
  // no referential stability to key a query.
  const fenceIdentity = store?.getState().ingestFenceIdentity ?? null;
  // The revision-gating seam. Keyed on the same three facts the cache entry is
  // (epic, viewer, store generation), so the stamp dies with the row set it
  // describes - see {@link useRecordListStamp}.
  const stamp = useRecordListStamp(epicId, viewerUserId, fenceIdentity);
  const query = useHostQueryWithResponseMap<
    HostRpcRegistry,
    "epic.listChatRecords",
    ChatRecordListAnswer,
    { readonly seq: number } | null
  >({
    cacheKeyIdentity: [viewerUserId, fenceIdentity],
    client,
    method: "epic.listChatRecords",
    params,
    // What this client holds, at the moment the request leaves. An older host
    // never sees it at all: the request is projected onto the negotiated
    // minor, and `@1.2`'s schema has no `knownRevision` to project it into.
    buildRequest: (base) => ({ ...base, knownRevision: stamp.read() }),
    options: {
      enabled: epicId.length > 0 && viewerUserId.length > 0,
      staleTime: 10_000,
      // Opt in to the table's fixed cadence. A `fixed` poll policy is OPT-IN
      // in `useHostQuery` (only `condition` policies poll by default), so
      // without this the 20s the table declares - and the paragraph above
      // promises - is never armed: `refetchInterval` stays `false` and the
      // only thing left refreshing the list is a window-focus refetch.
      poll: true,
      retry: (failureCount, error) =>
        error.code !== "E_HOST_UNSUPPORTED" && failureCount < 2,
    },
    // Runs immediately before the RPC is dispatched - see
    // `ChatRecordListAnswer`. A push delta that lands while this request is
    // in flight advances the counter past this value, which is exactly how
    // the store knows the answer could not have carried that row.
    captureRequestContext: () => {
      if (store === null) return null;
      return { seq: store.getState().peekChatIngestSeq() };
    },
    mapResponse: ({ response, requestContext }) => {
      const context = requestContext ?? null;
      return {
        // `unchanged` maps to `null`, never to `[]`. An empty array is not the
        // neutral value here: the store merges omissions against the dispatch
        // fence, so an empty answer RETRACTS every row that landed before it.
        // "Nothing changed" and "you have no chats" must not share a
        // representation.
        chats: response.kind === "snapshot" ? response.chats : null,
        // The `snapshot` arm carries no patches by construction: its rows are
        // the recency.
        touched: response.kind === "unchanged" ? response.touched : [],
        listStamp: response.listStamp,
        issuedAtSeq: context === null ? null : context.seq,
      };
    },
  });

  const answer = query.data ?? null;
  const recordListAuthoritative =
    query.isSuccess ||
    (query.isError && query.error.code === "E_HOST_UNSUPPORTED");
  useEffect(() => {
    if (store === null || !recordListAuthoritative) return;
    if (answer !== null) {
      if (answer.chats !== null) {
        // The fence is used as captured. It was read from THIS store, because
        // the generation is in the cache key - see `ChatRecordListAnswer`.
        store.getState().applyChatRecords(answer.chats, answer.issuedAtSeq);
      } else if (answer.touched.length > 0) {
        // The `unchanged` arm. No fence: this answer carried no rows, so it
        // authorizes no omission and the snapshot watermark stays where the
        // last rows answer left it.
        //
        // Guarded on emptiness because that is the STEADY STATE of a quiet
        // epic - `unchanged` with nothing touched, every 20s - and the apply
        // crosses the runtime worker's command bridge. The table would gate it
        // to nothing at the far end; not sending it costs one comparison.
        store.getState().applyChatRecordTouches(answer.touched);
      }
      // AFTER the apply, and only for an answer that reached a store. The
      // stamp is the host's record of what this client holds, and holding one
      // for an answer that was never applied would license an `unchanged`
      // reply about rows this store never received.
      stamp.hold(answer.listStamp);
    }
    store.getState().markChatRecordListAuthoritative();
  }, [answer, recordListAuthoritative, stamp, store]);
}

/**
 * Drops this host's cached record list so the next read re-asks.
 *
 * Called by the chat mutations after the host has committed one, because the
 * commit lands in the chat database and NOTHING carries it back to this
 * renderer on its own: a rename, re-parent or archive of a chat with no doc
 * entry is invisible until this list is read again. Without it those
 * affordances would appear to do nothing for up to one poll interval, which is
 * the same "the click did nothing" the record channel exists to fix.
 *
 * Scoped to the method (every epic's list on that host), not to one epic's
 * params: a mutation knows the record it changed, and the epic-scoped key is
 * the params object it would have to reconstruct exactly to hit the slot.
 *
 * ## Why plain invalidation, and not an explicit fetch
 *
 * TanStack's defaults already cover the three states this key can be in when a
 * mutation lands, so nothing more is needed here:
 *  - MOUNTED AND ENABLED (the create-then-open case: the modal and the fork
 *    dialog both live inside the epic route, which mounts the sync hook) -
 *    `refetchType` defaults to `"active"`, so it refetches immediately; and
 *    `refetchQueries` defaults to `cancelRefetch: true`, so a read that was
 *    already in flight when the mutation landed - and would have answered from
 *    BEFORE the write - is cancelled and re-issued rather than allowed to
 *    settle and clear the invalidation.
 *  - CACHED BUT INACTIVE - marked invalid, hence stale, so the next observer
 *    to mount fetches rather than serving the cached rows.
 *  - NOT IN THE CACHE AT ALL (the epic just opened) - the first mount fetches
 *    anyway.
 * A `refetchType: "all"` would additionally re-read every OTHER open epic's
 * list on this host, since this key is method-scoped, for no gain.
 */
export function invalidateEpicChatRecords(
  queryClient: QueryClient,
  hostId: string | null,
): void {
  void queryClient.invalidateQueries({
    queryKey: hostQueryKeys.methodScope(hostId, "epic.listChatRecords"),
  });
}
