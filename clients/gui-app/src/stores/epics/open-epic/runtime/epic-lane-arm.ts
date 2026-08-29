/**
 * The lane arm: T10's adapters wired to T12's replicas.
 *
 * Everything here is composition. The adapters decode, the replicas decide what
 * may be applied, and this module is the ORDER and the ROUTING between them -
 * the same job `createLegacyEpicStreamAdapter`'s attachment does for the `@1`
 * arm, which is why the two are interchangeable to the runtime above.
 *
 * ## The four wiring obligations, and where each one is discharged
 *
 * 1. **`readAppliedCursor` reads the REPLICA's watermark.** It is
 *    {@link EpicLaneStateReplica.appliedCursor}, which moves only after a whole
 *    envelope is applied. An adapter-held arrival counter would advance on a
 *    delta the replica ignored - a stale revision, an absorbed tombstone, a torn
 *    apply - and the next resume would ask the host to continue from work this
 *    client never finished.
 * 2. **The typed replica applies `EpicStateRow`.** Owned by the state replica;
 *    this module only hands it events and republishes when it says something
 *    moved.
 * 3. **`observedAuthorityEpoch()` is what a body lane attaches under.** Exposed
 *    off the status adapter, which keeps it across `detach()` on purpose - the
 *    epoch is a fact about the host's replica, not about a socket.
 * 4. **Both lanes may request replacement and the RUNTIME coalesces.** Both
 *    adapters' `requestReplacement` funnel into one callback here, and the
 *    runtime decides once. Two lanes each asking for one real epoch change is
 *    two true statements, not two replacements.
 *
 * ## Why the control replica is fed translated `@1` events
 *
 * The migration modal's state machine, the access-lost latch, the transport
 * policy and the freshness latches are identical on both arms; only the words
 * differ. So the status lane translates at this boundary
 * (`lane-control-translation.ts`) and the control replica keeps one
 * implementation. A second control replica would be a second answer to "is this
 * epic writable".
 */
import type {
  AdapterDetachReason,
  ControlEvent,
  LaneCursor,
  ReplicaReplacementReason,
  ReplicaResetCause,
  RuntimeEnvironment,
} from "@traycer-clients/shared/replica-runtime";
import type {
  EpicStateLaneAdapter,
  EpicStateLaneEvent,
  EpicStateStreamClientFactory,
  EpicStatusLaneAdapter,
  EpicStatusStreamClientFactory,
} from "@traycer-clients/shared/epic-lanes";
import {
  createEpicStateLaneAdapter,
  createEpicStatusLaneAdapter,
} from "@traycer-clients/shared/epic-lanes";
import type { EpicControlEvent } from "./epic-runtime-events";
import { legacyControlEventOf } from "./lane-control-translation";
import {
  createEpicLaneStateReplica,
  type EpicLaneStateReplica,
  type EpicLaneStateSlices,
} from "./epic-lane-state-replica";

export interface EpicLaneArmSources {
  readonly epicId: string;
  readonly environment: RuntimeEnvironment;
  readonly stateStreamClientFactory: EpicStateStreamClientFactory;
  readonly statusStreamClientFactory: EpicStatusStreamClientFactory;
  readonly getCurrentUserId: () => string | null;
  readonly isDisposed: () => boolean;
  /** Publish the records lane's populations. Called only when they moved. */
  readonly onStateSlices: (slices: EpicLaneStateSlices) => void;
  /** One control event, already in the `@1` replica's vocabulary. */
  readonly onControlEvent: (event: EpicControlEvent) => void;
  /**
   * Either lane asking for the replica to be rebuilt. The runtime coalesces -
   * two lanes reporting ONE epoch change is two true statements.
   */
  readonly onReplacementRequested: (reason: ReplicaReplacementReason) => void;
}

export interface EpicLaneArm {
  /** Open both lanes. The status lane is also the capability PROBE. */
  attach(): void;
  detach(reason: AdapterDetachReason): void;
  /** Close the sockets, keep the replicas - the retained-handle path. */
  closeTransport(): void;
  openTransport(): void;
  /**
   * The epoch a body lane must attach under, or `null` before the first status
   * snapshot. Read from the STATUS adapter rather than from the records lane's
   * cursor, because a body may legitimately be attached before the records lane
   * has produced any position at all.
   */
  observedAuthorityEpoch(): string | null;
  /** The records lane's applied watermark - what a resume may offer. */
  appliedCursor(): LaneCursor | null;
  /** The records lane's populations, as last recomputed. */
  stateSlices(): EpicLaneStateSlices;
  /**
   * Discard the lanes' replica state, carrying the cause. Sockets are the
   * caller's business.
   *
   * Takes the provenance rather than assuming one: a manifest change, a
   * resume-too-old and a user-requested reseed all empty the same replica and
   * differ only in what may be CLAIMED about why, and a hardcoded reason here
   * would put a fabricated authority event into logs and the replay harness.
   */
  reset(cause: ReplicaResetCause): void;
}

