import type {
  HostBusyBreakdown,
  HostStatusUpdateOperation,
  HostStatusUpdateProgress,
  HostUpdateTransactionCapability,
} from "@traycer/protocol/host/status/index";
import type { HostUpdateAttemptPhase } from "@traycer/protocol/config/host-update-attempt";

/**
 * The pure projection every update surface reads - landing banner, Settings selector badge, and selected-host Overview all derive from this one function, so the three cannot disagree about what a host is doing.
 */

/** Where an observation came from. Presentation and telemetry only. */
export type FleetUpdateSource =
  /** This computer's own host, over the local runner/host path. */
  | "local"
  /** The Settings-scoped host, over its own live connection. */
  | "selected"
  /** A remote row read over a BORROWED ready session - never a dial. */
  | "borrowed"
  /** Directory/registry coarse state only; no live read happened. */
  | "registry";

/** One `host.status` read, stamped with client-local freshness. */
export interface FleetUpdateWireObservation {
  readonly hostId: string;
  readonly source: FleetUpdateSource;
  readonly observedAtMs: number;
  /** After this instant the read is stale and projects `unknown`. */
  readonly freshUntilMs: number;
  /**
   * `null` means the PEER did not report - it is pre-`host.status@1.3`.
   * It does NOT mean "no update": see {@link projectFleetUpdateView}'s `unknown` arm.
   */
  readonly operation: HostStatusUpdateOperation | null;
  /** `null` = peer did not say. Every transaction gate fails closed on it. */
  readonly transaction: HostUpdateTransactionCapability | null;
  /**
   * The released two-state marker (`host.status@1.1`'s `updateProgress`), carried BESIDE the attempt rather than folded into it.
   */
  readonly coarseProgress: HostStatusUpdateProgress | null;
}

/** What the durable record on this machine establishes for the host-down window. */
export interface FleetUpdateRecordObservation {
  readonly hostId: string;
  /** Discriminant. Never one of {@link FleetUpdateSource} - no live read happened. */
  readonly source: "durable-record";
  readonly observedAtMs: number;
  readonly attemptId: string;
  readonly targetVersion: string;
  /** The phase the record names, already narrowed at the read boundary. */
  readonly phase: HostUpdateAttemptPhase;
}

/** Everything the projector accepts. */
export type FleetUpdateObservation =
  | FleetUpdateWireObservation
  | FleetUpdateRecordObservation;

/** Narrowing helper, so no consumer re-derives the discriminant test. */
export function isRecordObservation(
  observation: FleetUpdateObservation,
): observation is FleetUpdateRecordObservation {
  return observation.source === "durable-record";
}

/**
 * Measured progress, with the three quantities kept INDEPENDENT because the wire makes them independent: `percent`, `bytes` and `totalBytes` are each separately nullable, and a host that streams an unsized body reports bytes with no percentage at all.
 */
export type FleetUpdateProgress =
  | { readonly kind: "none" }
  /**
   * Running, and the host cannot express it as a fraction.
   * The BAR renders indeterminate; any counters here are still true and still rendered.
   */
  | {
      readonly kind: "indeterminate";
      readonly bytes: number | null;
      readonly totalBytes: number | null;
    }
  | {
      readonly kind: "determinate";
      readonly percent: number;
      readonly bytes: number | null;
      readonly totalBytes: number | null;
    };

export type FleetUpdateViewKind =
  /**
   * We do not know.
   * Covers a pre-1.3 peer, a stale or missing poll, and a lost session.
   */
  | "unknown"
  /** Read cleanly; this host has no attempt. */
  | "idle"
  /**
   * An update is in flight and the host can say nothing finer than that.
   * The legacy `traycer host update` path reports through the coarse `updateProgress` marker alone, which has no phase, no target and no percentage - so this kind exists for exactly that signal, and a surface renders it as a generic, indeterminate "Updating host".
   */
  | "updating"
  | "downloading"
  | "preparing"
  | "applying"
  | "waiting-for-work"
  | "waiting-to-activate"
  | "restarting"
  | "reconnecting"
  | "verifying"
  | "complete"
  | "failed"
  /** Fail-closed record evidence. Diagnostic and repairable, NOT a failure. */
  | "unavailable";

