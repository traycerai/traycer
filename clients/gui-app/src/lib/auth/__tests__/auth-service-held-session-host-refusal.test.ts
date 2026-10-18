import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { OpenFrameBearerSource } from "@traycer-clients/shared/auth/bearer-source";
import {
  AUTH_FETCH_MAX_ATTEMPTS,
  authRetryDelayMs,
} from "@traycer-clients/shared/auth/auth-validation";
import {
  AuthService,
  AUTH_ERROR_SESSION_EXPIRED,
  AUTH_ERROR_SIGNED_OUT_EVERYWHERE,
  type RevokedCloudAuthorization,
} from "@/lib/auth/auth-service";
import { createStreamAuthRevalidator } from "@/lib/auth/stream-auth-revalidator";
import { resolveShellLocalPlaneAdmission } from "@/hooks/auth/use-shell-local-plane-admission";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * A session authn has REFUSED, held open as `unverified` for its local plane,
 * and what a host refusing its bearer does afterwards.
 *
 * The stored access token is rejected by `/api/v3/user` and the refresh token
 * by `/api/v3/auth/refresh` (a 401: `refresh-rejected-credential`), so the
 * session is `unverified` with `cloudVerdictLoss: "session-rejected"`, the
 * service's terminal latch set, and a "Session expired" error raised once. The
 * bearer it retains is the one the host serves the local plane on, and the
 * host verifies it like any other: once it has EXPIRED, every host request
 * fails UNAUTHORIZED and the transport asks `revalidateExpectedBearer` (unary)
 * or `revalidateCurrentContext` (stream) what to do.
 *
 * Before the fix each of those asks re-ran `/api/v3/user` AND re-spent the
 * refresh token authn had already refused, then re-raised "session expired",
 * so the toast came back on every host request (a refresh roughly every three
 * seconds). Now the latch answers `rejected` without asking authn anything -
 * while the session is `unverified` AND while a sign-in attempt is replacing
 * it (`signing-in`; `signed-in` holds a verdict and is never answered from the
 * latch).
 *
 * The shell is sent to the sign-in page (`hostRefusedHeldBearer`) only when
 * the held bearer has actually EXPIRED. A host also answers UNAUTHORIZED to
 * requests that need the cloud verdict this session no longer has, while it
 * keeps serving the local plane on the same bearer until that bearer's own
 * expiry; flagging on the refusal alone would throw away a working local
 * plane. So `AuthService.noteHostRefusedHeldBearer` reads the bearer's `exp`
 * and flags only an expired one, and a token whose expiry cannot be read is
 * never flagged. That is why the fixtures here are JWT-shaped: an opaque
 * string like `"dead-token"` has no readable expiry and would never trip it.
 * The status stays `unverified` throughout: the identity is kept and nothing
 * account-scoped is purged.
 *
 * One refusal does not wait for `exp`: authn's user-epoch revocation ("sign out
 * everywhere", a refresh 401 stamped `revocation_scope: user_epoch`). The host
 * refuses a revoked bearer as soon as the account's token floor reaches it, so
 * the service remembers the bearer it held at that refusal
 * (`revokedHeldBearer`) and flags it at once, however far off its `exp` is.
 * Only that bearer: a plain credential refusal still waits for `exp`, and the
 * mark clears with the latch, so it never rides onto a later session. A
 * sibling window that held the same bearer learns of the revocation over the
 * cross-window revoke channel, which carries the scope
 * (`ingestCloudAuthorizationRevoked`), so it flags the bearer at once as well.
 *
 * Fixtures follow `auth-service-session-recovery-wake.test.ts`: a
 * `MockRunnerHost`, a `fetch` double keyed on the two authn routes (counted,
 * so "asks authn nothing" is a number rather than an absence), fake timers
 * with a CONTROLLED system time (the expiry decision reads `Date.now()`),
 * driven with `vi.advanceTimersByTimeAsync` and `vi.setSystemTime`, never a
 * `vi.waitFor` on a spy count.
 */

// The identity route `validateAuthTokenIdentity*` calls FIRST (see
// `auth-validation.ts`); every fixture in this file answers this one.
const VALIDATION_URL = "http://localhost:5005/api/v3/user/negotiated";
const REFRESH_URL = "http://localhost:5005/api/v3/auth/refresh";

/** How many host refusals the "it used to come back every time" tests replay. */
const HOST_REFUSALS = 10;

/** The fake wall clock every test starts at. */
const NOW_MS = Date.parse("2026-10-16T12:00:00.000Z");
const MINUTE_MS = 60_000;

/** Unreadable expiry: not a JWT, so it can never be judged expired. */
const OPAQUE_TOKEN = "dead-token";

function base64Url(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A JWT-shaped access token whose `exp` claim is `expiresAtMs` (the claim is
 * seconds since the epoch). The signature segment is never read: the client
 * decodes `exp` only, and the host is the sole authority on validity.
 */
function jwtExpiringAt(expiresAtMs: number): string {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({ sub: "user-1", exp: Math.floor(expiresAtMs / 1000) }),
  );
  return `${header}.${payload}.signature`;
}

/** Expired a minute before the fake `NOW_MS`. */
const EXPIRED_TOKEN = jwtExpiringAt(NOW_MS - MINUTE_MS);
/** Still valid at `NOW_MS`, and expires a few minutes later. */
const EXPIRES_AT_MS = NOW_MS + 5 * MINUTE_MS;
const SOON_EXPIRING_TOKEN = jwtExpiringAt(EXPIRES_AT_MS);
/** A fake time at which `SOON_EXPIRING_TOKEN` has expired. */
const PAST_EXPIRY_MS = EXPIRES_AT_MS + MINUTE_MS;
/**
 * Still valid at `NOW_MS` for half an hour: the bearer a person signs in on
 * after a refusal, long-lived enough that the refresh scheduler leaves it be.
 */
