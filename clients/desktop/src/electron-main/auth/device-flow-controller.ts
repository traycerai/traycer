import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  applySlowDown,
  createPollSchedule,
  DEFAULT_DEVICE_REQUEST_TIMEOUT_MS,
  isDeviceExpired,
  pollDeviceToken,
  resetPollInterval,
  startDeviceAuthorization,
  withReturnScheme,
  type DeviceAuthorizationResult,
  type DevicePollSchedule,
} from "@traycer-clients/shared/auth/device-auth";
import { log } from "../app/logger";

/**
 * Two reasons (Findings 7 & 9): 1. CORS-safe - the authn endpoints don't allow the renderer origin, so a renderer fetch would be blocked; running in main sidesteps that.
 * Cancellation (supersede / sign-out / dispose / window-close) aborts the attempt; an aborted attempt delivers NOTHING - the renderer has already moved on.
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
  /** Called at most once per attempt and never for an aborted/cancelled one. */
  readonly onResult: (
    attemptId: string,
    result: DeviceFlowResultPayload,
  ) => void;
}

class PollWaker {
  private resolve: (() => void) | null = null;
  private pending = false;

  arm(resolve: () => void): void {
    if (this.pending) {
      this.pending = false;
      resolve();
      return;
    }
    this.resolve = resolve;
  }

  clear(): void {
    this.resolve = null;
  }

  wake(): void {
    const resolve = this.resolve;
    this.resolve = null;
    if (resolve === null) {
      this.pending = true;
      return;
    }
    resolve();
  }
}

interface AttemptHandle {
  readonly abortController: AbortController;
  readonly waker: PollWaker;
}

export class DeviceFlowController {
  private readonly attempts = new Map<string, AttemptHandle>();

  constructor(
    private readonly authnBaseUrl: string,
    // The deep-link scheme this build registered (see
    // `electron-main/auth/deep-link.ts`); threaded into the verification URL
    // so the browser's return deep link targets this exact app.
    private readonly returnScheme: string,
  ) {}

  async start(
    handlers: DeviceFlowStartHandlers,
  ): Promise<DeviceFlowStartOutcome> {
    const authorization = await startDeviceAuthorization(
      this.authnBaseUrl,
      {
        clientId: "desktop",
        hostLabel: deviceHostLabel(),
      },
      // No per-attempt abort exists until the attempt id is minted below; a
      // bounded timeout still guarantees `/device/authorize` can't hang the
      // invoke forever.
      { signal: undefined, timeoutMs: DEFAULT_DEVICE_REQUEST_TIMEOUT_MS },
    );
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
        // The short display URI stays clean for manual entry; only the
        // pre-filled URL the shell opens carries the return scheme.
        verificationUri: authorization.verificationUri,
        verificationUriComplete: withReturnScheme(
          authorization.verificationUriComplete,
          this.returnScheme,
        ),
        expiresInSeconds: authorization.expiresInSeconds,
        intervalSeconds: authorization.intervalSeconds,
      },
    };
  }

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

/** Returns the terminal outcome, or `"aborted"` when the attempt was cancelled (the caller delivers nothing in that case). */
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
    // The attempt `signal` is threaded into the request so an abort/supersede actually cancels the in-flight `/device/token` socket (not just stops awaiting it), and a per-request.
    const poll = await raceAbort(
      pollDeviceToken(authnBaseUrl, authorization.deviceCode, "desktop", {
        signal,
        timeoutMs: pollRequestTimeoutMs(schedule.intervalMs),
      }),
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
        // The server accepted this poll's pacing - drop any slow_down widening
        // (a premature browser-return nudge earns one) back to the base
        // interval instead of carrying it for the rest of the attempt.
        schedule = resetPollInterval(schedule);
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

/** `pollDeviceToken` never rejects (it maps transport failures to `network-error`), but a rejection is treated as an abort defensively. */
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

/** Never below the shared default ceiling, and never below the current poll interval, so a legitimately slow round-trip isn't cut off mid-flight while a truly black-holed connection. */
function pollRequestTimeoutMs(intervalMs: number): number {
  return Math.max(intervalMs, DEFAULT_DEVICE_REQUEST_TIMEOUT_MS);
}

function deviceHostLabel(): string {
  const hostname = os.hostname();
  return hostname.length > 0 ? hostname : "Traycer Desktop";
}
