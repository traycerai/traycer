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
  ChatRecordSummaryV11,
} from "@traycer/protocol/host/epic/chat-records";
import type { ChatRecordDelta } from "@traycer-clients/shared/host-transport/chat-records-stream-client";
import type { ChatsSlice, HeldChatRecordRow } from "../types";
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
import {
  createRecordTable,
  ownerScopedRowKey,
  type RecordTable,
} from "./record-table";

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
    records: readonly ChatRecordSummaryV11[],
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
  // {@link ownerScopedRowKey} holds the encoding and the argument for it; both
  // record planes key through it, which is what stops this one from drifting
  // from the terminal-agent table's again. It matters more here than there by
  // one degree: this key also indexes `pendingCreations`, so a collision can
  // retire the wrong pending stand-in as well as evict the wrong row.
  return ownerScopedRowKey(ownerUserId, chatId);
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
  const expirePendingCreationForRecord = (record: HeldChatRecordRow): void => {
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

  // EXPLICIT type arguments, not inference. `TRow` has exactly one annotated
  // inference site among these callbacks - `onRowServed` - so before this the
  // whole table silently inferred the BASE wire row from that one parameter,
  // and every `docResident` read in the plane config was a property access on a
  // type that does not have it. The `RecordTable<…>` annotation on the binding
  // does not prevent that: it is checked against the inferred result rather
  // than driving it.
  const table: RecordTable<HeldChatRecordRow, ChatsSlice> = createRecordTable<
    HeldChatRecordRow,
    ChatsSlice
  >(
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
       * The monotonic-`revision` test, EXCEPT over a row whose HOME is unknown,
       * which it cannot judge - the chat plane's own carve-out, narrower than
       * the terminal twin's and for the opposite reason.
       *
       * A delta seeds `docResident: null` for a chat it has never held (see
       * `applyDelta`), and the `@1.1` answer that states the home is a fresher
       * read of the SAME registry row, so it routinely carries the SAME
       * revision. `n > n` is false, so without this the row would keep its
       * unknown home for the life of the session and every write affordance on
       * it would stay closed - a chat the user can see and cannot rename.
       *
       * One direction only, and only where nothing is being overwritten that
       * anyone stated: the waiver applies when the HELD row's home is unknown,
       * so a stated home is never replaced by a stale answer, and the ordinary
       * guard still governs every other pair. Snapshot-only, like the twin's:
       * a later ANSWER is a fresher read of the same map, while a delta
       * arriving out of order is not.
       */
      supersedesOnSnapshot: (candidate, held) =>
        held.docResident === null || candidate.revision > held.revision,
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

    // `@1.1` states the home for every row it carries, so the answer is
    // authoritative and the held row takes it verbatim.
    applyRecords: (records, issuedAtSeq) =>
      published(
        table.applySnapshot(
          records.map((record) => ({
            ...record,
            docResident: record.docResident,
          })),
          issuedAtSeq,
        ),
      ),

    applyDelta: (delta) => {
      if (delta.kind === "remove") {
        return published(table.applyRemoval(delta.chatId, delta.reason));
      }
      // `host.chatRecords.subscribe` carries the BASE row, which says nothing
      // about the home - and unlike the terminal twin, "a doc-homed row cannot
      // produce a delta" is FALSE here: `ChatRegistryService.acquire` calls
      // `hydrateLegacyDocSecondary(legacyDocChats, true)`, deliberately
      // announcing doc-homed chats so a chat-list stream that won the first
      // acquire with no Y.Doc learns its baseline grew. Stamping `false` would
      // route exactly those rows' renames to a writer that cannot address them.
      //
      // So: carry forward what the last ANSWER stated for this chat, and admit
      // ignorance when nothing has. Read from the RETAINED row rather than a
      // second map, since two books that can disagree is the defect class this
      // plane already documents - but by the FULL record identity, not off the
      // published slice.
      //
      // The slice is keyed by `chatId` alone and filtered to the viewer, and
      // the record table's own note says why that is not the same question:
      // it "is keyed on the bare id, which is not necessarily a record
      // identity". Two owners can hold the same host-minted chat id, and a
      // delta for one arriving while the OTHER owner's row is the published
      // one - the null-viewer boot window, an account transition - inherited
      // that stranger's home. The consequences run both ways: a doc-resident
      // chat gets a registry RPC enabled on it, or a valid write is disabled
      // until some later full list answer corrects it.
      const held = table.retainedRow(
        recordKey(delta.record.ownerUserId, delta.record.chatId),
      );
      const heldHome = held === null ? null : held.docResident;
      return published(
        table.applyUpsert({
          ...delta.record,
          docResident: heldHome,
        }),
      );
    },

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
