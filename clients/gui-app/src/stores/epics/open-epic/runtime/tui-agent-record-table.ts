/**
 * The host's registry-backed terminal-agent rows - the terminal twin of `chat-record-table.ts`,
 * and now literally the same reconciliation: both planes are configurations of {@link
 */
import type { ChatRecordRemovalReason } from "@traycer/protocol/host/epic/chat-records";
import type { TuiAgentRecordSummaryV12 } from "@traycer/protocol/host/epic/tui-agent-records";
import type { TuiAgentRecordDelta } from "@traycer-clients/shared/host-transport/chat-records-stream-client";
import type { TerminalAgentsSlice } from "../types";
import { EMPTY_TERMINAL_AGENTS_SLICE } from "../types";
import {
  isTerminalAgentVisibleToUser,
  terminalAgentSlicesEq,
  tuiAgentRecordsSlice,
} from "../projection-helpers";
import {
  createRecordTable,
  ownerScopedRowKey,
  type RecordTable,
} from "./record-table";

export interface TuiAgentRecordTableSources {
  readonly getCurrentUserId: () => string | null;
  readonly onBeforePublish: () => void;
}

export interface TuiAgentRecordPublication {
  readonly tuiAgentRecords: TerminalAgentsSlice;
  /** Non-null only when a retraction moved. */
  readonly tuiAgentRetractions: Readonly<
    Record<string, ChatRecordRemovalReason>
  > | null;
}

export interface TuiAgentRecordTable {
  current(): TerminalAgentsSlice;
  ingestSeq(): number;
  applyRecords(
    records: readonly TuiAgentRecordSummaryV12[],
    issuedAtSeq: number | null,
  ): TuiAgentRecordPublication | null;
  applyDelta(delta: TuiAgentRecordDelta): TuiAgentRecordPublication | null;
  republishForCurrentUser(): TuiAgentRecordPublication | null;
  servesNodeToViewer(nodeId: string, currentUserId: string | null): boolean;
}

/**
 * Whether an incoming terminal-agent row should REPLACE the one held. AUTHORITY FIRST, revision
 * second - and the order is the whole point.
 */
function tuiAgentRowSupersedes(
  candidate: TuiAgentRecordSummaryV12,
  held: TuiAgentRecordSummaryV12,
): boolean {
  const candidateIsLocal = candidate.origin !== "cloud";
  const heldIsLocal = held.origin !== "cloud";
  if (candidateIsLocal !== heldIsLocal) return candidateIsLocal;
  if (candidate.origin === "doc" && held.origin === "doc") return true;
  return candidate.revision > held.revision;
}

export function createTuiAgentRecordTable(
  sources: TuiAgentRecordTableSources,
): TuiAgentRecordTable {
  const { getCurrentUserId, onBeforePublish } = sources;

  const table: RecordTable<TuiAgentRecordSummaryV12, TerminalAgentsSlice> =
    createRecordTable(
      {
        /**
         * Keyed by `(ownerUserId, tuiAgentId)`, exactly as the chat table is, and for the reason that
         * table's own key comment gives.
         */
        rowKey: (row) => ownerScopedRowKey(row.ownerUserId, row.tuiAgentId),
        retractionIdOf: (row) => row.tuiAgentId,
        isVisibleToUser: (row, currentUserId) =>
          isTerminalAgentVisibleToUser(row.ownerUserId, currentUserId),
        /**
         * Both paths take the SAME rule, and the merge that brought `@1.2` here is why they no longer
         * differ - see {@link tuiAgentRowSupersedes}.
         */
        supersedesOnSnapshot: tuiAgentRowSupersedes,
        supersedesOnUpsert: tuiAgentRowSupersedes,
        buildSlice: (visibleRows) => {
          const next = tuiAgentRecordsSlice(visibleRows);
          return next.allIds.length === 0 ? EMPTY_TERMINAL_AGENTS_SLICE : next;
        },
        slicesEq: terminalAgentSlicesEq,
        emptySlice: EMPTY_TERMINAL_AGENTS_SLICE,
      },
      {
        getCurrentUserId,
        // Provenance marks are captured at the one seam every terminal-agent
        // record write flows through, before the change gate can early-return.
        onBeforePublish,
        // This plane holds no stand-ins, so a row landing retires nothing and a
        // removal changes no state beyond the rows and the retraction itself.
        onRowServed: () => {},
        onUpsertAdmitted: () => {},
        onRemoval: () => false,
      },
    );

  function published(
    publication: {
      readonly slice: TerminalAgentsSlice;
      readonly retractions: Readonly<
        Record<string, ChatRecordRemovalReason>
      > | null;
    } | null,
  ): TuiAgentRecordPublication | null {
    if (publication === null) return null;
    return {
      tuiAgentRecords: publication.slice,
      tuiAgentRetractions: publication.retractions,
    };
  }

  return {
    current: () => table.current(),
    ingestSeq: () => table.ingestSeq(),

    applyRecords: (records, issuedAtSeq) =>
      published(table.applySnapshot(records, issuedAtSeq)),

    applyDelta(delta) {
      if (delta.kind === "tuiRemove") {
        return published(table.applyRemoval(delta.tuiAgentId, delta.reason));
      }
      // Passed through as it arrived. The row is already in its final shape by the time it reaches this
      // plane, and stamping it here would be wrong in both directions now:
      return published(table.applyUpsert(delta.record));
    },

    republishForCurrentUser: () => published(table.republish()),

    servesNodeToViewer: (nodeId, currentUserId) =>
      table.servesNodeToViewer(nodeId, currentUserId),
  };
}
