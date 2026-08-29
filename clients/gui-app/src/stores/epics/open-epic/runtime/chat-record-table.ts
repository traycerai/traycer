/**
 * The host's store-backed chat records, and the reconciliation that keeps the
 * poll and the push from fighting over them.
 *
 * Re-homed from the open-epic closure: five collections, three counters and
 * seven closures that lived as `let`s beside a websocket. Nothing about the
 * logic changed - the revision guard, the request-time fence, the absorbing
 * retractions and the ingest-time owner selection are the same rules with the
 * same comments, which is the point. This is the algorithm the north-star
 * architecture names as implemented three times in this codebase; unifying the
 * copies is a separate change, and it operates on this file rather than on a
 * closure.
 *
 * Push is the trigger and the poll is the backup, so both write this table and
 * neither owns it: a host without the stream loses latency and nothing else,
 * and a delta lost to a disconnect is repaired by the next 20s list read.
 */
import type {
  ChatRecordRemovalReason,
  ChatRecordSummary,
} from "@traycer/protocol/host/epic/chat-records";
import type { ChatRecordDelta } from "@traycer-clients/shared/host-transport/chat-records-stream-client";
import type { ChatsSlice } from "../types";
import { EMPTY_CHATS_SLICE } from "../types";
import {
  chatRecordsSlice,
  chatSlicesEq,
  isChatVisibleToUser,
} from "../projection-helpers";
import {
  unionPendingChatCreations,
  type PendingChatCreation,
  type RetainedChatCreation,
} from "../pending-chat-creations";

/**
 * What a mutation the table now backs needs to hear, and when.
 *
 * Called from the ONE seam every chat-record write flows through, BEFORE the
 * change gate can early-return: the optimistic overlay's record-plane
 * provenance marks must be captured while the row exists, and a gate that
 * returned first would lose exactly the rows that arrived without changing the
 * published slice.
 */
export interface ChatRecordTableSources {
  readonly getCurrentUserId: () => string | null;
  readonly onBeforePublish: () => void;
  readonly now: () => number;
}

/**
 * A recomputed table, ready to publish. `null` from a recompute means the
 * change gate held: an answer that says the same thing as the last one writes
 * nothing, so the 20s poll behind it costs no renders while an epic is quiet.
 */
export interface ChatRecordPublication {
  readonly chatRecords: ChatsSlice;
  /**
   * Non-null only when a retraction moved. The retraction map BYPASSES the
   * change gate, because a removal that leaves the slice unchanged - a chat
   * this session never held a record for, opened cross-host from the sidebar -
   * still has to reach the open tab that is rendering it.
   */
  readonly chatRetractions: Readonly<
    Record<string, ChatRecordRemovalReason>
  > | null;
}

export interface ChatRecordTable {
  /** The slice as last published. The projector reads this as an input. */
  current(): ChatsSlice;
  /**
   * The ingest counter as it stands now - the value a list request captures at
   * dispatch and passes back as `issuedAtSeq`. Monotonic, per session; every
   * accepted row write advances it.
   */
  ingestSeq(): number;
  applyRecords(
    records: readonly ChatRecordSummary[],
    issuedAtSeq: number | null,
  ): ChatRecordPublication | null;
  applyDelta(delta: ChatRecordDelta): ChatRecordPublication | null;
  beginPendingCreation(
    pending: PendingChatCreation,
  ): ChatRecordPublication | null;
  clearPendingCreation(chatId: string): ChatRecordPublication | null;
  /**
   * Rebuild for the CURRENTLY signed-in user from the retained raw rows.
   *
   * The slice is keyed on the record id alone and so can only ever represent
   * one owner's rows, which means a user switch has to REBUILD it -
   * re-projecting alone would keep serving the previous identity's selection.
   * Retained rows make that lossless.
   */
  republishForCurrentUser(): ChatRecordPublication | null;
  /** Whether the record plane serves `nodeId` to this viewer right now. */
  servesNodeToViewer(nodeId: string, currentUserId: string | null): boolean;
}

/**
 * A record identity is `(epicId, ownerUserId, chatId)`. The id is host-minted,
 * so two users can legitimately hold the same one inside a single task, and
 * this table is already scoped to one epic. Keying on the id alone would let a
 * collaborator's row EVICT the viewer's own same-id chat, which reads as the
 * viewer's chat vanishing from their own sidebar.
 */
function recordKey(ownerUserId: string, chatId: string): string {
  return `${ownerUserId}\u001f${chatId}`;
}

