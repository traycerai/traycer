/**
 * Throttled "this session cannot connect, here is why" logging for the client remote session's forever-retrying connect loop (`RemoteSession`).
 * Diagnosing that took authn request logs plus relay-side telemetry to prove the dial never left the machine.
 */

export interface DialFailure {
  /** Why the attempt failed, in words. */
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
   * The session was torn down (caller `close()` - linger expiry, supersession, retirement) while the connect loop was still failing.
   * Without this line the tail reads "…retrying in Nms" followed by silence, which failure mode 2 above says a reader takes as recovery.
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
   * The session reached its ready boundary. Logs the recovery only if
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
