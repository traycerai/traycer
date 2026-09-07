import { sessionKeyOf } from "@traycer-clients/shared/replica-runtime";
import type { ConfirmedChatMutation } from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
/**
 * The host's store-backed chat records: this plane's answers to `record-table.ts`, plus the
 * pending-creation registry that is chats-only.
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

/** What a mutation the table now backs needs to hear, and when. */
export interface ChatRecordTableSources {
  readonly getCurrentUserId: () => string | null;
  readonly onBeforePublish: () => void;
  readonly now: () => number;
}

/** A recomputed table, ready to publish. */
export interface ChatRecordPublication {
  readonly chatRecords: ChatsSlice;
  /** Non-null only when a retraction moved. */
  readonly chatRetractions: Readonly<
    Record<string, ChatRecordRemovalReason>
  > | null;
}

export interface ChatRecordTable {
  /** The slice as last published. The projector reads this as an input. */
  current(): ChatsSlice;
  /**
   * The ingest counter as it stands now - the value a list request captures at dispatch and passes
   * back as `issuedAtSeq`. Monotonic, per session; every accepted row write advances it.
   */
  ingestSeq(): number;
  applyRecords(
    records: readonly ChatRecordSummaryV11[],
    issuedAtSeq: number | null,
  ): ChatRecordPublication | null;
  applyDelta(delta: ChatRecordDelta): ChatRecordPublication | null;
  applyConfirmedMutation(
    mutation: ConfirmedChatMutation,
  ): ChatRecordPublication | null;
  beginPendingCreation(
    pending: PendingChatCreation,
  ): ChatRecordPublication | null;
  clearPendingCreation(chatId: string): ChatRecordPublication | null;
  /** Rebuild for the CURRENTLY signed-in user from the retained raw rows. */
  republishForCurrentUser(): ChatRecordPublication | null;
  /** Whether the record plane serves `nodeId` to this viewer right now. */
  servesNodeToViewer(nodeId: string, currentUserId: string | null): boolean;
}

/** A record identity is `(epicId, ownerUserId, chatId)`. */
function recordKey(ownerUserId: string, chatId: string): string {
  // {@link ownerScopedRowKey} holds the encoding and the argument for it; both record planes key
  // through it, which is what stops this one from drifting from the terminal-agent table's again.
  return ownerScopedRowKey(ownerUserId, chatId);
}

/**
 * Whether an incoming chat row should REPLACE the one held, on the SNAPSHOT path - the
 * monotonic-`revision` test plus the two pairs it cannot judge.
 */
function chatRowSupersedesOnSnapshot(
  candidate: HeldChatRecordRow,
  held: HeldChatRecordRow,
): boolean {
  if (held.docResident === null) return true;
  if (held.docResident && candidate.docResident === true) return true;
  return candidate.revision > held.revision;
}

