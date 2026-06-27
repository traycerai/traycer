import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  applySlowDown,
  createPollSchedule,
  isDeviceExpired,
  pollDeviceToken,
  startDeviceAuthorization,
  type DeviceAuthorizationResult,
  type DevicePollSchedule,
} from "@traycer-clients/shared/auth/device-auth";
import { log } from "../app/logger";

/**
 * Main-process owner of the OAuth 2.0 Device Authorization Grant (RFC 8628)
 * attempt: it runs `/device/authorize` AND the `/device/token` poll loop here,
 * NOT in the renderer. Two reasons (Findings 7 & 9):
 *
 *   1. CORS-safe - the authn endpoints don't allow the renderer origin, so a
 *      renderer fetch would be blocked; running in main sidesteps that.
 *   2. The loop survives renderer window close / sleep. The whole machine
 *      sleeping just pauses main with everything else; on resume the loop
 *      continues. A window that *closes* is handled by the IPC layer cancelling
 *      the attempt (it watches the owner `webContents`), so no 10-minute poll
 *      ever leaks.
 *
 * The renderer only observes the terminal `DeviceFlowResultPayload`. Cancellation
 * (supersede / sign-out / dispose / window-close) aborts the attempt; an aborted
 * attempt delivers NOTHING - the renderer has already moved on.
 *
 * Accepted residual (Finding 7): `pollDeviceToken` (shared) takes no
 * `AbortSignal`, so a request already on the wire when the attempt is aborted
 * can't be socket-cancelled. We re-check `signal.aborted` immediately before
 * dispatching each poll AND immediately after it resolves, and we stop waiting
 * for an in-flight poll the moment the abort fires (its late result is
 * discarded). The window where the server still mints an unused refresh token
 * after a redirect won locally is therefore minimized but not eliminable until
 * the deferred per-credential (`jti`) revocation phase.
 */
export interface DeviceFlowAuthorizationPayload {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly expiresInSeconds: number;
  readonly intervalSeconds: number;
}

export type DeviceFlowResultPayload =
  | {
      readonly kind: "authorized";
      readonly token: string;
      readonly refreshToken: string;
    }
  | { readonly kind: "denied" }
  | { readonly kind: "expired" }
  | { readonly kind: "error" };

export type DeviceFlowStartOutcome =
  | {
      readonly ok: true;
      readonly attemptId: string;
      readonly authorization: DeviceFlowAuthorizationPayload;
    }
  | { readonly ok: false };

export interface DeviceFlowStartHandlers {
  /**
   * Delivers the terminal outcome to the renderer that started the attempt.
   * Called at most once per attempt and never for an aborted/cancelled one.
   */
  readonly onResult: (
    attemptId: string,
    result: DeviceFlowResultPayload,
  ) => void;
}

/**
 * Per-attempt interrupt that lets `pollNow` cut short the loop's interval sleep
 * so the next `/device/token` poll fires immediately. `arm` registers the
 * current sleep's early-resolve; `wake` fires it (a no-op when nothing is armed,
 * e.g. while a poll is already on the wire); `clear` disarms once the sleep
 * settles for any reason.
 */
class PollWaker {
  private resolve: (() => void) | null = null;

  arm(resolve: () => void): void {
    this.resolve = resolve;
  }

  clear(): void {
    this.resolve = null;
  }

  wake(): void {
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.();
  }
}

interface AttemptHandle {
  readonly abortController: AbortController;
  readonly waker: PollWaker;
}

export class DeviceFlowController {
  private readonly attempts = new Map<string, AttemptHandle>();

  constructor(private readonly authnBaseUrl: string) {}

  /**
   * Authorizes a new device attempt and kicks off the poll loop. Resolves once
   * `/device/authorize` returns so the renderer can show the user code, then
   * the loop runs in the background and reports its terminal state through
   * `handlers.onResult`. Resolves `{ ok: false }` when authorization itself
   * fails (network/5xx) - the renderer surfaces a launch-style failure.
   */
  async start(
    handlers: DeviceFlowStartHandlers,
  ): Promise<DeviceFlowStartOutcome> {
    const authorization = await startDeviceAuthorization(this.authnBaseUrl, {
      clientId: "desktop",
      hostLabel: deviceHostLabel(),
    });
    if (authorization.kind !== "started") {
      return { ok: false };
    }
    const attemptId = randomUUID();
    const handle: AttemptHandle = {
      abortController: new AbortController(),
      waker: new PollWaker(),
    };
    this.attempts.set(attemptId, handle);
    // Run the loop detached from the invoke response so the renderer gets the
    // authorization immediately and can render progress.
    void this.runAttempt(attemptId, authorization, handle, handlers);
    return {
      ok: true,
      attemptId,
      authorization: {
        userCode: authorization.userCode,
        verificationUri: authorization.verificationUri,
        verificationUriComplete: authorization.verificationUriComplete,
        expiresInSeconds: authorization.expiresInSeconds,
        intervalSeconds: authorization.intervalSeconds,
      },
    };
  }