export interface FleetUpdateView {
  readonly kind: FleetUpdateViewKind;
  /** The attempt this view describes, when there is one to name. */
  readonly attemptId: string | null;
  readonly targetVersion: string | null;
  readonly progress: FleetUpdateProgress;
  /**
   * True when the view describes evidence we could not refresh - a stale poll, or a live phase whose liveness the host could not establish.
   */
  readonly qualified: boolean;
  /**
   * The phase we last actually OBSERVED, when `kind` has since decayed to `unknown` - and `null` in every other case.
   */
  readonly lastKnownKind: FleetUpdateViewKind | null;
  /** When {@link lastKnownKind} was observed. `null` whenever that is. */
  readonly lastObservedAtMs: number | null;
  /**
   * Live work blocking the update, from the SAME read as the phase.
   * `null` means the host did not report a count - never a fabricated zero.
   */
  readonly blockingSessionCount: number | null;
  readonly blockingBreakdown: HostBusyBreakdown | null;
  /** Phase-specific cause, for the `failed` arm only. */
  readonly errorMessage: string | null;
}

/** "We know nothing", as a value. */
export const UNKNOWN_FLEET_UPDATE_VIEW: FleetUpdateView = {
  kind: "unknown",
  attemptId: null,
  targetVersion: null,
  progress: { kind: "none" },
  qualified: true,
  lastKnownKind: null,
  lastObservedAtMs: null,
  blockingSessionCount: null,
  blockingBreakdown: null,
  errorMessage: null,
};

export interface FleetUpdateViewInput {
  /** `null` when nothing has been observed for this host yet. */
  readonly observation: FleetUpdateObservation | null;
  readonly nowMs: number;
  /** Whether this client currently has a live route to the host. */
  readonly connected: boolean;
}

/** Projects an observation into the one view every surface renders from. */
export function projectFleetUpdateView(
  input: FleetUpdateViewInput,
): FleetUpdateView {
  const { observation, nowMs } = input;
  if (observation === null) {
    return UNKNOWN_FLEET_UPDATE_VIEW;
  }

  // Host-down window: handled before the wire arms because it answers a different question with different evidence, and the guards below all presuppose a peer that spoke.
  if (isRecordObservation(observation)) {
    return {
      ...UNKNOWN_FLEET_UPDATE_VIEW,
      attemptId: observation.attemptId,
      targetVersion: observation.targetVersion,
      lastKnownKind: phaseKind(observation.phase, false),
      lastObservedAtMs: observation.observedAtMs,
    };
  }

  const stale = nowMs > observation.freshUntilMs;
  const operation = observation.operation;

  // THE PEER SAID NOTHING.
  // Kept as its own branch, above and separate from `kind: "none"`, and deliberately NOT merged with it - the two look alike (both are "no attempt to show") and mean opposite things:
  if (operation === null) {
    // A pre-@1.3 peer cannot report an attempt, but it CAN report the coarse `updateProgress` marker (`host.status@1.1`), and for that cohort the marker is the only update signal there is.
    const coarseView = coarseProgressView(observation, stale);
    if (coarseView !== null) return coarseView;
    return UNKNOWN_FLEET_UPDATE_VIEW;
  }

  if (operation.kind === "none") {
    // "No attempt record" is NOT "no update".
    // The shipped legacy update path (`traycer host update`, every host while the executor cohort is shadow -disabled) writes no schema-v2 record at all; it reports through the coarse `updateProgress` marker, and a @1.3 host on that path answers `{kind:"none"}`.
    const coarseView = coarseProgressView(observation, stale);
    if (coarseView !== null) return coarseView;
    // A stale read of a quiet host is still unknown rather than idle: the absence of an attempt was true when we looked, and we have since stopped looking.
    // Claiming "up to date" from a reading we cannot refresh is the same class of error as claiming an update is running from one.
    if (stale) {
      return {
        ...UNKNOWN_FLEET_UPDATE_VIEW,
        lastKnownKind: "idle",
        lastObservedAtMs: observation.observedAtMs,
      };
    }
    return { ...UNKNOWN_FLEET_UPDATE_VIEW, kind: "idle", qualified: false };
  }

  if (operation.kind === "unavailable") {
    // Deliberately NOT downgraded by staleness.
    // This is a durable fact about a file on that host, not a live reading: a corrupt record does not repair itself because our poll lapsed, and hiding it behind `unknown` would take the repair path off the screen.
    return {
      ...UNKNOWN_FLEET_UPDATE_VIEW,
      kind: "unavailable",
      qualified: stale,
    };
  }

  const base = {
    attemptId: operation.attemptId,
    targetVersion: operation.targetVersion,
    progress: projectProgress(operation),
    blockingSessionCount: operation.busySessionCount,
    blockingBreakdown: operation.busyBreakdown,
    errorMessage: operation.error?.message ?? null,
  } satisfies Omit<
    FleetUpdateView,
    "kind" | "qualified" | "lastKnownKind" | "lastObservedAtMs"
  >;
  const noRetainedPhase = {
    lastKnownKind: null,
    lastObservedAtMs: null,
  } satisfies Pick<FleetUpdateView, "lastKnownKind" | "lastObservedAtMs">;

  if (stale) {
    // The last phase, explicitly qualified, and now actually CARRIED rather than described in a comment.
    // `kind` decays to `unknown` - every gate and every cadence decision reads it, and both must treat this host as one we know nothing current about - while `lastKnownKind` keeps the phase so a surface can say "last seen preparing v1.2.3" instead of dropping to.
    return {
      ...base,
      kind: "unknown",
      qualified: true,
      lastKnownKind: phaseKind(operation.phase, input.connected),
      lastObservedAtMs: observation.observedAtMs,
    };
  }

  // Liveness is the host's read-side conclusion joining the attempt lock's
  // holder, and a client cannot re-derive it - so it outranks the phase.
  if (operation.liveness === "interrupted") {
    // The ONLY route to `failed` that the phase alone does not carry: a non-terminal, non-parked attempt with positive proof its executor is gone.
    // `indeterminate` deliberately does not reach here.
    return {
      ...base,
      ...noRetainedPhase,
      kind: "failed",
      qualified: false,
      errorMessage: base.errorMessage ?? "The update was interrupted.",
    };
  }

  const view = {
    ...base,
    ...noRetainedPhase,
    kind: phaseKind(operation.phase, input.connected),
  };
  // `indeterminate` means the host could not establish whether the executor is alive.
  // The phase is still the best thing we have, so it is shown - and qualified, so no surface presents it as confirmed-live.
  return { ...view, qualified: operation.liveness === "indeterminate" };
}