export function createChatRecordTable(
  sources: ChatRecordTableSources,
): ChatRecordTable {
  const { getCurrentUserId, onBeforePublish, now } = sources;
  const confirmedDeletions = new Set<string>();
  const identityKey = (row: {
    readonly ownerUserId: string;
    readonly originHostId: string;
    readonly chatId: string;
  }): string => sessionKeyOf([row.ownerUserId, row.originHostId, row.chatId]);

  /**
   * Locally initiated creations with no record back yet, keyed like the record rows - `(ownerUserId,
   * chatId)` - and held in their OWN map rather than seeded into that one.
   */
  const pendingCreations = new Map<string, RetainedChatCreation>();

  /** Retires the stand-in that an ARRIVING RECORD has just made redundant. */
  const expirePendingCreationForRecord = (record: HeldChatRecordRow): void => {
    pendingCreations.delete(recordKey(record.ownerUserId, record.chatId));
  };

  /** Drops every retained creation for `chatId`, whoever it was registered for. */
  const dropPendingCreationsForChat = (chatId: string): boolean => {
    let dropped = false;
    for (const [key, retained] of pendingCreations) {
      if (retained.pending.chatId !== chatId) continue;
      pendingCreations.delete(key);
      dropped = true;
    }
    return dropped;
  };

  // EXPLICIT type arguments, not inference.
  const table: RecordTable<HeldChatRecordRow, ChatsSlice> = createRecordTable<
    HeldChatRecordRow,
    ChatsSlice
  >(
    {
      rowKey: (row) => recordKey(row.ownerUserId, row.chatId),
      /**
       * A `remove` frame names `(epicId, chatId, reason)` and no owner, so the frame's addressing is
       * COARSER than a record identity and a removal retracts every retained row with that id in this
       */
      retractionIdOf: (row) => row.chatId,
      isVisibleToUser: (row, currentUserId) =>
        isChatVisibleToUser(row.ownerUserId, currentUserId),
      supersedesOnSnapshot: chatRowSupersedesOnSnapshot,
      /**
       * The bare guard, and deliberately NOT the snapshot rule - the twin shares one function across
       * both paths and this plane must not.
       */
      supersedesOnUpsert: (candidate, held) =>
        candidate.revision > held.revision,
      /**
       * Creations this client has asked for but has no record back for, folded in HERE - the one seam
       * both the poll and the push path publish through, so neither can see a table the other cannot.
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
      // Same handover as the poll's, on the same full identity: whichever path delivers the real row
      // first retires the stand-in, so the row never blinks out between the two.
      onUpsertAdmitted: expirePendingCreationForRecord,
      // A retraction outranks a creation this client is still holding open: removal is terminal and
      // absorbing, and an optimistic row is the weakest claim there is.
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
          records.flatMap<HeldChatRecordRow>((record) => {
            if (!confirmedDeletions.has(identityKey(record))) return [record];
            const held = table.retainedRow(
              recordKey(record.ownerUserId, record.chatId),
            );
            // A stale deleted-host row says nothing about a same-id peer's omission.
            return held !== null && held.originHostId !== record.originHostId
              ? [held]
              : [];
          }),
          issuedAtSeq,
        ),
      ),

    applyConfirmedMutation: (mutation) => {
      if (mutation.kind === "upsert") {
        if (confirmedDeletions.has(identityKey(mutation.record))) return null;
        const held = table.retainedRow(
          recordKey(mutation.record.ownerUserId, mutation.record.chatId),
        );
        if (held !== null) {
          if (held.originHostId !== mutation.record.originHostId) return null;
          if (mutation.record.revision < held.revision) {
            expirePendingCreationForRecord(mutation.record);
            return published(table.republish());
          }
        }
        return published(table.applyPointRead(mutation.record));
      }
      confirmedDeletions.add(identityKey(mutation));
      const key = recordKey(mutation.ownerUserId, mutation.chatId);
      const pending = pendingCreations.get(key);
      if (pending?.pending.hostId === mutation.originHostId)
        pendingCreations.delete(key);
      const held = table.retainedRow(key);
      if (held !== null && held.originHostId === mutation.originHostId) {
        return published(table.removeRow(key));
      }
      return published(table.republish());
    },

    applyDelta: (delta) => {
      if (delta.kind === "remove") {
        return published(table.applyRemoval(delta.chatId, delta.reason));
      }
      if (confirmedDeletions.has(identityKey(delta.record))) return null;
      // `host.chatRecords.subscribe` carries the BASE row, which says nothing about the home - and
      // unlike the terminal twin, "a doc-homed row cannot produce a delta" is FALSE here:
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
      // The chat still surfaces when its own record arrives - i.e.
      const ownerUserId = pending.ownerUserId;
      if (ownerUserId === null) return null;
      if (
        confirmedDeletions.has(
          identityKey({
            ownerUserId,
            originHostId: pending.hostId,
            chatId: pending.chatId,
          }),
        )
      )
        return null;
      // NOT gated on whether a served row for this chat is already held.
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