export function createEpicLaneArm(sources: EpicLaneArmSources): EpicLaneArm {
  const {
    epicId,
    environment,
    stateStreamClientFactory,
    statusStreamClientFactory,
    getCurrentUserId,
    isDisposed,
    onStateSlices,
    onControlEvent,
    onReplacementRequested,
  } = sources;

  const stateReplica: EpicLaneStateReplica = createEpicLaneStateReplica({
    getCurrentUserId,
    isDisposed,
    // Republish only when the replica says something moved. The replica has
    // already run the change gate, so a frame that changed nothing costs no
    // projection - which is what keeps a quiet epic's deltas free.
    onChanged: () => {
      onStateSlices(stateReplica.slices());
    },
  });

  const stateAdapter: EpicStateLaneAdapter = createEpicStateLaneAdapter({
    epicId,
    streamClientFactory: stateStreamClientFactory,
    // Obligation 1: the REPLICA's watermark, never a counter.
    readAppliedCursor: () => stateReplica.appliedCursor(),
    isDisposed,
  });

  const statusAdapter: EpicStatusLaneAdapter = createEpicStatusLaneAdapter({
    epicId,
    environment,
    streamClientFactory: statusStreamClientFactory,
    isDisposed,
  });

  function attachState(): void {
    stateAdapter.attach({
      environment,
      emit: (event: EpicStateLaneEvent) => {
        stateReplica.apply(event);
      },
      // The resume OUTCOME is a statement about the subscription, and the
      // replica already learns everything it needs from the frames that follow
      // it - a `reseeded` outcome arrives with the snapshot that replaces the
      // rows, and a `resumed` outcome with the trust event that cannot be
      // inherited. Nothing here needs a second copy of it.
      reportResume: () => {},
      // Both lanes report transport status and the control replica owns the
      // policy that follows a close (a migration modal, a snapshot error, an
      // auth cascade) - so it is routed as a control event rather than acted on
      // here, exactly as the `@1` arm routes it.
      reportStatus: (status) => {
        onControlEvent({
          kind: "transport-status",
          status: status.connection,
          reason: status.closeReason,
        });
      },
      requestReplacement: onReplacementRequested,
    });
  }

  function attachStatus(): void {
    statusAdapter.attach({
      environment,
      emit: (event: ControlEvent) => {
        onControlEvent(legacyControlEventOf(event));
      },
      // The control lane has no cursor at `@1.0`, so it has no resume outcome
      // to report - its whole state is one snapshot frame.
      reportResume: () => {},
      reportStatus: (status) => {
        onControlEvent({
          kind: "transport-status",
          status: status.connection,
          reason: status.closeReason,
        });
      },
      requestReplacement: onReplacementRequested,
    });
  }

  return {
    attach(): void {
      // STATUS FIRST, and not for tidiness: on a connection whose manifest has
      // not resolved this open is the capability PROBE. It succeeds on a lane
      // host - and is the real first lane, since the epoch body lanes attach
      // under comes from its `observedAuthorityEpoch()` - while on an old host
      // the subscribe resolves method-unsupported, which is the typed answer
      // that settles the arm. Opening the records lane first would make the
      // probe's cost two rejected subscribes instead of one.
      attachStatus();
      attachState();
    },

    detach(reason: AdapterDetachReason): void {
      statusAdapter.detach(reason);
      stateAdapter.detach(reason);
    },

    closeTransport(): void {
      statusAdapter.closeTransport();
      stateAdapter.closeTransport();
    },

    openTransport(): void {
      statusAdapter.openTransport();
      stateAdapter.openTransport();
    },

    observedAuthorityEpoch: () => statusAdapter.observedAuthorityEpoch(),
    appliedCursor: () => stateReplica.appliedCursor(),
    stateSlices: () => stateReplica.slices(),

    reset(cause: ReplicaResetCause): void {
      stateReplica.reset(cause);
    },
  };
}
