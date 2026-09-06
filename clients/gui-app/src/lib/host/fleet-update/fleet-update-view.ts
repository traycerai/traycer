import type {
  HostBusyBreakdown,
  HostStatusUpdateOperation,
  HostStatusUpdateProgress,
  HostUpdateTransactionCapability,
} from "@traycer/protocol/host/status/index";
import {
  isTerminalPhase,
  type HostUpdateAttemptPhase,
} from "@traycer/protocol/config/host-update-attempt";
import type { LocalAttemptLiveness } from "@traycer-clients/shared/platform/runner-host";
import type { LegacyUpdateFacts } from "@/lib/host/fleet-update/legacy-update-facts";

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
  /**
   * The released two-state marker (`host.status@1.1`'s `updateProgress`),
   * carried BESIDE the attempt rather than folded into it.
   *
   * It is the only update signal the shipped legacy path emits: `traycer host
   * update` writes `update-progress.json` around download → swap → restart →
   * health probe and never a schema-v2 attempt record while the executor
   * cohort is shadow-disabled. A @1.3 host running that path answers
   * `updateOperation: {kind:"none"}` (it read the record; there is none) AND
   * `updateProgress: {state:"updating"}` at the same time, and only this field
   * lets the projector tell that host apart from a genuinely quiet one.
   *
   * `null` when the peer reported nothing in that field.
   */
  readonly coarseProgress: HostStatusUpdateProgress | null;
  /**
   * What the install and staged RECORDS say about a parked legacy update
   * (`legacy-update-facts.ts`), derived by the caller from
   * `host.getInstallationInfo` beside this same `host.status` read.
   *
   * The legacy updater WITHDRAWS its marker when a busy host makes it stop, so
   * for the two parks it can leave behind — bytes installed but not running,
   * bytes staged and waiting — the coarse field says nothing and these facts
   * are the only signal. Consulted after the coarse marker and before `idle`.
   *
   * `null` when the caller had no installation read to derive from: the
   * borrowed fleet leg, the landing banner (which keeps its own desktop-status
   * debt arm), and a surface whose installation query has not answered. Like
   * every other `null` on this record it means "not observed", never "no
   * park".
   */
  readonly legacyFacts: LegacyUpdateFacts | null;
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
  /**
   * What the READER's own holder probe established (D13), never something
   * derived from the record's contents.
   *
   * This is the one fact the record cannot supply about itself: a file saying
   * `restarting` proves an executor once wrote that, never that one is still
   * carrying it. `live` is minted only from a `holder-live` probe whose record
   * identity was unchanged across a bracketing re-read; `interrupted` and
   * `unknown` are conclusions this projector keeps OUTSIDE the lifecycle gate.
   */
  readonly liveness: LocalAttemptLiveness;
  /**
   * The PROBER's clock at the probe that produced {@link liveness}, or `null`
   * when no probe ran (parked and terminal records are never probed).
   *
   * A positive proof has to be allowed to expire, which is why this travels
   * beside the verdict rather than being folded into it. The controller query
   * that carries these facts keeps its last value indefinitely
   * (`staleTime: Infinity`) and the publisher stops publishing when its read
   * fails, so `live` with no deadline would hold a lifecycle gate open forever
   * on a payload nothing is refreshing.
   */
  readonly livenessObservedAtMs: number | null;
  /**
   * The record's OWN last-write timestamp (ISO 8601), as the record states it.
   *
   * Ordering-only, and only across DIFFERENT attempts — see
   * {@link preferLiveOverRecord}. Not a freshness signal: how old the record is
   * says nothing about whether anything is still working on it.
   */
  readonly updatedAt: string;
  /**
   * The record's position, which is what orders two observations of the SAME
   * attempt. Monotone per attempt by the writer's construction, and — unlike
   * any timestamp — comparable across the two readers (the host's observer and
   * this machine's own read) without trusting either one's clock.
   */
  readonly generation: number;
  readonly sequence: number;
}

