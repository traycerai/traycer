/**
 * The host's registry-backed terminal-agent rows - the terminal twin of
 * `chat-record-table.ts`, and now literally the same reconciliation: both
 * planes are configurations of {@link createRecordTable}, which owns the fence,
 * the per-row revision guard, the absorbing retractions and the change gate.
 *
 * The three differences that kept the two implementations apart through the
 * extraction survive as declarations rather than as a second copy of the
 * algorithm: this plane keys rows by id alone, waives the revision guard for
 * doc-resident-over-doc-resident on the SNAPSHOT path only, and has no
 * pending-creation registry. Each is argued below, at the point that holds it.
 */
import type { ChatRecordRemovalReason } from "@traycer/protocol/host/epic/chat-records";
import type { TuiAgentRecordSummaryV11 } from "@traycer/protocol/host/epic/tui-agent-records";
import type { TuiAgentRecordDelta } from "@traycer-clients/shared/host-transport/chat-records-stream-client";
import type { TerminalAgentsSlice } from "../types";
import { EMPTY_TERMINAL_AGENTS_SLICE } from "../types";
import {
  isTerminalAgentVisibleToUser,
  terminalAgentSlicesEq,
  tuiAgentRecordsSlice,
} from "../projection-helpers";
import { createRecordTable, type RecordTable } from "./record-table";

export interface TuiAgentRecordTableSources {
  readonly getCurrentUserId: () => string | null;
  readonly onBeforePublish: () => void;
}

export interface TuiAgentRecordPublication {
  readonly tuiAgentRecords: TerminalAgentsSlice;
  /**
   * Non-null only when a retraction moved. Bypasses the change gate for the
   * same reason the chats' does: a removal that changes no slice (a row this
   * session never held) still has to reach an open tab that is rendering the
   * agent.
   */
  readonly tuiAgentRetractions: Readonly<
    Record<string, ChatRecordRemovalReason>
  > | null;
}

export interface TuiAgentRecordTable {
  current(): TerminalAgentsSlice;
  ingestSeq(): number;
  applyRecords(
    records: readonly TuiAgentRecordSummaryV11[],
    issuedAtSeq: number | null,
  ): TuiAgentRecordPublication | null;
  applyDelta(delta: TuiAgentRecordDelta): TuiAgentRecordPublication | null;
  republishForCurrentUser(): TuiAgentRecordPublication | null;
  servesNodeToViewer(nodeId: string, currentUserId: string | null): boolean;
}

export function createTuiAgentRecordTable(
  sources: TuiAgentRecordTableSources,
): TuiAgentRecordTable {
  const { getCurrentUserId, onBeforePublish } = sources;

  const table: RecordTable<TuiAgentRecordSummaryV11, TerminalAgentsSlice> =
    createRecordTable(
      {
        /**
         * Keyed by `tuiAgentId` ALONE, unlike the chat table's: the host serves
         * the CALLER'S OWN rows only (terminal agents are structurally
         * owner-private, per the `epic.listTuiAgents` contract), so within one
         * viewer's answer the id is unambiguous. Rows are still retained
         * regardless of owner - a delta could in principle carry another
         * identity's row after an account switch - and the recompute
         * re-selects for the current user, so the keying only has to be safe
         * for what the host actually serves.
         */
        rowKey: (row) => row.tuiAgentId,
        /**
         * The same id the row is keyed by, so a `tuiRemove` names exactly one
         * row and the removal sweep's coarser addressing has nothing to hit
         * here.
         */
        retractionIdOf: (row) => row.tuiAgentId,
        isVisibleToUser: (row, currentUserId) =>
          isTerminalAgentVisibleToUser(row.ownerUserId, currentUserId),
        /**
         * The monotonic-`revision` test, EXCEPT doc-resident over doc-resident,
         * which it cannot judge. A doc row has no registry seq to carry, so it
         * ships at `revision: 0` on EVERY answer - `0 <= 0` would reject each
         * refresh and freeze that agent at whatever the first answer of the
         * session said, for the life of the session. Under `@2` that row is its
         * only source, so the freeze hides a peer-host rename, reparent and
         * archive alike.
         *
         * Narrow, and in one direction only. The guard still applies the moment
         * either side is registry-backed: a doc row at 0 can never clobber an
         * adopted registry row (`0 <= n`), and an adopted row still replaces the
         * frozen copy (`n <= 0` is false). What is waived is only the comparison
         * between two rows that both carry a placeholder, where the later answer
         * is newer by construction because it is a fresher read of the same map.
         */
        supersedesOnSnapshot: (candidate, held) =>
          (held.docResident && candidate.docResident) ||
          candidate.revision > held.revision,
        /**
         * No carve-out on the delta path: the plane is REGISTRY-ONLY by
         * construction there (see `applyDelta`), so both sides of a comparison
         * that reaches here carry a real revision.
         */
        supersedesOnUpsert: (candidate, held) =>
          candidate.revision > held.revision,
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
      // The delta plane is REGISTRY-ONLY by construction - a doc-resident agent
      // has no registry row, so it can never produce a delta. So `false` here
      // is a fact about the source, not a filled-in default.
      //
      // It is also what makes ADOPTION converge through the staleness test:
      // `epic.listTuiAgents@1.1` serves a frozen doc row at `revision: 0`, so
      // the first real delta after that agent's binding host upgrades and the
      // sweep imports it strictly exceeds 0 and replaces the frozen copy in
      // place.
      return published(
        table.applyUpsert({ ...delta.record, docResident: false }),
      );
    },

    republishForCurrentUser: () => published(table.republish()),

    servesNodeToViewer: (nodeId, currentUserId) =>
      table.servesNodeToViewer(nodeId, currentUserId),
  };
}