const LONG_LIVED_EXPIRES_AT_MS = NOW_MS + 30 * MINUTE_MS;
const LONG_LIVED_TOKEN = jwtExpiringAt(LONG_LIVED_EXPIRES_AT_MS);
/** A fake time at which `LONG_LIVED_TOKEN` has expired. */
const LONG_LIVED_PAST_EXPIRY_MS = LONG_LIVED_EXPIRES_AT_MS + MINUTE_MS;

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

type AuthnAnswer = () => Promise<Response>;

/**
 * A `fetch` double for the two authn routes this suite cares about. Every
 * call is counted and answered by the CURRENT `answerValidation` /
 * `answerRefresh`, which a test swaps to move authn from "accepts" to
 * "refuses" mid-scenario. Anything else answers 500.
 */
interface AuthnDouble {
  validationCalls: number;
  refreshCalls: number;
  answerValidation: AuthnAnswer;
  answerRefresh: AuthnAnswer;
  readonly handler: FetchHandler;
}

function status(code: number): Promise<Response> {
  return Promise.resolve(new Response(null, { status: code }));
}

function unreachable(): Promise<Response> {
  return Promise.reject(new TypeError("Failed to fetch"));
}

/**
 * authn's refresh refusal for the user's own "sign out everywhere": a 401
 * stamped with the user-epoch revocation scope (the shape `auth-service.test.ts`
 * pins for the same copy). A fresh `Response` per call, since a body reads once.
 */
function revokedEverywhere(): Promise<Response> {
  return Promise.resolve(
    new Response(
      JSON.stringify({ error: "needs_reauth", revocation_scope: "user_epoch" }),
      { status: 401, headers: { "content-type": "application/json" } },
    ),
  );
}

function createAuthnDouble(): AuthnDouble {
  const double: AuthnDouble = {
    validationCalls: 0,
    refreshCalls: 0,
    answerValidation: () => status(500),
    answerRefresh: () => status(500),
    handler: (input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url === VALIDATION_URL) {
        double.validationCalls += 1;
        return double.answerValidation();
      }
      if (url === REFRESH_URL) {
        double.refreshCalls += 1;
        return double.answerRefresh();
      }
      return status(500);
    },
  };
  return double;
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

const DEFAULT_IDENTITY = {
  id: "user-1",
  email: "test@example.com",
  name: "Test User",
} as const;

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
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "x-traycer-user-record-version": "2.0",
        },
      },
    ),
  );
}

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

/** Fake timers whose system time is pinned to `NOW_MS`, so `exp` is decidable. */
function useFakeClock(): void {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
}

/** Advances past one probe's full internal retry sequence. */
async function advancePastAuthRetries(): Promise<void> {
  for (let retry = 1; retry < AUTH_FETCH_MAX_ATTEMPTS; retry += 1) {
    await vi.advanceTimersByTimeAsync(authRetryDelayMs(retry));
  }
}

/**
 * Counts how many times one auth error (the "session expired" one, unless a
 * test names another) is DELIVERED, the way `AuthSessionExpiredToastBridge`
 * consumes it: it toasts the error and then clears the durable one so an inline
 * surface never renders stale copy.
 *
 * The acknowledgement is the point. `setLastError` de-duplicates, so without
 * it a second "session expired" would be swallowed as "no change" and the
 * count could not tell a service that re-raised it from one that did not. With
 * it, every re-raise is a fresh delivery - which is the toast the person saw
 * come back.
 */
interface ErrorDeliveries {
  count(): number;
}

function watchDeliveries(
  service: AuthService,
  wanted: string,
): ErrorDeliveries {
  let delivered = 0;
  service.onErrorChange((error) => {
    if (error !== wanted) {
      return;
    }
    delivered += 1;
    service.clearLastError();
  });
  return { count: () => delivered };
}

function watchExpiryDeliveries(service: AuthService): ErrorDeliveries {
  return watchDeliveries(service, AUTH_ERROR_SESSION_EXPIRED);
}

/** The credentials object a host transport would hand back as `expected`. */
function liveCredentials(service: AuthService): OpenFrameBearerSource {
  const context = service.getRequestContextProvider().current();
  if (context === null) {
    throw new Error("expected a live request context");
  }
  return context.credentials;
}

function repeated(count: number, outcome: string): string[] {
  return Array.from({ length: count }, () => outcome);
}

/** Replays `count` unary host refusals of `credentials`. */
async function refuseUnary(
  service: AuthService,
  credentials: OpenFrameBearerSource,
  count: number,
): Promise<string[]> {
  const outcomes: string[] = [];
  for (let refusal = 0; refusal < count; refusal += 1) {
    outcomes.push(await service.revalidateExpectedBearer(credentials));
  }
  return outcomes;
}

/**
 * Boots a stored session whose access token authn refuses (401) and whose
 * refresh spend is answered by `answerRefresh`. Startup validates, rotates, and
 * lands the session `unverified` on a `session-rejected` verdict, raising one
 * auth error, counted under `deliveries` as `deliveredError`.
 */
async function startStoredSessionRefusedBy(
  authn: AuthnDouble,
  accessToken: string,
  answerRefresh: AuthnAnswer,
  deliveredError: string,
): Promise<{
  service: AuthService;
  host: MockRunnerHost;
  deliveries: ErrorDeliveries;
}> {
  authn.answerValidation = () => status(401);
  authn.answerRefresh = answerRefresh;
  const { service, host } = makeService();
  const deliveries = watchDeliveries(service, deliveredError);
  await host.tokenStore.signIn(
    { token: accessToken, refreshToken: "dead-refresh" },
    { ...DEFAULT_IDENTITY },
  );
  await service.start();
  return { service, host, deliveries };
}

/**
 * A stored session whose access token AND refresh token authn refuses (401 on
 * both routes), raising "session expired" once.
 */
