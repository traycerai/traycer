/**
 * Client-side detector for a wrong local system clock, built from samples the client already collects - no probe requests of its own.
 * The incident it exists for: a machine rebooted with its wall clock 7h ahead (the rtc's utc value read as local time, w32tm never synced).
 */

export type ServerClockVerdict = "unknown" | "ok" | "skewed";

export interface ServerClockState {
  readonly verdict: ServerClockVerdict;
  /** `serverTime − Date.now()` at the moment of the last sample, carried forward. */
  readonly offsetMs: number | null;
}

export type LocalClockDirection = "ahead" | "behind";

export function localClockDirection(offsetMs: number): LocalClockDirection {
  return offsetMs < 0 ? "ahead" : "behind";
}

/**
 * Whether the clock is wrong in the one direction that can make a bearer which is genuinely valid read as expired here - i.e. running ahead.
 * This is the predicate every auth park gate keys on, and it is strictly narrower than "the verdict is `skewed`".
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
 * The read side, which is all the stream transport and the gui need.
 * Kept separate from the tracker class so consumers cannot feed samples into it and test doubles stay trivial.
 */
export interface ServerClockSkewSignal {
  currentState(): ServerClockState;
  /**
   * The auth park gate: see {@link clockCanMakeValidBearersLookExpired}.
   * Not "is the clock wrong" - a clock wrong in the other direction is still `skewed`, still worth a banner, and still must not park anything.
   */
  canMakeValidBearersLookExpired(): boolean;
  /** Fires on every state change; returns an unsubscribe. */
  subscribe(listener: (state: ServerClockState) => void): () => void;
  /**
   * Fires only on the `skewed → ok` edge - the clock-was-fixed signal a parked stream session resumes on.
   * Deliberately narrower than {@link subscribe}: a parked session must not re-dial on magnitude changes within `skewed`.
   */
  subscribeToRecovery(listener: () => void): () => void;
}

/**
 * Enter `skewed` above this.
 * Sits far beyond any plausible ntp jitter and far below the 15-minute bearer ttl that skew of this size destroys, so it can only fire on a clock that is genuinely wrong.
 */
export const DEFAULT_SKEW_ENTER_MS = 5 * 60_000;
export const DEFAULT_SKEW_EXIT_MS = 2 * 60_000;

/**
 * Minimum wall-vs-monotonic divergence, between two consecutive {@link ServerTimeOffsetTracker.noteWallClockTick} calls, that counts as the wall clock having been set rather than having merely ticked.
 */
const WALL_CLOCK_JUMP_MS = 30_000;

export interface ServerTimeOffsetTrackerOptions {
  /** The wall clock under suspicion. Production passes `Date.now`. */
  readonly nowMs: () => number;
  /**
   * A source that advances with elapsed time and is not affected by the user or ntp setting the wall clock - `performance.now` in both the renderer and node.
   * Only ever read as a delta, so the epoch is irrelevant.
   */
  readonly monotonicNowMs: () => number;
  readonly enterSkewMs: number;
  readonly exitSkewMs: number;
}

export class ServerTimeOffsetTracker implements ServerClockSkewSignal {
  private readonly options: ServerTimeOffsetTrackerOptions;
  private state: ServerClockState = { verdict: "unknown", offsetMs: null };
  private readonly listeners = new Set<(state: ServerClockState) => void>();
  private readonly recoveryListeners = new Set<() => void>();
  /**
   * The wall/monotonic pair captured at the previous tick, or `null` before the first one.
   * Divergence is only ever measured between two ticks, so the first tick after construction (or after a gap) can never be read as a jump.
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

  /** Records a server timestamp observed at `observedAtMs` on the local clock. */
  recordServerTimeMs(serverEpochMs: number, observedAtMs: number): void {
    if (!Number.isFinite(serverEpochMs) || !Number.isFinite(observedAtMs)) {
      return;
    }
    this.applyOffset(serverEpochMs - observedAtMs);
  }

  /**
   * Records the `Date` header of an authn response.
   * `null`/absent/unparseable headers are dropped silently - this is an opportunistic input, and a proxy that strips the header simply means no sample, never a wrong one.
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
   * Records the `iat` of a token authn minted moments ago.
   * The caller owns the freshness claim - only a just-rotated/just-exchanged token qualifies, never a token rehydrated from disk, whose `iat` says when the last session started and nothing about the current server time.
   */
  recordFreshlyIssuedToken(token: string): void {
    const issuedAtMs = readTokenIssuedAtMs(token);
    if (issuedAtMs === null) {
      return;
    }
    this.recordServerTimeMs(issuedAtMs, this.options.nowMs());
  }

  /**
   * Compares elapsed wall time against elapsed monotonic time since the last tick, and reacts when they disagree by more than {@link WALL_CLOCK_JUMP_MS} - the signature of somebody (or ntp) setting the clock.
   * This is a recovery accelerant, never the detector.
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
      // Rule 2: the carried sample is no longer trustworthy, but nothing here proves the clock is wrong.
      // Drop back to `unknown` and wait for a real sample.
      this.publish({ verdict: "unknown", offsetMs: null });
      return;
    }
    this.applyOffset(offsetMs - divergenceMs);
  }

  /** Classifies a fresh offset under the hysteresis band and publishes it. */
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
 * Epoch milliseconds of a JWT's `iat` claim, or `null` when the token is not a decodable JWT or carries no finite numeric `iat`.
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
 * Human-facing description of a skew verdict - "~7h ahead" - shared by the gui banner and the transport's fatal-reason copy so the two can never disagree about direction.
 * Reads the sign through {@link localClockDirection} rather than inlining it, so the copy and the park gate can never drift apart on which way round `offsetMs` runs.
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
 * The reason string a stream session carries when the clock - not the credential - is why it cannot connect.
 */
export function clockSkewStreamReason(state: ServerClockState): string {
  const offsetMs = state.offsetMs;
  const magnitude =
    offsetMs === null ? "" : ` (${describeClockOffset(offsetMs)})`;
  return `System clock is wrong${magnitude}; Traycer cannot authenticate until it is corrected`;
}
