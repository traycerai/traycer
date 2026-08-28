import type {
  HostBusyBreakdown,
  HostStatusUpdateOperation,
  HostUpdateTransactionCapability,
} from "@traycer/protocol/host/status/index";
import type { HostUpdateAttemptPhase } from "@traycer/protocol/config/host-update-attempt";

/**
 * The pure projection every update surface reads — landing banner, Settings
 * selector badge, and selected-host Overview all derive from this one function,
 * so the three cannot disagree about what a host is doing.
 *
 * Nothing here reads a clock, a query, or a store: the caller supplies the
 * observation and `nowMs`. That is what makes the staleness rules testable
 * without fake timers and what keeps the same input rendering the same view on
 * every surface.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE, stated once because every arm below
 * is a consequence of it: **absence of evidence is never evidence of absence.**
 * A peer that said nothing, a poll that did not come back, and a record that
 * could not be read are three different kinds of "we do not know", and none of
 * them may render as "no update is running" or as "the update failed".
 */

/** Where an observation came from. Presentation and telemetry only. */
export type FleetUpdateSource =
  /** This computer's own host, over the local runner/host path. */
  | "local"
  /** The Settings-scoped host, over its own live connection. */
  | "selected"
  /** A remote row read over a BORROWED ready session — never a dial. */
  | "borrowed"
  /** Directory/registry coarse state only; no live read happened. */
  | "registry";

/**
 * One `host.status` read, stamped with client-local freshness.
 *
 * `observedAtMs` / `freshUntilMs` are **presentation only** and must never
 * order attempt state — that is `attemptId + generation + sequence`, which is
 * why no timestamp crosses the wire at all. Two clients with skewed clocks have
 * to be unable to disagree about which attempt is newer; stamping locally on
 * receipt keeps the freshness question (a local one) away from the ordering
 * question (a distributed one).
 */
export interface FleetUpdateWireObservation {
  readonly hostId: string;
  readonly source: FleetUpdateSource;
  readonly observedAtMs: number;
  /** After this instant the read is stale and projects `unknown`. */
  readonly freshUntilMs: number;
  /**
   * `null` means the PEER did not report — it is pre-`host.status@1.3`. It does
   * NOT mean "no update": see {@link projectFleetUpdateView}'s `unknown` arm.
   */
  readonly operation: HostStatusUpdateOperation | null;
  /** `null` = peer did not say. Every transaction gate fails closed on it. */
  readonly transaction: HostUpdateTransactionCapability | null;
}

/**
 * What the DURABLE RECORD on this machine establishes, for the host-down
 * window (Ticket 07 §5.2.7).
 *
 * ## Why this is a second arm rather than a synthesized `operation`
 *
 * A `host.status` operation carries `liveness`, `execution`, busy counts and an
 * error — facts only a RUNNING host can report. The record establishes none of
 * them. Building an `operation` here would mean inventing those fields, and an
 * invented `liveness` is the difference between "an update is running" and "a
 * file says an update was running": exactly the fabrication the module header
 * forbids. So the arm carries only what the record actually says, and the
 * projector has a branch that knows it cannot ask liveness questions of it.
 *
 * ## What it is NOT
 *
 * Not a substitute for a live read. A fresh wire observation always outranks
 * it ({@link preferLiveOverRecord}), because a running host reporting on itself
 * is strictly better evidence than a file describing what it last wrote.
 */
export interface FleetUpdateRecordObservation {
  readonly hostId: string;
  /** Discriminant. Never one of {@link FleetUpdateSource} — no live read happened. */
  readonly source: "durable-record";
  readonly observedAtMs: number;
  readonly attemptId: string;
  readonly targetVersion: string;
  /** The phase the record names, already narrowed at the read boundary. */
  readonly phase: HostUpdateAttemptPhase;
}