/**
 * What the coarse `updateProgress` marker says, as a view kind - or `null` when it says nothing, which is the only case that may fall through to `idle`.
 */
/**
 * The view the coarse `updateProgress` marker projects on its own, or `null` when the peer reported no marker.
 * Shared by the two arms that have no attempt to read - a pre-@1.3 peer (`operation === null`) and a @1.3 peer with no record (`kind: "none"`) - so the two cannot drift on how the legacy path's only signal is rendered.
 */
function coarseProgressView(
  observation: FleetUpdateWireObservation,
  stale: boolean,
): FleetUpdateView | null {
  const coarse = coarseKind(observation.coarseProgress);
  if (coarse === null) return null;
  if (stale) {
    return {
      ...UNKNOWN_FLEET_UPDATE_VIEW,
      lastKnownKind: coarse.kind,
      lastObservedAtMs: observation.observedAtMs,
      errorMessage: coarse.errorMessage,
    };
  }
  return {
    ...UNKNOWN_FLEET_UPDATE_VIEW,
    kind: coarse.kind,
    qualified: false,
    // Indeterminate, never `none`: the marker proves motion and nothing about how far along it is, and a surface draws that as a moving bar rather than as an operation with no progress to show.
    progress:
      coarse.kind === "updating"
        ? { kind: "indeterminate", bytes: null, totalBytes: null }
        : { kind: "none" },
    errorMessage: coarse.errorMessage,
  };
}

function coarseKind(coarse: HostStatusUpdateProgress | null): {
  readonly kind: "updating" | "failed";
  readonly errorMessage: string | null;
} | null {
  if (coarse === null) return null;
  if (coarse.state === "updating") {
    return { kind: "updating", errorMessage: null };
  }
  return {
    kind: "failed",
    errorMessage:
      coarse.error ?? "The last update attempt failed on this host.",
  };
}

/** Whether a view has nothing a person needs to see about an update. */
export function isQuietUpdateView(view: FleetUpdateView): boolean {
  if (view.kind === "idle") return true;
  if (view.kind !== "unknown") return false;
  return (
    view.lastKnownKind === null ||
    view.lastKnownKind === "idle" ||
    view.lastKnownKind === "unknown"
  );
}

