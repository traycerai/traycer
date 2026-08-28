import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type {
  SchemaVersion,
  VersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import type { VersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { IRemoteSession } from "@traycer-clients/shared/host-transport/remote/remote-session";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
import {
  acquireRemoteSession,
  remoteSessionRefCountForTest,
  resetRemoteSessionReadinessListenersForTest,
  retireAllRemoteSessions,
  type RemoteSessionAcquirePolicy,
  type RemoteSessionIdentity,
} from "@traycer-clients/shared/host-transport/remote/active-remote-sessions";
import {
  AUTH_FETCH_MAX_ATTEMPTS,
  authRetryDelayMs,
} from "@traycer-clients/shared/auth/auth-validation";
import {
  AuthService,
  AUTH_ERROR_SESSION_EXPIRED,
  type ExternalSession,
} from "@/lib/auth/auth-service";
import { useAuthStore } from "@/stores/auth/auth-store";

// Companion to `auth-service.test.ts`, isolated into its own file because it
// straddles TWO module-level singletons at once - the auth store AND the
// process-global remote-session cache (`active-remote-sessions.ts`) - and the
// harness for driving each is large enough on its own. See P1 in the task
// brief: `demoteVerifiedSessionToUnverified` must sweep
// `retireAllRemoteSessions()` when, and only when, a verified session is
// genuinely being demoted (not on the ordinary never-verified
// `applyUnverifiedSession` startup path, which must never sweep a cache it
// never held a verdict for). `retireAllRemoteSessions` was widened to
// force-close HELD entries (not just free/lingering ones) specifically to
// cover this auth-boundary case - see `active-remote-sessions.test.ts`'s
// "closes a HELD entry outright at the auth boundary" for the cache-level
// half of this same fix; this file pins that the auth boundary actually
// drives it, and only when a verdict was genuinely lost.

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

function okWithProfile(): Promise<Response> {
  return Promise.resolve(
    new Response(
      JSON.stringify({
        user: {
          id: "user-1",
          name: "Test User",
          providerId: "gh-1",
          providerHandle: "test-user",
          providerType: "GITHUB",
          email: "test@example.com",
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
          userID: "user-1",
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

function status(code: number): Promise<Response> {
  return Promise.resolve(new Response(null, { status: code }));
}

// The `/api/v3/auth/refresh` response rotates both tokens. Copied from the
// sibling `auth-service.test.ts` harness for the same reason `deviceSignIn`
// is - that file is deliberately not touched by this task.
function okWithRefreshToken(token: string): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify({ token, refreshToken: `${token}-refresh` }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

/**
 * A cross-window `ExternalSession` for `applyExternalSession`, mirroring the
 * sibling suite's `externalSessionForUser` helper (copied rather than
 * imported for the same reason as `deviceSignIn`/`okWithRefreshToken` above).
 */
function externalSessionForUser(
  userId: string,
  token: string,
): ExternalSession {
  const now = new Date("2026-07-30T10:00:00.000Z");
  return {
    status: "signed-in",
    token,
    profile: {
      userId,
      userName: `${userId} display`,
      email: `${userId}@example.com`,
      avatarUrl: null,
    },
    user: {
      user: {
        id: userId,
        name: `${userId} display`,
        providerId: `gh-${userId}`,
        providerHandle: userId,
        providerType: "GITHUB",
        email: `${userId}@example.com`,
        avatarUrl: null,
        activatedAt: null,
        createdAt: now,
        updatedAt: now,
        lastSeenAt: null,
        privacyMode: false,
        isLearningEnabled: true,
      },
      userSubscription: {
        id: `sub-${userId}`,
        userID: userId,
        orgID: null,
        teamID: null,
        customerId: `cus-${userId}`,
        createdAt: now,
        updatedAt: now,
        subscriptionExpiry: null,
        trialEndsAt: null,
        subscriptionStatus: "FREE",
        hasPaymentMethod: false,
        isInTrial: false,
        rechargeRateSeconds: 0,
      },
      teamSubscriptions: [],
      payAsYouGoUsage: { allowPayAsYouGo: false },
    },
  };
}

/**
 * Drives a full device-flow sign-in: start the attempt, then settle its poll
 * on the `authorized` terminal and wait for the signed-in projection. Copied
 * from the sibling `auth-service.test.ts` harness rather than imported - that
 * file is deliberately not touched by this task, and the helper is a handful
 * of lines that would otherwise force a cross-file coupling neither file
 * needs.
 */
async function deviceSignIn(
  service: AuthService,
  host: MockRunnerHost,
  token: string,
): Promise<void> {
  await service.signIn();
  host.deviceFlow.emitResult({
    kind: "authorized",
    token,
    refreshToken: `${token}-refresh`,
  });
  await vi.waitFor(() => {
    expect(service.getCurrentSessionSnapshot().token).toBe(token);
  });
}

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
  return { service, host };
}

/**
 * A fake `IRemoteSession`, mirroring the double `active-remote-sessions.test.ts`
 * builds for the cache's own unit tests - the cache only ever calls
 * `isReady()`/`close()` on what a `createSession` factory returns, so a
 * minimal double exercising those is faithful here too. `closeCalls` is what
 * both scenarios below assert on: it lives on the UNDERLYING session the
 * cache entry wraps, not on the per-consumer view `acquireRemoteSession`
 * hands back (that view's own `close()` only ever calls `release()`, and for
 * a still-held entry release does not touch the underlying session at all -
 * see the module's own comments on `retireAllRemoteSessions`, which closes
 * `entry.session` directly regardless of who holds it).
 */
interface FakeSession extends IRemoteSession<
  VersionedRpcRegistry,
  VersionedStreamRpcRegistry
> {
  readonly closeCalls: number;
  /**
   * Lets a test model an `openAck`-derived capability transition. The
   * acquired cache view must forward this underlying session state instead
   * of freezing a fake permissive answer at its own boundary.
   */
  setMethodSupport(
    support: StreamMethodSupport,
    schemaVersion: SchemaVersion | null,
  ): void;
}

// Authorization loss sweeps the cache wholesale, so sweep eligibility is not a
// variable here: one eligible policy serves every acquire in this file.
const AUTH_LOSS_TEST_POLICY: RemoteSessionAcquirePolicy = {
  proactiveWakeEligible: true,
};

function fakeSession(): FakeSession {
  let closeCalls = 0;
  let methodSupport: StreamMethodSupport = "unknown";
  let methodSchemaVersion: SchemaVersion | null = null;
  const methodSupportListeners = new Set<() => void>();
  const session: FakeSession = {
    get closeCalls() {
      return closeCalls;
    },
    start: vi.fn(),
    isClosed: () => closeCalls > 0,
    isReady: () => true,
    sendUnary: vi.fn(() => {
      throw new Error("not exercised by these tests");
    }),
    forceReconnect: vi.fn(),
    subscribe: vi.fn(() => {
      throw new Error("not exercised by these tests");
    }),
    subscribeWithParamsProvider: vi.fn(() => {
      throw new Error("not exercised by these tests");
    }),
    notifyBearerRotated: vi.fn(),
    wake: vi.fn(),
    onClosed: () => () => undefined,
    subscribeAvailabilityRecovered: () => () => undefined,
    subscribeReadinessLost: () => () => undefined,
    getMethodSupport: () => methodSupport,
    getMethodSchemaVersion: () => methodSchemaVersion,
    subscribeMethodSupport: (listener) => {
      methodSupportListeners.add(listener);
      return () => {
        methodSupportListeners.delete(listener);
      };
    },
    terminalFatal: () => null,
    setMethodSupport: (support, schemaVersion) => {
      methodSupport = support;
      methodSchemaVersion = schemaVersion;
      for (const listener of methodSupportListeners) listener();
    },
    close: () => {
      closeCalls += 1;
    },
  };
  return session;
}

let nextIdentitySeq = 0;
/**
 * A fresh, fully-populated identity per test. The cache is a process-global
 * singleton shared with every other suite in this run, so a fixed identity
 * would let one test's entry collide with another's (or with a leftover
 * lingering entry from a prior test file) - exactly the leakage the sibling
 * `active-remote-sessions.test.ts` harness avoids the same way.
 */
function freshIdentity(): RemoteSessionIdentity {
  nextIdentitySeq += 1;
  return {
    hostId: `authz-loss-host-${nextIdentitySeq}`,
    userId: `authz-loss-user-${nextIdentitySeq}`,
    hostPublicKey: `authz-loss-pubkey-${nextIdentitySeq}`,
    relayAttachUrl: `wss://relay.test/authz-loss-attach-${nextIdentitySeq}`,
    authRecovery: "revalidate",
    authEpoch: "authz-loss-lease-1",
  };
}

const trackedServices: AuthService[] = [];

describe("AuthService authorization-loss remote-session sweep", () => {
  let restoreFetch: () => void = () => undefined;

  beforeEach(() => {
    useAuthStore.getState().setSignedOut();
    restoreFetch = installFetch(() => okWithProfile());
  });

  afterEach(() => {
    while (trackedServices.length > 0) {
      const service = trackedServices.pop();
      if (service !== undefined) {
        service.dispose();
      }
    }
    useAuthStore.getState().setSignedOut();
    // Mirrors the sibling suite's cache-leakage cleanup: readiness listeners
    // are the one piece of module state that has a test-only reset. The
    // entries themselves are cleaned up per-test below by closing whatever
    // this test acquired, and every test uses a `freshIdentity()` so a test
    // that forgot to close cannot be adopted by a later one anyway.
    resetRemoteSessionReadinessListenersForTest();
    vi.useRealTimers();
    restoreFetch();
  });

  it("closes an already-established remote session when a verified session is demoted on a terminal refresh-rejection", async () => {
    // Acquire a held remote session into the REAL, module-global cache first -
    // this is what an already-open chat/terminal tab looks like from the
    // cache's point of view. Held, not released: the whole point of P1 is
    // that a HELD entry (an open tab) must not be able to outlive the
    // account's authorization.
    const identity = freshIdentity();
    const underlying = fakeSession();
    const view = acquireRemoteSession(
      identity,
      AUTH_LOSS_TEST_POLICY,
      () => underlying,
    );
    expect(remoteSessionRefCountForTest(identity)).toBe(1);
    expect(underlying.closeCalls).toBe(0);

    const { service, host } = makeService();
    trackedServices.push(service);
    await service.start();
    await deviceSignIn(service, host, "dead-token");
    expect(useAuthStore.getState().status).toBe("signed-in");

    // Terminal server verdict: BOTH the access-token validation and the
    // refresh both reject. This is exactly the driving mechanism the sibling
    // `auth-service.test.ts` uses for
    // "reactive refresh-rejected demotes to unverified (file kept,
    // session-expired)" - reused here rather than duplicated, layering the
    // remote-session assertion on top.
    restoreFetch();
    restoreFetch = installFetch((input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url === VALIDATION_URL) {
        return status(401);
      }
      if (url === REFRESH_URL) {
        return status(401);
      }
      return status(500);
    });

    const outcome = await service.revalidateCurrentContext();
    expect(outcome?.kind).toBe("rejected");
    // The demotion this fix targets: a session that HELD a verdict lost it.
    expect(useAuthStore.getState().status).toBe("unverified");
    expect(service.getLastError()).toBe(AUTH_ERROR_SESSION_EXPIRED);

    // THE FIX: the previously-established remote session was closed by the
    // sweep, on the underlying session the cache entry wraps - not on the
    // per-consumer view's own `close()`, which this test never called.
    expect(underlying.closeCalls).toBe(1);

    // Clean up: release this test's own view so it does not linger and leak
    // into another test. The entry is already closed (the sweep marked it
    // `superseded` and closed it), so this is the idempotent "displaced from
    // the map while held" release path the module documents, not a second
    // live teardown.
    view.close();
  });

  it("does NOT close a held remote session when a session that never held a verdict lands unverified (cold start, network error)", async () => {
    // Same setup: a held remote session sitting in the cache before the auth
    // transition runs.
    const identity = freshIdentity();
    const underlying = fakeSession();
    const view = acquireRemoteSession(
      identity,
      AUTH_LOSS_TEST_POLICY,
      () => underlying,
    );
    expect(remoteSessionRefCountForTest(identity)).toBe(1);
    expect(underlying.closeCalls).toBe(0);

    // A cold start with a stored credential that fails initial validation
    // with a NETWORK/transport fault (not a 401) - this is the
    // `applyUnverifiedSession` path, which `hasVerifiedSession()` reads as
    // `false` for its whole run because the service never held a verified
    // session in the first place. It is a different function than
    // `demoteVerifiedSessionToUnverified` and, per the fix, must never sweep.
    const { service, host } = makeService();
    trackedServices.push(service);
    await host.tokenStore.signIn(
      { token: "stored-token", refreshToken: "stored-token-refresh" },
      { id: "user-1", email: "test@example.com", name: "Test User" },
    );

    restoreFetch();
    restoreFetch = installFetch(() =>
      Promise.reject(new Error("authn unreachable")),
    );

    await service.start();
    expect(useAuthStore.getState().status).toBe("unverified");
    // Non-vacuity: the session really does hold a bearer read off disk, so
    // this is a genuine `applyUnverifiedSession` landing and not merely
    // "there was nothing to project".
    expect(service.getCurrentSessionSnapshot().token).toBe("stored-token");

    // THE GUARD: no verdict was ever held, so no verdict was lost, so the
    // sweep must not run. The underlying session stays open and the cache
    // entry stays a live hit.
    expect(underlying.closeCalls).toBe(0);
    expect(remoteSessionRefCountForTest(identity)).toBe(1);

    // This entry was never swept (that is the point of the test), so
    // `view.close()` alone only releases it into the keep-warm linger - it
    // stays in the process-global cache with a real pending timer for
    // `REMOTE_SESSION_LINGER_MS` after this test ends. `retireAllRemoteSessions`
    // force-closes and evicts it synchronously, the same scoped cleanup the
    // sibling `active-remote-sessions.test.ts` harness relies on via fake
    // timers - here it is unconditional since this suite runs on real timers.
    view.close();
    retireAllRemoteSessions();
  });
});

// Covers the actual bug: `cloudAuthorized` was set at mint time and never
// mutated on the four in-place paths that retain/rotate a LIVE context for
// the SAME identity (demotion, recovery promotion, cross-window promotion).
// Every case below must fail if the corresponding `setCloudAuthorized` call
// is removed from `auth-service.ts` - a test that reads the verdict without
// having driven a REAL in-place rotation (same context object survives)
// would not be exercising the fix at all.
describe("AuthService cloudAuthorized verdict propagation on in-place transitions", () => {
  let restoreFetch: () => void = () => undefined;

  beforeEach(() => {
    useAuthStore.getState().setSignedOut();
    restoreFetch = installFetch(() => okWithProfile());
  });

  afterEach(() => {
    while (trackedServices.length > 0) {
      const service = trackedServices.pop();
      if (service !== undefined) {
        service.dispose();
      }
    }
    useAuthStore.getState().setSignedOut();
    resetRemoteSessionReadinessListenersForTest();
    vi.useRealTimers();
    restoreFetch();
  });

  it("withdraws the retained context's verdict on a same-user demotion to unverified", async () => {
    const { service, host } = makeService();
    trackedServices.push(service);
    await service.start();
    await deviceSignIn(service, host, "dead-token");
    expect(useAuthStore.getState().status).toBe("signed-in");

    const provider = service.getRequestContextProvider();
    const contextBefore = provider.current();
    expect(contextBefore).not.toBeNull();
    expect(contextBefore?.cloudAuthorized).toBe(true);

    // Terminal server verdict on both the access token and the refresh -
    // the same driving mechanism as the remote-session sweep suite above.
    restoreFetch();
    restoreFetch = installFetch((input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url === VALIDATION_URL || url === REFRESH_URL) {
        return status(401);
      }
      return status(500);
    });

    const outcome = await service.revalidateCurrentContext();
    expect(outcome?.kind).toBe("rejected");
    expect(useAuthStore.getState().status).toBe("unverified");

    // THE FIX (edit B / `projectUnverifiedSession`'s retain branch): the
    // SAME context object survives the demotion (retain, not re-mint) - and
    // its verdict is withdrawn rather than left `true`.
    const contextAfter = provider.current();
    expect(contextAfter).toBe(contextBefore);
    expect(contextAfter?.cloudAuthorized).toBe(false);
  });

  it("restores the verdict when the recovery loop promotes a minted unverified context back to signed-in", async () => {
    vi.useFakeTimers();
    const { service, host } = makeService();
    trackedServices.push(service);
    await host.tokenStore.signIn(
      { token: "late-authn-token", refreshToken: "late-authn-refresh" },
      { id: "user-1", email: "test@example.com", name: "Test User" },
    );
    restoreFetch();
    let reachable = false;
    restoreFetch = installFetch((input) => {
      const url = typeof input === "string" ? input : String(input);
      if (!reachable) {
        return Promise.reject(new Error("connection refused"));
      }
      if (url === VALIDATION_URL) {
        return okWithProfile();
      }
      return status(500);
    });

    const start = service.start();
    for (let retry = 1; retry < AUTH_FETCH_MAX_ATTEMPTS; retry += 1) {
      await vi.advanceTimersByTimeAsync(authRetryDelayMs(retry));
    }
    await start;
    expect(useAuthStore.getState().status).toBe("unverified");

    const provider = service.getRequestContextProvider();
    const contextBefore = provider.current();
    // A never-verified startup mints a fresh context (no live context existed
    // yet) with `cloudAuthorized: false` at construction.
    expect(contextBefore).not.toBeNull();
    expect(contextBefore?.cloudAuthorized).toBe(false);

    reachable = true;
    // First recovery tick fires after the initial 1s backoff.
    await vi.advanceTimersByTimeAsync(1_000);

    expect(useAuthStore.getState().status).toBe("signed-in");
    // THE FIX (edit A.2 / `applySignedIn`'s rotate branch): the promotion
    // rotates the SAME context in place (the "same user => same context
    // object" invariant) and now also restores the verdict it withdrew.
    const contextAfter = provider.current();
    expect(contextAfter).toBe(contextBefore);
    expect(contextAfter?.cloudAuthorized).toBe(true);
  });

  it("restores the verdict when a cross-window snapshot re-signs-in the same unverified user", async () => {
    const { service, host } = makeService();
    trackedServices.push(service);
    await service.start();
    await deviceSignIn(service, host, "live-token");

    // Demote to unverified via the same terminal-refresh-rejection mechanism
    // as the first test in this block, so the live context is RETAINED
    // (same object) rather than re-minted, and its verdict is withdrawn.
    restoreFetch();
    restoreFetch = installFetch((input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url === VALIDATION_URL || url === REFRESH_URL) {
        return status(401);
      }
      return status(500);
    });
    const demoteOutcome = await service.revalidateCurrentContext();
    expect(demoteOutcome?.kind).toBe("rejected");
    expect(useAuthStore.getState().status).toBe("unverified");

    const provider = service.getRequestContextProvider();
    const contextBefore = provider.current();
    expect(contextBefore).not.toBeNull();
    expect(contextBefore?.cloudAuthorized).toBe(false);

    // A sibling window validated a fresh sign-in for the SAME user end to
    // end and projects it here via the cross-window bridge.
    service.applyExternalSession(
      externalSessionForUser("user-1", "sibling-window-token"),
    );

    expect(useAuthStore.getState().status).toBe("signed-in");
    expect(service.getCurrentSessionSnapshot().token).toBe(
      "sibling-window-token",
    );
    // THE FIX (edit A.3 / `applyExternalSession`'s rotate branch): the SAME
    // context object carries on (not an aborted predecessor plus a fresh
    // successor) and its verdict is restored.
    const contextAfter = provider.current();
    expect(contextAfter).toBe(contextBefore);
    expect(contextAfter?.cloudAuthorized).toBe(true);
  });

  it("a plain same-user bearer rotation through rotateLiveBearer leaves an unverified session's verdict false", async () => {
    // Regression guard flagged in the task brief: a successful token refresh
    // is NOT a `/api/v3/user` verdict, so the one rotation path that is NOT
    // one of the four fixed call sites (`rotateLiveBearer`, reached here via
    // the reactive 401 path) must NOT flip the verdict back to `true`.
    const { service, host } = makeService();
    trackedServices.push(service);
    await service.start();
    await deviceSignIn(service, host, "dead-token");

    // Demote to unverified (retain branch) exactly as in the first test.
    restoreFetch();
    restoreFetch = installFetch((input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url === VALIDATION_URL || url === REFRESH_URL) {
        return status(401);
      }
      return status(500);
    });
    const demoteOutcome = await service.revalidateCurrentContext();
    expect(demoteOutcome?.kind).toBe("rejected");
    expect(useAuthStore.getState().status).toBe("unverified");

    const provider = service.getRequestContextProvider();
    const contextBefore = provider.current();
    expect(contextBefore?.cloudAuthorized).toBe(false);

    // The stored refresh token is still good (the file was kept on demotion):
    // a fresh reactive 401 rotate succeeds ("applied"), which drives
    // `rotateLiveBearer` while the session is still `unverified`. The
    // handler must distinguish the two validate calls by bearer - the stale
    // "dead-token" (rejected, driving the rotate) and the freshly-rotated
    // "post-demotion-token" (accepted, driving `revalidateCurrentContextOnce`'s
    // post-rotate re-check) - or the second call would also read as rejected.
    restoreFetch();
    restoreFetch = installFetch((input, init) => {
      const url = typeof input === "string" ? input : String(input);
      if (
        url === VALIDATION_URL &&
        init?.headers?.Authorization === "Bearer post-demotion-token"
      ) {
        return okWithProfile();
      }
      if (url === VALIDATION_URL) {
        return status(401);
      }
      if (url === REFRESH_URL) {
        return okWithRefreshToken("post-demotion-token");
      }
      return status(500);
    });

    const rotateOutcome = await service.revalidateCurrentContext();
    expect(rotateOutcome?.kind).toBe("valid");
    expect(service.getCurrentSessionSnapshot().token).toBe(
      "post-demotion-token",
    );

    // Still unverified, still unauthorized: a bearer rotation alone is not a
    // verdict, so `rotateLiveBearer` must not have touched `cloudAuthorized`.
    expect(useAuthStore.getState().status).toBe("unverified");
    const contextAfter = provider.current();
    expect(contextAfter).toBe(contextBefore);
    expect(contextAfter?.cloudAuthorized).toBe(false);
  });
});
