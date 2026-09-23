/**
 * The `agentIdentity.state.subscribe@1.0` adapter - an identity's INDEX lane,
 * decode half.
 *
 * It turns one server frame into one burst of decoded events and emits them. It
 * never touches a projection, a store, or React, and it holds no row state of
 * its own: the replica decides what may be applied and the runtime sequences
 * planes against each other. That is what makes a captured frame log replayable
 * through the real replicas with no host attached.
 *
 * The epic records lane's adapter, one container over, and the reasoning below
 * is deliberately the same reasoning - the two lanes carry the same CLASS of
 * thing (server-arbitrated, revisioned rows on one ordered channel), so a rule
 * that holds for one holds for the other. What does not transfer is the address
 * and the populations, which is why this is a sibling rather than a generic.
 *
 * ## The resume cursor is READ, never remembered
 *
 * `resumeOffer()` reads {@link IdentityStateLaneAdapterSources.readAppliedCursor}
 * and returns what that says. The adapter deliberately does not keep its own
 * "last frame I delivered" counter, because the cursor a client may offer is the
 * furthest point it has APPLIED - never the furthest it has RECEIVED. An
 * adapter-held counter would advance on a delta the replica then ignored (a
 * stale revision, an absorbed tombstone, a torn apply), and the next resume would
 * ask the host to continue from work this client did not finish. The contract
 * states the same rule on the delta frame: persist the position "once the
 * envelope is fully applied - never before".
 *
 * ## Lane strip and stamp
 *
 * The wire carries no `lane` field - the lane IS the method, each its own cursor
 * domain. The client-side `LaneCursor` does carry one, because the runtime holds
 * several lanes' cursors in one structure, and here it must also name the
 * IDENTITY: a session may hold two identities open, and their positions are
 * unrelated. So this adapter STRIPS `lane` when it builds the wire `resume` and
 * STAMPS it back when it builds a cursor out of an ingested frame. Both halves
 * are here and nowhere else.
 *
 * ## What this adapter does NOT decide
 *
 * A `delta` is emitted with the epoch the frame carried, verbatim, even when that
 * epoch is not the one the previous frame carried. The replica's own epoch check
 * answers `"requires-replacement"` for it, and the runtime drives the rebuild.
 * Enforcing the epoch here as well would put the same invariant in two places,
 * where it would be enforced twice and eventually only once - and it would let
 * the adapter fabricate a replacement request for a frame the host is about to
 * correct with the snapshot it always sends on an epoch change.
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
import {
  authorityEpochTransition,
  createGenerationGuard,
  resumeTooOldTransition,
} from "@traycer-clients/shared/replica-runtime";
import type {
  IdentityStateDeltaFrame,
  IdentityStateHostStateFrame,
  IdentityStateResumedFrame,
  IdentityStateSnapshotFrame,
  IdentityStateStreamCallbacks,
} from "@traycer-clients/shared/host-transport/identity-state-stream-client";
import type { EpicLaneCursor } from "@traycer/protocol/host/epic/lane-cursor";
import {
  IDENTITY_RECORD_ROW_ID,
  IDENTITY_ROW_REMOVE_REASON,
  identityDocumentRowId,
  identityFileRowId,
  identityRowIdFor,
  type IdentityStateRow,
} from "./identity-state-rows";
import {
  identityStateLaneId,
  type IdentityStateLaneEvent,
} from "./lane-events";

/**
 * The subset of the index lane's stream client this adapter drives. Narrowed at
 * the seam so a test double has a small, explicit surface to satisfy.
 */
export interface IdentityStateLaneStreamClient {
  close(): void;
}

/**
 * Factory contract for the stream-client layer. Production wires this to
 * `new IdentityStateStreamClient({ wsStreamClient, identityId, resumeProvider,
 * callbacks })`; tests pass a fake that invokes the callbacks on their own
 * schedule so the adapter's behaviour can be asserted without network I/O.
 */
export type IdentityStateStreamClientFactory = (
  identityId: string,
  callbacks: IdentityStateStreamCallbacks,
  /**
   * The wire-shaped resume offer, re-read before every wire subscribe including
   * the re-declare that follows a physical reconnect - so it must stay a live
   * read, never a captured value.
   */
  resumeProvider: () => EpicLaneCursor | null,
) => IdentityStateLaneStreamClient;