/**
 * Everything the projector accepts.
 *
 * Discriminated on `source`, and the record arm's literal is deliberately
 * OUTSIDE `FleetUpdateSource` so the two can never be confused by a widening
 * of that union — a new live source is still a live source, and adding one
 * must not silently make it record-derived.
 */
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
 * Measured progress, with the three quantities kept INDEPENDENT because the
 * wire makes them independent: `percent`, `bytes` and `totalBytes` are each
 * separately nullable, and a host that streams an unsized body reports bytes
 * with no percentage at all.
 *
 * `indeterminate` therefore still carries its counters. The first shape of this
 * type dropped them — it treated "no percentage" as "nothing measured" — which
 * silently discarded a real `80 MB of 200 MB` and left the surface with an
 * anonymous moving bar. The bar's determinacy and the byte detail are two
 * different questions, and the contract asks for "real percentage/bytes when
 * known", not for one gated on the other.
 */
export type FleetUpdateProgress =
  | { readonly kind: "none" }
  /**
   * Running, and the host cannot express it as a fraction. The BAR renders
   * indeterminate; any counters here are still true and still rendered.
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
   * We do not know. Covers a pre-1.3 peer, a stale or missing poll, and a lost
   * session. NEVER collapses into `idle` or `failed`.
   */
  | "unknown"
  /** Read cleanly; this host has no attempt. */
  | "idle"
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
   * True when the view describes evidence we could not refresh — a stale poll,
   * or a live phase whose liveness the host could not establish.
   *
   * Surfaces MUST qualify a view carrying this ("last seen …") rather than
   * presenting it as current. It is deliberately separate from `kind`: a
   * `downloading` that has gone stale is still the last thing we knew, and
   * throwing that away would replace a qualified truth with nothing.
   */
  readonly qualified: boolean;
  /**
   * The phase we last actually OBSERVED, when `kind` has since decayed to
   * `unknown` — and `null` in every other case.
   *
   * The invariant, which is what makes this safe to add beside `kind`:
   * **`lastKnownKind !== null` implies `kind === "unknown"`.** It is never a
   * second opinion about the present; it is the only opinion about the past,
   * and it exists because the two were previously the same field and the past
   * lost.
   *
   * Staleness used to overwrite the observed phase with `unknown` and drop it,
   * while the comment beside that line promised a surface could still say "last
   * seen preparing". Nothing could: the phase was gone by the time any consumer
   * saw the view, so an offline row rendered a blank badge and the banner the
   * generic "Update state unknown" — the required qualified state was not merely
   * unrendered, it was unrepresentable.
   *
   * WHAT THIS MUST NOT DO. Every gate and every cadence decision reads `kind`,
   * which is `unknown`, so a retained phase can neither hold a lifecycle gate
   * nor earn the active poll. That is not an accident of the current consumers —
   * it is the point. Reintroducing the lock through a retained `downloading`
   * would be the stale-gate defect a second time, arriving through the fix for
   * a different one.
   *
   * Surfaces MUST qualify it explicitly ("last seen …"). Rendering it bare is
   * indistinguishable from claiming it is current.
   */
  readonly lastKnownKind: FleetUpdateViewKind | null;
  /** When {@link lastKnownKind} was observed. `null` whenever that is. */
  readonly lastObservedAtMs: number | null;
  /**
   * Live work blocking the update, from the SAME read as the phase. `null`
   * means the host did not report a count — never a fabricated zero.
   *
   * Non-null with a positive count is what entitles a surface to show
   * **Force restart…**.
   */
  readonly blockingSessionCount: number | null;
  readonly blockingBreakdown: HostBusyBreakdown | null;
  /** Phase-specific cause, for the `failed` arm only. */
  readonly errorMessage: string | null;
}

/**
 * "We know nothing", as a value.
 *
 * Exported so no caller has to hand-write this literal. Two already did, and a
 * hand-written copy is a maintenance trap with a delay fuse: adding
 * `lastKnownKind`/`lastObservedAtMs` to {@link FleetUpdateView} would have
 * broken each copy in a different file, and the tempting fix at each site is to
 * paste the missing fields rather than to notice there should only ever have
 * been one of these.
 */
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
  /**
   * Whether this client currently has a live route to the host.
   *
   * Used for exactly one thing: telling `restarting` from `reconnecting`. The
   * host says `restarting` — that is its phase — and a client that has since
   * lost the connection is the only party that can observe the *reconnect*
   * half. A client that never saw the restart shows generic offline/unknown
   * instead, which is the accepted cost of having no cloud progress journal.
   */
  readonly connected: boolean;
}

