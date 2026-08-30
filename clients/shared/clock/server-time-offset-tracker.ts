/**
 * Client-side detector for a wrong LOCAL system clock, built from samples the
 * client already collects — no probe requests of its own.
 *
 * The incident it exists for: a machine rebooted with its wall clock 7h ahead
 * (the RTC's UTC value read as local time, w32tm never synced). Every 15-minute
 * bearer then reads as hours expired against `Date.now()`, so the stream's
 * pre-dial gate revalidates, authn — whose clock is correct — answers "valid",
 * the same token is re-dialed, and the no-progress bound takes the session
 * terminal. Nothing in that loop names the actual cause, and fixing the clock
 * recovers nothing because terminal sessions never re-dial.
 *
 * The load-bearing fact from that incident is that the client↔authn HTTPS path
 * worked THROUGHOUT — that is precisely why the loop made no progress. So authn
 * responses are a trustworthy server-time reference exactly when host
 * connections are down, which is what makes an opportunistic detector possible
 * at all.
 *
 * Lives in `shared/` beside the host-transport layer rather than in any one
 * client: the stream transport consumes the verdict to park a session, the GUI
 * renders a banner off the same state, and the CLI can subscribe later without
 * a second implementation.
 */

/**
 * How the tracker currently reads the local clock.
 *
 * `unknown` is a real state, not a placeholder for `ok`: before any server-time
 * sample lands (and after a sample is invalidated by a wall-clock jump) the
 * tracker has NOTHING to say, and callers that park sessions or render banners
 * must key on `skewed` alone rather than on "not ok".
 */
export type ServerClockVerdict = "unknown" | "ok" | "skewed";

export interface ServerClockState {
  readonly verdict: ServerClockVerdict;
  /**
   * `serverTime − Date.now()` at the moment of the last sample, carried
   * forward. Positive means the local clock is BEHIND the server; negative
   * means it is AHEAD. `null` while the verdict is `unknown`.
   */
  readonly offsetMs: number | null;
}

/** Which way round a wrong local clock is wrong. */
export type LocalClockDirection = "ahead" | "behind";

/**
 * THE ONE PLACE the sign convention is decoded. `offsetMs` is
 * `serverTime − Date.now()`, and that sign is easy to invert mentally, so
 * nothing else in the codebase should be reading `offsetMs < 0` directly:
 *
 *   - local clock AHEAD (running fast) ⇒ `Date.now()` is the LARGER term
 *     ⇒ `offsetMs` is NEGATIVE;
 *   - local clock BEHIND (running slow) ⇒ `offsetMs` is POSITIVE.
 */
export function localClockDirection(offsetMs: number): LocalClockDirection {
  return offsetMs < 0 ? "ahead" : "behind";
}

/**
 * Whether the clock is wrong in the one direction that can make a bearer which
 * is GENUINELY VALID read as expired here — i.e. running AHEAD.
 *
 * This is the predicate every auth park gate keys on, and it is strictly
 * narrower than "the verdict is `skewed`". The two directions have opposite
 * causal meaning at an auth failure, and only one of them is a cause at all:
 *
 *   - AHEAD (fast): the local `exp <= Date.now()` comparison reads a
 *     just-minted bearer as hours expired, authn (correct clock) answers
 *     "valid", the same token is re-dialed forever. This is the incident the
 *     whole clock feature exists for, and parking is the fix.
 *   - BEHIND (slow): a bearer can only look MORE valid than it is, never
 *     expired — and the host validates against ITS OWN clock, so ours cannot
 *     make it reject anything. An UNAUTHORIZED seen while the clock is slow
 *     therefore has an UNRELATED cause (revocation, host config mismatch), and
 *     parking on it would strand a session that the terminal bound would have
 *     diagnosed honestly, until the user "fixed" a clock that was never the
 *     problem. That is this feature's own failure mode, mirrored.
 *
 * Detection is deliberately NOT narrowed to match: a clock that is hours slow
 * is worth telling the user about (it has its own consequences elsewhere), so
 * the `skewed` verdict and the banner still speak for both directions. Only
 * PARKING keys on this.
 */
export function clockCanMakeValidBearersLookExpired(
  state: ServerClockState,
): boolean {
  return (
    state.verdict === "skewed" &&
    state.offsetMs !== null &&
    localClockDirection(state.offsetMs) === "ahead"
  );
}

