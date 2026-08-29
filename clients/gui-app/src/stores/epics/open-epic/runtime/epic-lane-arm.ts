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
  ArtifactStreamClientFactory,
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
import type { ArtifactSubscribeSeedOffer } from "@traycer/protocol/host/epic/artifact-subscribe";
import type { EpicControlEvent, EpicRoomEvent } from "./epic-runtime-events";
import {
  createEpicArtifactBodyLanes,
  type EpicArtifactBodyLanes,
} from "./epic-artifact-body-lanes";
import { isMethodIncompatibleClose } from "@traycer-clients/shared/host-transport/i-stream-session";
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
  readonly artifactStreamClientFactory: ArtifactStreamClientFactory;
  /** What this client holds for one body. Wired to the artifact-body tier. */
  readonly readDocSeed: (
    artifactId: string,
  ) => ArtifactSubscribeSeedOffer | null;
  /** One decoded body frame, in the rooms plane's vocabulary. */
  readonly onRoomEvent: (event: EpicRoomEvent) => void;
  /**
   * What the capability probe learned, reported EXACTLY once per arm.
   *
   * This is the selection input, and it is deliberately not a manifest read.
   * A remote peer's `getMethodSupport` answers `"unknown"` forever - the mux
   * resolves an incompatible method as a fatal on the subscribe attempt rather
   * than as a queryable pre-check - so a runtime that waits for support to
   * resolve never installs an arm on a relay connection and the epic never
   * renders. The subscribe's own outcome is the only evidence that exists on
   * both transports.
   */
  readonly onProbeOutcome: (outcome: EpicLaneProbeOutcome) => void;
}

/**
 * What opening the status lane proved about this connection.
 *
 * Two members, both positive statements about an observed event - a frame
 * arrived, or the mux refused the method. There is deliberately no "pending"
 * member: not-yet-answered is the absence of a call, not a value, so nothing
 * downstream can branch on a probe result that has not happened.
 */
export type EpicLaneProbeOutcome = "succeeded" | "unsupported";