export function createChatRecordTable(
  sources: ChatRecordTableSources,
): ChatRecordTable {
  const { getCurrentUserId, onBeforePublish, now } = sources;

  /**
   * The host's store-backed chat records, held as the projector's INPUT (the
   * mirrored copy in the published projection is what components and tests
   * read). Held here rather than read back out of the projection because the
   * projector runs inside the publish path, where reading what it is about to
   * write is exactly the kind of cycle that produces a projection built from
   * half-updated state.
   */
  let chatRecords: ChatsSlice = EMPTY_CHATS_SLICE;

  /**
   * The RAW rows behind {@link chatRecords}, keyed by OWNER AND CHAT.
   *
   * The projected slice cannot serve as the record layer's own state on two
   * counts. It drops `revision`, which is the entire basis of the staleness
   * test a push delta has to make; and it is keyed on `chatId` ALONE, which is
   * not a record identity - see {@link recordKey}.
   *
   * Held beside the slice rather than folded into `ChatProjection`, because a
   * revision is sync bookkeeping and nothing that renders should be able to
   * read it.
   */
  const rows = new Map<string, ChatRecordSummary>();

  /**
   * Chats the record plane RETRACTED while this session was open, and why -
   * ABSORBING for the life of the session, so an id in here is filtered out of
   * every later record answer, poll included.
   *
   * Keyed by `chatId` alone, unlike {@link rows}, because that is all a
   * `remove` frame carries: the delta names `(epicId, chatId, reason)` and no
   * owner. The frame's addressing is therefore COARSER than a record identity,
   * so a removal retracts every retained row with that id in this epic.
   * Bounded and invisible today - the display filter already withholds every
   * row whose owner is not the signed-in user, so the only rows that can render
   * are ones for which `chatId` IS unique. Widening the frame is a protocol
   * change, not something to guess at here.
   */
  const retractions = new Map<string, ChatRecordRemovalReason>();

  /**
   * Local ingest order for the chat rows, and the watermark the last
   * `epic.listChatRecords` answer left behind. `revision` orders two versions
   * of ONE row and says nothing about a row an answer omits, so an omission may
   * only retract a row that was already held when the answer was issued, and a
   * served row may only replace a strictly older version.
   */
  const rowSeq = new Map<string, number>();
  let ingestSeq = 0;
  let snapshotFence = 0;

  /**
   * Locally initiated creations with no record back yet, keyed like
   * {@link rows} - `(ownerUserId, chatId)` - and held in their OWN map rather
   * than seeded into that one.
   *
   * Separate because these are not records and must not be treated as any: the
   * row map's entries carry a per-chat `revision` that the delta path's
   * staleness test compares against, and a synthesized entry would have to
   * invent one. A fabricated `revision: 0` would then make the real row's first
   * delta (also revision 0) read as a replay and be DROPPED - the optimistic
   * row would outlive the truth it stands in for. Held apart, the record path's
   * ordering rules are untouched and the union happens at publish.
   */
  const pendingCreations = new Map<string, RetainedChatCreation>();

  /**
   * Retires the stand-in that an ARRIVING RECORD has just made redundant.
   *
   * Keyed on the record's full identity, not on its id: `chatId` is not
   * globally unique, and a collaborator's legitimate same-id row must not be
   * able to retire the viewer's own in-flight creation - the row that replaces
   * a stand-in has to be the SAME chat, not merely a chat with the same id.
   */
  const expirePendingCreationForRecord = (
    ownerUserId: string,
    chatId: string,
  ): boolean => pendingCreations.delete(recordKey(ownerUserId, chatId));

  /**
   * Drops every retained creation for `chatId`, whoever it was registered for.
   *
   * The id-coarse arm, for the two callers that genuinely have no owner to
   * narrow by, both of which are addressing THIS CLIENT'S OWN creations rather
   * than reconciling somebody's record:
   *
   *  - a `remove` frame, which carries `(epicId, chatId, reason)` and no owner
   *    at all - the same coarseness the retraction map is keyed at, and bounded
   *    the same way;
   *  - a create that failed, whose caller knows the id it sent and not the
   *    profile that was signed in when the retention happened.
   *
   * Scoping the failure arm to the CURRENT user instead was considered and
   * rejected: it strands a stand-in for a chat that does not exist whenever the
   * account moves between the request and its refusal, and a ghost row for a
   * chat nobody can open is worse than dropping a stand-in for one that exists
   * (which the record channel restores on its next answer). This map only ever
   * holds creations THIS session initiated, and an id names at most one of
   * them, so the coarseness has nothing to hit in practice.
   */
  const dropPendingCreationsForChat = (chatId: string): boolean => {
    let dropped = false;
    for (const [key, retained] of pendingCreations) {
      if (retained.pending.chatId !== chatId) continue;
      pendingCreations.delete(key);
      dropped = true;
    }
    return dropped;
  };

  /**
   * Re-derives the record slice from the raw rows.
   *
   * The ONE recompute, shared by the poll and the push so the two halves of one
   * table cannot drift in how they publish it. The slice is keyed on `chatId`
   * alone, so it can only be built from rows for which that id is unambiguous -
   * i.e. ONE owner's. Selecting that owner here (rather than letting
   * `unionChatsSlice`'s filter do it downstream) is what stops a collaborator's
   * same-id row from taking the `byId` slot the viewer's own chat needs.
   *
   * The objection this used to carry - that filtering at ingest freezes the
   * answer at the moment the rows ARRIVED - is answered by {@link rows}, which
   * retains EVERY row regardless of owner. A user switch re-runs this from the
   * retained rows, so nothing is frozen and nothing is lost.
   * `unionChatsSlice` still applies the same predicate at projection time; two
   * boundaries, one shared rule, so they cannot disagree.
   */
  function recompute(withRetractions: boolean): ChatRecordPublication | null {
    const currentUserId = getCurrentUserId();
    // Record provenance for any pending metadata mutation this table now
    // backs, BEFORE the change gate below can early-return.
    onBeforePublish();
    const visible: ChatRecordSummary[] = [];
    for (const row of rows.values()) {
      if (!isChatVisibleToUser(row.ownerUserId, currentUserId)) continue;
      visible.push(row);
    }
    // Creations this client has asked for but has no record back for, folded
    // in HERE - the one seam both the poll and the push path publish through,
    // so neither can see a table the other cannot. A real row always wins over
    // its pending stand-in.
    const next = unionPendingChatCreations(
      chatRecordsSlice(visible),
      pendingCreations.values(),
      currentUserId,
    );
    const nextSlice = next.allIds.length === 0 ? EMPTY_CHATS_SLICE : next;
    if (!withRetractions && chatSlicesEq(chatRecords, nextSlice)) return null;
    chatRecords = nextSlice;
    return {
      chatRecords: nextSlice,
      chatRetractions: withRetractions ? Object.fromEntries(retractions) : null,
    };
  }

  return {
    current: () => chatRecords,
    ingestSeq: () => ingestSeq,

    applyRecords(records, issuedAtSeq) {
      const served = new Map<string, ChatRecordSummary>();
      for (const row of records) {
        // A retracted chat never comes back through the poll. The list read is
        // a SNAPSHOT of the host's SQLite and the host applies a removal before
        // it emits one, so a response that still carries the row was
        // necessarily issued before the retraction - letting it through would
        // resurrect a chat seconds after its tab said it was gone.
        if (retractions.has(row.chatId)) continue;
        served.set(recordKey(row.ownerUserId, row.chatId), row);
      }
      // Omissions first, against the fence - see `rowSeq`. A row this answer
      // does not carry is dropped only if it was already held when the answer
      // was ISSUED; anything ingested since then (a push delta, a faster later
      // answer) is newer than this snapshot by construction and survives it.
      const fence = issuedAtSeq ?? snapshotFence;
      for (const key of [...rows.keys()]) {
        if (served.has(key)) continue;
        if ((rowSeq.get(key) ?? 0) > fence) continue;
        rows.delete(key);
        rowSeq.delete(key);
      }
      for (const [key, row] of served) {
        // The record for a creation this client is holding open has arrived:
        // the stand-in has served its purpose and the served row takes over.
        // Runs for EVERY served row - stale-rejected ones included, since even
        // an old version proves the record exists - which is what lets a later
        // answer retire a stand-in registered while the row was already held.
        expirePendingCreationForRecord(row.ownerUserId, row.chatId);
        const held = rows.get(key);
        // The same monotonic-`revision` test the delta path applies, in the
        // same direction: a snapshot row that does not strictly exceed what is
        // held is an older version of that row, and overwriting with it would
        // regress a push the client has already shown - and, through the
        // optimistic overlay's supersession rule, terminally kill a healthy
        // pending chain over a read that was merely slow. (No doc-resident
        // carve-out here, unlike the terminal-agent twin: chat records are
        // registry-only, so every row carries a real revision.)
        if (held !== undefined && row.revision <= held.revision) continue;
        rows.set(key, row);
        ingestSeq += 1;
        rowSeq.set(key, ingestSeq);
      }
      snapshotFence = ingestSeq;
      return recompute(false);
    },

    applyDelta(delta) {
      if (delta.kind === "remove") {
        // Every retained row with this id, because the frame carries no owner
        // to narrow by - see the retraction map for why that is bounded rather
        // than wrong.
        const doomed = Array.from(rows.entries())
          .filter(([, row]) => row.chatId === delta.chatId)
          .map(([key]) => key);
        // A retraction outranks a creation this client is still holding open:
        // removal is terminal and absorbing, and an optimistic row is the
        // weakest claim there is. Dropped BEFORE the idempotence test so a
        // redelivered removal that is the first one to race a registration
        // still retires it.
        const hadPending = dropPendingCreationsForChat(delta.chatId);
        // Idempotent: a redelivered removal for the same reason is not a state
        // change, and re-publishing on it would re-project the epic for
        // nothing.
        if (
          retractions.get(delta.chatId) === delta.reason &&
          doomed.length === 0 &&
          !hadPending
        ) {
          return null;
        }
        retractions.set(delta.chatId, delta.reason);
        for (const key of doomed) {
          rows.delete(key);
          rowSeq.delete(key);
        }
        return recompute(true);
      }
      const { record } = delta;
      // Removal is TERMINAL AND ABSORBING - the one lifecycle rule in this
      // design - so no later upsert resurrects the row here.
      if (retractions.has(record.chatId)) return null;
      const key = recordKey(record.ownerUserId, record.chatId);
      const held = rows.get(key);
      // The staleness test, and the only ordering fact on a row: `revision` is
      // per-chat monotonic, so a delta that does not strictly exceed what is
      // held is a replay, a reorder or a duplicate. Dropping it is what makes
      // those harmless with no merge logic anywhere. NOT a timestamp
      // comparison - host clocks skew and `updatedAt` is display metadata no
      // ordering decision may read.
      if (held !== undefined && record.revision <= held.revision) return null;
      rows.set(key, record);
      // Past the fence the last snapshot left: an `epic.listChatRecords` answer
      // already in flight cannot carry this row's new version, so its omission
      // - or its stale copy, via the revision test above - must not defeat it.
      ingestSeq += 1;
      rowSeq.set(key, ingestSeq);
      // Same handover as the poll's, on the same full identity: whichever path
      // delivers the real row first retires the stand-in, so the row never
      // blinks out between the two.
      expirePendingCreationForRecord(record.ownerUserId, record.chatId);
      return recompute(false);
    },

    beginPendingCreation(pending) {
      // A chat this session has already seen retracted cannot be created back
      // into view - the same absorbing rule the record paths apply.
      if (retractions.has(pending.chatId)) return null;
      // No signed-in user means no identity to retain this under, and an
      // unattributed stand-in is worse than none: it could be retired by a
      // stranger's same-id row, or rendered to whoever signs in next. The chat
      // still surfaces when its own record arrives - i.e. exactly the behavior
      // that existed before this registry.
      //
      // Taken from the CALLER, who captured it when the request left, rather
      // than read live here. This runs when the host answers, and a profile
      // change while the create was in flight would otherwise file a chat
      // authorized as user A under user B - visible to B, and unretirable by
      // A's real record when it arrives under its actual owner.
      const ownerUserId = pending.ownerUserId;
      if (ownerUserId === null) return null;
      // NOT gated on whether a served row for this chat is already held. It can
      // be - the owning host pushes its record the moment it commits, so a
      // delta can beat the create's own answer - and retaining anyway is
      // deliberate: the union shadows the stand-in for as long as the real row
      // is there, and a stale list answer that clear-and-replaces that row (one
      // issued before the chat existed, landing after) would otherwise leave
      // NEITHER, which is the exact disappearance this registry exists to
      // prevent. The redundant entry costs one map slot and is retired by the
      // next answer carrying the row.
      const key = recordKey(ownerUserId, pending.chatId);
      if (pendingCreations.has(key)) return null;
      pendingCreations.set(key, {
        pending,
        ownerUserId,
        createdAt: now(),
      });
      return recompute(false);
    },

    clearPendingCreation(chatId) {
      if (!dropPendingCreationsForChat(chatId)) return null;
      return recompute(false);
    },

    republishForCurrentUser() {
      return recompute(false);
    },

    servesNodeToViewer(nodeId, currentUserId) {
      for (const row of rows.values()) {
        if (row.chatId !== nodeId) continue;
        if (isChatVisibleToUser(row.ownerUserId, currentUserId)) return true;
      }
      return false;
    },
  };
}
