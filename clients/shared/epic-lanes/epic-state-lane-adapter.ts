/**
 * The `epic.state.subscribe@1.0` adapter - the records lane's decode half.
 *
 * It turns one server frame into one burst of decoded events and emits them.
 * It never touches a projection, a store, or React, and it holds no row state
 * of its own: the replica decides what may be applied and the runtime sequences
 * planes against each other. That is what makes a captured frame log replayable
 * through the real replicas with no host attached.
 *
 * ## The resume cursor is READ, never remembered
 *
 * `resumeOffer()` reads {@link EpicStateLaneAdapterSources.readAppliedCursor}
 * and returns what that says. The adapter deliberately does not keep its own
 * "last frame I delivered" counter, because the cursor a client may offer is
 * the furthest point it has APPLIED - never the furthest it has RECEIVED. An
 * adapter-held counter would advance on a delta the replica then ignored (a
 * stale revision, an absorbed tombstone, a torn apply), and the next resume
 * would ask the host to continue from work this client did not finish. The
 * contract states the same rule on the delta frame: persist the position "once
 * the envelope is fully applied - never before".
 *
 * ## Lane strip and stamp
 *
 * The wire carries no `lane` field - the lane IS the method, each its own
 * cursor domain, and there is nothing on the wire to tempt a consumer into
 * comparing two lanes' positions. The client-side `LaneCursor` does carry one,
 * because the runtime holds several lanes' cursors in one structure. So this
 * adapter STRIPS `lane` when it builds the wire `resume` and STAMPS it back
 * when it builds a cursor out of an ingested frame. Both halves are here and
 * nowhere else.
 *
 * ## What this adapter does NOT decide
 *
 * A `delta` is emitted with the epoch the frame carried, verbatim, even when
 * that epoch is not the one the previous frame carried. The replica's own
 * epoch check answers `"requires-replacement"` for it, and the runtime drives
 * the rebuild. Enforcing the epoch here as well would put the same invariant in
 * two places, where it would be enforced twice and eventually only once - and
 * it would let the adapter fabricate a replacement request for a frame the host
 * is about to correct with the snapshot it always sends on an epoch change.
 *
 * The two cases the adapter DOES act on are the ones only it can see, because
 * they are statements about the SUBSCRIPTION rather than about the data: the
 * snapshot `basis`, and the transport's status.
 */
import type {
  AdapterDescriptor,
  AdapterDetachReason,
  AdapterHost,
  LaneAdapter,
  LaneCursor,
  RecordChange,
  RecordRow,
  ResumeOffer,
  SeedTrust,
} from "@traycer-clients/shared/replica-runtime";
import { createGenerationGuard } from "@traycer-clients/shared/replica-runtime";
import type {
  EpicStateDeltaFrame,
  EpicStateResumedFrame,
  EpicStateSnapshotFrame,
  EpicStateStreamCallbacks,
  EpicStateTrustChangedFrame,
} from "@traycer-clients/shared/host-transport/epic-state-stream-client";
import type { EpicLaneCursor } from "@traycer/protocol/host/epic/lane-cursor";
import {
  ARTIFACT_TOMBSTONE_REMOVE_REASON,
  COMMENT_THREAD_REMOVE_REASON,
  EPIC_META_ROW_ID,
  ROLE_CLAIMS_ROW_ID,
  artifactRowId,
  artifactTombstoneRowId,
  commentThreadRowId,
  type EpicStateRow,
} from "./epic-state-rows";
import { EPIC_STATE_LANE_ID, type EpicStateLaneEvent } from "./lane-events";

/**
 * The subset of the state lane's stream client this adapter drives. Narrowed at
 * the seam so a test double has a small, explicit surface to satisfy.
 */
export interface EpicStateLaneStreamClient {
  close(): void;
}

/**
 * Factory contract for the stream-client layer. Production wires this to
 * `new EpicStateStreamClient({ wsStreamClient, epicId, resumeProvider,
 * callbacks })`; tests pass a fake that invokes the callbacks on their own
 * schedule so the adapter's behaviour can be asserted without network I/O.
 */
export type EpicStateStreamClientFactory = (
  epicId: string,
  callbacks: EpicStateStreamCallbacks,
  /**
   * The wire-shaped resume offer, re-read before every wire subscribe
   * including the re-declare that follows a physical reconnect - so it must
   * stay a live read, never a captured value.
   */
  resumeProvider: () => EpicLaneCursor | null,
) => EpicStateLaneStreamClient;