/**
 * How long a POSITIVE holder probe may still be presented as proof (D13).
 *
 * Five seconds: comfortably above the 750 ms cadence a live record is
 * published at, so an ordinary publication always renews the proof before it
 * lapses, and short enough that a publisher which has stopped publishing
 * cannot hold the lifecycle gate for more than one blink.
 *
 * Measured against a clock that TICKS on its own — never against the last
 * `host.status` success, which stops advancing exactly when the host goes
 * down, which is precisely when this proof is load-bearing.
 */
export const LOCAL_LIVENESS_PROOF_MS = 5_000;

/**
 * How far a probe stamp may sit in this reader's FUTURE before it stops
 * counting as proof.
 *
 * The rule D13 states is `0 ≤ nowMs - livenessObservedAtMs`, and a strict `0`
 * would be wrong here for a reason that has nothing to do with clocks
 * disagreeing: `nowMs` comes from a one-second renderer tick, so it lags real
 * time by up to that interval, while the stamp is written at the instant of
 * the probe. A record published 200 ms after the last tick therefore carries a
 * stamp "ahead" of `nowMs` every single time — refusing it would reject
 * exactly the freshest proofs.
 *
 * So the lower bound is one tick's worth of slack, which is what the
 * quantisation can produce and nothing more. A real backward wall-clock step —
 * the `lock.ts` TTL pitfall this bound exists for — moves the clock by seconds
 * or minutes and is still refused.
 */
export const LOCAL_LIVENESS_CLOCK_SLACK_MS = 1_000;

/**
 * The two instants the local (wire + record) projection is evaluated against.
 *
 * They are separate because the two legs measure different things and one
 * clock cannot answer both. Passing the same value for both is a legitimate
 * thing for a test to do, but a production call site that does it has a bug in
 * one leg or the other — see {@link preferLiveOverRecord} for which.
 */