/**
 * The ONE phase -> kind mapping.
 * Both observation arms call it.
 */
function phaseKind(
  phase: HostUpdateAttemptPhase,
  connected: boolean,
): FleetUpdateViewKind {
  switch (phase) {
    case "downloading":
      return "downloading";
    case "preparing":
      return "preparing";
    case "applying":
      return "applying";
    case "waiting-for-work":
      return "waiting-for-work";
    case "waiting-to-activate":
      return "waiting-to-activate";
    case "restarting":
      // The one place the client's own vantage changes the answer.
      // Same host phase, two honest renderings: still connected means the restart has been promised but not yet taken the connection down; connection lost means we are waiting for it to come back.
      return connected ? "restarting" : "reconnecting";
    case "verifying":
      return "verifying";
    case "complete":
      return "complete";
    case "failed":
      return "failed";
    case "superseded":
      // A superseded attempt is terminal bookkeeping, not something a person needs to act on: a NEWER attempt replaced it, and that attempt is what the record now describes.
      // Showing it would put a dead target on screen beside the live one.
      return "idle";
  }
}

function projectProgress(
  operation: Extract<HostStatusUpdateOperation, { kind: "attempt" }>,
): FleetUpdateProgress {
  // Parked and terminal attempts are not making progress, so they carry none -
  // a bar frozen at 40% under "Waiting for work" reads as a stall.
  if (operation.execution !== "active") return { kind: "none" };
  const progress = operation.progress;
  // Read ONCE, above the percentage branch, and carried into both arms.
  // The three fields are independently nullable on the wire, so "no percentage" says nothing about whether bytes were measured - reading the counters inside the determinate arm only, as this did, threw away a complete `80 MB of 200 MB` because the host could.
  const bytes = progress?.bytes ?? null;
  const totalBytes = progress?.totalBytes ?? null;
  if (progress === null || progress.percent === null) {
    // Active with nothing measured is explicitly INDETERMINATE, never 0%.
    // A zero-width determinate bar and an unmeasured one look identical for the first instant and then diverge into a lie.
    return { kind: "indeterminate", bytes, totalBytes };
  }
  return {
    kind: "determinate",
    percent: clampPercent(progress.percent),
    bytes,
    totalBytes,
  };
}

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, percent));
}

/** Whether this view entitles a surface to offer **Force restart…**. */
export function offersForceRestart(view: FleetUpdateView): boolean {
  return (
    view.kind === "waiting-for-work" &&
    view.blockingSessionCount !== null &&
    view.blockingSessionCount > 0
  );
}

/**
 * Hold page-wide lifecycle controls only while execution is active; parked, terminal, `unknown`, and coarse `updating` fail open.
 * Does not gate starting a conflicting update (that is the host contender boundary).
 */
export function holdsLifecycleGate(view: FleetUpdateView): boolean {
  switch (view.kind) {
    case "downloading":
    case "preparing":
    case "applying":
    case "restarting":
    case "verifying":
      return true;
    case "updating":
    case "reconnecting":
    case "waiting-for-work":
    case "waiting-to-activate":
    case "complete":
    case "failed":
    case "unavailable":
    case "idle":
    case "unknown":
      return false;
  }
}

/** Whether this host is running an operation worth polling at the fast cadence. */
export function warrantsFastPoll(view: FleetUpdateView): boolean {
  if (view.qualified) return false;
  switch (view.kind) {
    case "downloading":
    case "preparing":
    case "applying":
    case "restarting":
    case "reconnecting":
    case "verifying":
      return true;
    case "updating":
    case "unknown":
    case "idle":
    case "waiting-for-work":
    case "waiting-to-activate":
    case "complete":
    case "failed":
    case "unavailable":
      return false;
  }
}

/** Precedence between a live read and the durable record. */
export function preferLiveOverRecord(
  wire: FleetUpdateWireObservation | null,
  record: FleetUpdateRecordObservation | null,
  nowMs: number,
): FleetUpdateObservation | null {
  if (wire !== null && nowMs <= wire.freshUntilMs) return wire;
  // Stale or absent wire.
  // The record fills the window when there is one; when there is not, the stale wire is retained rather than dropped, because its own stale arm still carries `lastKnownKind`.
  return record ?? wire;
}
