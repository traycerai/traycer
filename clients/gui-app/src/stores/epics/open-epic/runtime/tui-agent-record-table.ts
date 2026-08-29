/**
 * The host's registry-backed terminal-agent rows - the terminal twin of
 * `chat-record-table.ts`, with the same contract, the same fence, the same
 * absorbing retractions and the same change gate.
 *
 * Kept as a SEPARATE implementation rather than folded into a generic. The two
 * tables are one of the three copies of this algorithm the architecture calls
 * out, and collapsing them is a deliberate, separately-scoped change; doing it
 * inside a relocation would mean the move and the unification land as one diff,
 * with no point at which the behaviour is provably unchanged. They differ in
 * more than a type parameter today (owner keying, the doc-resident revision
 * carve-out, no pending-creation registry), and every one of those differences
 * has to be argued about on its own.
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

  let tuiAgentRecords: TerminalAgentsSlice = EMPTY_TERMINAL_AGENTS_SLICE;

  /**
   * The raw rows, keyed by `tuiAgentId` ALONE, unlike the chat table's: the
   * host serves the CALLER'S OWN rows only (terminal agents are structurally
   * owner-private, per the `epic.listTuiAgents` contract), so within one
   * viewer's answer the id is unambiguous. Rows are still retained regardless
   * of owner - a delta could in principle carry another identity's row after an
   * account switch - and the recompute below re-selects for the current user,
   * so the keying only has to be safe for what the host actually serves.
   */
  const rows = new Map<string, TuiAgentRecordSummaryV11>();

  /** Absorbing for the session, exactly as the chat table's is. */
  const retractions = new Map<string, ChatRecordRemovalReason>();

  /**
   * Local ingest order for the terminal-agent rows, and the watermark the last
   * `epic.listTuiAgents` answer left behind.
   *
   * `revision` orders two versions of ONE row; it says nothing about a row the
   * snapshot simply does not contain. That omission is the ambiguous case: a
   * list read issued before an agent was committed cannot carry it, and the
   * `tuiUpsert` that announced it can land while that read is still in flight.
   * Applying such a snapshot as clear-and-replace deletes the row it never had
   * a chance to see - precisely the A2A-created agent this whole channel exists
   * to surface - until the next 20s poll.
   *
   * So an omission is only allowed to retract a row that was already held when
   * the answer was issued. `rowSeq` stamps every accepted write with a
   * monotonic counter; the list hook reads that counter at dispatch and hands
   * it back with the answer as the fence, so a row ingested past it survives
   * that answer and an answer issued after the row landed retracts it at once -
   * a deletion missed while the stream was down is collected by the very next
   * read, not one read later. `snapshotFence` (where the counter stood after
   * the previous answer) is the fallback for an answer dispatched with no
   * session to read; it holds an omitted row for one extra pass. Retractions
   * are unaffected: `tuiRemove` is the explicit signal and stays absorbing.
   */
  const rowSeq = new Map<string, number>();
  let ingestSeq = 0;
  let snapshotFence = 0;

  /**
   * The ONE recompute, shared by the poll and the push, with the chat table's
   * ingest-time owner selection (retained rows make a user switch lossless) and
   * the same {@link terminalAgentSlicesEq} change gate.
   */
  function recompute(
    withRetractions: boolean,
  ): TuiAgentRecordPublication | null {
    const currentUserId = getCurrentUserId();
    // Provenance marks are captured at the one seam every terminal-agent
    // record write flows through, before the change gate can early-return.
    onBeforePublish();
    const visible: TuiAgentRecordSummaryV11[] = [];
    for (const row of rows.values()) {
      if (!isTerminalAgentVisibleToUser(row.ownerUserId, currentUserId)) {
        continue;
      }
      visible.push(row);
    }
    const next = tuiAgentRecordsSlice(visible);
    const nextSlice =
      next.allIds.length === 0 ? EMPTY_TERMINAL_AGENTS_SLICE : next;
    if (!withRetractions && terminalAgentSlicesEq(tuiAgentRecords, nextSlice)) {
      return null;
    }
    tuiAgentRecords = nextSlice;
    return {
      tuiAgentRecords: nextSlice,
      tuiAgentRetractions: withRetractions
        ? Object.fromEntries(retractions)
        : null,
    };
  }

  return {
    current: () => tuiAgentRecords,
    ingestSeq: () => ingestSeq,

    applyRecords(records, issuedAtSeq) {
      const served = new Map<string, TuiAgentRecordSummaryV11>();
      for (const row of records) {
        // A retracted agent never comes back through the poll: the list read is
        // a snapshot of the host's registry and the host applies a removal
        // before it emits one, so a response still carrying the row was issued
        // before the retraction.
        if (retractions.has(row.tuiAgentId)) continue;
        served.set(row.tuiAgentId, row);
      }
      // Omissions first, against the fence - see `rowSeq`. A row this answer
      // does not carry is dropped only if it was already held when the answer
      // was ISSUED; anything ingested since then is newer than the snapshot by
      // construction and survives it. The request-time counter is the exact
      // fence; the previous answer's watermark is the fallback when none was
      // captured.
      const fence = issuedAtSeq ?? snapshotFence;
      for (const id of [...rows.keys()]) {
        if (served.has(id)) continue;
        if ((rowSeq.get(id) ?? 0) > fence) continue;
        rows.delete(id);
        rowSeq.delete(id);
      }
      for (const [id, row] of served) {
        const held = rows.get(id);
        // The same monotonic-`revision` test the delta path applies, for the
        // same reason and in the same direction: a snapshot row that does not
        // strictly exceed what is held is an older version of that row, and
        // overwriting with it would regress a push the client has already
        // shown.
        //
        // EXCEPT doc-resident over doc-resident, which the test cannot judge. A
        // doc row has no registry seq to carry, so it ships at `revision: 0` on
        // EVERY answer - `0 <= 0` would reject each refresh and freeze that
        // agent at whatever the first answer of the session said, for the life
        // of the session. Under `@2` that row is its only source, so the freeze
        // hides a peer-host rename, reparent and archive alike.
        //
        // Narrow, and in one direction only. The guard still applies the moment
        // either side is registry-backed: a doc row at 0 can never clobber an
        // adopted registry row (`0 <= n`), and an adopted row still replaces the
        // frozen copy (`n <= 0` is false). What is waived is only the comparison
        // between two rows that both carry a placeholder, where the later answer
        // is newer by construction because it is a fresher read of the same map.
        if (held !== undefined) {
          const bothDocResident = held.docResident && row.docResident;
          if (!bothDocResident && row.revision <= held.revision) continue;
        }
        rows.set(id, row);
        ingestSeq += 1;
        rowSeq.set(id, ingestSeq);
      }
      snapshotFence = ingestSeq;
      return recompute(false);
    },

    applyDelta(delta) {
      if (delta.kind === "tuiRemove") {
        const hadRow = rows.delete(delta.tuiAgentId);
        rowSeq.delete(delta.tuiAgentId);
        // Idempotent: a redelivered removal for the same reason is not a state
        // change, and re-publishing on it would re-project the epic for
        // nothing.
        if (retractions.get(delta.tuiAgentId) === delta.reason && !hadRow) {
          return null;
        }
        retractions.set(delta.tuiAgentId, delta.reason);
        return recompute(true);
      }
      const { record } = delta;
      // Removal is TERMINAL AND ABSORBING - no later upsert resurrects the row
      // here.
      if (retractions.has(record.tuiAgentId)) return null;
      const held = rows.get(record.tuiAgentId);
      // The staleness test: `revision` is per-record monotonic and the only
      // ordering fact on a row, so a delta that does not strictly exceed what
      // is held is a replay, a reorder or a duplicate.
      if (held !== undefined && record.revision <= held.revision) return null;
      // The delta plane is REGISTRY-ONLY by construction - a doc-resident agent
      // has no registry row, so it can never produce a delta. So `false` here
      // is a fact about the source, not a filled-in default.
      //
      // It is also what makes ADOPTION converge through the staleness test
      // above: `epic.listTuiAgents@1.1` serves a frozen doc row at
      // `revision: 0`, so the first real delta after that agent's binding host
      // upgrades and the sweep imports it strictly exceeds 0 and replaces the
      // frozen copy in place.
      rows.set(record.tuiAgentId, { ...record, docResident: false });
      // Past the fence the last snapshot left: an `epic.listTuiAgents` answer
      // already in flight cannot carry this row, so its omission must not
      // delete it.
      ingestSeq += 1;
      rowSeq.set(record.tuiAgentId, ingestSeq);
      return recompute(false);
    },

    republishForCurrentUser() {
      return recompute(false);
    },

    servesNodeToViewer(nodeId, currentUserId) {
      const row = rows.get(nodeId);
      if (row === undefined) return false;
      return isTerminalAgentVisibleToUser(row.ownerUserId, currentUserId);
    },
  };
}
