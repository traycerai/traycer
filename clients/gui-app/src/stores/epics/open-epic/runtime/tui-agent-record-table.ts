/**
 * The host's registry-backed terminal-agent rows - the terminal twin of
 * `chat-record-table.ts`, and now literally the same reconciliation: both
 * planes are configurations of {@link createRecordTable}, which owns the fence,
 * the per-row revision guard, the absorbing retractions and the change gate.
 *
 * The differences that kept the two implementations apart through the
 * extraction survive as declarations rather than as a second copy of the
 * algorithm: this plane waives the revision guard for doc-over-doc, and has no
 * pending-creation registry. Each is argued below, at the point that holds it.
 *
 * Keying is no longer one of them. This plane keyed rows by id alone until the
 * chat table's owner-collision fix showed the argument for it did not survive
 * an account switch - see the `rowKey` declaration below.
 */
import type { ChatRecordRemovalReason } from "@traycer/protocol/host/epic/chat-records";
import type { RecordListRecencyPatch } from "@traycer/protocol/host/epic/record-list-revision";
import type { TuiAgentRecordSummaryV13 } from "@traycer/protocol/host/epic/tui-agent-records";
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
  /**
   * The terminal twin of the chat table's - see
   * {@link RecordTable.snapshotIncompleteSeq}.
   */
  snapshotIncompleteSeq(): number;
  /**
   * The `@1.3` row, which is the `@1.2` row plus the SESSION FACET
   * (`sessionState` / `lastExit`). Typed up to it rather than left at `@1.2`
   * so the facet survives in the retained rows: a reaped agent reads as asleep
   * and resumable, and a type that dropped the two keys would leave the
   * sidebar and the tile with no way to say so.
   */
  applyRecords(
    records: readonly TuiAgentRecordSummaryV13[],
    issuedAtSeq: number | null,
  ): TuiAgentRecordPublication | null;
  /**
   * The recency patches an `unchanged` list answer carried - the terminal twin
   * of the chat table's, with the same contract: the recency pair only, under
   * the strictly-exceeds rule, dropped for a row this table does not hold.
   */
  applyTouches(
    patches: readonly RecordListRecencyPatch[],
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
  candidate: TuiAgentRecordSummaryV13,
  held: TuiAgentRecordSummaryV13,
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

  const table: RecordTable<TuiAgentRecordSummaryV13, TerminalAgentsSlice> =
    createRecordTable<TuiAgentRecordSummaryV13, TerminalAgentsSlice>(
      {
        /**
         * Keyed by `(ownerUserId, tuiAgentId)`, exactly as the chat table is,
         * and for the reason that table's own key comment gives.
         *
         * This previously keyed by `tuiAgentId` alone, on the argument that
         * the host serves the CALLER'S OWN rows only (terminal agents are
         * owner-private per the `epic.listTuiAgents` contract), so within one
         * viewer's answer the id is unambiguous. That argument is true and
         * insufficient, and the old comment named the gap without closing it:
         * rows are RETAINED across an account switch, so the map spans answers
         * to two different viewers even though each answer was unambiguous on
         * its own.
         *
         * What that costs, once the ids collide: `tuiAgentRowSupersedes` falls
         * through to `candidate.revision > held.revision` for two local rows,
         * and the two accounts' revision streams are independent - so a
         * legitimate row whose revision is not greater than the retained
         * stranger's is REJECTED, while `isVisibleToUser` hides the retained
         * one from the new viewer. The agent is simply absent for the rest of
         * the session, with no frame able to correct it.
         *
         * Reachable because the ids are host-minted per account, not globally
         * unique by construction - the same shape of collision the chat table
         * was keyed against in this PR, on the plane its own header calls "the
         * terminal twin".
         */
        rowKey: (row) => ownerScopedRowKey(row.ownerUserId, row.tuiAgentId),
        /**
         * The BARE id, deliberately not the composite `rowKey` above: a
         * `tuiRemove` frame carries `(epicId, tuiAgentId)` and no owner at all,
         * so the retraction map has to be addressed at the coarseness the wire
         * actually speaks. The chat table draws the same line for the same
         * reason - retained rows are owner-scoped, removals are not.
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
        recency: {
          // The patch addresses the same owner-scoped identity the rows are
          // keyed by - `id` on the wire is this plane's `tuiAgentId`.
          rowKeyOfPatch: (patch) =>
            ownerScopedRowKey(patch.ownerUserId, patch.id),
          revisionOf: (row) => row.revision,
          /**
           * `origin` and the SESSION FACET are untouched, deliberately. A
           * patch is a registry quiet write and reports neither: re-stamping
           * `origin` would move the row between planes on an answer that never
           * mentioned it (and {@link tuiAgentRowSupersedes} reads authority
           * first for exactly that reason), and blanking `sessionState` would
           * report a sleeping agent as unknown every time it emits a token.
           *
           * `revision` is untouched too, and that one is the shared table's
           * rule rather than this plane's: it describes the row's CONTENT,
           * which a quiet write did not move. See `record-table.ts`'s module
           * doc.
           */
          withPatch: (row, patch) => ({ ...row, updatedAt: patch.updatedAt }),
        },
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
    snapshotIncompleteSeq: () => table.snapshotIncompleteSeq(),

    applyRecords: (records, issuedAtSeq) =>
      published(table.applySnapshot(records, issuedAtSeq)),

    applyTouches: (patches) => published(table.applyTouches(patches)),

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
      //
      // The SESSION FACET has two sources and they are not interchangeable.
      //
      // A `@1.4` frame STATES it (`delta.sessionFacet`), and that statement is
      // the point of the minor: a spawn or a reap moves nothing else on the
      // row, so a client that ignored it would learn an agent had gone to
      // sleep only at the next full snapshot - which under revision gating is
      // only ever fetched on a genuine gap, i.e. possibly never.
      //
      // Below `@1.4` the frame has no field for it (`null`), which is NOT the
      // row's own `null`: the latter means "the serving host cannot know", the
      // former means "this minor could not say". So carry forward what the
      // last ANSWER stated for this agent and admit ignorance when nothing
      // has, exactly as the chat twin does for `docResident`. Stamping `null`
      // instead would report a sleeping agent as unknown on every unrelated
      // rename until the next snapshot; read by the FULL record identity, not
      // off the published slice, for the reason that twin gives.
      //
      // One holder for both sources: a stated facet and a retained row answer
      // exactly these two questions, so the `??` picks the authority and the
      // reads below need no second branch. It short-circuits, so a `@1.4`
      // frame never looks the row up.
      //
      // On that carry-forward path the staleness is bounded to one poll
      // interval rather than to the session, WHEN the delta came from a live
      // write: that write moved the host's list revision, so the next gated
      // poll cannot answer `unchanged` and the snapshot it answers states the
      // facet. That is the same guarantee `snapshotIncompleteSeq` restores for
      // a fence-skipped row - see `record-table.ts`.
      //
      // One producer escapes the bound today: a BIND REPLAY re-emits rows
      // without incrementing the counter, so a carried-forward facet it
      // refreshes nothing for can outlive a poll. It is the pre-`@1.4` path
      // that is exposed - a `@1.4` replay states the facet outright - and the
      // host-side counter fix is in flight. Until it lands, treat the bound as
      // a property of live writes.
      const facet =
        delta.sessionFacet ??
        table.retainedRow(
          ownerScopedRowKey(delta.record.ownerUserId, delta.record.tuiAgentId),
        );
      return published(
        table.applyUpsert({
          ...delta.record,
          sessionState: facet === null ? null : facet.sessionState,
          lastExit: facet === null ? null : facet.lastExit,
        }),
      );
    },

    republishForCurrentUser: () => published(table.republish()),

    servesNodeToViewer: (nodeId, currentUserId) =>
      table.servesNodeToViewer(nodeId, currentUserId),
  };
}