export interface LocalUpdateClock {
  /**
   * The instant the WIRE read was taken at (the query's `dataUpdatedAt`).
   *
   * A healthy read must be fresh by construction, because its deadline was
   * derived from this same instant plus the query's health. Anything that
   * advances independently turns "the round trip was slow" into "the host
   * stopped reporting", which is a different and much louder claim.
   */
  readonly wireNowMs: number;
  /**
   * A clock that TICKS, for the RECORD leg alone.
   *
   * The record's proof expires on its own, and every timestamp attached to the
   * record stops advancing in exactly the situation the record is read in — so
   * only a clock nobody has to refresh can retire it.
   */
  readonly recordNowMs: number;
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
  /**
   * An update is in flight and the host can say nothing finer than that. The
   * legacy `traycer host update` path reports through the coarse
   * `updateProgress` marker alone, which has no phase, no target and no
   * percentage — so this kind exists for exactly that signal, and a surface
   * renders it as a generic, indeterminate "Updating host". A live phase from
   * the attempt record always outranks it.
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
 * 3. **`operation === null`** → the coarse `updateProgress` view when the peer
 *    reported one, else the record-derived park ({@link legacyFactsView}),
 *    else `unknown`. This is the one that is easy to get
 *    wrong and expensive when wrong: for a REMOTE host on a per-host `manual`
 *    update policy this is potentially the indefinite steady state, not an
 *    upgrade transient. Reading it as "no update in progress" would show those
 *    users nothing during a real update, for as long as their host stayed on
 *    `@1.2`.
 * 4. **`kind: "none"`** → the coarse marker, else the record-derived park,
 *    else `idle`. The host looked and there is nothing.
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
  //
  // THE ONE EXCEPTION is the probed live `restarting` below, and it is an
  // exception to the paragraph above rather than to the module header: a
  // holder probe is evidence, not an inference from the file's contents, so
  // that arm is not "we do not know" dressed up as a phase.
  if (isRecordObservation(observation)) {
    return recordObservationView(observation, nowMs);
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
    // A pre-@1.3 peer cannot report an attempt, but it CAN report the coarse
    // `updateProgress` marker (`host.status@1.1`), and for that cohort the
    // marker is the only update signal there is. Consulted first: without it
    // the landing banner and the host badges hid a live or failed legacy
    // update on exactly the hosts that could say nothing finer. Only when the
    // peer reported no marker either does this fall through to `unknown` -
    // never `idle`, for the reasons above.
    const coarseView = coarseProgressView(observation, stale);
    if (coarseView !== null) return coarseView;
    // Same order as the `none` arm below: a park the RECORDS describe is
    // rendered for this cohort too, because a pre-@1.3 host's legacy updater
    // parks in exactly the same way as a current one's.
    const parkedView = legacyFactsView(observation, stale);
    if (parkedView !== null) return parkedView;
    return UNKNOWN_FLEET_UPDATE_VIEW;
  }

  if (operation.kind === "none") {
    // "No attempt record" is NOT "no update". The shipped legacy update path
    // (`traycer host update`, every host while the executor cohort is shadow
    // -disabled) writes no schema-v2 record at all; it reports through the
    // coarse `updateProgress` marker, and a @1.3 host on that path answers
    // `{kind:"none"}` here while `updateProgress` says `updating`. Reading
    // the attempt alone rendered a live download → swap → restart as "Host is
    // up to date" — on the very Overview whose Update now had just started it
    // — which is the incident this branch was rewritten for. The coarse
    // marker is consulted FIRST, and only its absence means quiet.
    const coarseView = coarseProgressView(observation, stale);
    if (coarseView !== null) return coarseView;
    // Then the parks the marker CANNOT carry. The legacy updater withdraws
    // its marker when a busy host makes it stop, leaving either bytes
    // installed under a host still running the old version, or a stage
    // waiting for the host to go idle. Both are visible in the install and
    // staged records and nowhere else, and reading the marker alone rendered
    // them as "Host is up to date" - on an Overview whose header said rc.2
    // and whose Installation card said rc.3.
    const parkedView = legacyFactsView(observation, stale);
    if (parkedView !== null) return parkedView;
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

  // THE ATTEMPT ARM, in its own function beside the other three
  // (`coarseProgressView`, `legacyFactsView`, `recordObservationView`). It is
  // the last arm that was still inline, and D-49's terminal fall-back is what
  // made that worth changing: the rule is a statement about which LEG answers,
  // so it belongs where the legs are chosen from rather than buried in the
  // middle of the longest branch.
  return attemptOperationView({
    operation,
    observation,
    stale,
    connected: input.connected,
  });
}

/**
 * What the DURABLE RECORD projects on its own (D13).
 *
 * Two arms, and the split is exactly the difference between evidence and
 * inference:
 *
 *  - **`restarting` with a FRESH positive holder probe** projects the live
 *    `restarting` kind — indeterminate bar, lifecycle gate held, exactly as a
 *    live wire `restarting` does. Nothing is invented: the probe read the
 *    sibling lock's holder and found it alive, which is the same join the
 *    host's own observer performs, and this is the one window in which no host
 *    exists to perform it. `connected` is not consulted (the wire arm's
 *    restarting/reconnecting split is about whether OUR connection survived
 *    the restart; here the executor's liveness is the observed fact, and it is
 *    observed locally).
 *
 *  - **everything else** keeps the qualified-stale shape it has always had:
 *    `kind: "unknown"` with the phase retained as `lastKnownKind`, so a
 *    surface says "last seen preparing v2.0.0" and every gate and cadence
 *    decision — all of which read `kind` — treats this host as one we know
 *    nothing current about. `interrupted` and `unknown` liveness land here, and
 *    so does a `live` verdict whose proof has aged out, stepped backward, or
 *    arrived without a usable stamp.
 *
 * On expiry the observation does NOT disappear: it returns to the second arm,
 * keeping its last-seen history while the gate releases.
 */
function recordObservationView(
  observation: FleetUpdateRecordObservation,
  nowMs: number,
): FleetUpdateView {
  const identity = {
    attemptId: observation.attemptId,
    targetVersion: observation.targetVersion,
  };
  if (
    observation.phase === "restarting" &&
    localLivenessProofHolds(observation, nowMs)
  ) {
    return {
      ...UNKNOWN_FLEET_UPDATE_VIEW,
      ...identity,
      kind: "restarting",
      // Indeterminate, never `none`: a restart is motion with nothing to
      // measure, and the wire's own `restarting` frame draws the same bar.
      progress: { kind: "indeterminate", bytes: null, totalBytes: null },
      qualified: false,
    };
  }
  return {
    ...UNKNOWN_FLEET_UPDATE_VIEW,
    ...identity,
    lastKnownKind: phaseKind(observation.phase, false),
    lastObservedAtMs: observation.observedAtMs,
  };
}

/**
 * Whether a positive holder probe may still be presented as proof.
 *
 * Three ways to fail, all of them projecting `unknown` rather than a phase:
 * the verdict was never `live`; the stamp is absent or not a finite instant
 * (nothing to age it against — refusing beats guessing); or the age is outside
 * `[-LOCAL_LIVENESS_CLOCK_SLACK_MS, LOCAL_LIVENESS_PROOF_MS]`.
 *
 * The lower bound is the half worth stating. A cached positive that never
 * expires is the defect this whole mechanism exists for, and a wall-clock step
 * BACKWARD is how a bounded proof silently becomes an unbounded one — the same
 * pitfall the attempt lock's TTL already guards. Ageing a stamp against a clock
 * that has moved backward produces a negative age, which reads as "even fresher
 * than new" to any check that only looks at the upper bound.
 */
function localLivenessProofHolds(
  observation: FleetUpdateRecordObservation,
  nowMs: number,
): boolean {
  if (observation.liveness !== "live") return false;
  const observedAtMs = observation.livenessObservedAtMs;
  if (observedAtMs === null) return false;
  if (!Number.isFinite(observedAtMs) || !Number.isFinite(nowMs)) return false;
  const ageMs = nowMs - observedAtMs;
  return (
    ageMs >= -LOCAL_LIVENESS_CLOCK_SLACK_MS && ageMs <= LOCAL_LIVENESS_PROOF_MS
  );
}

/**
 * What the coarse `updateProgress` marker says, as a view kind — or `null`
 * when it says nothing, which is the only case that may fall through to `idle`.
 *
 * `updating` is the marker's whole vocabulary for "in flight": the legacy
 * updater sets it before the download and clears it after the post-restart
 * health probe, so it covers every phase without naming one. `failed` carries
 * the cause the updater terminated the marker with — the health-check failure
 * that used to be invisible on a @1.3 peer, because the Overview only read the
 * coarse field for peers that could not report an attempt.
 */
/**
 * The view the coarse `updateProgress` marker projects on its own, or `null`
 * when the peer reported no marker. Shared by the two arms that have no
 * attempt to read - a pre-@1.3 peer (`operation === null`) and a @1.3 peer
 * with no record (`kind: "none"`) - so the two cannot drift on how the legacy
 * path's only signal is rendered. A live phase from an attempt record always
 * outranks it; neither caller reaches here with one.
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
    // Indeterminate, never `none`: the marker proves motion and nothing
    // about how far along it is, and a surface draws that as a moving bar
    // rather than as an operation with no progress to show.
    progress:
      coarse.kind === "updating"
        ? { kind: "indeterminate", bytes: null, totalBytes: null }
        : { kind: "none" },
    errorMessage: coarse.errorMessage,
  };
}

/**
 * The view a parked legacy update projects from the RECORDS, or `null` when
 * the caller derived no park (or had nothing to derive from).
 *
 * The two kinds already exist for the schema-v2 attempt's own parks and carry
 * exactly the right copy, gates and cadence: `waiting-to-activate` ("Update
 * installed — restart host to finish") and `waiting-for-work` ("Update
 * waits for N sessions to finish", with **Force** when the count is
 * positive). Neither holds the lifecycle gate nor earns the fast poll — a park
 * can sit for days, and the restart it waits for must stay pressable.
 *
 * Debt outranks the staged wait when both hold (rc.3 installed, rc.4 staged,
 * rc.2 running and busy): the restart is the smaller, always-available step,
 * and the stage is applied by the next run once the host is idle anyway.
 *
 * Consulted AFTER the coarse marker on purpose. A live `updating` means an
 * updater is working right now and its park, if any, is still ahead of it; a
 * retained `failed` is real evidence about the last run that a derived park
 * must not paper over — the Overview keeps the failure text and offers
 * Restart from the debt fact directly, off the view kind.
 */
function legacyPark(facts: LegacyUpdateFacts): {
  readonly kind: "waiting-to-activate" | "waiting-for-work";
  readonly targetVersion: string;
  readonly blockingSessionCount: number | null;
} | null {
  // Debt outranks a staged wait: the installed bytes are the nearer fact,
  // and a restart resolves the debt before any stage can matter.
  if (facts.activationDebt !== null) {
    return {
      kind: "waiting-to-activate",
      targetVersion: facts.activationDebt.installedVersion,
      blockingSessionCount: null,
    };
  }
  if (facts.stagedWait !== null) {
    return {
      kind: "waiting-for-work",
      targetVersion: facts.stagedWait.stagedVersion,
      blockingSessionCount: facts.stagedWait.blockingSessionCount,
    };
  }
  return null;
}

function legacyFactsView(
  observation: FleetUpdateWireObservation,
  stale: boolean,
): FleetUpdateView | null {
  const facts = observation.legacyFacts;
  if (facts === null) return null;
  const park = legacyPark(facts);
  if (park === null) return null;
  if (stale) {
    return {
      ...UNKNOWN_FLEET_UPDATE_VIEW,
      targetVersion: park.targetVersion,
      lastKnownKind: park.kind,
      lastObservedAtMs: observation.observedAtMs,
    };
  }
  return {
    ...UNKNOWN_FLEET_UPDATE_VIEW,
    kind: park.kind,
    targetVersion: park.targetVersion,
    blockingSessionCount: park.blockingSessionCount,
    qualified: false,
  };
}

/**
 * What a REPORTED attempt projects to: the phase, qualified by staleness and
 * by the host's own liveness conclusion — plus D-49's one exception, where a
 * terminal attempt steps aside for the record-derived parks.
 *
 * Extracted from {@link projectFleetUpdateView} so every arm is a named
 * function and the leg-selection rules read together. Behaviour is unchanged
 * by the extraction itself.
 */
function attemptOperationView(input: {
  readonly operation: Extract<HostStatusUpdateOperation, { kind: "attempt" }>;
  readonly observation: FleetUpdateWireObservation;
  readonly stale: boolean;
  readonly connected: boolean;
}): FleetUpdateView {
  const { operation, observation, stale } = input;
  // D-49: A TERMINAL attempt that is NOT `failed` does not occupy the
  // operation slot for the purpose of the record-derived parks.
  //
  // The case is D-47's: another actor delivered the requested version and the
  // host is not running it, so the executor ends the attempt `superseded` - no
  // error, nothing owed on the attempt itself - while `install.json` names X
  // and the runtime names Y. That IS an activation debt, and it is visible in
  // the records and nowhere else. Without this the attempt arm takes the
  // frame, `superseded` projects `idle`, `idle` is quiet, and the page says
  // nothing at all after an "Updating…" toast: the user's last word on their
  // own update is a sentence that turned out to be wrong.
  //
  // GUI-SIDE ON PURPOSE. The alternative was a host guarantee that terminal
  // records stop appearing on `host.status`, and whether the host's
  // `projectUpdateOperation` withholds them is a projection detail that can
  // change under us. The debt sentence is derived from the RECORDS, so it has
  // to be reachable whenever the records say debt - deciding it from the wire
  // leg's phase instead is the class of error findings 1/4/6 were.
  //
  // FALL-BACK, NOT REPLACEMENT: the substitution applies to THIS CHOICE only.
  // With no park the attempt arm below still runs and still answers, so
  // `superseded` keeps projecting `idle` and - the case that makes the
  // distinction load-bearing - `complete` keeps projecting `complete`. The
  // landing banner renders a completion acknowledgement off that kind and
  // auto-collapses it (`useLandingCompletionCollapse`), and ITS leg passes
  // `legacyFacts: null`, so a blanket substitution would have deleted that
  // surface outright rather than merely reordering it.
  //
  // `failed` is excluded because its cause must render: it is the one terminal
  // state with something to say that the records cannot say for it. And a park
  // OUTRANKING a `complete` is deliberate rather than incidental - a completed
  // attempt whose install record disagrees with the running version is exactly
  // "delivered, not running it", which is the debt.
  if (isTerminalPhase(operation.phase) && operation.phase !== "failed") {
    const parkedView = legacyFactsView(observation, stale);
    if (parkedView !== null) return parkedView;
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

/**
 * Whether a view has nothing a person needs to see about an update.
 *
 * `idle` is a fresh read with no attempt; `unknown` with no retained phase (or
 * a retained `idle`) is a host we cannot currently ask and last saw quiet.
 * Neither is a claim about the catalog — "Host is up to date" is a sentence
 * about VERSIONS, which this projection knows nothing about — so a surface that
 * also renders the catalog's own answer ("v2.0.0 is available.") must not put
 * this view beside it. The landing banner and the Overview both hide on this
 * predicate; it lives here so they cannot drift on where "quiet" begins.
 */
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
      // A superseded attempt is terminal bookkeeping: the request it recorded
      // was WITHDRAWN. THREE causes, one rendering, and the record carries no
      // discriminator between them.
      //
      //  1. A NEWER attempt replaced it, and that attempt is what the record
      //     now describes - showing the old one would put a dead target on
      //     screen beside the live one.
      //  2. The executor refused the request as not newer than what is
      //     already installed (`E_HOST_UPDATE_NOT_NEWER`, D-46). It withdraws
      //     its own marker rather than failing, because "you asked for a
      //     version you already have" is not a failure to report.
      //  3. Another actor delivered the requested version but the host is not
      //     RUNNING it (D-47). Nothing failed; the remedy is a restart, and a
      //     record must not carry an `error` for that.
      //
      // `idle` is right for all three as far as THIS projection goes - there
      // is no operation - and it is why this phase is dropped by
      // `recordObservationFromLocalAttempt` rather than memorialised the way
      // `failed` is.
      //
      // Cause 3 is the one where saying nothing is least acceptable, and the
      // answer is deliberately NOT here: `install.json` names the delivered
      // version and the runtime does not, which is the activation-debt park,
      // and `legacyFactsView` renders it with its Restart from the RECORDS
      // alone. Reaching that arm is not left to the host: D-49's terminal
      // fall-through above consults the parks BEFORE this mapping is ever
      // used, so the debt speaks whether or not the peer is still reporting
      // the terminal attempt. This `idle` is what remains when the records
      // have nothing to say - which for cause 1 and cause 2 is the whole
      // truth. Telling the three apart in COPY would need the record to carry
      // a cause, which is a CLI-side change and an accepted residual of the
      // cutover, not something to infer here.
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
 *
 * `updating` — the coarse `updateProgress` marker projected beside a `none`
 * attempt — is deliberately in the fail-open arm with `unknown`, for the same
 * reason `unknown` is. The marker is a file the legacy updater writes before
 * it starts and deletes when it finishes; it carries no liveness, and a host
 * keeps serving a fresh `{state:"updating"}` for as long as that file exists,
 * which after an updater crash or hang is forever. A gate held by it would be
 * the unrecoverable case above with a different name: Restart, Diagnostics
 * and the service verbs disabled indefinitely by an update nobody is running.
 * The marker informs (a card, a moving bar); it never stands between a
 * person and their host.
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

/**
 * Whether this host is running an operation worth polling at the fast cadence.
 *
 * Only a genuinely ACTIVE, unqualified operation earns ~2s. A parked attempt
 * can sit for a week (`waiting-to-activate` survives a reboot by design), a
 * terminal one is retained for seven days, and a qualified one is evidence we
 * already know we cannot refresh — none of those justify polling a host every
 * two seconds, and doing so would be the retry storm §6 forbids.
 *
 * The coarse `updating` kind does not earn it either, and for the same
 * reason it does not hold the lifecycle gate: the marker proves a file
 * exists, not that anything is moving, and a marker left behind by a crashed
 * updater would otherwise keep one host on the 2s cadence for as long as any
 * surface observing it stays mounted. The `host.status` 10s baseline still
 * shows the card within one poll of a real legacy update.
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

/**
 * Precedence between a live read and the durable record (Ticket 07 §5.2.7,
 * ordering per D13).
 *
 * A FRESH wire observation always wins: a running host reporting on itself is
 * strictly better evidence than a file describing what it last wrote, and the
 * record arm exists for the host-down window. Once the wire read has gone stale
 * the record is better — it was read from this machine's disk just now, so it is
 * a current reading of a durable fact, where the stale wire observation is an
 * old reading of a live one.
 *
 * Deliberately NOT expressed as "whichever was observed most recently". That
 * rule looks equivalent and is not: the record is re-read on every tick, so its
 * `observedAtMs` is always newer, and a recency comparison would let it
 * outrank a perfectly good live read and permanently suppress real progress.
 * **No read time is an input here** — neither observation's `observedAtMs`
 * reaches this decision, and the clock is consulted only to ask whether the
 * wire read is still presentable and whether the record's own timestamp is
 * sane.
 *
 * ## Two instants, because those two questions are asked of different clocks
 *
 * `wireNowMs` is the instant the wire read was taken at — the query's
 * `dataUpdatedAt`. Measuring a wire read's own deadline against it is what
 * makes a HEALTHY read fresh by construction, which is the pre-existing
 * semantics and the only correct one: `observationFromCanonicalRead` already
 * folds the query's health into `freshUntilMs` and stamps an unhealthy read as
 * expired, so freshness is a health verdict and never a race against how long
 * the round trip took. Handing this a ticking clock instead — which is what
 * this function briefly did — means a single `host.status` round trip longer
 * than the fresh window demotes a live attempt to "last seen", drops the
 * page-wide lifecycle gate, and disengages the poll accelerator that was
 * keeping the wire caught up, on a host that is answering perfectly well and
 * is merely far away.
 *
 * `recordNowMs` is a renderer tick, and only the record's questions may use
 * it. The record's evidence expires on its own — a holder probe's proof lives
 * five seconds — while both timestamps that could age it stop advancing
 * exactly when it matters, so nothing but a clock that keeps running can
 * retire it. `recordTimestampIsSane` takes the tick for the same reason from
 * the other side: its tolerance is one second, so judging a current record
 * against a `dataUpdatedAt` frozen minutes ago would reject it as
 * "future-dated" for being what it is, current.
 *
 * What ORDERS the two once the wire is stale depends on whether they are even
 * talking about the same attempt:
 *
 *  - **Same attempt** → `(generation, sequence)`, the writer's own monotone
 *    position. A record BEHIND the last wire frame is a lagging copy of a story
 *    the wire already told better, so the wire keeps it; at or ahead, the record
 *    wins and brings its liveness with it. Equality is the common case in the
 *    host-down window (both readers read the same last write) and it must go to
 *    the record, which is the only side that can still say anything about a
 *    holder.
 *  - **Different attempts**, or a wire frame naming no attempt at all → the
 *    record's own `updatedAt`, as a BOUND rather than as a comparison: there is
 *    nothing on the wire to compare it against (no timestamp crosses it, by
 *    design), so all it can do is establish that the record is not obvious
 *    nonsense. An unparseable or future-dated stamp is treated as unknown and
 *    the wire keeps the slot.
 *
 * The tie rule is what preserves the invariant a repeated read must not break:
 * re-reading ONE unchanged record produces the same `(generation, sequence)`
 * every time, so it can never climb over a healthy live frame of that attempt.
 */
export function preferLiveOverRecord(
  wire: FleetUpdateWireObservation | null,
  record: FleetUpdateRecordObservation | null,
  clock: LocalUpdateClock,
): FleetUpdateObservation | null {
  if (record === null) return wire;
  if (wire === null) return record;
  // A HEALTHY live read wins outright, whatever the record says. Handing the
  // slot to a record that happens to sit one `sequence` ahead — which it
  // routinely does, being re-read several times per `host.status` poll — would
  // replace a live phase and its percentage with "last seen …" for most of
  // every download, and then remove the fast poll that was keeping the wire
  // caught up. Progress the host is actively reporting is never improved by a
  // file that cannot report liveness.
  if (clock.wireNowMs <= wire.freshUntilMs) return wire;
  const wireAttempt = wireAttemptPosition(wire);
  if (wireAttempt !== null && wireAttempt.attemptId === record.attemptId) {
    return recordIsBehind(record, wireAttempt) ? wire : record;
  }
  return recordTimestampIsSane(record, clock.recordNowMs) ? record : wire;
}

/** The wire frame's attempt position, or `null` when it names no attempt. */
function wireAttemptPosition(wire: FleetUpdateWireObservation): {
  readonly attemptId: string;
  readonly generation: number;
  readonly sequence: number;
} | null {
  const operation = wire.operation;
  if (operation === null || operation.kind !== "attempt") return null;
  return {
    attemptId: operation.attemptId,
    generation: operation.generation,
    sequence: operation.sequence,
  };
}

/** Lexicographic on `(generation, sequence)`; equality is NOT behind. */
function recordIsBehind(
  record: FleetUpdateRecordObservation,
  wire: { readonly generation: number; readonly sequence: number },
): boolean {
  if (record.generation !== wire.generation) {
    return record.generation < wire.generation;
  }
  return record.sequence < wire.sequence;
}

/**
 * Whether the record's `updatedAt` is usable as the different-attempt bound.
 *
 * `Date.parse` on a non-timestamp yields `NaN`, which every comparison answers
 * `false` to — so the finiteness check is written out rather than relied upon
 * implicitly, because "invalid loses" and "invalid silently wins" differ by one
 * negated operator.
 *
 * The future allowance is {@link LOCAL_LIVENESS_CLOCK_SLACK_MS} for the same
 * reason the proof's lower bound has one: `nowMs` is a one-second tick and lags
 * real time, so a record written moments ago is routinely stamped after it.
 * Anything beyond that is a timestamp we cannot account for, and an
 * unaccountable timestamp orders nothing.
 */
function recordTimestampIsSane(
  record: FleetUpdateRecordObservation,
  nowMs: number,
): boolean {
  const updatedAtMs = Date.parse(record.updatedAt);
  if (!Number.isFinite(updatedAtMs) || !Number.isFinite(nowMs)) return false;
  return updatedAtMs - nowMs <= LOCAL_LIVENESS_CLOCK_SLACK_MS;
}