const EPIC_STATE_DESCRIPTOR: AdapterDescriptor = {
  laneId: EPIC_STATE_LANE_ID,
  kind: "lane",
  label: "epic.state.subscribe@1.0 (records lane)",
};

export interface EpicStateLaneAdapterSources {
  readonly epicId: string;
  readonly streamClientFactory: EpicStateStreamClientFactory;
  /**
   * The furthest point on this lane the consumer has APPLIED, or `null` when
   * it holds nothing. Pure and synchronous by contract: it is invoked
   * immediately before every wire subscribe and must not create transport or
   * application state as a side effect.
   */
  readonly readAppliedCursor: () => LaneCursor | null;
  readonly isDisposed: () => boolean;
}

export interface EpicStateLaneAdapter extends LaneAdapter<EpicStateLaneEvent> {
  /**
   * Close the socket and retire the current generation, keeping the host
   * binding so a later {@link openTransport} resumes decoding into the same
   * runtime.
   *
   * Split from {@link openTransport} for the same reason the `@1` adapter
   * splits them: a locally requested reseed has to close BEFORE it discards
   * the replica and open AFTER, because the re-subscribe reads the resume
   * cursor and a cursor read before the discard would name state the client no
   * longer holds.
   */
  closeTransport(): void;
  openTransport(): void;
}