export interface IdentityStateLaneAdapterSources {
  readonly identityId: string;
  readonly streamClientFactory: IdentityStateStreamClientFactory;
  /**
   * The furthest point on this lane the consumer has APPLIED, or `null` when it
   * holds nothing. Pure and synchronous by contract: it is invoked immediately
   * before every wire subscribe and must not create transport or application
   * state as a side effect.
   */
  readonly readAppliedCursor: () => LaneCursor | null;
  readonly isDisposed: () => boolean;
}

export interface IdentityStateLaneAdapter extends LaneAdapter<IdentityStateLaneEvent> {
  /**
   * Close the socket and retire the current generation, keeping the host binding
   * so a later {@link openTransport} resumes decoding into the same runtime.
   *
   * Split from {@link openTransport} for the reason the epic lanes split them: a
   * locally requested reseed has to close BEFORE it discards the replica and
   * open AFTER, because the re-subscribe reads the resume cursor and a cursor
   * read before the discard would name state the client no longer holds.
   */
  closeTransport(): void;
  openTransport(): void;
}

export function createIdentityStateLaneAdapter(
  sources: IdentityStateLaneAdapterSources,
): IdentityStateLaneAdapter {
  const { identityId, streamClientFactory, readAppliedCursor, isDisposed } =
    sources;

  const laneId = identityStateLaneId(identityId);
  const descriptor: AdapterDescriptor = {
    laneId,
    kind: "lane",
    label: `agentIdentity.state.subscribe@1.0 (identity ${identityId})`,
  };

  const guard = createGenerationGuard();
  let host: AdapterHost<IdentityStateLaneEvent> | null = null;
  let client: IdentityStateLaneStreamClient | null = null;
  /**
   * Whether this attachment has already delivered a lead frame.
   *
   * The only piece of state the adapter keeps, and it exists for one decision: a
   * snapshot is the FIRST view of the identity (`"initial"`) or a replacement of
   * one the consumer already had (`"reseed"`). The replica logs and reports those
   * differently, and neither the frame nor the cursor says which - a cold-basis
   * snapshot is reachable mid-attachment whenever the consumer's applied cursor
   * went back to `null`.
   */
  let leadDelivered = false;

  function closeStreamClient(): void {
    if (client === null) return;
    const active = client;
    client = null;
    active.close();
  }

  /**
   * One `if` in one place, instead of once per callback. The bug it prevents (a
   * superseded socket's frame written into the live replica) returns the moment
   * someone adds a callback and forgets the line.
   */
  function accepts(generation: number): boolean {
    if (isDisposed()) return false;
    if (!guard.isCurrent(generation)) return false;
    return host !== null;
  }

  /** Stamp: a wire position becomes a client cursor by gaining its lane. */
  function cursorAt(authorityEpoch: string, position: number): LaneCursor {
    return { authorityEpoch, lane: laneId, position };
  }

  /**
   * The wire's boolean as the seam's named state.
   *
   * `false` is not an error and not a degraded mode - the host serving from its
   * own replica ahead of a cloud reconcile is the design. What the label gates is
   * what the client may CLAIM, and the named form is what stops a consumer
   * writing `if (!trust)` for a fact with three possible answers once `null` (an
   * adapter that cannot tell) is in the picture.
   */
  function trustOf(reconciledWithCloud: boolean): SeedTrust {
    return reconciledWithCloud ? "reconciled-with-cloud" : "seed-only";
  }

  function currentOffer(): ResumeOffer {
    const cursor = readAppliedCursor();
    if (cursor === null) return null;
    if (cursor.lane !== laneId) {
      // A cursor for a different lane is a wiring error, and the safe answer is
      // to offer nothing: the cost is one full snapshot, where offering it would
      // ask the host to resume this lane from a position minted in another
      // cursor domain - which here includes ANOTHER IDENTITY'S index, since the
      // lane id is what carries the identity.
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
    frame: IdentityStateSnapshotFrame,
  ): readonly RecordRow<IdentityStateRow>[] {
    const rows: RecordRow<IdentityStateRow>[] = [];
    // WHOLE here, patch on a delta - see `IdentityStateRow`. A snapshot restates
    // the settings in full, so installing it wholesale is correct and merging
    // would retain a description the host has since forgotten.
    rows.push({
      rowId: IDENTITY_RECORD_ROW_ID,
      revision: frame.identity.revision,
      row: { kind: "identity", identity: frame.identity.identity },
    });
    for (const row of frame.documents) {
      rows.push({
        rowId: identityDocumentRowId(row.path, row.incarnation),
        revision: row.revision,
        row: { kind: "document", row },
      });
    }
    for (const row of frame.files) {
      rows.push({
        rowId: identityFileRowId(row.path, row.incarnation),
        revision: row.revision,
        row: { kind: "file", row },
      });
    }
    return rows;
  }

  function deltaChanges(
    frame: IdentityStateDeltaFrame,
  ): readonly RecordChange<IdentityStateRow>[] {
    const changes: RecordChange<IdentityStateRow>[] = [];
    const identity = frame.identity;
    if (identity !== null) {
      // A PATCH row, not a whole one: `identity` here carries only the fields
      // this commit changed, and a consumer that replaced with it would drop the
      // field the host deliberately did not restate.
      changes.push({
        kind: "upsert",
        row: {
          rowId: IDENTITY_RECORD_ROW_ID,
          revision: identity.revision,
          row: { kind: "identity-patch", identity: identity.identity },
        },
      });
    }
    for (const row of frame.documentUpserts) {
      changes.push({
        kind: "upsert",
        row: {
          rowId: identityDocumentRowId(row.path, row.incarnation),
          revision: row.revision,
          row: { kind: "document", row },
        },
      });
    }
    for (const row of frame.fileUpserts) {
      changes.push({
        kind: "upsert",
        row: {
          rowId: identityFileRowId(row.path, row.incarnation),
          revision: row.revision,
          row: { kind: "file", row },
        },
      });
    }
    for (const removal of frame.removals) {
      // `population` comes off the wire and is never re-derived from the path:
      // which map a path belongs to is a host rule, and a rename ships the new
      // row and the old path's removal in ONE envelope, so a client guessing
      // wrong would strand the old path forever.
      changes.push({
        kind: "remove",
        rowId: identityRowIdFor(
          removal.population,
          removal.path,
          removal.incarnation,
        ),
        revision: removal.revision,
        reason: IDENTITY_ROW_REMOVE_REASON,
      });
    }
    return changes;
  }

  function buildCallbacks(generation: number): IdentityStateStreamCallbacks {
    const emit = (event: IdentityStateLaneEvent): void => {
      if (!accepts(generation)) return;
      host?.emit(event);
    };
    return {
      onSnapshot: (frame: IdentityStateSnapshotFrame) => {
        if (!accepts(generation)) return;
        const watermark = cursorAt(frame.authorityEpoch, frame.position);
        // Reported BEFORE the rows, and through `reportResume` rather than as an
        // event, because it is a statement about the SUBSCRIPTION: a
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
          // The snapshot's own high-water mark, carried on the frame rather than
          // inferred from the first delta: a quiet identity may never send one,
          // and a client that had to wait for a delta to learn its own cursor
          // could not persist a resume point at all.
          watermark,
        });
        // Only the two FAILURE bases ask for a rebuild, and they ask for
        // different amounts of discarding - which is the whole reason the
        // contract distinguishes them. `resumeTooOld` keeps the replica's
        // identity, so per-file body state stays valid and only the row set
        // re-seeds; `authorityEpochChanged` voids everything, bodies included -
        // every open `agentIdentity.file.subscribe` was attached under the old
        // epoch and will be refused terminally. A `cold` basis asks for nothing:
        // the client offered nothing, so there is nothing to replace.
        if (frame.basis === "resumeTooOld") {
          host?.requestReplacement(
            "resume-too-old",
            resumeTooOldTransition(`${frame.authorityEpoch}/${frame.position}`),
          );
        } else if (frame.basis === "authorityEpochChanged") {
          host?.requestReplacement(
            "authority-epoch-changed",
            authorityEpochTransition(frame.authorityEpoch),
          );
        }
        emit({
          kind: "record-snapshot",
          watermark,
          rows: snapshotRows(frame),
          trust: trustOf(frame.reconciledWithCloud),
          cause: leadDelivered ? "reseed" : "initial",
        });
        // AFTER the rows: a shard set qualifies the documents it serves, so
        // delivering it first would hand a consumer availability for rows it
        // does not yet hold. It is its own event rather than part of the
        // snapshot because the wire also flips it with no row having changed -
        // see `IdentityShardAvailabilityEvent`.
        emit({
          kind: "identity-shard-availability",
          authorityEpoch: frame.authorityEpoch,
          shards: frame.shards,
        });
        leadDelivered = true;
      },
      onResumed: (frame: IdentityStateResumedFrame) => {
        if (!accepts(generation)) return;
        // The acknowledgement exists so that "your cursor was accepted and
        // nothing has happened since" is a STATEMENT rather than an absence. No
        // ROWS are emitted: the consumer keeps every one it holds.
        host?.reportResume({
          kind: "resumed",
          from: cursorAt(frame.authorityEpoch, frame.position),
        });
        // Trust and shards ARE emitted, and they are the two things a resume
        // cannot let the client carry over. Rows are row state and survive the
        // gap by definition; both of these describe the SERVING HOST, which may
        // have restarted seed-only or lost a shard since the cursor was
        // persisted. A client that kept its old values would resume believing it
        // is reconciled against a host that is not, and rendering a writable
        // editor over a room that is down.
        emit({
          kind: "record-trust",
          authorityEpoch: frame.authorityEpoch,
          trust: trustOf(frame.reconciledWithCloud),
        });
        emit({
          kind: "identity-shard-availability",
          authorityEpoch: frame.authorityEpoch,
          shards: frame.shards,
        });
        leadDelivered = true;
      },
      onDelta: (frame: IdentityStateDeltaFrame) => {
        if (!accepts(generation)) return;
        // Unconditional, and safe to be so: the contract refuses a delta that
        // carries no change at all (an empty envelope would consume a lane
        // position for a commit that never happened), and every one of the four
        // change fields maps to a change here - including `identity`, which is a
        // revisioned row rather than a special case.
        emit({
          kind: "record-transaction",
          cursor: cursorAt(frame.authorityEpoch, frame.seq),
          changes: deltaChanges(frame),
          // Cross-lane atomicity is exceptional and must be NAMED. One envelope
          // on one lane already carries every affected row together - a rename
          // ships the new row and the old path's removal in the same one - so
          // there is nothing here for a barrier to tie.
          barrier: null,
        });
      },
      onHostStateChanged: (frame: IdentityStateHostStateFrame) => {
        // No rows changed, which is exactly why this frame exists: a background
        // reconcile that finds the local replica already correct commits
        // nothing, and a shard room reconnecting changes no row at all, so
        // there is no envelope to carry either fact and no honest `basis` for a
        // re-snapshot. Without it a seed-served client labels its data stale for
        // the life of the subscription, and a file whose room came back stays
        // read-only until the tab is reopened.
        //
        // Both facts are restated on every one of these frames, so both are
        // re-emitted: the wire has no way to say "trust changed but shards did
        // not", and inferring one from an unchanged value would make "unchanged"
        // and "not sent" the same observation.
        emit({
          kind: "record-trust",
          authorityEpoch: frame.authorityEpoch,
          trust: trustOf(frame.reconciledWithCloud),
        });
        emit({
          kind: "identity-shard-availability",
          authorityEpoch: frame.authorityEpoch,
          shards: frame.shards,
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
      identityId,
      buildCallbacks(generation),
      wireResume,
    );
  }

  return {
    descriptor,

    attach(nextHost: AdapterHost<IdentityStateLaneEvent>): void {
      host = nextHost;
      openStreamClient();
    },

    resumeOffer: currentOffer,

    detach(_reason: AdapterDetachReason): void {
      // Retire the generation FIRST: `close()` can synchronously deliver a final
      // status frame, and a frame stamped with a generation the guard has already
      // moved past is inert by construction rather than by luck.
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
