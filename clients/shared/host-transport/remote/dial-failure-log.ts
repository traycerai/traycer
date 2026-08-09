/**
 * Throttled "this session cannot connect, here is why" logging for the client
 * remote session's forever-retrying connect loop (`RemoteSession`).
 *
 * The loop is, by design, infinite: any failure - grant mint, relay dial,
 * Noise handshake, open/openAck - re-arms the backoff timer and nothing
 * escalates. That is the right BEHAVIOUR (the session self-heals the moment
 * the fault clears), but with no logging it produced a renderer that dialed a
 * relay hostname that did not even resolve in DNS, failed every attempt in
 * milliseconds, and wrote NOTHING anywhere: the only visible symptom was
 * every host-scoped query erroring "Remote session is not ready" while the
 * host itself showed Online. Diagnosing that took authn request logs plus
 * relay-side telemetry to prove the dial never left the machine.
 *
 * Two failure modes to avoid, hence this type rather than a bare
 * `console.warn` (same contract as the host's `UplinkFailureLog` - the other
 * half of this tunnel logs identically):
 *
 *  1. Logging every attempt. A 30s-capped backoff writes ~120 lines/hour
 *     forever, which buries everything else in the forwarded renderer log.
 *  2. Logging only the FIRST occurrence. Whoever reads the log is reading its
 *     TAIL, long after the single line scrolled away, and concludes nothing
 *     is wrong. The periodic re-statement below exists specifically so the
 *     cause is present in the window a reader actually looks at.
 *
 * So: log on the first failure, log again whenever the CAUSE changes, and
 * otherwise re-state on a slow interval with a count of what was suppressed.
 * Recovery gets its own line - "it is working again, after N failures over
 * M seconds" is the other half of the story.
 */

export interface DialFailure {
  /**
   * WHY the attempt failed, in words. This doubles as the dedup key, so it
   * must NOT embed values that change every attempt (attempt counters,
   * backoff delays, countdowns) - a cause that is never equal to the previous
   * one defeats the throttle and re-creates failure mode 1 above. Put
   * anything that moves in {@link DialFailure.context}.
   */
  readonly cause: string;
  /**
   * Live detail worth printing but NOT worth re-logging for. Reported, never
   * compared. `""` to omit.
   */
  readonly context: string;
  /** When the loop will try again. Reported, never compared. */
  readonly retryInMs: number;
}

export interface DialFailureLogOptions {
  /** Names the session in every line, e.g. `remote session (host 1aa90d38)`. */
  readonly label: string;
  readonly now: () => number;
  /** How often an unchanged cause is re-stated. */
  readonly repeatIntervalMs: number;
  /** Warn sink (failures + re-statements). Injectable for tests. */
  readonly warn: (message: string) => void;
  /** Info sink (the recovery line). Injectable for tests. */
  readonly info: (message: string) => void;
}

export class DialFailureLog {
  private readonly options: DialFailureLogOptions;
  private consecutiveFailures = 0;
  private firstFailureAt = 0;
  private lastCause: string | null = null;
  private lastLoggedAt = 0;
  private suppressedSinceLastLog = 0;

  constructor(options: DialFailureLogOptions) {
    this.options = options;
  }

  recordFailure(failure: DialFailure): void {
    const now = this.options.now();
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures === 1) {
      this.firstFailureAt = now;
    }
    const causeChanged = failure.cause !== this.lastCause;
    const restatementDue =
      now - this.lastLoggedAt >= this.options.repeatIntervalMs;
    if (!causeChanged && !restatementDue) {
      this.suppressedSinceLastLog += 1;
      return;
    }
    const context = failure.context === "" ? "" : ` (${failure.context})`;
    this.options.warn(
      causeChanged
        ? `[remote-session] ${this.options.label} is down: ${failure.cause}${context} - retrying in ${failure.retryInMs}ms`
        : `[remote-session] ${this.options.label} is still down after ${this.consecutiveFailures} consecutive failures over ${secondsSince(this.firstFailureAt, now)}s: ${failure.cause}${context} - retrying in ${failure.retryInMs}ms (${this.suppressedSinceLastLog} identical failures not logged)`,
    );
    this.lastCause = failure.cause;
    this.lastLoggedAt = now;
    this.suppressedSinceLastLog = 0;
  }

  /**
   * The session was torn down (caller `close()` — linger expiry, supersession,
   * retirement) while the connect loop was still failing. Without this line
   * the tail reads "…retrying in Nms" followed by silence, which failure
   * mode 2 above says a reader takes as recovery. One line, no-op when
   * nothing had failed, so a healthy close stays silent.
   */
  recordAbandoned(): void {
    if (this.consecutiveFailures === 0) {
      return;
    }
    const now = this.options.now();
    this.options.warn(
      `[remote-session] ${this.options.label} closed while still down after ${this.consecutiveFailures} consecutive failures over ${secondsSince(this.firstFailureAt, now)}s - the retry loop has ended`,
    );
    this.reset();
  }

  /**
   * The session reached its ready boundary. Logs the recovery ONLY if
   * something had actually failed, so a healthy session never emits it.
   */
  recordSuccess(): void {
    if (this.consecutiveFailures === 0) {
      return;
    }
    const now = this.options.now();
    this.options.info(
      `[remote-session] ${this.options.label} recovered after ${this.consecutiveFailures} consecutive failures over ${secondsSince(this.firstFailureAt, now)}s`,
    );
    this.reset();
  }

  private reset(): void {
    this.consecutiveFailures = 0;
    this.firstFailureAt = 0;
    this.lastCause = null;
    this.lastLoggedAt = 0;
    this.suppressedSinceLastLog = 0;
  }
}

function secondsSince(startMs: number, nowMs: number): number {
  return Math.max(0, Math.round((nowMs - startMs) / 1000));
}
