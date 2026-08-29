/**
 * The host's store-backed chat records: this plane's answers to
 * `record-table.ts`, plus the pending-creation registry that is chats-only.
 *
 * The reconciliation itself - the request-time fence, the per-row revision
 * guard, the absorbing retractions, the one gated recompute - lives in
 * {@link createRecordTable} and is shared with the terminal-agent twin. What is
 * here is what the shared algorithm cannot know: that a chat record's identity
 * composes its owner, that a removal frame is addressed more coarsely than
 * that, and that this plane holds stand-ins for creations no record has come
 * back for yet.
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
import { createRecordTable, type RecordTable } from "./record-table";

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
   * Locally initiated creations with no record back yet, keyed like the record
   * rows - `(ownerUserId, chatId)` - and held in their OWN map rather than
   * seeded into that one.
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
  const expirePendingCreationForRecord = (record: ChatRecordSummary): void => {
    pendingCreations.delete(recordKey(record.ownerUserId, record.chatId));
  };

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

  const table: RecordTable<ChatRecordSummary, ChatsSlice> = createRecordTable(
    {
      rowKey: (row) => recordKey(row.ownerUserId, row.chatId),
      /**
       * A `remove` frame names `(epicId, chatId, reason)` and no owner, so the
       * frame's addressing is COARSER than a record identity and a removal
       * retracts every retained row with that id in this epic.
       *
       * Bounded and invisible today - the display filter already withholds
       * every row whose owner is not the signed-in user, so the only rows that
       * can render are ones for which `chatId` IS unique. Widening the frame is
       * a protocol change, not something to guess at here.
       */
      retractionIdOf: (row) => row.chatId,
      isVisibleToUser: (row, currentUserId) =>
        isChatVisibleToUser(row.ownerUserId, currentUserId),
      /**
       * No doc-resident carve-out here, unlike the terminal-agent twin: chat
       * records are registry-only, so every row carries a real revision and the
       * same monotonic test governs both paths.
       */
      supersedesOnSnapshot: (candidate, held) =>
        candidate.revision > held.revision,
      supersedesOnUpsert: (candidate, held) =>
        candidate.revision > held.revision,
      /**
       * Creations this client has asked for but has no record back for, folded
       * in HERE - the one seam both the poll and the push path publish through,
       * so neither can see a table the other cannot. A real row always wins over
       * its pending stand-in.
       */
      buildSlice: (visibleRows, currentUserId) => {
        const next = unionPendingChatCreations(
          chatRecordsSlice(visibleRows),
          pendingCreations.values(),
          currentUserId,
        );
        return next.allIds.length === 0 ? EMPTY_CHATS_SLICE : next;
      },
      slicesEq: chatSlicesEq,
      emptySlice: EMPTY_CHATS_SLICE,
    },
    {
      getCurrentUserId,
      onBeforePublish,
      // The record for a creation this client is holding open has arrived: the
      // stand-in has served its purpose and the served row takes over.
      onRowServed: expirePendingCreationForRecord,
      // Same handover as the poll's, on the same full identity: whichever path
      // delivers the real row first retires the stand-in, so the row never
      // blinks out between the two.
      onUpsertAdmitted: expirePendingCreationForRecord,
      // A retraction outranks a creation this client is still holding open:
      // removal is terminal and absorbing, and an optimistic row is the weakest
      // claim there is.
      onRemoval: dropPendingCreationsForChat,
    },
  );

  function published(
    publication: {
      readonly slice: ChatsSlice;
      readonly retractions: Readonly<
        Record<string, ChatRecordRemovalReason>
      > | null;
    } | null,
  ): ChatRecordPublication | null {
    if (publication === null) return null;
    return {
      chatRecords: publication.slice,
      chatRetractions: publication.retractions,
    };
  }

  return {
    current: () => table.current(),
    ingestSeq: () => table.ingestSeq(),

    applyRecords: (records, issuedAtSeq) =>
      published(table.applySnapshot(records, issuedAtSeq)),

    applyDelta: (delta) =>
      published(
        delta.kind === "remove"
          ? table.applyRemoval(delta.chatId, delta.reason)
          : table.applyUpsert(delta.record),
      ),

    beginPendingCreation(pending) {
      // A chat this session has already seen retracted cannot be created back
      // into view - the same absorbing rule the record paths apply.
      if (table.isRetracted(pending.chatId)) return null;
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
      return published(table.republish());
    },

    clearPendingCreation(chatId) {
      if (!dropPendingCreationsForChat(chatId)) return null;
      return published(table.republish());
    },

    republishForCurrentUser: () => published(table.republish()),

    servesNodeToViewer: (nodeId, currentUserId) =>
      table.servesNodeToViewer(nodeId, currentUserId),
  };
}
