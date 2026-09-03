import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  AUTH_FETCH_MAX_ATTEMPTS,
  authRetryDelayMs,
} from "@traycer-clients/shared/auth/auth-validation";
import { AuthService } from "@/lib/auth/auth-service";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * Regression coverage for the "wake arrives while a stored-session recovery
 * probe is in flight" bug.
 *
 * `auth-service.ts`'s `scheduleSessionRecovery` is single-armed
 * (`sessionRecoveryTimer !== null` short-circuits it), which is what stops
 * overlapping ticks. The failure tail of a recovery probe re-arms the loop
 * ON ITS WAY OUT - i.e. BEFORE the probe's own promise settles - so by the
 * time `runSessionRecovery(...).finally()` runs, a fresh (backed-off) timer
 * is already pending. A wake (`online` / OS-resume) that lands while that
 * probe is running only records `sessionRecoveryRerunRequested = true` and
 * waits for the `.finally()` to act on it; the fix
 * (`replaceScheduledSessionRecovery`) makes that tail CANCEL the pending
 * backed-off timer and re-arm from the floor
 * (`SESSION_RECOVERY_INITIAL_DELAY_MS`, 1s) instead of calling
 * `scheduleSessionRecovery` again (which would see the timer already armed
 * and no-op).
 *
 * This file exercises exactly that seam with `vi.useFakeTimers()`, reusing
 * the timer-driving idiom from the sibling `auth-service.test.ts` (repeated
 * `vi.advanceTimersByTimeAsync(...)` steps mirroring the auth boundary's own
 * per-attempt retry backoff, never a `vi.waitFor` poll on a spy count).
 */

const VALIDATION_URL = "http://localhost:5005/api/v3/user";
const REFRESH_URL = "http://localhost:5005/api/v3/auth/refresh";

type FetchHandler = (
  input: unknown,
  init:
    | {
        readonly method?: string;
        readonly headers?: Record<string, string>;
        readonly body?: BodyInit | null;
      }
    | undefined,
) => Promise<Response>;

interface DeferredResponse {
  readonly promise: Promise<Response>;
  resolve(response: Response): void;
}

function createDeferredResponse(): DeferredResponse {
  const state: { resolve: (response: Response) => void } = {
    resolve: () => undefined,
  };
  const promise = new Promise<Response>((resolve) => {
    state.resolve = resolve;
  });
  return {
    promise,
    resolve: (response) => {
      state.resolve(response);
    },
  };
}

function status(code: number): Promise<Response> {
  return Promise.resolve(new Response(null, { status: code }));
}

const DEFAULT_IDENTITY = {
  id: "user-1",
  email: "test@example.com",
  name: "Test User",
} as const;

const trackedServices: AuthService[] = [];

function makeService(): { service: AuthService; host: MockRunnerHost } {
  const host = new MockRunnerHost({
    signInUrl:
      "https://auth.traycer.ai/sign-in?redirect_uri=traycer%3A%2F%2Fauth",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const service = new AuthService({ runnerHost: host });
  trackedServices.push(service);
  return { service, host };
}

function installFetch(handler: FetchHandler): () => void {
  const originalFetch: unknown = (globalThis as { fetch?: unknown }).fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: handler,
  });
  return () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
  };
}

/** Advances past one recovery/startup probe's full internal retry sequence. */
async function advancePastAuthRetries(): Promise<void> {
  for (let retry = 1; retry < AUTH_FETCH_MAX_ATTEMPTS; retry += 1) {
    await vi.advanceTimersByTimeAsync(authRetryDelayMs(retry));
  }
}

