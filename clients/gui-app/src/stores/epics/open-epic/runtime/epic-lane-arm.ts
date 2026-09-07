/** The lane arm: T10's adapters wired to T12's replicas. Everything here is composition. */
import type {
  AdapterDetachReason,
  ControlEvent,
  LaneCursor,
  ReplicaReplacementReason,
  ReplicaResetCause,
  ReplicaTransitionToken,
  RuntimeEnvironment,
} from "@traycer-clients/shared/replica-runtime";
import { authorityEpochTransition } from "@traycer-clients/shared/replica-runtime";
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
  createWorkspaceContextRefreshPolicy,
} from "@traycer-clients/shared/epic-lanes";
import type { ArtifactSubscribeSeedOffer } from "@traycer/protocol/host/epic/artifact-subscribe";
import type { EarlyMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
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
  /** The records lane's LEAD snapshot landed. */
  readonly onStateLeadSnapshot: () => void;
  /** One control event, already in the `@1` replica's vocabulary. */
  readonly onControlEvent: (event: EpicControlEvent) => void;
  /** `epic.getWorkspaceContext@1.0`, on the main thread's requester. The READ only. */
  readonly getWorkspaceContext: () => Promise<EarlyMetaEpic>;
  /** Where a workspace context lands. */
  readonly onWorkspaceContext: (context: EarlyMetaEpic) => void;
  /** Either lane asking for the replica to be rebuilt. */
  readonly onReplacementRequested: (
    reason: ReplicaReplacementReason,
    transition: ReplicaTransitionToken,
  ) => void;
  readonly artifactStreamClientFactory: ArtifactStreamClientFactory;
  /** What this client holds for one body. Wired to the artifact-body tier. */
  readonly readDocSeed: (
    artifactId: string,
  ) => ArtifactSubscribeSeedOffer | null;
  /** One decoded body frame, in the rooms plane's vocabulary. */
  readonly onRoomEvent: (event: EpicRoomEvent) => void;
  /**
   * What the capability probe learned, reported EXACTLY once per arm. This is the selection input,
   * and it is deliberately not a manifest read.
   */
  readonly onProbeOutcome: (outcome: EpicLaneProbeOutcome) => void;
  /**
   * A lane this arm REQUIRES has been refused by the host, reported at most once per arm. Separate
   * from {@link onProbeOutcome} because it is a different question asked at a different time.
   */
  readonly onRequiredLaneUnsupported: () => void;
}

/**
 * What opening the status lane proved about this connection. Two members, both positive statements
 * about an observed event - a frame arrived, or the mux refused the method.
 */
export type EpicLaneProbeOutcome = "succeeded" | "unsupported";