async function startRefusedSession(
  authn: AuthnDouble,
  accessToken: string,
): Promise<{
  service: AuthService;
  host: MockRunnerHost;
  expiry: ErrorDeliveries;
}> {
  const { service, host, deliveries } = await startStoredSessionRefusedBy(
    authn,
    accessToken,
    () => status(401),
    AUTH_ERROR_SESSION_EXPIRED,
  );
  return { service, host, expiry: deliveries };
}

/**
 * A stored session authn refuses as the user's own "sign out everywhere": the
 * refresh 401 carries the user-epoch revocation scope, so the one error raised
 * is the signed-out-everywhere copy.
 */
async function startRevokedSession(
  authn: AuthnDouble,
  accessToken: string,
): Promise<{
  service: AuthService;
  host: MockRunnerHost;
  signedOutEverywhere: ErrorDeliveries;
}> {
  const { service, host, deliveries } = await startStoredSessionRefusedBy(
    authn,
    accessToken,
    revokedEverywhere,
    AUTH_ERROR_SIGNED_OUT_EVERYWHERE,
  );
  return { service, host, signedOutEverywhere: deliveries };
}

/**
 * A stored session authn accepts, started `signed-in` on `token`: the state of
 * a window that holds a cloud verdict, before anything refuses it.
 */
async function startSignedInSession(
  authn: AuthnDouble,
  token: string,
): Promise<{ service: AuthService; host: MockRunnerHost }> {
  const { service, host } = makeService();
  authn.answerValidation = okUser;
  await host.tokenStore.signIn(
    { token, refreshToken: "live-refresh" },
    { ...DEFAULT_IDENTITY },
  );
  await service.start();
  expect(useAuthStore.getState().status).toBe("signed-in");
  expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(false);
  return { service, host };
}

/**
 * The interactive sign-in the person does after a refusal: authn accepts the
 * freshly authorized token, and the session lands `signed-in`.
 */
async function signInInteractively(
  service: AuthService,
  host: MockRunnerHost,
  authn: AuthnDouble,
  token: string,
): Promise<void> {
  authn.answerValidation = okUser;
  await service.signIn();
  host.deviceFlow.emitResult({
    kind: "authorized",
    token,
    refreshToken: "fresh-refresh",
  });
  await vi.waitFor(() => {
    expect(useAuthStore.getState().status).toBe("signed-in");
  });
}