/**
 * Projects an observation into the one view every surface renders from.
 *
 * The order of the guards is the contract, so it is worth reading as a
 * sequence rather than as a switch:
 *
 * 1. **No observation at all** → `unknown`. A cache-cold client knows nothing.
 * 2. **Stale observation** → `unknown`, but *qualified* and carrying the last
 *    phase, so a surface can say "last seen downloading" rather than going
 *    blank. A missed poll is not a state change on the host.
 * 3. **`operation === null`** → `unknown`. This is the one that is easy to get
 *    wrong and expensive when wrong: for a REMOTE host on a per-host `manual`
 *    update policy this is potentially the indefinite steady state, not an
 *    upgrade transient. Reading it as "no update in progress" would show those
 *    users nothing during a real update, for as long as their host stayed on
 *    `@1.2`.
 * 4. **`kind: "none"`** → `idle`. The host looked and there is nothing.
 * 5. **`kind: "unavailable"`** → `unavailable`. Fail-closed evidence stays
 *    distinct from both "no attempt" and "failed".
 * 6. **`kind: "attempt"`** → liveness first, then phase.
 */
export function projectFleetUpdateView(
  input: FleetUpdateViewInput,
): FleetUpdateView {
  const { observation, nowMs } = input;
  if (observation === null) {
    return UNKNOWN_FLEET_UPDATE_VIEW;
  }

  // THE HOST-DOWN WINDOW (Ticket 07 §5.2.7). Handled before the wire arms
  // because it answers a different question with different evidence, and the
  // guards below all presuppose a peer that spoke.
  //
  // The record establishes that an attempt EXISTS and what phase it last
  // reached. It establishes nothing about whether anything is still working on
  // it — no liveness, no execution, no busy counts. So this projects the
  // qualified-stale shape and NOT a live phase:
  //
  //   kind: "unknown"        - every gate and every cadence decision reads
  //                            `kind`, and a host we cannot reach must hold no
  //                            gate and earn no active poll.
  //   lastKnownKind: <phase> - the phase is still the last thing we knew, and
  //                            throwing it away would replace a qualified
  //                            truth with nothing.
  //
  // That is exactly the distinction §5.2.7 asks for: "attempt progressing" is a
  // live `kind`, "attempt exists, host unreachable" is `unknown` + a retained
  // phase, so a surface renders "last seen preparing v2.0.0" rather than either
  // a bare offline badge or a false claim of progress.
  //
  // `connected: false` is passed deliberately rather than threading
  // `input.connected`: the only phase whose rendering depends on the client's
  // vantage is `restarting`, and reading a record because the host is down IS
  // the disconnected vantage. Passing `true` here would render `restarting`
  // for a host that is not answering.
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

  // THE PEER SAID NOTHING. Kept as its own branch, above and separate from
  // `kind: "none"`, and deliberately NOT merged with it — the two look alike
  // (both are "no attempt to show") and mean opposite things:
  //
  //   null        -> this peer is pre-@1.3. It cannot tell us about attempts at
  //                  all. It may well be updating right now.
  //   kind:"none" -> this peer CAN tell us, looked, and there is nothing.
  //
  // Collapsing them renders a mid-update remote host as "up to date". That is
  // not a hypothetical: for a remote host on a per-host `manual` update policy
  // administered from another machine, `null` is potentially the INDEFINITE
  // steady state rather than an upgrade transient, so the wrong answer would
  // persist for as long as that host stayed on @1.2.
  //
  // Written as two independent early returns rather than one guard with an
  // inner ternary so that no single edit — a "simplification", a merged
  // condition — can silently turn the first into the second.
  if (operation === null) {
    return UNKNOWN_FLEET_UPDATE_VIEW;
  }

  if (operation.kind === "none") {
    // A stale read of a quiet host is still unknown rather than idle: the
    // absence of an attempt was true when we looked, and we have since stopped
    // looking. Claiming "up to date" from a reading we cannot refresh is the
    // same class of error as claiming an update is running from one.
    //
    // The retained phase is `idle` because that IS what we last saw, and the
    // offline row in the experience contract wants exactly that ("last known
    // version; live update state unknown"). Whether a surface says so is the
    // surface's call — this layer's job is not to throw the fact away.
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
    // Deliberately NOT downgraded by staleness. This is a durable fact about a
    // file on that host, not a live reading: a corrupt record does not repair
    // itself because our poll lapsed, and hiding it behind `unknown` would take
    // the repair path off the screen.
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
    // The last phase, explicitly qualified, and now actually CARRIED rather
    // than described in a comment. `kind` decays to `unknown` — every gate and
    // every cadence decision reads it, and both must treat this host as one we
    // know nothing current about — while `lastKnownKind` keeps the phase so a
    // surface can say "last seen preparing v1.2.3" instead of dropping to a
    // bare "offline" that loses everything we knew.
    return {
      ...base,
      kind: "unknown",
      qualified: true,
      lastKnownKind: phaseKind(operation.phase, input.connected),
      lastObservedAtMs: observation.observedAtMs,
    };
  }

  // Liveness is the host's read-side conclusion joining the attempt lock's
  // holder, and a client cannot re-derive it — so it outranks the phase.
  if (operation.liveness === "interrupted") {
    // The ONLY route to `failed` that the phase alone does not carry: a
    // non-terminal, non-parked attempt with positive proof its executor is
    // gone. `indeterminate` deliberately does not reach here.
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
  // `indeterminate` means the host could not establish whether the executor is
  // alive. The phase is still the best thing we have, so it is shown — and
  // qualified, so no surface presents it as confirmed-live.
  //
  // No retained phase here even though this view IS qualified: `kind` is the
  // live phase, so there is nothing in the past that `kind` is not already
  // saying. `lastKnownKind` is populated only where `kind` decayed to
  // `unknown` — that is the invariant the field's doc states.
  return { ...view, qualified: operation.liveness === "indeterminate" };
}

/**
 * The ONE phase -> kind mapping. Both observation arms call it.
 *
 * Takes the phase rather than the operation precisely so the record arm can
 * reach it: a second copy of this switch is the duplicated-policy class this
 * epic keeps paying for, and here it would mean the banner and the badge could
 * disagree about what `restarting` looks like.
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
      // The one place the client's own vantage changes the answer. Same host
      // phase, two honest renderings: still connected means the restart has
      // been promised but not yet taken the connection down; connection lost
      // means we are waiting for it to come back.
      return connected ? "restarting" : "reconnecting";
    case "verifying":
      return "verifying";
    case "complete":
      return "complete";
    case "failed":
      return "failed";
    case "superseded":
      // A superseded attempt is terminal bookkeeping, not something a person
      // needs to act on: a NEWER attempt replaced it, and that attempt is what
      // the record now describes. Showing it would put a dead target on screen
      // beside the live one.
      return "idle";
  }
}

function projectProgress(
  operation: Extract<HostStatusUpdateOperation, { kind: "attempt" }>,
): FleetUpdateProgress {
  // Parked and terminal attempts are not making progress, so they carry none —
  // a bar frozen at 40% under "Waiting for work" reads as a stall.
  if (operation.execution !== "active") return { kind: "none" };
  const progress = operation.progress;
  // Read ONCE, above the percentage branch, and carried into both arms. The
  // three fields are independently nullable on the wire, so "no percentage"
  // says nothing about whether bytes were measured — reading the counters
  // inside the determinate arm only, as this did, threw away a complete
  // `80 MB of 200 MB` because the host could not also express it as a
  // fraction.
  const bytes = progress?.bytes ?? null;
  const totalBytes = progress?.totalBytes ?? null;
  if (progress === null || progress.percent === null) {
    // Active with nothing measured is explicitly INDETERMINATE, never 0%. A
    // zero-width determinate bar and an unmeasured one look identical for the
    // first instant and then diverge into a lie. That is about the BAR; the
    // counters ride along and are rendered beside it.
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

/**
 * Whether this view entitles a surface to offer **Force restart…**.
 *
 * Two conditions, both required. The attempt must be parked on live work
 * (`waiting-for-work`), and the host must have REPORTED a positive count from
 * the same read. A `null` count is not zero and not "probably fine": it means
 * no live source, and offering to end work we cannot count is how a button
 * promises "ends 2 sessions" and ends five.
 *
 * This never gates the host's own Restart control. Per the ticket's standing
 * rule, update state is not a host-action mutex — the overflow Restart stays
 * available whatever this returns.
 */
export function offersForceRestart(view: FleetUpdateView): boolean {
  return (
    view.kind === "waiting-for-work" &&
    view.blockingSessionCount !== null &&
    view.blockingSessionCount > 0
  );
}

/**
 * Whether an update is genuinely EXECUTING right now — the only thing that may
 * hold a page-wide lifecycle gate.
 *
 * This exists because the coarse `updateProgress` field cannot answer it, and
 * the difference is a shipped-defect-sized gap. Ticket 04's derivation maps a
 * PARKED attempt (`waiting-for-work`, `waiting-to-activate`) to
 * `{state:"updating"}` — correctly, for its own purpose: bytes or an activation
 * really are still pending, and calling it `failed` would be worse. But a
 * consumer that reads "updating" as "a mutation is in flight, lock the page"
 * then locks it for the entire life of the park, and `waiting-to-activate` is
 * designed to survive a reboot and sit for a week.
 *
 * The result would be the exact inversion the ticket forbids twice: a parked
 * update disabling Restart, Diagnostics and the service verbs — while the
 * restart it is waiting for is the user's only way out. A banner may inform and
 * may offer **Force restart…**; it may never be the thing standing between a
 * person and their host.
 *
 * So: `execution === "active"` only. Parked is not executing. Terminal is not
 * executing. `unknown` is not executing either — and that last one is a
 * deliberate fail-OPEN rather than fail-closed, which is worth stating because
 * it inverts this codebase's usual instinct. The risk of leaving controls live
 * during an unobserved update is a refused or queued mutation; the risk of
 * locking them on a stale reading is a host nobody can recover, indefinitely,
 * with no way to clear it. Only the second is unrecoverable, so `unknown`
 * leaves the controls alone.
 *
 * Note what this does NOT gate: starting a conflicting UPDATE. A parked attempt
 * absolutely should stop a second install being launched over it — that is the
 * contender boundary's job on the host, and it refuses with `already-updating`.
 * This predicate is only about the surrounding lifecycle controls.
 */
export function holdsLifecycleGate(view: FleetUpdateView): boolean {
  switch (view.kind) {
    case "downloading":
    case "preparing":
    case "applying":
    case "restarting":
    case "verifying":
      return true;
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

/**
 * Whether this host is running an operation worth polling at the fast cadence.
 *
 * Only a genuinely ACTIVE, unqualified operation earns ~2s. A parked attempt
 * can sit for a week (`waiting-to-activate` survives a reboot by design), a
 * terminal one is retained for seven days, and a qualified one is evidence we
 * already know we cannot refresh — none of those justify polling a host every
 * two seconds, and doing so would be the retry storm §6 forbids.
 */
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

/**
 * Precedence between a live read and the durable record (Ticket 07 §5.2.7).
 *
 * A FRESH wire observation always wins: a running host reporting on itself is
 * strictly better evidence than a file describing what it last wrote, and the
 * record arm exists for the host-down window only.
 *
 * Once the wire read has gone stale the record is better — it was read from
 * this machine's disk just now, so it is a current reading of a durable fact,
 * where the stale wire observation is an old reading of a live one.
 *
 * Deliberately NOT expressed as "whichever was observed most recently". That
 * rule looks equivalent and is not: the record is re-read on every tick, so its
 * `observedAtMs` is always newer, and a recency comparison would let it
 * outrank a perfectly good live read and permanently suppress real progress.
 */
export function preferLiveOverRecord(
  wire: FleetUpdateWireObservation | null,
  record: FleetUpdateRecordObservation | null,
  nowMs: number,
): FleetUpdateObservation | null {
  if (wire !== null && nowMs <= wire.freshUntilMs) return wire;
  // Stale or absent wire. The record fills the window when there is one; when
  // there is not, the stale wire is retained rather than dropped, because its
  // own stale arm still carries `lastKnownKind`.
  return record ?? wire;
}