export interface EpicLaneArm {
  /**
   * Open ONLY the status lane, as the capability probe for a connection whose
   * manifest has not resolved.
   *
   * This exists because "unknown support is not a selection" and a subscribe is
   * the only thing that can settle it: the client learns a method's support
   * from a subscribe COMPLETING (`applyHostManifest` runs with the subscribed
   * method's outcome), so a runtime that installs no arm while it waits for
   * support to resolve waits forever - there is nothing else in the epic
   * session that would ask.
   *
   * The probe is the status lane rather than a throwaway request because the
   * open is not wasted on the arm it is probing FOR: on a lane host this
   * stream is the real status lane, and {@link attach} adopts it instead of
   * opening a second one. On an old host the subscribe resolves
   * method-unsupported, which is the typed answer that installs legacy, and
   * the cost is the one rejected subscribe that answer requires.
   */
  probe(): void;
  /**
   * Open both lanes, adopting a stream {@link probe} already opened.
   *
   * Idempotent per lane: attaching after a probe opens the records lane only,
   * so the probe-then-lanes path costs exactly one status open, not two.
   */
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
   * The per-body lanes. Exposed rather than folded in, because the demand on
   * them is the UI's (a mounted tile's lease), not this arm's.
   */
  readonly bodies: EpicArtifactBodyLanes;
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
    artifactStreamClientFactory,
    readDocSeed,
    onRoomEvent,
    onProbeOutcome,
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

  const bodies: EpicArtifactBodyLanes = createEpicArtifactBodyLanes({
    epicId,
    environment,
    streamClientFactory: artifactStreamClientFactory,
    // Obligation 3: bodies attach under the STATUS adapter's epoch, which it
    // keeps across `detach()` - the epoch is a fact about the host's replica,
    // not about a socket.
    readAuthorityEpoch: () => statusAdapter.observedAuthorityEpoch(),
    readDocSeed,
    isDisposed,
    onRoomEvent,
    onReplacementRequested,
  });

  /**
   * Whether this arm has already answered the capability question. One answer
   * per arm: the outcome installs an adapter, and a second report would ask the
   * runtime to re-decide something it has already acted on.
   */
  let probeAnswered = false;

  function answerProbe(outcome: EpicLaneProbeOutcome): void {
    if (probeAnswered) return;
    probeAnswered = true;
    onProbeOutcome(outcome);
  }

  function attachStatus(): void {
    statusAdapter.attach({
      environment,
      emit: (event: ControlEvent) => {
        // ANY control frame proves the subscribe is being served, which is the
        // whole capability question. Read off the frame rather than off the
        // manifest because the manifest is exactly what a remote peer never
        // resolves - see `answerProbe`'s callers and
        // `isMethodIncompatibleClose`.
        answerProbe("succeeded");
        onControlEvent(legacyControlEventOf(event));
        // The status snapshot is the frame that first names an epoch, and a
        // later one arrives whenever the authority reissues it. Reconciling
        // here rather than detecting the change means a body that mounted
        // before any epoch existed opens by itself, and one built under a
        // superseded epoch is rebuilt - both without the UI asking twice.
        bodies.syncToAuthorityEpoch();
      },
      // The control lane has no cursor at `@1.0`, so it has no resume outcome
      // to report - its whole state is one snapshot frame.
      reportResume: () => {},
      reportStatus: (status) => {
        // The ONLY capability evidence a remote session produces: the mux
        // resolves an incompatible method as a fatal on the subscribe attempt,
        // never as a queryable pre-check. A client that waits for
        // `getMethodSupport` to move waits forever.
        if (isMethodIncompatibleClose(status.closeReason)) {
          answerProbe("unsupported");
        }
        onControlEvent({
          kind: "transport-status",
          status: status.connection,
          reason: status.closeReason,
        });
      },
      requestReplacement: onReplacementRequested,
    });
  }

  // Which lanes hold an open subscription. Tracked here rather than inferred
  // from the adapters because the probe leaves this arm HALF attached, and
  // every lifecycle call below has to act on the half that exists: the
  // adapters' own `openTransport` opens unconditionally, so an ungated
  // reopen would dial a records lane that was never attached.
  let statusAttached = false;
  let stateAttached = false;

  function ensureStatusAttached(): void {
    if (statusAttached) return;
    attachStatus();
    statusAttached = true;
  }

  return {
    probe(): void {
      ensureStatusAttached();
    },

    attach(): void {
      // STATUS FIRST, and not for tidiness: on a connection whose manifest has
      // not resolved this open is the capability PROBE. It succeeds on a lane
      // host - and is the real first lane, since the epoch body lanes attach
      // under comes from its `observedAuthorityEpoch()` - while on an old host
      // the subscribe resolves method-unsupported, which is the typed answer
      // that settles the arm. Opening the records lane first would make the
      // probe's cost two rejected subscribes instead of one.
      //
      // `ensureStatusAttached` rather than `attachStatus`, because the probe
      // usually got here first and its stream IS this lane.
      ensureStatusAttached();
      if (stateAttached) return;
      attachState();
      stateAttached = true;
    },

    detach(reason: AdapterDetachReason): void {
      // Guarded per lane so this also retires a bare probe - the runtime calls
      // it on the legacy install to close the status stream the probe opened,
      // and on teardown with no arm installed at all.
      if (statusAttached) {
        statusAdapter.detach(reason);
        statusAttached = false;
      }
      if (stateAttached) {
        stateAdapter.detach(reason);
        stateAttached = false;
      }
      // Sockets down, DEMAND kept: a transport-only detach and a replacement
      // are both followed by a reopen that must restore the same bodies.
      bodies.detachAll(reason);
    },

    closeTransport(): void {
      if (statusAttached) statusAdapter.closeTransport();
      if (stateAttached) stateAdapter.closeTransport();
      bodies.closeTransport();
    },

    openTransport(): void {
      if (statusAttached) statusAdapter.openTransport();
      if (stateAttached) stateAdapter.openTransport();
      bodies.openTransport();
    },

    bodies,

    observedAuthorityEpoch: () => statusAdapter.observedAuthorityEpoch(),
    appliedCursor: () => stateReplica.appliedCursor(),
    stateSlices: () => stateReplica.slices(),

    reset(cause: ReplicaResetCause): void {
      stateReplica.reset(cause);
    },
  };
}