export interface EpicLaneArm {
  /**
   * Open ONLY the status lane, as the capability probe for a connection whose manifest has not
   * resolved.
   */
  probe(): void;
  /** Open both lanes, adopting a stream {@link probe} already opened. */
  attach(): void;
  detach(reason: AdapterDetachReason): void;
  /** Close the sockets, keep the replicas - the retained-handle path. */
  closeTransport(): void;
  openTransport(): void;
  /** The epoch a body lane must attach under, or `null` before the first status snapshot. */
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
  /** Discard the lanes' replica state, carrying the cause. Sockets are the caller's business. */
  reset(cause: ReplicaResetCause): void;
  /**
   * Reopen the body lanes a whole-plane reset left owing nothing, if this cause is one that needs
   * it.
   */
  rebuildBodiesAfterReset(cause: ReplicaResetCause): void;
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
    onStateLeadSnapshot,
    onControlEvent,
    getWorkspaceContext,
    onWorkspaceContext,
    onReplacementRequested: reportReplacementRequested,
    artifactStreamClientFactory,
    readDocSeed,
    onRoomEvent,
    onProbeOutcome,
    onRequiredLaneUnsupported,
  } = sources;

  /**
   * The `epic.getWorkspaceContext@1.0` fetch-and-REFETCH policy, living here because its triggers
   * are this module's frames.
   */
  const workspaceContext = createWorkspaceContextRefreshPolicy({
    epicId,
    environment,
    fetch: () => getWorkspaceContext(),
    onContext: (context) => {
      onWorkspaceContext(context);
    },
    // The policy has already logged the failure with its cause.
    onError: () => {},
    isDisposed,
  });

  /**
   * Every replacement request, from either lane or any body, plus the ONE refresh trigger the policy
   * cannot infer from a control frame.
   */
  function onReplacementRequested(
    reason: ReplicaReplacementReason,
    transition: ReplicaTransitionToken,
  ): void {
    workspaceContext.noteAuthorityEpochChanged();
    reportReplacementRequested(reason, transition);
  }

  const stateReplica: EpicLaneStateReplica = createEpicLaneStateReplica({
    getCurrentUserId,
    isDisposed,
    // Republish only when the replica says something moved.
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
        const outcome = stateReplica.apply(event);
        // READ, not discarded. The replica documents this as a division of labour - "it does not decide
        // replacement ...
        if (
          event.kind === "record-transaction" &&
          outcome.kind === "requires-replacement"
        ) {
          onReplacementRequested(
            outcome.reason,
            authorityEpochTransition(event.cursor.authorityEpoch),
          );
        }
        // AFTER the replica applied it, so the loaded flag never leads the rows it claims are loaded.
        if (event.kind === "record-snapshot") onStateLeadSnapshot();
      },
      reportResume: () => {},
      // Both lanes report transport status and the control replica owns the policy that follows a close
      // (a migration modal, a snapshot error, an auth cascade) - so it is routed as a control event
      reportStatus: (status) => {
        // The records lane is REQUIRED.
        if (isMethodIncompatibleClose(status.closeReason)) {
          reportRequiredLaneUnsupported();
        }
        onControlEvent({
          kind: "transport-status",
          status: status.connection,
          reason: status.closeReason,
          // The records lane rides ALONGSIDE the control snapshot; it never carries one.
          ownsControlCycle: false,
          // This IS the records lane.
          carriesRecords: true,
        });
      },
      requestReplacement: onReplacementRequested,
    });
  }

  const bodies: EpicArtifactBodyLanes = createEpicArtifactBodyLanes({
    epicId,
    environment,
    streamClientFactory: artifactStreamClientFactory,
    // Obligation 3: bodies attach under the STATUS adapter's epoch, which it keeps across `detach()` -
    // the epoch is a fact about the host's replica, not about a socket.
    readAuthorityEpoch: () => statusAdapter.observedAuthorityEpoch(),
    readDocSeed,
    isDisposed,
    onRoomEvent,
    onReplacementRequested,
    // Bodies are required too: rendering them is the one thing `@1` does that an arm without
    // `artifact.subscribe` cannot.
    onLaneUnsupported: reportRequiredLaneUnsupported,
  });

  /** Whether this arm has already answered the capability question. */
  let probeAnswered = false;

  function answerProbe(outcome: EpicLaneProbeOutcome): void {
    if (probeAnswered) return;
    probeAnswered = true;
    onProbeOutcome(outcome);
  }

  /** Whether this arm has already reported a required lane refused. */
  let requiredLaneUnsupportedReported = false;

  function reportRequiredLaneUnsupported(): void {
    if (requiredLaneUnsupportedReported) return;
    requiredLaneUnsupportedReported = true;
    onRequiredLaneUnsupported();
  }

  function attachStatus(): void {
    statusAdapter.attach({
      environment,
      emit: (event: ControlEvent) => {
        // ANY control frame proves the subscribe is being served, which is the whole capability question.
        answerProbe("succeeded");
        // The LANE's event, before translation.
        workspaceContext.noteControlEvent(event);
        onControlEvent(legacyControlEventOf(event));
        // The status snapshot is the frame that first names an epoch, and a later one arrives whenever the
        // authority reissues it.
        bodies.syncToAuthorityEpoch();
      },
      // The control lane has no cursor at `@1.0`, so it has no resume outcome
      // to report - its whole state is one snapshot frame.
      reportResume: () => {},
      reportStatus: (status) => {
        // The ONLY capability evidence a remote session produces: the mux resolves an incompatible method
        // as a fatal on the subscribe attempt, never as a queryable pre-check.
        if (isMethodIncompatibleClose(status.closeReason)) {
          // Before the probe answers, this IS the answer. After it, the arm is already installed and this is
          // a required lane going away, which `answerProbe` would swallow (one answer per arm).
          answerProbe("unsupported");
          reportRequiredLaneUnsupported();
        }
        // The CONTROL lane's transitions and not the records lane's, because the policy's reconnect
        // trigger is one fact and two lanes reporting the same reconnect would be two.
        workspaceContext.noteTransportStatus(status.connection);
        // The body lanes read the same fact for a different reason: a reconnect ends the transport session
        // a `terminal` body refusal was scoped to, so it is the edge on which a refused body may be
        bodies.noteTransportStatus(status.connection);
        onControlEvent({
          kind: "transport-status",
          status: status.connection,
          reason: status.closeReason,
          // This lane serves `control-snapshot`, so its open/close IS the control cycle's boundary - the
          // third consumer of the same one-reconnect-is-one-fact rule the two calls above apply.
          ownsControlCycle: true,
          // The status lane carries no record rows; the records lane beside it
          // does, and reports its own transitions above.
          carriesRecords: false,
        });
      },
      requestReplacement: onReplacementRequested,
    });
  }

  // Which lanes hold an open subscription.
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
      // STATUS FIRST, and not for tidiness: on a connection whose manifest has not resolved this open is
      // the capability PROBE.
      ensureStatusAttached();
      // The tab-open read, on ATTACH and never on `probe`.
      workspaceContext.start();
      if (stateAttached) return;
      attachState();
      stateAttached = true;
    },

    detach(reason: AdapterDetachReason): void {
      // Guarded per lane so this also retires a bare probe - the runtime calls it on the legacy install
      // to close the status stream the probe opened, and on teardown with no arm installed at all.
      if (statusAttached) {
        statusAdapter.detach(reason);
        statusAttached = false;
      }
      if (stateAttached) {
        stateAdapter.detach(reason);
        stateAttached = false;
      }
      // This arm is over. Whatever attaches next is a new one and gets its own single answer - see the
      // latch's own doc for why session-scoped was a defect rather than a simplification.
      requiredLaneUnsupportedReported = false;
      // The PROBE latch is the same rule, and it was the one member of the pair not being reset here.
      probeAnswered = false;
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

    /**
     * Reopen the body lanes a whole-plane reset left owing nothing. SEPARATE from {@link reset}, and
     * called separately, because of where the bodies are actually destroyed.
     */
    rebuildBodiesAfterReset(cause: ReplicaResetCause): void {
      // ONE cause, and it is the only authority-side reason that discards bodies without moving the
      // authority epoch.
      if (cause.origin !== "authority") return;
      if (cause.reason !== "security-epoch-changed") return;
      bodies.rebuildDemandedBodies();
    },
  };
}