describe("AuthService session recovery - wake mid-probe", () => {
  let restoreFetch: () => void = () => undefined;

  beforeEach(() => {
    useAuthStore.getState().setSignedOut();
    restoreFetch = installFetch(() => status(500));
  });

  afterEach(() => {
    while (trackedServices.length > 0) {
      const service = trackedServices.pop();
      if (service !== undefined) {
        service.dispose();
      }
    }
    useAuthStore.getState().setSignedOut();
    vi.useRealTimers();
    restoreFetch();
  });

  it("re-arms recovery from the floor when a wake lands mid-probe, discarding the already-armed backoff", async () => {
    vi.useFakeTimers();
    const { service, host } = makeService();
    await host.tokenStore.signIn(
      { token: "stale-token", refreshToken: "stale-refresh" },
      { ...DEFAULT_IDENTITY },
    );

    let validationCalls = 0;
    // Set right before the tick we want to catch in flight; consumed by the
    // very next `/user` call and then cleared, so only ONE call ever hangs.
    let hangNextValidation = false;
    const deferred = createDeferredResponse();
    restoreFetch();
    restoreFetch = installFetch((input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url !== VALIDATION_URL) {
        return status(500);
      }
      validationCalls += 1;
      if (hangNextValidation) {
        hangNextValidation = false;
        return deferred.promise;
      }
      // Every settled attempt is a plain 5xx -> `network-error`, never a
      // 401/403/404 - those route to the terminal rotate branch instead of
      // the recovery backoff this test is about.
      return status(500);
    });

    // Startup: `/user` unreachable -> local plane admitted `unverified`,
    // recovery armed at the floor (1s) via `startup:validate-network`.
    const start = service.start();
    await advancePastAuthRetries();
    await start;
    expect(useAuthStore.getState().status).toBe("unverified");

    // Tick 1 (armed at 1s): fails -> re-arms tick 2 at 2s.
    await vi.advanceTimersByTimeAsync(1_000);
    await advancePastAuthRetries();
    expect(useAuthStore.getState().status).toBe("unverified");

    // Tick 2 (armed at 2s): fails -> re-arms tick 3 at 4s. Backoff is now
    // well past the 1s floor - this is the "2-3 failures" wind-up the wake
    // has to overturn.
    await vi.advanceTimersByTimeAsync(2_000);
    await advancePastAuthRetries();
    expect(useAuthStore.getState().status).toBe("unverified");

    // Tick 3 (armed at 4s): let its ONE `/user` call hang instead of
    // settling, to catch it genuinely in flight.
    hangNextValidation = true;
    await vi.advanceTimersByTimeAsync(4_000);
    const callsWhenHung = validationCalls;
    expect(callsWhenHung).toBeGreaterThan(0);

    // The wake signal lands while that probe is in flight.
    // `nudgeSessionRecoveryOnWake` sees `sessionRecoveryInFlight === true`
    // and only records `sessionRecoveryRerunRequested = true` here - the
    // seam this test drives is `IRunnerHost.onSystemResumed`, the
    // deterministic test double `installWakeRefreshListeners` wires
    // alongside the `online` DOM event; `MockRunnerHost.emitSystemResumed()`
    // fires it synchronously, with none of the `online` path's 250ms
    // debounce to drive through fake timers.
    host.emitSystemResumed({ backgroundedForMs: null });

    // Resolve the in-flight probe as a failure - the recovery tick's failure
    // tail runs `scheduleSessionRecovery("recovery:validate-network")` on its
    // way out (arming the NEXT tick at the already-backed-off ~8s delay)
    // BEFORE its own promise settles, and only then does `.finally()` see
    // `sessionRecoveryRerunRequested` and act on the wake.
    deferred.resolve(new Response(null, { status: 500 }));
    // The retry loop the boundary runs on a failed attempt continues from
    // here (2 more attempts, real settled responses this time).
    await advancePastAuthRetries();
    expect(useAuthStore.getState().status).toBe("unverified");

    const callsAfterProbeSettled = validationCalls;

    // THE ASSERTION THAT DISTINGUISHES THE FIX FROM THE BUG:
    //
    // Pre-fix, the failure tail's `scheduleSessionRecovery` call (made while
    // the probe was still settling) already armed the NEXT tick at the
    // backed-off ~8s delay, and the `.finally()` tail called plain
    // `scheduleSessionRecovery` again - which no-ops because
    // `sessionRecoveryTimer !== null`. So pre-fix, no new probe would fire
    // until the full ~8s elapsed, and it would fire at the STALE backed-off
    // delay, not the floor.
    //
    // Post-fix, `replaceScheduledSessionRecovery` cancels that ~8s timer and
    // re-arms from `SESSION_RECOVERY_INITIAL_DELAY_MS` (1s). So a new probe
    // must appear at exactly 1s past this point - far short of the ~8s a
    // reverted fix would need, and this is the exact delta that would make
    // this assertion fail against the pre-fix `scheduleSessionRecovery`-only
    // tail.
    await vi.advanceTimersByTimeAsync(999);
    expect(validationCalls).toBe(callsAfterProbeSettled);

    await vi.advanceTimersByTimeAsync(1);
    expect(validationCalls).toBe(callsAfterProbeSettled + 1);
  });
});

