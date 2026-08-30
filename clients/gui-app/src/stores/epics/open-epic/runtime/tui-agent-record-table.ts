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
import type { TuiAgentRecordSummaryV12 } from "@traycer/protocol/host/epic/tui-agent-records";
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
    records: readonly TuiAgentRecordSummaryV12[],
    issuedAtSeq: number | null,
  ): TuiAgentRecordPublication | null;
  applyDelta(delta: TuiAgentRecordDelta): TuiAgentRecordPublication | null;
  republishForCurrentUser(): TuiAgentRecordPublication | null;
  servesNodeToViewer(nodeId: string, currentUserId: string | null): boolean;
}

/**
 * Whether an incoming terminal-agent row should REPLACE the one held.
 *
 * AUTHORITY FIRST, revision second - and the order is the whole point.
 *
 * A `cloud` row is a read-only replica of an agent on another machine; a
 * `registry` (or `doc`) row is the serving host's own. Comparing revisions
 * first treats the two as interchangeable, and they are not: the host may
 * legitimately answer with an authoritative row at the SAME revision a stale
 * replica already carries - it silently drops a stale replica sitting under a
 * live local row, then serves the local row from its next list - and a
 * revision-first rule rejects it as "not newer". The GUI then keeps the cloud
 * copy for good: it is unlaunchable and unforkable, and because the id WAS in
 * the snapshot, the omission fence cannot remove it either.
 *
 * The doc-over-doc waiver is the clause this plane already had, and it stands
 * unchanged: a doc row has no registry seq to carry, so it ships at
 * `revision: 0` on EVERY answer - `0 > 0` would reject each refresh and freeze
 * that agent at whatever the first answer of the session said. Under `@2` that
 * row is its only source, so the freeze hides a peer-host rename, reparent and
 * archive alike. Two doc reads are the same authority and the later one is
 * newer by construction, being a fresher read of the same map. It stays narrow:
 * the revision guard still applies the moment either side is registry-backed.
 *
 * Keyed on `origin`, NOT on `docResident`, which is the sharper half of what
 * `@1.2` brought. `docResident` is a boolean a REGISTRY row may also carry -
 * it says "the doc map has a copy of me", not "I came from the doc map" - so
 * the old `held.docResident && candidate.docResident` test would waive the
 * revision guard between two registry rows that happen to be doc-resident.
 * `origin` is the authority discriminant and answers the question the waiver
 * is actually about.
 *
 * ONE rule for both paths, where this plane previously had two. The delta
 * path's carve-out said "the plane is REGISTRY-ONLY by construction there, so
 * both sides carry a real revision" - true at `@1.1` and FALSE at `@1.2`,
 * whose whole point is that `tuiUpsert` can now carry a cross-host replica.
 * A delta path still comparing revisions first is exactly the stale-replica
 * trap above, reached by the newer of the two routes.
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
         * Both paths take the SAME rule, and the merge that brought
         * `@1.2` here is why they no longer differ - see
         * {@link tuiAgentRowSupersedes}.
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
      // Passed through as it arrived. The row is already in its final shape
      // by the time it reaches this plane, and stamping it here would be
      // wrong in both directions now:
      //
      //  - From an `@1.1` host the fill has already happened, one layer down.
      //    `parseV11Frame` sets `docResident: false, origin: "registry"` on
      //    exactly this frame kind, and argues there why that is EXACT rather
      //    than a default. Re-stamping restates a decision that is no longer
      //    ours to make.
      //  - From an `@1.2` host the record is a real union arm carrying its own
      //    authority. `cloud` has no `docResident` AT ALL - deliberately, a
      //    replica is not addressable through the registry affordances - so a
      //    blanket stamp does not type, and forcing `false` onto a `doc` or
      //    `registry` arm would overwrite what the wire actually said.
      //
      // The old rationale here ("the delta plane is REGISTRY-ONLY by
      // construction") was true at `@1.1` and is false at `@1.2`, whose whole
      // point is that `tuiUpsert` can carry a cross-host replica - the same
      // premise that {@link tuiAgentRowSupersedes} had to stop relying on.
      return published(table.applyUpsert(delta.record));
    },

    republishForCurrentUser: () => published(table.republish()),

    servesNodeToViewer: (nodeId, currentUserId) =>
      table.servesNodeToViewer(nodeId, currentUserId),
  };
}
