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
  /**
   * The records lane's LEAD snapshot landed.
   *
   * Separate from `onStateSlices` because that one fires only when the
   * populations moved, and a lead snapshot for an epic with no artifacts moves
   * nothing while still being the authoritative answer.
   */
  readonly onStateLeadSnapshot: () => void;
  /** One control event, already in the `@1` replica's vocabulary. */
  readonly onControlEvent: (event: EpicControlEvent) => void;
  /**
   * `epic.getWorkspaceContext@1.0`, on the main thread's requester.
   *
   * The READ only. When to issue it is this arm's business, because the
   * contract's refetch obligation is written in terms of the control lane's
   * own frames and this is the module that holds them - see
   * {@link workspaceContext}.
   */
  readonly getWorkspaceContext: () => Promise<EarlyMetaEpic>;
  /**
   * Where a workspace context lands. The runtime routes it into the SAME
   * early-meta projection path the `@1` arm's `earlyMeta` frame takes, which is
   * the point: this payload is that frame, and a second projection route for it
   * would be a second answer to what `snapshotMeta` holds before a snapshot.
   */
  readonly onWorkspaceContext: (context: EarlyMetaEpic) => void;
  /**
   * Either lane asking for the replica to be rebuilt. The runtime coalesces on
   * `transition` - two lanes reporting ONE epoch change is two true statements,
   * and only the transition identifies it as one occurrence (the two can name
   * the reason differently).
   */
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
  /**
   * A lane this arm REQUIRES has been refused by the host, reported at most
   * once per arm.
   *
   * Separate from {@link onProbeOutcome} because it is a different question
   * asked at a different time. The probe answers "can this connection serve
   * lanes at all", once, before anything is installed. This answers "a lane
   * the installed arm depends on is not served", which can only be learned
   * AFTER installation - and on a forever-unknown remote connection it is the
   * only way it can ever be learned, since the manifest never resolves.
   *
   * The arm is only an arm if every required lane is served. A host that
   * serves status but refuses state is a real class (a rolling upgrade, a lane
   * behind a flag), and on it a "lanes" arm renders no records at all - which
   * is not "degraded relative to `@1`", it is empty. So this is a fallback to
   * legacy, not a partial mode.
   */
  readonly onRequiredLaneUnsupported: () => void;
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
  /**
   * Reopen the body lanes a whole-plane reset left owing nothing, if this cause
   * is one that needs it.
   *
   * Called by the runtime AFTER the body tier has actually been emptied, which
   * is why it is not folded into {@link reset} - see the implementation. A
   * no-op for every cause that moves the authority epoch, since the control
   * handler's own epoch sync rebuilds those.
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
   * The `epic.getWorkspaceContext@1.0` fetch-and-REFETCH policy, living here
   * because its triggers are this module's frames.
   *
   * The read is a one-liner; the contract is the refetch obligation, which is
   * written in terms of the CONTROL LANE - "fetch at tab open, and REFETCH on
   * reconnect and on every migration or permission frame" - plus the epoch
   * change that a completing migration IS. Every one of those is a value this
   * arm holds and the runtime above does not: the runtime sees control events
   * only after {@link legacyControlEventOf} has translated them into the `@1`
   * vocabulary, and the policy folds the LANE's.
   *
   * Constructed once and never disposed here. Its `isDisposed` is the
   * RUNTIME's, which is the lifetime that actually bounds it, and disposal is
   * terminal - so calling it from {@link EpicLaneArm.detach} would silently
   * retire the context refresh for every arm installed after a
   * `manifest-changed` replacement, on a path whose whole purpose is to
   * re-install the lanes.
   */
  const workspaceContext = createWorkspaceContextRefreshPolicy({
    epicId,
    environment,
    fetch: () => getWorkspaceContext(),
    onContext: (context) => {
      onWorkspaceContext(context);
    },
    // The policy has already logged the failure with its cause. There is no
    // composition-level remedy on THIS arm and saying so is the honest
    // handling: the contract's degrade for an unsupported read is the legacy
    // adapter, and a connection that reached this code is one whose three lane
    // stream methods are supported - so it is not going to legacy, and the
    // outcome is the same `snapshotMeta` a lane session had before this policy
    // existed. Latching a failure would be worse than reporting it, since the
    // next trigger's fetch is exactly what recovers a transient one.
    //
    // Why "the streams are supported" settles it for a UNARY, which is not in
    // `EPIC_LANE_METHODS` and has no `getMethodSupport` entry to check: the
    // host registry introduces `epic.getWorkspaceContext@1.0` and the three
    // `@1.0` lane subscriptions together, each documented with the SAME
    // degrade - a peer without them is a peer still serving `epic.subscribe@1`,
    // whose `earlyMeta` frame is this exact payload. A host process serves the
    // registry it was built with, so "three lanes but no context read" is not a
    // state any host version produces. That is a fact about the release
    // boundary, not about this arm, which is why it is worth writing down: the
    // read IS optional and off the released floor, so the day one of the four
    // version-gates ahead of the others, this handler is where the decision
    // lands. Reaching for the legacy arm then would be the wrong lever anyway -
    // it would trade three working lanes for one metadata payload - and
    // recovering the refusal's CODE here is not available either, since
    // `epic-lane-unary-dispatch` flattens the cause to a message string on
    // purpose.
    //
    // "The next trigger" is the policy's obligation, not this arm's, and it
    // holds because the policy retries a first read that failed on the status
    // lane's first `"open"`. That is the one trigger with no natural
    // successor; every other one recurs on its own.
    onError: () => {},
    isDisposed,
  });

  /**
   * Every replacement request, from either lane or any body, plus the ONE
   * refresh trigger the policy cannot infer from a control frame.
   *
   * All six `ReplicaReplacementReason` members feed it, and that is the
   * contract rather than an over-approximation: the policy's own cause is
   * named `"authority-epoch-changed"` and documented as "a replacement, or a
   * migration completing", so a replacement IS the trigger. A completing
   * migration is the case that motivated it - there is no "migration
   * completed" frame anywhere in this design, so a policy watching only
   * control events would refetch throughout a migration and never once after
   * it, which is the single moment the context is most likely to have moved.
   *
   * Cost of the coarse read is bounded by the policy's own coalescing: at most
   * one request in flight, and a trigger that arrives during one sets a re-run
   * flag rather than starting a second.
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
        const outcome = stateReplica.apply(event);
        // READ, not discarded. The replica documents this as a division of
        // labour - "it does not decide replacement ... the RUNTIME drives the
        // rebuild, so two lanes reporting one epoch change coalesce into a
        // single replacement instead of racing two" - and that only holds if
        // the runtime is actually told.
        //
        // The stimulus is narrower than the adapter's own two. The adapter
        // requests a replacement off a SNAPSHOT's basis, which is the
        // subscription reporting the change; this is a TRANSACTION arriving on
        // a still-open subscription stamped with an epoch the replica is not
        // serving. `applyRecordTransaction` returns without touching its rows
        // or its cursor, so every later delta at the new epoch is dropped the
        // same way - the projection stays on the old world for as long as no
        // snapshot happens to arrive to say so.
        //
        // Keyed by the epoch the frame carries, so the token is the same string
        // the status lane builds for the same transition and the runtime sees
        // one occurrence reported twice rather than two rebuilds.
        //
        // Narrowed on the EVENT as well as the outcome, and not only to reach
        // `cursor`: `requires-replacement` is returned from exactly one place,
        // `applyRecordTransaction`, so the transaction arm is where the epoch
        // that identifies the transition lives. A future second source would
        // carry its own, and would have to say so here rather than inherit
        // this one.
        if (
          event.kind === "record-transaction" &&
          outcome.kind === "requires-replacement"
        ) {
          onReplacementRequested(
            outcome.reason,
            authorityEpochTransition(event.cursor.authorityEpoch),
          );
        }
        // AFTER the replica applied it, so the loaded flag never leads the rows
        // it claims are loaded. A reseed lands here too and re-publishes, which
        // is harmless and honest: the answer really was replaced.
        if (event.kind === "record-snapshot") onStateLeadSnapshot();
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
        // The records lane is REQUIRED. A host that served status and refuses
        // this one renders no records at all, and on a forever-unknown remote
        // connection nothing else would ever say so - the manifest never
        // resolves, and the status lane is already happily connected.
        if (isMethodIncompatibleClose(status.closeReason)) {
          reportRequiredLaneUnsupported();
        }
        onControlEvent({
          kind: "transport-status",
          status: status.connection,
          reason: status.closeReason,
          // The lanes do not negotiate the `@1` durability capability; see
          // the event's own doc for why `false` keeps the pre-status branch
          // honest rather than reassuring.
          durabilityStatusNegotiated: false,
          // The records lane rides ALONGSIDE the control snapshot; it never
          // carries one. So its transitions must not open or close the control
          // cycle - the same "one reconnect is one fact, and it is the control
          // lane's" rule the status lane's `reportStatus` applies to the
          // workspace-context and body-lane reads just below.
          //
          // The event is still routed, because the close POLICY is genuinely
          // shared: a fatal close on the required records lane owes the same
          // migration modal / snapshot error / auth cascade as one on the
          // status lane. Only the cycle bookkeeping is the control lane's.
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
    // Obligation 3: bodies attach under the STATUS adapter's epoch, which it
    // keeps across `detach()` - the epoch is a fact about the host's replica,
    // not about a socket.
    readAuthorityEpoch: () => statusAdapter.observedAuthorityEpoch(),
    readDocSeed,
    isDisposed,
    onRoomEvent,
    onReplacementRequested,
    // Bodies are required too: rendering them is the one thing `@1` does that
    // an arm without `artifact.subscribe` cannot. Routed through the arm's
    // once-per-arm reporter, so a canvas with twelve open tiles asks for ONE
    // replacement rather than twelve.
    onLaneUnsupported: reportRequiredLaneUnsupported,
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

  /**
   * Whether this arm has already reported a required lane refused.
   *
   * Once per ARM, not once per lane and emphatically not once per tile: a
   * canvas with twelve open bodies whose host refuses `artifact.subscribe`
   * would otherwise ask for twelve replacements of one replica.
   *
   * Cleared by {@link detach}, which is what makes it once per arm rather than
   * once per SESSION. This object outlives the arms it serves: a fallback to
   * `@1` detaches, a later host upgrade re-selects lanes, and that is a NEW
   * arm on the same instance. A latch that never cleared would swallow the
   * second arm's refusal and leave the lanes half-installed with nothing left
   * to repair it - the exact state this signal exists to prevent, reachable
   * again one selection later.
   *
   * `detach` and not `attach`, and not a reconnect: a HOLD-resume plans no
   * transition steps, so it never detaches, which is precisely how the
   * once-per-arm guarantee survives a support reset.
   */
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
        // ANY control frame proves the subscribe is being served, which is the
        // whole capability question. Read off the frame rather than off the
        // manifest because the manifest is exactly what a remote peer never
        // resolves - see `answerProbe`'s callers and
        // `isMethodIncompatibleClose`.
        answerProbe("succeeded");
        // The LANE's event, before translation. The refetch obligation is
        // written against this vocabulary - the policy decides which frames
        // move the workspace context - and `legacyControlEventOf` narrows some
        // of them away (the lane's `dirty: null` emits nothing at all, and the
        // permission role is re-parsed), so folding the translated event would
        // hand the policy a different set of facts than its contract names.
        workspaceContext.noteControlEvent(event);
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
          // Before the probe answers, this IS the answer. After it, the arm is
          // already installed and this is a required lane going away, which
          // `answerProbe` would swallow (one answer per arm). Both are routed,
          // and each guards itself.
          answerProbe("unsupported");
          reportRequiredLaneUnsupported();
        }
        // The CONTROL lane's transitions and not the records lane's, because
        // the policy's reconnect trigger is one fact and two lanes reporting
        // the same reconnect would be two. This is the lane the contract names
        // - "the control lane is what tells a client its workspace context may
        // have moved" - and it is also the lane that is always attached, since
        // the probe opens it alone.
        workspaceContext.noteTransportStatus(status.connection);
        // The body lanes read the same fact for a different reason: a
        // reconnect ends the transport session a `terminal` body refusal was
        // scoped to, so it is the edge on which a refused body may be dialled
        // again. Off THIS lane for the reason named just above - one reconnect
        // is one fact - and off this lane in particular because a terminally
        // refused body has no lane of its own left to report anything.
        bodies.noteTransportStatus(status.connection);
        onControlEvent({
          kind: "transport-status",
          status: status.connection,
          reason: status.closeReason,
          // Same answer as the records lane's, for the same reason: no lane
          // negotiates the `@1` durability capability yet.
          durabilityStatusNegotiated: false,
          // This lane serves `control-snapshot`, so its open/close IS the
          // control cycle's boundary - the third consumer of the same
          // one-reconnect-is-one-fact rule the two calls above apply.
          ownsControlCycle: true,
          // The status lane carries no record rows; the records lane beside it
          // does, and reports its own transitions above.
          carriesRecords: false,
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
      // The tab-open read, on ATTACH and never on `probe`. A probe that
      // resolves method-unsupported installs the LEGACY arm, whose `earlyMeta`
      // frame is this same payload - so reading here would put two writers on
      // `snapshotMeta` for the one session that has a working alternative.
      // `start` is idempotent, so the reattach after a `manifest-changed`
      // replacement costs nothing; the epoch trigger is what refreshes there.
      workspaceContext.start();
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
      // This arm is over. Whatever attaches next is a new one and gets its own
      // single answer - see the latch's own doc for why session-scoped was a
      // defect rather than a simplification.
      requiredLaneUnsupportedReported = false;
      // The PROBE latch is the same rule, and it was the one member of the
      // pair not being reset here. Leaving it set made "one answer per arm"
      // read as one answer per RUNTIME, because this arm object is a `const`
      // built once and only ever detached - so a legacy install (which detaches
      // the probe's stream through this very function) permanently spent the
      // arm's only answer. Nothing could then move a tab whose host upgraded
      // underneath it, which is exactly the case the latch's doc says a new
      // attachment gets a fresh answer for.
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
     * Reopen the body lanes a whole-plane reset left owing nothing.
     *
     * SEPARATE from {@link reset}, and called separately, because of where the
     * bodies are actually destroyed. `resetAllPlanes` runs `laneArm.reset()`
     * and only THEN `rooms.reset()`, so a rebuild issued from inside `reset`
     * would reopen lanes and have the tier emptied underneath them a moment
     * later. The runtime calls this after the destruction instead.
     */
    rebuildBodiesAfterReset(cause: ReplicaResetCause): void {
      // ONE cause, and it is the only authority-side reason that discards
      // bodies without moving the authority epoch.
      //
      // Every other reason moves it, so the control handler's
      // `syncToAuthorityEpoch` closes each lane and reopens it under the new
      // epoch and the seeds arrive on their own. A SECURITY-epoch replacement
      // does not: the sync finds every lane already bound to the epoch it is
      // syncing to, skips them all, and the still-open subscriptions owe
      // nothing - from the host's side no transition occurred. Mounted editors
      // are then left without documents for the rest of the session, and later
      // updates apply against an empty tier.
      //
      // Same shape as the `resume-too-old` bug that produced
      // `resetStateRecordsOnly`, opposite remedy. There the bodies were still
      // VALID and the reset was too wide, so the fix was to stop discarding
      // them. Here discarding is right - authorization moved, so what this
      // client holds must be re-served under the new grant - and what is
      // missing is the reopen.
      //
      // A CLIENT-origin reset is not a member: `requestFreshSnapshot` closes
      // and reopens the sockets itself, so its lanes are rebuilt by the
      // reconnect rather than by anything here.
      if (cause.origin !== "authority") return;
      if (cause.reason !== "security-epoch-changed") return;
      bodies.rebuildDemandedBodies();
    },
  };
}