export function createEpicStateLaneAdapter(
  sources: EpicStateLaneAdapterSources,
): EpicStateLaneAdapter {
  const { epicId, streamClientFactory, readAppliedCursor, isDisposed } =
    sources;

  const guard = createGenerationGuard();
  let host: AdapterHost<EpicStateLaneEvent> | null = null;
  let client: EpicStateLaneStreamClient | null = null;
  /**
   * Whether this attachment has already delivered a lead frame.
   *
   * The only piece of state the adapter keeps, and it exists for one decision:
   * a snapshot is the FIRST view of the epic (`"initial"`) or a replacement of
   * one the consumer already had (`"reseed"`). The replica logs and reports
   * those differently, and neither the frame nor the cursor says which - a
   * cold-basis snapshot is reachable mid-attachment whenever the consumer's
   * applied cursor went back to `null`.
   */
  let leadDelivered = false;

  function closeStreamClient(): void {
    if (client === null) return;
    const active = client;
    client = null;
    active.close();
  }

  /**
   * One `if` in one place, instead of once per callback - the same guard the
   * `@1` adapter hoisted out of thirty hand-written copies. The bug it prevents
   * (a superseded socket's frame written into the live replica) returns the
   * moment someone adds a callback and forgets the line.
   */
  function accepts(generation: number): boolean {
    if (isDisposed()) return false;
    if (!guard.isCurrent(generation)) return false;
    return host !== null;
  }

  /** Stamp: a wire position becomes a client cursor by gaining its lane. */
  function cursorAt(authorityEpoch: string, position: number): LaneCursor {
    return { authorityEpoch, lane: EPIC_STATE_LANE_ID, position };
  }

  /**
   * The wire's boolean as the seam's named state.
   *
   * `false` is not an error and not a degraded mode - the host serving from its
   * own replica ahead of a cloud reconcile is the design. What the label gates
   * is what the client may CLAIM, and the named form is what stops a consumer
   * writing `if (!trust)` for a fact with three possible answers once `null`
   * (an adapter that cannot tell) is in the picture.
   */
  function trustOf(reconciledWithCloud: boolean): SeedTrust {
    return reconciledWithCloud ? "reconciled-with-cloud" : "seed-only";
  }

  function currentOffer(): ResumeOffer {
    const cursor = readAppliedCursor();
    if (cursor === null) return null;
    if (cursor.lane !== EPIC_STATE_LANE_ID) {
      // A cursor for a different lane is a wiring error, and the safe answer is
      // to offer nothing: the cost is one full snapshot, where offering it
      // would ask the host to resume this lane from a position minted in
      // another cursor domain.
      return null;
    }
    return { kind: "cursor", cursor };
  }

  /** Strip: the client cursor loses its lane on the way to the wire. */
  function wireResume(): EpicLaneCursor | null {
    const offer = currentOffer();
    if (offer === null || offer.kind !== "cursor") return null;
    return {
      authorityEpoch: offer.cursor.authorityEpoch,
      position: offer.cursor.position,
    };
  }

  function snapshotRows(
    frame: EpicStateSnapshotFrame,
  ): readonly RecordRow<EpicStateRow>[] {
    const rows: RecordRow<EpicStateRow>[] = [];
    for (const record of frame.artifactRecords) {
      rows.push({
        rowId: artifactRowId(record.id),
        revision: record.revision,
        row: { kind: "artifact", record },
      });
    }
    for (const record of frame.deletedArtifacts) {
      rows.push({
        rowId: artifactTombstoneRowId(record.id),
        revision: record.revision,
        row: { kind: "artifact-tombstone", record },
      });
    }
    for (const record of frame.commentThreads) {
      rows.push({
        rowId: commentThreadRowId(record.artifactId, record.threadId),
        revision: record.revision,
        row: { kind: "comment-thread", record },
      });
    }
    // Always present, even when empty: an epic with no claims is a fact the
    // snapshot states, and omitting the row would leave a stale claim set from
    // a previous epoch renderable after a replacement the snapshot exists to
    // announce.
    rows.push({
      rowId: ROLE_CLAIMS_ROW_ID,
      revision: frame.roleClaims.revision,
      row: { kind: "role-claims", claims: frame.roleClaims.claims },
    });
    // WHOLE here, patch on a delta - see `EpicStateRow`. A snapshot restates
    // the metadata in full, so installing it wholesale is correct and merging
    // would retain a title the host has since forgotten.
    rows.push({
      rowId: EPIC_META_ROW_ID,
      revision: frame.epicMeta.revision,
      row: { kind: "epic-meta", meta: frame.epicMeta.meta },
    });
    return rows;
  }

  function deltaChanges(
    frame: EpicStateDeltaFrame,
  ): readonly RecordChange<EpicStateRow>[] {
    const changes: RecordChange<EpicStateRow>[] = [];
    for (const record of frame.artifactUpserts) {
      changes.push({
        kind: "upsert",
        row: {
          rowId: artifactRowId(record.id),
          revision: record.revision,
          row: { kind: "artifact", record },
        },
      });
    }
    for (const record of frame.artifactTombstones) {
      // Both halves of one tombstone, in one envelope: the live row goes away
      // terminally, and the deleted-artifact affordance keeps its payload. See
      // `epic-state-rows.ts` for why these are two key spaces.
      changes.push({
        kind: "remove",
        rowId: artifactRowId(record.id),
        revision: record.revision,
        reason: ARTIFACT_TOMBSTONE_REMOVE_REASON,
      });
      changes.push({
        kind: "upsert",
        row: {
          rowId: artifactTombstoneRowId(record.id),
          revision: record.revision,
          row: { kind: "artifact-tombstone", record },
        },
      });
    }
    for (const record of frame.commentThreadUpserts) {
      changes.push({
        kind: "upsert",
        row: {
          rowId: commentThreadRowId(record.artifactId, record.threadId),
          revision: record.revision,
          row: { kind: "comment-thread", record },
        },
      });
    }
    for (const removal of frame.commentThreadRemovals) {
      changes.push({
        kind: "remove",
        rowId: commentThreadRowId(removal.artifactId, removal.threadId),
        revision: removal.revision,
        reason: COMMENT_THREAD_REMOVE_REASON,
      });
    }
    const roleClaims = frame.roleClaims;
    if (roleClaims !== null) {
      changes.push({
        kind: "upsert",
        row: {
          rowId: ROLE_CLAIMS_ROW_ID,
          revision: roleClaims.revision,
          row: { kind: "role-claims", claims: roleClaims.claims },
        },
      });
    }
    const epicMeta = frame.epicMeta;
    if (epicMeta !== null) {
      // A PATCH row, not a whole one: `meta` here carries only the fields this
      // commit changed, and a consumer that replaced with it would drop the
      // field the host deliberately did not restate.
      changes.push({
        kind: "upsert",
        row: {
          rowId: EPIC_META_ROW_ID,
          revision: epicMeta.revision,
          row: { kind: "epic-meta-patch", meta: epicMeta.meta },
        },
      });
    }
    return changes;
  }

  function buildCallbacks(generation: number): EpicStateStreamCallbacks {
    const emit = (event: EpicStateLaneEvent): void => {
      if (!accepts(generation)) return;
      host?.emit(event);
    };
    return {
      onSnapshot: (frame: EpicStateSnapshotFrame) => {
        if (!accepts(generation)) return;
        const watermark = cursorAt(frame.authorityEpoch, frame.position);
        // Reported BEFORE the rows, and through `reportResume` rather than as
        // an event, because it is a statement about the SUBSCRIPTION: a
        // `"reseeded"` outcome has to be visible to the runtime even when the
        // snapshot that follows is byte-identical to what the replica already
        // held.
        host?.reportResume({
          kind: "reseeded",
          reason:
            frame.basis === "cold"
              ? "no-offer"
              : frame.basis === "resumeTooOld"
                ? "resume-too-old"
                : "epoch-changed",
          // The snapshot's own high-water mark, carried on the frame rather
          // than inferred from the first delta: a quiet epic may never send
          // one, and a client that had to wait for a delta to learn its own
          // cursor could not persist a resume point at all.
          watermark,
        });
        // Only the two FAILURE bases ask for a rebuild, and they ask for
        // different amounts of discarding - which is the whole reason the
        // contract distinguishes them. `resumeTooOld` keeps the replica's
        // identity, so per-artifact body state stays valid and only the row set
        // re-seeds; `authorityEpochChanged` voids everything, bodies included.
        // A `cold` basis asks for nothing: the client offered nothing, so
        // there is nothing to replace, and requesting one here would be a
        // fabricated authority-side event on the most ordinary path there is.
        if (frame.basis === "resumeTooOld") {
          host?.requestReplacement("resume-too-old");
        } else if (frame.basis === "authorityEpochChanged") {
          host?.requestReplacement("authority-epoch-changed");
        }
        emit({
          kind: "record-snapshot",
          watermark,
          rows: snapshotRows(frame),
          trust: trustOf(frame.reconciledWithCloud),
          cause: leadDelivered ? "reseed" : "initial",
        });
        leadDelivered = true;
      },
      onResumed: (frame: EpicStateResumedFrame) => {
        if (!accepts(generation)) return;
        // The acknowledgement exists so that "your cursor was accepted and
        // nothing has happened since" is a STATEMENT rather than an absence.
        // No ROWS are emitted: the consumer keeps every one it holds.
        host?.reportResume({
          kind: "resumed",
          from: cursorAt(frame.authorityEpoch, frame.position),
        });
        // Trust IS emitted, and it is the one thing a resume cannot let the
        // client carry over. Rows are row state and survive the gap by
        // definition; trust describes the SERVING HOST'S replica, which may
        // have restarted seed-only since the cursor was persisted. A client
        // that kept its old value would resume believing it is reconciled
        // against a host that is not - the dangerous direction of exactly the
        // bug the trust transition exists to fix.
        emit({
          kind: "record-trust",
          authorityEpoch: frame.authorityEpoch,
          trust: trustOf(frame.reconciledWithCloud),
        });
        leadDelivered = true;
      },
      onDelta: (frame: EpicStateDeltaFrame) => {
        if (!accepts(generation)) return;
        // Unconditional, and safe to be so: the contract refuses a delta that
        // carries no change at all (an empty envelope would consume a lane
        // position for a commit that never happened), and every one of the six
        // change fields maps to a row here - including `epicMeta`, which is a
        // revisioned row rather than a special case.
        emit({
          kind: "record-transaction",
          cursor: cursorAt(frame.authorityEpoch, frame.seq),
          changes: deltaChanges(frame),
          // Cross-lane atomicity is exceptional and must be NAMED. One
          // envelope on one lane already carries every affected row together,
          // so there is nothing here for a barrier to tie.
          barrier: null,
        });
      },
      onTrustChanged: (frame: EpicStateTrustChangedFrame) => {
        // No rows changed, which is exactly why this frame exists: a background
        // reconcile that finds the local replica already correct commits
        // nothing, so there is no envelope to carry the fact and no honest
        // `basis` for a re-snapshot. Without it a seed-served client labels its
        // data stale for the life of the subscription.
        emit({
          kind: "record-trust",
          authorityEpoch: frame.authorityEpoch,
          trust: trustOf(frame.reconciledWithCloud),
        });
      },
      onConnectionStatus: (status, reason) => {
        if (!accepts(generation)) return;
        host?.reportStatus({
          connection: status,
          closeReason: status === "closed" ? reason : null,
        });
      },
    };
  }

  function openStreamClient(): void {
    const generation = guard.next();
    client = streamClientFactory(
      epicId,
      buildCallbacks(generation),
      wireResume,
    );
  }

  return {
    descriptor: EPIC_STATE_DESCRIPTOR,

    attach(nextHost: AdapterHost<EpicStateLaneEvent>): void {
      host = nextHost;
      openStreamClient();
    },

    resumeOffer: currentOffer,

    detach(_reason: AdapterDetachReason): void {
      // Retire the generation FIRST: `close()` can synchronously deliver a
      // final status frame, and a frame stamped with a generation the guard has
      // already moved past is inert by construction rather than by luck.
      guard.next();
      host = null;
      leadDelivered = false;
      closeStreamClient();
    },

    closeTransport(): void {
      guard.next();
      closeStreamClient();
    },

    openTransport(): void {
      openStreamClient();
    },
  };
}