  /**
   * Nudges the named attempt's loop to poll `/device/token` immediately,
   * collapsing the remaining interval wait. Idempotent and best-effort: a no-op
   * for an unknown/settled attempt, or when a poll is already on the wire (the
   * next interval sleep is simply skipped). Driven by the browser-return deep
   * link so an approval is picked up at once instead of waiting out `interval`.
   */
  pollNow(attemptId: string): void {
    this.attempts.get(attemptId)?.waker.wake();
  }

  /** Aborts the named attempt's poll loop (idempotent). */
  cancel(attemptId: string): void {
    const handle = this.attempts.get(attemptId);
    if (handle === undefined) {
      return;
    }
    handle.abortController.abort();
    this.attempts.delete(attemptId);
  }

  /** Aborts every in-flight attempt (bridge teardown). */
  disposeAll(): void {
    for (const handle of this.attempts.values()) {
      handle.abortController.abort();
    }
    this.attempts.clear();
  }

  private async runAttempt(
    attemptId: string,
    authorization: Extract<DeviceAuthorizationResult, { kind: "started" }>,
    handle: AttemptHandle,
    handlers: DeviceFlowStartHandlers,
  ): Promise<void> {
    const result = await runDevicePollLoop(
      this.authnBaseUrl,
      authorization,
      handle.abortController.signal,
      handle.waker,
    );
    this.attempts.delete(attemptId);
    // An aborted attempt (superseded / cancelled / window closed) delivers
    // nothing: the renderer's source-aware finalizer would drop it anyway, and
    // staying silent avoids racing a newer attempt.
    if (result === "aborted") {
      return;
    }
    handlers.onResult(attemptId, result);
  }
}

/**
 * The poll loop proper. Returns the terminal outcome, or `"aborted"` when the
 * attempt was cancelled (the caller delivers nothing in that case). Pure over
 * the shared schedule helpers so the backoff/expiry maths matches the CLI.
 */
async function runDevicePollLoop(
  authnBaseUrl: string,
  authorization: Extract<DeviceAuthorizationResult, { kind: "started" }>,
  signal: AbortSignal,
  waker: PollWaker,
): Promise<DeviceFlowResultPayload | "aborted"> {
  let schedule: DevicePollSchedule = createPollSchedule({
    intervalSeconds: authorization.intervalSeconds,
    expiresInSeconds: authorization.expiresInSeconds,
    startedAtMs: Date.now(),
  });

  while (true) {
    if (signal.aborted) {
      return "aborted";
    }
    if (isDeviceExpired(schedule, Date.now())) {
      return { kind: "expired" };
    }
    // Re-check currency immediately before dispatching, and stop waiting for an
    // in-flight poll the moment the attempt is superseded.
    const poll = await raceAbort(
      pollDeviceToken(authnBaseUrl, authorization.deviceCode, "desktop"),
      signal,
    );
    if (poll === "aborted") {
      return "aborted";
    }

    switch (poll.kind) {
      case "authorized":
        return {
          kind: "authorized",
          token: poll.token,
          refreshToken: poll.refreshToken,
        };
      case "access-denied":
        return { kind: "denied" };
      case "expired":
        return { kind: "expired" };
      case "invalid":
        return { kind: "error" };
      case "slow-down":
        schedule = applySlowDown(schedule, poll.retryAfterSeconds);
        break;
      case "authorization-pending":
        break;
      case "network-error":
        // Transient (transport/5xx): keep polling until the device_code TTL.
        break;
    }

    const slept = await sleep(schedule.intervalMs, signal, waker);
    if (!slept) {
      return "aborted";
    }
  }
}

/**
 * Resolves with the promise's value, or `"aborted"` if `signal` fires first.
 * `pollDeviceToken` never rejects (it maps transport failures to
 * `network-error`), but a rejection is treated as an abort defensively.
 */
function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T | "aborted"> {
  if (signal.aborted) {
    return Promise.resolve("aborted");
  }
  return new Promise<T | "aborted">((resolve) => {
    const onAbort = (): void => resolve("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        log.warn("[device-flow] poll rejected unexpectedly", {
          message: error instanceof Error ? error.message : "unknown",
        });
        resolve("aborted");
      },
    );
  });
}

/**
 * Abortable, wakeable sleep. Resolves `true` when the delay elapses OR the
 * waker fires (`pollNow` - re-poll immediately), and `false` on abort. The
 * waker is disarmed and the timer cleared on whichever fires first.
 */
function sleep(
  ms: number,
  signal: AbortSignal,
  waker: PollWaker,
): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    const settle = (value: boolean): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      waker.clear();
      resolve(value);
    };
    const onAbort = (): void => settle(false);
    const timer = setTimeout(() => settle(true), ms);
    signal.addEventListener("abort", onAbort, { once: true });
    // A browser-return nudge collapses the remaining wait into an immediate poll.
    waker.arm(() => settle(true));
  });
}

/**
 * Human-readable label shown on the browser approval screen so the user can
 * tell which machine is asking. The OS hostname is the same identity the host
 * surfaces elsewhere; fall back to a generic label if it is unavailable.
 */
function deviceHostLabel(): string {
  const hostname = os.hostname();
  return hostname.length > 0 ? hostname : "Traycer Desktop";
}