/**
 * The read side, which is all the stream transport and the GUI need. Kept
 * separate from the tracker class so consumers cannot feed samples into it and
 * test doubles stay trivial.
 *
 * There is deliberately exactly ONE boolean here, and it is the narrow causal
 * one. A plain "is the clock wrong" convenience used to sit beside it, and
 * every park gate reached for it — which is precisely the bug
 * {@link clockCanMakeValidBearersLookExpired} exists to prevent. Surfacing
 * consumers (banners) read {@link currentState} and key on
 * `verdict === "skewed"` themselves, which keeps the wrong predicate out of
 * reach at a park site rather than merely documented against.
 */
export interface ServerClockSkewSignal {
  currentState(): ServerClockState;
  /**
   * The auth park gate: see {@link clockCanMakeValidBearersLookExpired}. NOT
   * "is the clock wrong" — a clock wrong in the other direction is still
   * `skewed`, still worth a banner, and still must NOT park anything.
   */
  canMakeValidBearersLookExpired(): boolean;
  /** Fires on every state change; returns an unsubscribe. */
  subscribe(listener: (state: ServerClockState) => void): () => void;
  /**
   * Fires ONLY on the `skewed → ok` edge — the clock-was-fixed signal a parked
   * stream session resumes on. Deliberately narrower than {@link subscribe}: a
   * parked session must not re-dial on magnitude changes within `skewed`.
   *
   * NARROW IS SAFE ONLY BECAUSE `skewed → unknown` CANNOT HAPPEN. It is not
   * that waking on it would be wrong — it is that the transition does not
   * exist, so `ok` is genuinely the only way out of `skewed` and this edge
   * therefore catches every one of them. That rests on two guards: the sole
   * `unknown` publish (in `noteWallClockTick`) is fenced behind
   * `verdict !== "skewed"`, and `applyOffset` can only ever yield `skewed` or
   * `ok`. A test pins it, because both guards are easy to break in good faith.
   *
   * SO: anything that adds a new way to reach `unknown` — a sample-age decay,
   * a staleness timer, a reset API — MUST widen this edge in the same change.
   * A parked session that never hears its wake-up is stranded until the user
   * reloads, which is precisely the failure this feature was built to remove.
   */
  subscribeToRecovery(listener: () => void): () => void;
}

/**
 * Enter `skewed` above this. Sits far beyond any plausible NTP jitter and far
 * below the 15-minute bearer TTL that skew of this size destroys, so it can
 * only fire on a clock that is genuinely wrong.
 */
export const DEFAULT_SKEW_ENTER_MS = 5 * 60_000;
/**
 * Return to `ok` below this. The gap to {@link DEFAULT_SKEW_ENTER_MS} is
 * hysteresis: an offset hovering on one threshold would otherwise flap the
 * banner and, worse, repeatedly unpark and re-park live sessions.
 */
export const DEFAULT_SKEW_EXIT_MS = 2 * 60_000;

/**
 * Minimum wall-vs-monotonic divergence, between two consecutive
 * {@link ServerTimeOffsetTracker.noteWallClockTick} calls, that counts as the
 * wall clock having been SET rather than having merely ticked. Well above any
 * timer jitter or throttling slop a background renderer produces, and well
 * below the skew band, so a fix that actually matters is always caught.
 */
const WALL_CLOCK_JUMP_MS = 30_000;

export interface ServerTimeOffsetTrackerOptions {
  /** The wall clock under suspicion. Production passes `Date.now`. */
  readonly nowMs: () => number;
  /**
   * A source that advances with elapsed time and is NOT affected by the user
   * or NTP setting the wall clock — `performance.now` in both the renderer and
   * node. Only ever read as a delta, so the epoch is irrelevant.
   */
  readonly monotonicNowMs: () => number;
  readonly enterSkewMs: number;
  readonly exitSkewMs: number;
}

/**
 * Accumulates opportunistic server-time samples and classifies the local clock.
 *
 * Sampling is deliberately passive. Both inputs ride requests the client makes
 * anyway:
 *
 *   - the HTTP `Date` header of an authn response — notably the revalidation
 *     the stream already performs when it believes its token expired, so a
 *     sample lands on the FIRST cycle of what used to be the terminal loop;
 *   - the `iat` of a token authn just minted, which is signature-trusted and
 *     was issued seconds ago by authn's correct clock.
 *
 * Neither is precise to the second (header granularity, request latency, and
 * the age of a "fresh" token all add noise), and neither needs to be: the
 * thresholds are minutes wide.
 */