describe("AuthService - a host refusing the bearer of a session authn refused", () => {
  let authn: AuthnDouble = createAuthnDouble();
  let restoreFetch: () => void = () => undefined;

  beforeEach(() => {
    useAuthStore.getState().setSignedOut();
    useAuthStore.getState().setCloudVerdictLoss("unreachable");
    authn = createAuthnDouble();
    restoreFetch = installFetch(authn.handler);
  });

  afterEach(() => {
    while (trackedServices.length > 0) {
      const service = trackedServices.pop();
      if (service !== undefined) {
        service.dispose();
      }
    }
    useAuthStore.getState().setSignedOut();
    useAuthStore.getState().setCloudVerdictLoss("unreachable");
    vi.useRealTimers();
    restoreFetch();
  });

  it("flags an already-expired held bearer at startup, then asks authn nothing across repeated unary refusals and raises the expiry once", async () => {
    useFakeClock();
    const { service, expiry } = await startRefusedSession(authn, EXPIRED_TOKEN);

    // The verdict, as startup left it: held for the local plane, refused by
    // authn - and, because the held bearer is already past its `exp`, already
    // known to be unusable by a host. No host has refused anything yet.
    const atVerdict = useAuthStore.getState();
    expect(atVerdict.status).toBe("unverified");
    expect(atVerdict.cloudVerdictLoss).toBe("session-rejected");
    expect(atVerdict.hostRefusedHeldBearer).toBe(true);
    const validationAtVerdict = authn.validationCalls;
    const refreshAtVerdict = authn.refreshCalls;
    // Not vacuous: the verdict itself cost a round trip to each route, so
    // "unchanged" below is a count that could have moved.
    expect(validationAtVerdict).toBeGreaterThan(0);
    expect(refreshAtVerdict).toBeGreaterThan(0);
    expect(expiry.count()).toBe(1);

    const outcomes = await refuseUnary(
      service,
      liveCredentials(service),
      HOST_REFUSALS,
    );

    // The fetch counts come first: this is where the bug showed, a validation
    // and a re-spent refresh per refusal.
    expect(authn.validationCalls).toBe(validationAtVerdict);
    expect(authn.refreshCalls).toBe(refreshAtVerdict);
    expect(expiry.count()).toBe(1);
    expect(service.getLastError()).toBeNull();
    expect(outcomes).toEqual(repeated(HOST_REFUSALS, "rejected"));
    const after = useAuthStore.getState();
    expect(after.hostRefusedHeldBearer).toBe(true);
    expect(after.status).toBe("unverified");
    expect(after.cloudVerdictLoss).toBe("session-rejected");
    expect(after.profile?.userId).toBe(DEFAULT_IDENTITY.id);

    // Nothing time-driven spends it either.
    await vi.advanceTimersByTimeAsync(60_000);
    await advancePastAuthRetries();
    expect(authn.validationCalls).toBe(validationAtVerdict);
    expect(authn.refreshCalls).toBe(refreshAtVerdict);
    expect(expiry.count()).toBe(1);
  });

  it("keeps a held bearer whose expiry cannot be read open for the local plane, however often a host refuses it", async () => {
    useFakeClock();
    const { service, expiry } = await startRefusedSession(authn, OPAQUE_TOKEN);
    const validationAtVerdict = authn.validationCalls;
    const refreshAtVerdict = authn.refreshCalls;
    expect(validationAtVerdict).toBeGreaterThan(0);

    const outcomes = await refuseUnary(service, liveCredentials(service), 3);

    // Still the latch's answer: no new round trip, no new toast.
    expect(authn.validationCalls).toBe(validationAtVerdict);
    expect(authn.refreshCalls).toBe(refreshAtVerdict);
    expect(expiry.count()).toBe(1);
    expect(outcomes).toEqual(repeated(3, "rejected"));
    // ...but "expired" cannot be proved of a token with no `exp`, so the
    // local plane it holds open is not thrown away on a guess.
    const after = useAuthStore.getState();
    expect(after.hostRefusedHeldBearer).toBe(false);
    expect(after.status).toBe("unverified");
  });

  it("asks authn nothing more across repeated stream-path revalidations, raises no new expiry, and leaves the flag to the transport that saw a host refuse", async () => {
    useFakeClock();
    const { service, expiry } = await startRefusedSession(
      authn,
      SOON_EXPIRING_TOKEN,
    );
    const validationAtVerdict = authn.validationCalls;
    const refreshAtVerdict = authn.refreshCalls;
    expect(validationAtVerdict).toBeGreaterThan(0);
    expect(refreshAtVerdict).toBeGreaterThan(0);
    expect(expiry.count()).toBe(1);
    // The held bearer expires while the app is open: from here a host would
    // refuse it, which is the situation every revalidation below is in.
    vi.setSystemTime(PAST_EXPIRY_MS);

    const outcomes: Array<string | undefined> = [];
    for (let attempt = 0; attempt < HOST_REFUSALS; attempt += 1) {
      outcomes.push((await service.revalidateCurrentContext())?.kind);
    }

    expect(authn.validationCalls).toBe(validationAtVerdict);
    expect(authn.refreshCalls).toBe(refreshAtVerdict);
    expect(expiry.count()).toBe(1);
    expect(service.getLastError()).toBeNull();
    expect(outcomes).toEqual(repeated(HOST_REFUSALS, "rejected"));
    // The session is untouched. This path does not speak for a HOST: the
    // settings subscription query reaches it too (`fetchAuthenticatedUser`),
    // and only the transports that saw a host refusal report one - the stream
    // revalidator through `noteHostRefusedHeldBearer`, `revalidateExpectedBearer`
    // directly.
    const after = useAuthStore.getState();
    expect(after.status).toBe("unverified");
    expect(after.hostRefusedHeldBearer).toBe(false);
  });

  it("drives the stream revalidator end to end: its local-plane-retained verdict asks authn nothing and flags the held bearer only once it has expired", async () => {
    useFakeClock();
    const { service, expiry } = await startRefusedSession(
      authn,
      SOON_EXPIRING_TOKEN,
    );
    const validationAtVerdict = authn.validationCalls;
    const refreshAtVerdict = authn.refreshCalls;
    expect(validationAtVerdict).toBeGreaterThan(0);
    expect(refreshAtVerdict).toBeGreaterThan(0);
    const revalidator = createStreamAuthRevalidator(service);

    // A reconnecting stream asks what to do after a host refused its bearer.
    // The session is `unverified`, so the verdict is "keep the local plane" -
    // and, the bearer not having expired, the host has not really lost it.
    expect(await revalidator.revalidateForReconnect()).toBe(
      "local-plane-retained",
    );
    expect(authn.validationCalls).toBe(validationAtVerdict);
    expect(authn.refreshCalls).toBe(refreshAtVerdict);
    expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(false);

    // Once the bearer has expired the same verdict reports the refusal to the
    // service, which now flags it: the stream path and the unary path apply
    // one rule.
    vi.setSystemTime(PAST_EXPIRY_MS);
    expect(await revalidator.revalidateForReconnect()).toBe(
      "local-plane-retained",
    );
    expect(authn.validationCalls).toBe(validationAtVerdict);
    expect(authn.refreshCalls).toBe(refreshAtVerdict);
    expect(expiry.count()).toBe(1);
    expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(true);
    expect(useAuthStore.getState().status).toBe("unverified");
  });

  it("does not flag a refused session whose held bearer has not expired yet, and flags it on the first refusal after it does", async () => {
    useFakeClock();
    const { service, expiry } = await startRefusedSession(
      authn,
      SOON_EXPIRING_TOKEN,
    );
    const validationAtVerdict = authn.validationCalls;
    const refreshAtVerdict = authn.refreshCalls;
    expect(validationAtVerdict).toBeGreaterThan(0);
    expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(false);

    // A host answers UNAUTHORIZED to a request that needs the cloud verdict
    // this session has lost, while serving the local plane on the same bearer
    // until it expires. The refusal alone is not "the local plane is gone".
    const credentials = liveCredentials(service);
    const early = await refuseUnary(service, credentials, HOST_REFUSALS);

    expect(authn.validationCalls).toBe(validationAtVerdict);
    expect(authn.refreshCalls).toBe(refreshAtVerdict);
    expect(early).toEqual(repeated(HOST_REFUSALS, "rejected"));
    expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(false);
    expect(useAuthStore.getState().status).toBe("unverified");

    // The bearer expires. Nothing time-driven flags it...
    vi.setSystemTime(PAST_EXPIRY_MS);
    expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(false);

    // ...the next refusal does, still without asking authn anything.
    expect(await service.revalidateExpectedBearer(credentials)).toBe(
      "rejected",
    );
    expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(true);
    expect(useAuthStore.getState().status).toBe("unverified");
    expect(authn.validationCalls).toBe(validationAtVerdict);
    expect(authn.refreshCalls).toBe(refreshAtVerdict);
    expect(expiry.count()).toBe(1);
  });

  it("holds the same line when the refusal follows a LIVE demotion on an unexpired bearer rather than a stored-session startup", async () => {
    useFakeClock();
    const { service, host } = makeService();
    const expiry = watchExpiryDeliveries(service);
    authn.answerValidation = okUser;
    await host.tokenStore.signIn(
      { token: SOON_EXPIRING_TOKEN, refreshToken: "live-refresh" },
      { ...DEFAULT_IDENTITY },
    );
    await service.start();
    expect(useAuthStore.getState().status).toBe("signed-in");
    expect(expiry.count()).toBe(0);

    // The live session's reactive rotation: validation and refresh both
    // refuse, and the session is demoted through the terminal arm.
    authn.answerValidation = () => status(401);
    authn.answerRefresh = () => status(401);
    const verdict = await service.revalidateCurrentContext();
    expect(verdict?.kind).toBe("rejected");
    expect(useAuthStore.getState().status).toBe("unverified");
    expect(useAuthStore.getState().cloudVerdictLoss).toBe("session-rejected");
    // Refused by authn, but the bearer it keeps has not expired: not flagged.
    expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(false);
    expect(expiry.count()).toBe(1);
    const validationAtVerdict = authn.validationCalls;
    const refreshAtVerdict = authn.refreshCalls;
    expect(refreshAtVerdict).toBeGreaterThan(0);

    const credentials = liveCredentials(service);
    const outcomes = await refuseUnary(service, credentials, HOST_REFUSALS);

    expect(authn.validationCalls).toBe(validationAtVerdict);
    expect(authn.refreshCalls).toBe(refreshAtVerdict);
    expect(expiry.count()).toBe(1);
    expect(outcomes).toEqual(repeated(HOST_REFUSALS, "rejected"));
    expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(false);
    expect(useAuthStore.getState().status).toBe("unverified");

    // Past the bearer's expiry, one more refusal flags it.
    vi.setSystemTime(PAST_EXPIRY_MS);
    expect(await service.revalidateExpectedBearer(credentials)).toBe(
      "rejected",
    );
    expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(true);
    expect(useAuthStore.getState().status).toBe("unverified");
    expect(authn.validationCalls).toBe(validationAtVerdict);
    expect(authn.refreshCalls).toBe(refreshAtVerdict);
    expect(expiry.count()).toBe(1);
  });

  it("sends a refused session back to sign-in again when a failed sign-in attempt hands the same expired bearer back to the recovery loop", async () => {
    useFakeClock();
    const { service, host } = await startRefusedSession(authn, EXPIRED_TOKEN);
    // A host refuses the expired bearer, so the shell is on the sign-in page.
    expect(
      await service.revalidateExpectedBearer(liveCredentials(service)),
    ).toBe("rejected");
    expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(true);

    // The person starts signing in again: the attempt retires the refusal,
    // since they are no longer held on the dead bearer...
    await service.signIn();
    expect(useAuthStore.getState().status).toBe("signing-in");
    expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(false);

    // ...and then the attempt FAILS (the person denies the request, the code
    // expires, the browser is closed). Nothing was destroyed: the stored pair
    // is still on disk, and the recovery loop re-arms to look at it.
    host.deviceFlow.emitResult({ kind: "denied" });
    await vi.waitFor(() => {
      expect(useAuthStore.getState().status).toBe("signed-out");
    });
    expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(false);

    // The loop's first tick (1 s) re-admits the stored session, which authn
    // still refuses. It is the SAME expired bearer, so the shell must go
    // straight back to the sign-in page rather than mount a workspace no host
    // will serve.
    await vi.advanceTimersByTimeAsync(1_000);
    const after = useAuthStore.getState();
    expect(after.status).toBe("unverified");
    expect(service.getCurrentSessionSnapshot().token).toBe(EXPIRED_TOKEN);
    expect(after.cloudVerdictLoss).toBe("session-rejected");
    expect(after.hostRefusedHeldBearer).toBe(true);
    expect(
      resolveShellLocalPlaneAdmission(
        after.status,
        true,
        after.hostRefusedHeldBearer,
      ),
    ).toEqual({ admitted: false, refusal: "unverified-host-refused" });
  });

  it("re-flags the same expired bearer on a recovery tick that only finds authn unreachable, through the unverified projection alone", async () => {
    useFakeClock();
    const { service, host } = await startRefusedSession(authn, EXPIRED_TOKEN);
    await service.signIn();
    host.deviceFlow.emitResult({ kind: "denied" });
    await vi.waitFor(() => {
      expect(useAuthStore.getState().status).toBe("signed-out");
    });
    expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(false);

    // This time authn does not answer at all when the recovery loop looks, so
    // the tick lands on its network-error arm: it re-admits the stored session
    // WITHOUT a fresh verdict, and nothing but the projection itself can
    // restore the refusal the failed attempt cleared. The terminal latch and
    // the stored `session-rejected` loss both survived the attempt.
    authn.answerValidation = unreachable;
    authn.answerRefresh = unreachable;
    await vi.advanceTimersByTimeAsync(1_000);
    await advancePastAuthRetries();

    const after = useAuthStore.getState();
    expect(after.status).toBe("unverified");
    expect(service.getCurrentSessionSnapshot().token).toBe(EXPIRED_TOKEN);
    expect(after.cloudVerdictLoss).toBe("session-rejected");
    expect(after.hostRefusedHeldBearer).toBe(true);
    expect(
      resolveShellLocalPlaneAdmission(
        after.status,
        true,
        after.hostRefusedHeldBearer,
      ),
    ).toEqual({ admitted: false, refusal: "unverified-host-refused" });
  });

  it("answers rejected without asking authn while a sign-in attempt is replacing the refused session, and keeps the attempt's status", async () => {
    useFakeClock();
    const { service, expiry } = await startRefusedSession(authn, EXPIRED_TOKEN);
    const validationAtVerdict = authn.validationCalls;
    const refreshAtVerdict = authn.refreshCalls;
    expect(validationAtVerdict).toBeGreaterThan(0);
    expect(refreshAtVerdict).toBeGreaterThan(0);
    expect(expiry.count()).toBe(1);
    // The credentials a host transport would still be holding while the
    // person signs in: the attempt does not tear the live context down.
    const credentials = liveCredentials(service);

    await service.signIn();
    expect(useAuthStore.getState().status).toBe("signing-in");

    const outcomes = await refuseUnary(service, credentials, 5);

    // The fetch counts first. Before the fix this validated, re-spent the
    // refresh token, re-raised the expiry - and the demotion it ended in
    // overwrote `signing-in`, taking the device-code screen away mid-attempt.
    expect(authn.validationCalls).toBe(validationAtVerdict);
    expect(authn.refreshCalls).toBe(refreshAtVerdict);
    expect(expiry.count()).toBe(1);
    expect(outcomes).toEqual(repeated(5, "rejected"));
    expect(useAuthStore.getState().status).toBe("signing-in");
    // The refusal is not recorded against a session that is no longer the one
    // being held: `signing-in` is not `unverified`.
    expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(false);
  });

  it("still asks authn, and records no host refusal, when the held session was only UNREACHABLE", async () => {
    useFakeClock();
    const { service, host } = makeService();
    authn.answerValidation = unreachable;
    authn.answerRefresh = unreachable;
    // An EXPIRED bearer on purpose: expiry alone must not flag a session authn
    // never refused - there, a fresh bearer can still arrive.
    await host.tokenStore.signIn(
      { token: EXPIRED_TOKEN, refreshToken: "stale-refresh" },
      { ...DEFAULT_IDENTITY },
    );
    const start = service.start();
    await advancePastAuthRetries();
    await start;
    // No verdict at all: unverified, but nothing here is a refusal by authn.
    expect(useAuthStore.getState().status).toBe("unverified");
    expect(useAuthStore.getState().cloudVerdictLoss).toBe("unreachable");
    expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(false);

    const credentials = liveCredentials(service);
    const validationBefore = authn.validationCalls;
    const refreshBefore = authn.refreshCalls;
    const pending = service.revalidateExpectedBearer(credentials);
    // No timer has moved yet, so the only fetch that can have happened is this
    // call's own first attempt - the recovery loop's tick is still ahead.
    await vi.advanceTimersByTimeAsync(0);
    expect(authn.validationCalls).toBe(validationBefore + 1);
    await advancePastAuthRetries();

    expect(await pending).toBe("network-error");
    // An unreachable authn is no reason to spend the refresh token.
    expect(authn.refreshCalls).toBe(refreshBefore);
    const after = useAuthStore.getState();
    expect(after.hostRefusedHeldBearer).toBe(false);
    expect(after.status).toBe("unverified");
    expect(after.cloudVerdictLoss).toBe("unreachable");
  });

  it("clears the refusal and the latch when the person signs in again", async () => {
    useFakeClock();
    const { service, host } = await startRefusedSession(authn, EXPIRED_TOKEN);
    const refusedCredentials = liveCredentials(service);
    expect(await service.revalidateExpectedBearer(refusedCredentials)).toBe(
      "rejected",
    );
    expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(true);

    // The interactive sign-in succeeds: authn accepts the freshly authorized
    // token. Starting the attempt already retires the refusal - the person is
    // no longer being held on the dead bearer.
    authn.answerValidation = okUser;
    await service.signIn();
    expect(useAuthStore.getState().status).toBe("signing-in");
    expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(false);
    host.deviceFlow.emitResult({
      kind: "authorized",
      token: "fresh-token",
      refreshToken: "fresh-refresh",
    });
    await vi.waitFor(() => {
      expect(useAuthStore.getState().status).toBe("signed-in");
    });

    const after = useAuthStore.getState();
    expect(after.hostRefusedHeldBearer).toBe(false);
    expect(after.cloudVerdictLoss).toBe("unreachable");
    expect(service.getCurrentSessionSnapshot().token).toBe("fresh-token");

    // The service-side latch cleared with it: a revalidation of the NEW bearer
    // is asked of authn again rather than answered `rejected` from the latch.
    const validationBefore = authn.validationCalls;
    const outcome = await service.revalidateExpectedBearer(
      liveCredentials(service),
    );
    expect(authn.validationCalls).toBe(validationBefore + 1);
    expect(outcome).toBe("rotated");
    expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(false);
  });

  it("flags the held bearer at once, before its exp, when authn's refusal of a LIVE session is a user-epoch revocation, then asks authn nothing across repeated refusals", async () => {
    useFakeClock();
    const { service, host } = makeService();
    const signedOutEverywhere = watchDeliveries(
      service,
      AUTH_ERROR_SIGNED_OUT_EVERYWHERE,
    );
    const expiry = watchExpiryDeliveries(service);
    authn.answerValidation = okUser;
    await host.tokenStore.signIn(
      { token: SOON_EXPIRING_TOKEN, refreshToken: "live-refresh" },
      { ...DEFAULT_IDENTITY },
    );
    await service.start();
    expect(useAuthStore.getState().status).toBe("signed-in");
    expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(false);

    // The user signs out everywhere: validation refuses the bearer and the
    // refresh spend answers with the user-epoch scope.
    authn.answerValidation = () => status(401);
    authn.answerRefresh = revokedEverywhere;
    const verdict = await service.revalidateCurrentContext();
    expect(verdict?.kind).toBe("rejected");

    const atVerdict = useAuthStore.getState();
    expect(atVerdict.status).toBe("unverified");
    expect(atVerdict.cloudVerdictLoss).toBe("session-rejected");
    // The bearer is the unexpired one and its `exp` is still ahead of the
    // clock - and the host is nonetheless known to refuse it, with no host
    // having refused anything yet.
    expect(service.getCurrentSessionSnapshot().token).toBe(SOON_EXPIRING_TOKEN);
    expect(Date.now()).toBeLessThan(EXPIRES_AT_MS);
    expect(atVerdict.hostRefusedHeldBearer).toBe(true);
    // The person is told the true thing, once - not "expired".
    expect(signedOutEverywhere.count()).toBe(1);
    expect(expiry.count()).toBe(0);
    expect(
      resolveShellLocalPlaneAdmission(
        atVerdict.status,
        true,
        atVerdict.hostRefusedHeldBearer,
      ),
    ).toEqual({ admitted: false, refusal: "unverified-host-refused" });
    const validationAtVerdict = authn.validationCalls;
    const refreshAtVerdict = authn.refreshCalls;
    // Not vacuous: the verdict itself cost a round trip to each route.
    expect(validationAtVerdict).toBeGreaterThan(0);
    expect(refreshAtVerdict).toBeGreaterThan(0);

    const credentials = liveCredentials(service);
    const outcomes: string[] = [];
    for (let refusal = 0; refusal < 5; refusal += 1) {
      outcomes.push(await service.revalidateExpectedBearer(credentials));
    }

    expect(authn.validationCalls).toBe(validationAtVerdict);
    expect(authn.refreshCalls).toBe(refreshAtVerdict);
    expect(outcomes).toEqual(repeated(5, "rejected"));
    expect(signedOutEverywhere.count()).toBe(1);
    expect(expiry.count()).toBe(0);
    expect(service.getLastError()).toBeNull();
    const after = useAuthStore.getState();
    expect(after.status).toBe("unverified");
    expect(after.hostRefusedHeldBearer).toBe(true);
  });

  it("flags a stored unexpired bearer at startup when authn's refusal is a user-epoch revocation", async () => {
    useFakeClock();
    const { service, signedOutEverywhere } = await startRevokedSession(
      authn,
      SOON_EXPIRING_TOKEN,
    );

    const atVerdict = useAuthStore.getState();
    expect(atVerdict.status).toBe("unverified");
    expect(atVerdict.cloudVerdictLoss).toBe("session-rejected");
    // Held for the local plane, `exp` still ahead - and flagged all the same.
    expect(service.getCurrentSessionSnapshot().token).toBe(SOON_EXPIRING_TOKEN);
    expect(Date.now()).toBeLessThan(EXPIRES_AT_MS);
    expect(atVerdict.hostRefusedHeldBearer).toBe(true);
    expect(signedOutEverywhere.count()).toBe(1);
    expect(authn.refreshCalls).toBeGreaterThan(0);
    expect(
      resolveShellLocalPlaneAdmission(
        atVerdict.status,
        true,
        atVerdict.hostRefusedHeldBearer,
      ),
    ).toEqual({ admitted: false, refusal: "unverified-host-refused" });
  });

  it("does not carry the revoked mark onto the bearer a later sign-in lands on: a plain refusal of the new unexpired bearer still waits for its exp", async () => {
    useFakeClock();
    const { service, host, signedOutEverywhere } = await startRevokedSession(
      authn,
      SOON_EXPIRING_TOKEN,
    );
    expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(true);

    await signInInteractively(service, host, authn, LONG_LIVED_TOKEN);
    const signedIn = useAuthStore.getState();
    expect(signedIn.hostRefusedHeldBearer).toBe(false);
    expect(signedIn.cloudVerdictLoss).toBe("unreachable");
    expect(service.getCurrentSessionSnapshot().token).toBe(LONG_LIVED_TOKEN);

    // authn now refuses the NEW bearer, but plainly: no revocation scope.
    authn.answerValidation = () => status(401);
    authn.answerRefresh = () => status(401);
    const verdict = await service.revalidateCurrentContext();
    expect(verdict?.kind).toBe("rejected");

    const refused = useAuthStore.getState();
    expect(refused.status).toBe("unverified");
    expect(refused.cloudVerdictLoss).toBe("session-rejected");
    // Plain "expired" copy, not a second signed-out-everywhere.
    expect(service.getLastError()).toBe(AUTH_ERROR_SESSION_EXPIRED);
    expect(signedOutEverywhere.count()).toBe(1);
    expect(refused.hostRefusedHeldBearer).toBe(false);

    const credentials = liveCredentials(service);
    const early = await refuseUnary(service, credentials, 3);
    expect(early).toEqual(repeated(3, "rejected"));
    expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(false);

    // Past the new bearer's own expiry, the next refusal flags it as usual.
    vi.setSystemTime(LONG_LIVED_PAST_EXPIRY_MS);
    expect(await service.revalidateExpectedBearer(credentials)).toBe(
      "rejected",
    );
    expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(true);
  });

  it("clears the revoked mark with the latch: the same bearer, held again after a sign-in, is not flagged by a later demotion that carries no revocation", async () => {
    useFakeClock();
    const { service, host } = await startRevokedSession(
      authn,
      LONG_LIVED_TOKEN,
    );
    expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(true);

    // The sign-in lands on the very bearer the revocation named, so a mark
    // that outlived the latch would match it.
    await signInInteractively(service, host, authn, LONG_LIVED_TOKEN);
    expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(false);

    // A sibling window's demotion names this bearer and carries no revocation
    // scope (a plain refusal on its side): nothing marks it revoked here.
    service.ingestCloudAuthorizationRevoked(LONG_LIVED_TOKEN, null);

    const after = useAuthStore.getState();
    expect(after.status).toBe("unverified");
    expect(after.cloudVerdictLoss).toBe("ended-elsewhere");
    expect(Date.now()).toBeLessThan(LONG_LIVED_EXPIRES_AT_MS);
    expect(after.hostRefusedHeldBearer).toBe(false);
  });

  /**
   * "Sign out everywhere" has to reach every window, not only the one whose
   * refresh authn refused. The window that SAW the refusal flags its bearer at
   * once (above); a sibling learns of it through the cross-window revoke
   * channel, which carries the revocation scope for exactly this.
   */
  describe("a sibling window's revoke of the bearer this window holds", () => {
    it("flags the held bearer at once, before its exp, when the revoke is a user-epoch revocation", async () => {
      useFakeClock();
      const { service } = await startSignedInSession(authn, LONG_LIVED_TOKEN);
      const validationBefore = authn.validationCalls;
      const refreshBefore = authn.refreshCalls;

      // The sibling saw authn's "sign out everywhere": the host refuses this
      // bearer now, whatever its `exp` says.
      service.ingestCloudAuthorizationRevoked(LONG_LIVED_TOKEN, "user-epoch");

      const after = useAuthStore.getState();
      expect(after.status).toBe("unverified");
      expect(after.cloudVerdictLoss).toBe("ended-elsewhere");
      expect(service.getCurrentSessionSnapshot().token).toBe(LONG_LIVED_TOKEN);
      // Not vacuous: the clock is well inside the bearer's lifetime, so the
      // flag below is not the expiry rule.
      expect(Date.now()).toBeLessThan(LONG_LIVED_EXPIRES_AT_MS);
      expect(after.hostRefusedHeldBearer).toBe(true);
      expect(
        resolveShellLocalPlaneAdmission(
          after.status,
          true,
          after.hostRefusedHeldBearer,
        ),
      ).toEqual({ admitted: false, refusal: "unverified-host-refused" });
      // Told by a sibling, so it cost this window no round trip to authn...
      expect(authn.validationCalls).toBe(validationBefore);
      expect(authn.refreshCalls).toBe(refreshBefore);

      // ...and it holds across repeated host refusals, still asking authn
      // nothing.
      const outcomes = await refuseUnary(service, liveCredentials(service), 3);
      expect(outcomes).toEqual(repeated(3, "rejected"));
      expect(authn.validationCalls).toBe(validationBefore);
      expect(authn.refreshCalls).toBe(refreshBefore);
      expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(true);
      expect(useAuthStore.getState().status).toBe("unverified");
    });

    it("leaves an unexpired bearer unflagged when the revoke carries no scope, and flags it on the first host refusal after its exp", async () => {
      useFakeClock();
      const { service } = await startSignedInSession(authn, LONG_LIVED_TOKEN);
      const validationBefore = authn.validationCalls;
      const refreshBefore = authn.refreshCalls;

      service.ingestCloudAuthorizationRevoked(LONG_LIVED_TOKEN, null);

      const after = useAuthStore.getState();
      expect(after.status).toBe("unverified");
      expect(after.cloudVerdictLoss).toBe("ended-elsewhere");
      expect(service.getCurrentSessionSnapshot().token).toBe(LONG_LIVED_TOKEN);
      expect(Date.now()).toBeLessThan(LONG_LIVED_EXPIRES_AT_MS);
      expect(after.hostRefusedHeldBearer).toBe(false);

      // A host refusing a bearer whose `exp` is still ahead is not "the local
      // plane is gone": it may only need the cloud verdict this window lost.
      const credentials = liveCredentials(service);
      const early = await refuseUnary(service, credentials, 3);
      expect(early).toEqual(repeated(3, "rejected"));
      expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(false);
      expect(useAuthStore.getState().status).toBe("unverified");

      // The bearer expires. Nothing time-driven flags it...
      vi.setSystemTime(LONG_LIVED_PAST_EXPIRY_MS);
      expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(false);

      // ...the next refusal does, still without asking authn anything.
      expect(await service.revalidateExpectedBearer(credentials)).toBe(
        "rejected",
      );
      expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(true);
      expect(useAuthStore.getState().status).toBe("unverified");
      expect(authn.validationCalls).toBe(validationBefore);
      expect(authn.refreshCalls).toBe(refreshBefore);
    });

    it("leaves a window holding a different bearer alone, whatever the scope", async () => {
      useFakeClock();
      const { service } = await startSignedInSession(authn, LONG_LIVED_TOKEN);

      // Windows' IPC is unordered: a revoke raised before this window's
      // sign-in can land after it. The fence runs before the scope is read.
      service.ingestCloudAuthorizationRevoked(
        SOON_EXPIRING_TOKEN,
        "user-epoch",
      );

      const after = useAuthStore.getState();
      expect(after.status).toBe("signed-in");
      expect(after.cloudVerdictLoss).toBe("unreachable");
      expect(after.hostRefusedHeldBearer).toBe(false);
      expect(service.getCurrentSessionSnapshot().token).toBe(LONG_LIVED_TOKEN);
    });
  });

  /**
   * The OUTBOUND half of the same channel: the scope a window's own refusal
   * carries to its siblings. `revokedHeldBearer` is set by the refresh arm
   * before the demotion fans out, so the listener hears what the refusal was.
   */
  describe("the cloud-authorization-revoked fan-out of a live refusal", () => {
    it("carries the user-epoch scope when authn's refusal is a user-epoch revocation", async () => {
      useFakeClock();
      const { service } = await startSignedInSession(authn, LONG_LIVED_TOKEN);
      const fanOuts: RevokedCloudAuthorization[] = [];
      service.onCloudAuthorizationRevoked((revoked) => {
        fanOuts.push(revoked);
      });

      authn.answerValidation = () => status(401);
      authn.answerRefresh = revokedEverywhere;
      const verdict = await service.revalidateCurrentContext();

      expect(verdict?.kind).toBe("rejected");
      expect(useAuthStore.getState().status).toBe("unverified");
      // Once, naming the refused bearer, and telling the other windows it was
      // the user's own "sign out everywhere".
      expect(fanOuts).toEqual([
        { token: LONG_LIVED_TOKEN, revocation: "user-epoch" },
      ]);
    });

    it("carries no scope when authn's refusal is a plain credential refusal", async () => {
      useFakeClock();
      const { service } = await startSignedInSession(authn, LONG_LIVED_TOKEN);
      const fanOuts: RevokedCloudAuthorization[] = [];
      service.onCloudAuthorizationRevoked((revoked) => {
        fanOuts.push(revoked);
      });

      authn.answerValidation = () => status(401);
      authn.answerRefresh = () => status(401);
      const verdict = await service.revalidateCurrentContext();

      expect(verdict?.kind).toBe("rejected");
      expect(useAuthStore.getState().status).toBe("unverified");
      expect(fanOuts).toEqual([{ token: LONG_LIVED_TOKEN, revocation: null }]);
    });
  });
});