describe("AuthService terminal verdicts and the recovery loop", () => {
  let restoreFetch: () => void = () => undefined;

  beforeEach(() => {
    useAuthStore.getState().setSignedOut();
    restoreFetch = installFetch(() => status(500));
  });

  afterEach(() => {
    while (trackedServices.length > 0) {
      const service = trackedServices.pop();
      if (service !== undefined) {
        service.dispose();
      }
    }
    useAuthStore.getState().setSignedOut();
    vi.useRealTimers();
    restoreFetch();
  });

  /** Signs the stored session in through startup with authn answering `ok`. */
  async function startSignedIn(
    service: AuthService,
    host: MockRunnerHost,
  ): Promise<void> {
    await host.tokenStore.signIn(
      { token: "live-token", refreshToken: "live-refresh" },
      { ...DEFAULT_IDENTITY },
    );
    await service.start();
    expect(useAuthStore.getState().status).toBe("signed-in");
  }

  /** The `/api/v3/user` body startup validation accepts (auth-service.test.ts's shape). */
  function okUser(): Promise<Response> {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          user: {
            id: DEFAULT_IDENTITY.id,
            name: DEFAULT_IDENTITY.name,
            providerId: "gh-1",
            providerHandle: "test-user",
            providerType: "GITHUB",
            email: DEFAULT_IDENTITY.email,
            avatarUrl: null,
            activatedAt: null,
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:00.000Z",
            lastSeenAt: null,
            privacyMode: false,
            isLearningEnabled: true,
          },
          userSubscription: {
            id: "sub-1",
            userID: DEFAULT_IDENTITY.id,
            orgID: null,
            teamID: null,
            customerId: "cus-1",
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:00.000Z",
            subscriptionExpiry: null,
            trialEndsAt: null,
            subscriptionStatus: "FREE",
            hasPaymentMethod: false,
            isInTrial: false,
            rechargeRateSeconds: 0,
          },
          teamSubscriptions: [],
          payAsYouGoUsage: { allowPayAsYouGo: false },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }

  it("does not re-spend the refused credential on wake after a LIVE terminal rejection", async () => {
    vi.useFakeTimers();
    const { service, host } = makeService();
    restoreFetch();
    restoreFetch = installFetch(() => okUser());
    await startSignedIn(service, host);

    // The live session's reactive rotation: validation and refresh both
    // reject. The stored-session paths latch this as terminal; the live arm
    // demotes through the same terminal arm and must latch too.
    let refreshCalls = 0;
    let validationCalls = 0;
    restoreFetch();
    restoreFetch = installFetch((input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url === VALIDATION_URL) {
        validationCalls += 1;
        return status(401);
      }
      if (url === REFRESH_URL) {
        refreshCalls += 1;
        return status(401);
      }
      return status(500);
    });
    const outcome = await service.revalidateCurrentContext();
    expect(outcome?.kind).toBe("rejected");
    expect(useAuthStore.getState().status).toBe("unverified");
    const refreshCallsAtVerdict = refreshCalls;
    const validationCallsAtVerdict = validationCalls;
    expect(refreshCallsAtVerdict).toBeGreaterThan(0);

    // A wake is evidence about the network, and this session did not stop
    // for the network. Past the recovery floor and its retries, nothing was
    // asked again - the server's verdict stands until a sign-in clears it.
    host.emitSystemResumed({ backgroundedForMs: null });
    await vi.advanceTimersByTimeAsync(5_000);
    await advancePastAuthRetries();
    expect(useAuthStore.getState().status).toBe("unverified");
    expect(refreshCalls).toBe(refreshCallsAtVerdict);
    expect(validationCalls).toBe(validationCallsAtVerdict);
  });

  it("re-arms stored-session recovery, not proactive refresh, when signOut's delete fails on a transiently unverified session", async () => {
    vi.useFakeTimers();
    const { service, host } = makeService();
    await host.tokenStore.signIn(
      { token: "stale-token", refreshToken: "stale-refresh" },
      { ...DEFAULT_IDENTITY },
    );
    let validationCalls = 0;
    restoreFetch();
    restoreFetch = installFetch((input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url === VALIDATION_URL) validationCalls += 1;
      return status(500);
    });
    const start = service.start();
    await advancePastAuthRetries();
    await start;
    expect(useAuthStore.getState().status).toBe("unverified");

    host.tokenStore.delete = (): Promise<void> =>
      Promise.reject(new Error("EACCES: credentials locked"));
    await service.signOut();
    expect(useAuthStore.getState().status).toBe("unverified");

    // The sign-out stood the recovery loop down; the failed delete must put
    // it back (from the floor), because the session it left in place is one
    // authn has not refused - only not reached.
    const callsAfterSignOut = validationCalls;
    await vi.advanceTimersByTimeAsync(1_000);
    await advancePastAuthRetries();
    expect(validationCalls).toBeGreaterThan(callsAfterSignOut);
  });

  it("restarts nothing when signOut's delete fails on a terminally rejected session", async () => {
    vi.useFakeTimers();
    const { service, host } = makeService();
    await host.tokenStore.signIn(
      { token: "dead-token", refreshToken: "dead-refresh" },
      { ...DEFAULT_IDENTITY },
    );
    let calls = 0;
    restoreFetch();
    restoreFetch = installFetch((input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url === VALIDATION_URL || url === REFRESH_URL) calls += 1;
      return status(401);
    });
    await service.start();
    expect(useAuthStore.getState().status).toBe("unverified");

    host.tokenStore.delete = (): Promise<void> =>
      Promise.reject(new Error("EACCES: credentials locked"));
    await service.signOut();
    expect(useAuthStore.getState().status).toBe("unverified");

    // Neither the recovery loop nor the proactive scheduler: the credential
    // on disk is one authn refused, and a failed sign-out is not a reason to
    // spend it again.
    const callsAfterSignOut = calls;
    await vi.advanceTimersByTimeAsync(60_000);
    await advancePastAuthRetries();
    expect(calls).toBe(callsAfterSignOut);
  });
});