export class ServerTimeOffsetTracker implements ServerClockSkewSignal {
  private readonly options: ServerTimeOffsetTrackerOptions;
  private state: ServerClockState = { verdict: "unknown", offsetMs: null };
  private readonly listeners = new Set<(state: ServerClockState) => void>();
  private readonly recoveryListeners = new Set<() => void>();
  /**
   * The wall/monotonic pair captured at the previous tick, or `null` before the
   * first one. Divergence is only ever measured BETWEEN two ticks, so the first
   * tick after construction (or after a gap) can never be read as a jump.
   */
  private lastTick: {
    readonly wallMs: number;
    readonly monotonicMs: number;
  } | null = null;

  constructor(options: ServerTimeOffsetTrackerOptions) {
    this.options = options;
  }

  currentState(): ServerClockState {
    return this.state;
  }

  canMakeValidBearersLookExpired(): boolean {
    return clockCanMakeValidBearersLookExpired(this.state);
  }

  subscribe(listener: (state: ServerClockState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeToRecovery(listener: () => void): () => void {
    this.recoveryListeners.add(listener);
    return () => {
      this.recoveryListeners.delete(listener);
    };
  }

  /**
   * Records a server timestamp observed at `observedAtMs` on the local clock.
   * The two are taken as close together as the caller can manage; request
   * latency between them is noise against a minutes-wide threshold.
   */
  recordServerTimeMs(serverEpochMs: number, observedAtMs: number): void {
    if (!Number.isFinite(serverEpochMs) || !Number.isFinite(observedAtMs)) {
      return;
    }
    this.applyOffset(serverEpochMs - observedAtMs);
  }

  /**
   * Records the `Date` header of an authn response. `null`/absent/unparseable
   * headers are dropped silently — this is an opportunistic input, and a proxy
   * that strips the header simply means no sample, never a wrong one.
   */
  recordServerDateHeader(headerValue: string | null): void {
    if (headerValue === null) {
      return;
    }
    const serverEpochMs = Date.parse(headerValue);
    if (Number.isNaN(serverEpochMs)) {
      return;
    }
    this.recordServerTimeMs(serverEpochMs, this.options.nowMs());
  }

  /**
   * Records the `iat` of a token authn minted moments ago. The CALLER owns the
   * freshness claim — only a just-rotated/just-exchanged token qualifies, never
   * a token rehydrated from disk, whose `iat` says when the last session
   * started and nothing about the current server time.
   */
  recordFreshlyIssuedToken(token: string): void {
    const issuedAtMs = readTokenIssuedAtMs(token);
    if (issuedAtMs === null) {
      return;
    }
    this.recordServerTimeMs(issuedAtMs, this.options.nowMs());
  }

  /**
   * Compares elapsed wall time against elapsed monotonic time since the last
   * tick, and reacts when they disagree by more than {@link WALL_CLOCK_JUMP_MS}
   * — the signature of somebody (or NTP) SETTING the clock.
   *
   * This is a recovery ACCELERANT, never the detector. Two rules keep it in its
   * lane, and both matter:
   *
   *   1. It cannot see wrong-from-boot skew at all. This incident's clock was
   *      already hours off when the process started and never jumped in-process,
   *      so a divergence-only design would have detected nothing.
   *   2. It may only ever CLEAR a verdict, never create one. A suspend/resume
   *      can make wall and monotonic diverge with no clock change whatsoever
   *      (some platforms freeze `performance.now` across sleep), so a jump that
   *      lands while the verdict is `ok`/`unknown` only invalidates the stale
   *      sample. Declaring `skewed` off that would fabricate the exact
   *      diagnosis the banner and the park state act on.
   *
   * While `skewed` the jump IS applied to the carried offset (a wall clock
   * moved forward by J reduces `server − local` by J), because that is the
   * whole point: a user fixing a 7h error should not wait for the next authn
   * call to get their app back. If the adjustment is wrong, the resumed dial's
   * own revalidation lands a real sample within seconds and re-parks.
   */
  noteWallClockTick(): void {
    const wallMs = this.options.nowMs();
    const monotonicMs = this.options.monotonicNowMs();
    const previous = this.lastTick;
    this.lastTick = { wallMs, monotonicMs };
    if (previous === null) {
      return;
    }
    const divergenceMs =
      wallMs - previous.wallMs - (monotonicMs - previous.monotonicMs);
    if (Math.abs(divergenceMs) < WALL_CLOCK_JUMP_MS) {
      return;
    }
    const offsetMs = this.state.offsetMs;
    if (offsetMs === null) {
      return;
    }
    if (this.state.verdict !== "skewed") {
      // Rule 2: the carried sample is no longer trustworthy, but nothing here
      // proves the clock is wrong. Drop back to `unknown` and wait for a real
      // sample.
      this.publish({ verdict: "unknown", offsetMs: null });
      return;
    }
    this.applyOffset(offsetMs - divergenceMs);
  }

  /**
   * Classifies a fresh offset under the hysteresis band and publishes it.
   * `skewed` is sticky until the offset falls under `exitSkewMs`, so an offset
   * oscillating around the enter threshold neither flaps the banner nor churns
   * parked sessions.
   */
  private applyOffset(offsetMs: number): void {
    const magnitude = Math.abs(offsetMs);
    const wasSkewed = this.state.verdict === "skewed";
    const threshold = wasSkewed
      ? this.options.exitSkewMs
      : this.options.enterSkewMs;
    const verdict: ServerClockVerdict = magnitude > threshold ? "skewed" : "ok";
    this.publish({ verdict, offsetMs });
  }

  private publish(next: ServerClockState): void {
    const previous = this.state;
    if (
      previous.verdict === next.verdict &&
      previous.offsetMs === next.offsetMs
    ) {
      return;
    }
    this.state = next;
    for (const listener of [...this.listeners]) {
      listener(next);
    }
    if (previous.verdict === "skewed" && next.verdict === "ok") {
      for (const listener of [...this.recoveryListeners]) {
        listener();
      }
    }
  }
}

/**
 * Epoch milliseconds of a JWT's `iat` claim, or `null` when the token is not a
 * decodable JWT or carries no finite numeric `iat`. Unverified, exactly as
 * {@link readAccessTokenExpiryMs} is — a token whose signature we have not
 * checked can only ever ADD a sample here, and a forged one would have to
 * agree with the real server time to change nothing or disagree and be
 * corrected by the next genuine sample.
 */
function readTokenIssuedAtMs(token: string): number | null {
  const segments = token.split(".");
  if (segments.length < 2) {
    return null;
  }
  const payload = decodeJwtSegment(segments[1]);
  if (typeof payload !== "object" || payload === null || !("iat" in payload)) {
    return null;
  }
  const iat = payload.iat;
  return typeof iat === "number" && Number.isFinite(iat)
    ? Math.trunc(iat * 1000)
    : null;
}

function decodeJwtSegment(segment: string): unknown {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  let json: string;
  try {
    json = atob(padded);
  } catch {
    return null;
  }
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Human-facing description of a skew verdict — "~7h ahead" — shared by the GUI
 * banner and the transport's fatal-reason copy so the two can never disagree
 * about direction. Reads the sign through {@link localClockDirection} rather
 * than inlining it, so the copy and the park gate can never drift apart on
 * which way round `offsetMs` runs.
 */
export function describeClockOffset(offsetMs: number): string {
  const magnitude = Math.abs(offsetMs);
  return `~${formatApproximateDuration(magnitude)} ${localClockDirection(offsetMs)}`;
}

function formatApproximateDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) {
    return `${Math.max(1, minutes)}m`;
  }
  const hours = ms / 3_600_000;
  if (hours < 24) {
    return `${roundToOneDecimal(hours)}h`;
  }
  return `${roundToOneDecimal(hours / 24)}d`;
}

function roundToOneDecimal(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
}

/**
 * The reason string a stream session carries when the clock — not the
 * credential — is why it cannot connect. Replaces the fabricated "client
 * resumed from suspension" copy that misdiagnosed this incident in the UI.
 */
export function clockSkewStreamReason(state: ServerClockState): string {
  const offsetMs = state.offsetMs;
  const magnitude =
    offsetMs === null ? "" : ` (${describeClockOffset(offsetMs)})`;
  return `System clock is wrong${magnitude}; Traycer cannot authenticate until it is corrected`;
}
