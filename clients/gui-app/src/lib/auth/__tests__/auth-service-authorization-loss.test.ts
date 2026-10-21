import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type {
  SchemaVersion,
  VersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import type { VersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { IRemoteSession } from "@traycer-clients/shared/host-transport/remote/remote-session";
import {
  WsStreamClient,
  type StreamMethodSupport,
} from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import type {
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketOpenEvent,
} from "@traycer-clients/shared/host-transport/ws-factory";
import type {
  IStreamWebSocketFactory,
  StreamWebSocketLike,
  StreamWebSocketMessageEvent,
} from "@traycer-clients/shared/host-transport/ws-stream-factory";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
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
  type RevokedCloudAuthorization,
} from "@/lib/auth/auth-service";
import { createStreamAuthRevalidator } from "@/lib/auth/stream-auth-revalidator";
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

// The identity route `validateAuthTokenIdentity*` calls FIRST (see
// `auth-validation.ts`); every fixture in this file answers this one.
const VALIDATION_URL = "http://localhost:5005/api/v3/user/negotiated";
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
      environments: { personal: null, teams: [] },
      actingAs: null,
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
  return makeServiceOnShell(undefined);
}

/**
 * `makeService` with the shell's local-host capability spelled out.
 *
 * `undefined` takes `MockRunnerHost`'s default (`true`) - a desktop-shaped
 * shell that bundles a host. `false` is the MOBILE shape: `clients/mobile`
 * declares `hasLocalHost = false` and is served entirely by a remote
 * directory entry.
 */
function makeServiceOnShell(hasLocalHost: boolean | undefined): {
  service: AuthService;
  host: MockRunnerHost;
} {
  const host = new MockRunnerHost({
    signInUrl:
      "https://auth.traycer.ai/sign-in?redirect_uri=traycer%3A%2F%2Fauth",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost,
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
    // Structural member: this fake models readiness, never silence.
    isSilentFor: () => false,
    sendUnary: vi.fn(() => {
      throw new Error("not exercised by these tests");
    }),
    subscribeAtVersion: vi.fn(() => {
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
    notifyCloudVerdictChanged: vi.fn(),
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
    openAuth: "user-bearer",
  };
}

/**
 * A scriptable `/stream` socket: the test fires the host's side (open, then a
 * fatal frame) and the real `WsStreamClient` reacts to it.
 */
class ScriptedStreamSocket implements StreamWebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: StreamWebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;

  send(): void {}

  close(): void {}

  fireOpen(): void {
    this.onopen?.({ type: "open" });
  }

  fireText(data: unknown): void {
    this.onmessage?.({ type: "text", data: JSON.stringify(data) });
  }
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

    // The copies held outside this renderer (desktop main's jar-plane
    // principal) learn of the terminal loss through this edge and nothing
    // else - an `unverified` snapshot is never projected cross-window.
    const revokedFanOuts: RevokedCloudAuthorization[] = [];
    const revokedSubscription = service.onCloudAuthorizationRevoked(
      (revoked) => {
        revokedFanOuts.push(revoked);
      },
    );

    const outcome = await service.revalidateCurrentContext();
    expect(outcome?.kind).toBe("rejected");
    // The demotion this fix targets: a session that HELD a verdict lost it.
    expect(useAuthStore.getState().status).toBe("unverified");
    expect(service.getLastError()).toBe(AUTH_ERROR_SESSION_EXPIRED);
    // Once, and naming the bearer that was rejected - the fence a copy held
    // outside this renderer applies before withdrawing its own verification.
    // A plain credential refusal (no `revocation_scope`), so it carries no
    // revocation: only a "sign out everywhere" tells the other windows more.
    expect(revokedFanOuts).toEqual([{ token: "dead-token", revocation: null }]);
    revokedSubscription.dispose();

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
    // `setSignedOut` keeps the last cloud verdict, so a demotion in an earlier
    // test would otherwise colour the next test's unverified projection.
    useAuthStore.getState().setCloudVerdictLoss("unreachable");
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
    const verifiedAnnouncements: Array<"signed-in" | "unverified"> = [];
    const verifiedSubscription = provider.onSessionVerified(() => {
      // Recorded WITH the store status at the moment of the announcement:
      // `HostRuntime`'s refresh reads `cloudBearer()`, which gates on it, so
      // an announcement made before the commit would be refused exactly like
      // no announcement at all.
      verifiedAnnouncements.push(
        useAuthStore.getState().status === "signed-in"
          ? "signed-in"
          : "unverified",
      );
    });

    // A sibling window validated a fresh sign-in for the SAME user end to
    // end and projects it here via the cross-window bridge.
    service.applyExternalSession(
      externalSessionForUser("user-1", "sibling-window-token"),
    );

    expect(useAuthStore.getState().status).toBe("signed-in");
    // RED before the fix: this branch restored the verdict and the store but
    // never announced, so the directory refresh refused while unverified was
    // never retried and a cold window kept an empty remote directory.
    expect(verifiedAnnouncements).toEqual(["signed-in"]);
    verifiedSubscription();
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
    //
    // The session reaches `unverified` through a cold start with authn
    // UNREACHABLE, not through a 401/401 demotion. A session authn REFUSED
    // sets the terminal latch, and from then on a reactive revalidation is
    // answered `rejected` without asking authn or rotating: a host refusing
    // the held bearer would otherwise re-spend the refused refresh token on
    // every request (see `auth-service-held-session-host-refusal.test.ts`).
    // An `unverified` session that authn merely could not be reached for
    // holds no verdict and no latch, so it still rotates reactively - and that
    // is the rotation this test guards.
    vi.useFakeTimers();
    const { service, host } = makeService();
    trackedServices.push(service);
    await host.tokenStore.signIn(
      { token: "stale-stored-token", refreshToken: "stale-stored-refresh" },
      { id: "user-1", email: "test@example.com", name: "Test User" },
    );
    restoreFetch();
    restoreFetch = installFetch(() =>
      Promise.reject(new Error("connection refused")),
    );

    const start = service.start();
    for (let retry = 1; retry < AUTH_FETCH_MAX_ATTEMPTS; retry += 1) {
      await vi.advanceTimersByTimeAsync(authRetryDelayMs(retry));
    }
    await start;
    expect(useAuthStore.getState().status).toBe("unverified");
    // Non-vacuity: no verdict was ever refused, so this is the unlatched path.
    expect(useAuthStore.getState().cloudVerdictLoss).toBe("unreachable");

    const provider = service.getRequestContextProvider();
    const contextBefore = provider.current();
    // A never-verified startup mints a fresh context with `cloudAuthorized:
    // false` at construction.
    expect(contextBefore?.cloudAuthorized).toBe(false);

    // Authn is reachable again and the stored refresh token is still good: a
    // fresh reactive 401 rotate succeeds ("applied"), which drives
    // `rotateLiveBearer` while the session is still `unverified`. The
    // handler must distinguish the two validate calls by bearer - the stale
    // stored token (rejected, driving the rotate) and the freshly-rotated
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

    // No timer is advanced before this call: the recovery loop's first tick
    // would validate the stored token itself and promote the session to
    // `signed-in`, which is a different transition from the one under test.
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

  it("a valid revalidation after a reactive rotate on an unverified session restores the verdict with the store's signed-in", async () => {
    // The step after the case above: the rotated bearer validates on the NEXT
    // check for the same user. That is a verdict, and the store goes
    // `signed-in` on it - here because the account was renamed since the stored
    // snapshot, so the identity reads as changed. The context every host call
    // socket reads (`cloudAuthorized: () => context.cloudAuthorized`) must go
    // with it, or the host refuses each call of a session the UI shows as
    // signed in.
    vi.useFakeTimers();
    const { service, host } = makeService();
    trackedServices.push(service);
    await host.tokenStore.signIn(
      { token: "stale-stored-token", refreshToken: "stale-stored-refresh" },
      { id: "user-1", email: "test@example.com", name: "Old Name" },
    );
    restoreFetch();
    restoreFetch = installFetch(() =>
      Promise.reject(new Error("connection refused")),
    );

    const start = service.start();
    for (let retry = 1; retry < AUTH_FETCH_MAX_ATTEMPTS; retry += 1) {
      await vi.advanceTimersByTimeAsync(authRetryDelayMs(retry));
    }
    await start;
    expect(useAuthStore.getState().status).toBe("unverified");

    const provider = service.getRequestContextProvider();
    const contextBefore = provider.current();
    expect(contextBefore?.cloudAuthorized).toBe(false);

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

    // The reactive rotate: a bearer swap, still no verdict (see above).
    const rotateOutcome = await service.revalidateCurrentContext();
    expect(rotateOutcome?.kind).toBe("valid");
    expect(useAuthStore.getState().status).toBe("unverified");
    expect(provider.current()?.cloudAuthorized).toBe(false);

    // The next check validates the held bearer outright.
    const verdictOutcome = await service.revalidateCurrentContext();
    expect(verdictOutcome?.kind).toBe("valid");

    expect(useAuthStore.getState().status).toBe("signed-in");
    const contextAfter = provider.current();
    expect(contextAfter).toBe(contextBefore);
    expect(contextAfter?.cloudAuthorized).toBe(true);
  });

  it("a valid verdict for the bearer a check was sent with is not projected onto a bearer a reconcile adopted meanwhile", async () => {
    // The verdict names the token that was sent. A reconcile that adopts a
    // same-user bearer authn refuses lands `unverified` on the new token
    // without moving the identity generation, so only the credential
    // generation tells the late verdict that its token is no longer the one
    // held. Authorizing the adopted bearer would give a token authn has just
    // refused a cloud verdict.
    vi.useFakeTimers();
    const { service, host } = makeService();
    trackedServices.push(service);
    await host.tokenStore.signIn(
      { token: "stale-stored-token", refreshToken: "stale-stored-refresh" },
      { id: "user-1", email: "test@example.com", name: "Test User" },
    );
    restoreFetch();
    restoreFetch = installFetch(() =>
      Promise.reject(new Error("connection refused")),
    );

    const start = service.start();
    for (let retry = 1; retry < AUTH_FETCH_MAX_ATTEMPTS; retry += 1) {
      await vi.advanceTimersByTimeAsync(authRetryDelayMs(retry));
    }
    await start;
    expect(useAuthStore.getState().status).toBe("unverified");

    const provider = service.getRequestContextProvider();
    const contextBefore = provider.current();
    expect(contextBefore?.cloudAuthorized).toBe(false);

    // The check on the held bearer is left pending; authn refuses the bearer
    // the reconcile is about to read off disk.
    let answerHeldBearer: (response: Response) => void = () => undefined;
    const heldBearerAnswer = new Promise<Response>((resolve) => {
      answerHeldBearer = resolve;
    });
    restoreFetch();
    restoreFetch = installFetch((input, init) => {
      const url = typeof input === "string" ? input : String(input);
      if (url !== VALIDATION_URL) {
        return status(500);
      }
      return init?.headers?.Authorization === "Bearer stale-stored-token"
        ? heldBearerAnswer
        : status(401);
    });
    const revalidation = service.revalidateCurrentContext();
    await vi.advanceTimersByTimeAsync(0);

    await host.tokenStore.signIn(
      { token: "adopted-token", refreshToken: "adopted-refresh" },
      { id: "user-1", email: "test@example.com", name: "Test User" },
    );
    await vi.advanceTimersByTimeAsync(0);
    // Non-vacuity: the reconcile really did adopt the second bearer.
    expect(service.getCurrentSessionSnapshot().token).toBe("adopted-token");

    answerHeldBearer(await okWithProfile());
    const outcome = await revalidation;
    expect(outcome?.kind).toBe("valid");

    expect(useAuthStore.getState().status).toBe("unverified");
    const contextAfter = provider.current();
    expect(contextAfter).toBe(contextBefore);
    expect(contextAfter?.cloudAuthorized).toBe(false);
  });

  it("a live revalidation stands down for an interactive sign-in attempt on an unverified session", async () => {
    // Session recovery never races an interactive attempt, and the live
    // revalidation must not either: a verdict would end `signing-in` while the
    // device flow still runs, leaving the attempt's own result landing on a
    // session the surface already reports as signed in.
    vi.useFakeTimers();
    const { service, host } = makeService();
    trackedServices.push(service);
    await host.tokenStore.signIn(
      { token: "stale-stored-token", refreshToken: "stale-stored-refresh" },
      { id: "user-1", email: "test@example.com", name: "Test User" },
    );
    restoreFetch();
    restoreFetch = installFetch(() =>
      Promise.reject(new Error("connection refused")),
    );

    const start = service.start();
    for (let retry = 1; retry < AUTH_FETCH_MAX_ATTEMPTS; retry += 1) {
      await vi.advanceTimersByTimeAsync(authRetryDelayMs(retry));
    }
    await start;
    expect(useAuthStore.getState().status).toBe("unverified");

    await service.signIn();
    expect(useAuthStore.getState().status).toBe("signing-in");
    expect(service.getDeviceProgress()?.phase).toBe("waiting-approval");

    // Authn is reachable again and accepts the bearer the session still holds.
    restoreFetch();
    restoreFetch = installFetch(() => okWithProfile());
    const outcome = await service.revalidateCurrentContext();
    expect(outcome).toEqual({ kind: "superseded" });

    expect(useAuthStore.getState().status).toBe("signing-in");
    expect(service.getDeviceProgress()?.phase).toBe("waiting-approval");
  });

  it("an unauthorized stream close during an interactive sign-in re-dials instead of going terminal", async () => {
    // The stream's UNAUTHORIZED recovery asks the live revalidation, which
    // stands down under the attempt. Reading that as a rejection would close
    // the stream for good while the sign-in is still deciding the session.
    vi.useFakeTimers();
    const { service, host } = makeService();
    trackedServices.push(service);
    await host.tokenStore.signIn(
      { token: "stale-stored-token", refreshToken: "stale-stored-refresh" },
      { id: "user-1", email: "test@example.com", name: "Test User" },
    );
    restoreFetch();
    restoreFetch = installFetch(() =>
      Promise.reject(new Error("connection refused")),
    );
    const start = service.start();
    for (let retry = 1; retry < AUTH_FETCH_MAX_ATTEMPTS; retry += 1) {
      await vi.advanceTimersByTimeAsync(authRetryDelayMs(retry));
    }
    await start;
    await service.signIn();
    expect(useAuthStore.getState().status).toBe("signing-in");

    const sockets: ScriptedStreamSocket[] = [];
    const factory: IStreamWebSocketFactory = {
      create: () => {
        const socket = new ScriptedStreamSocket();
        sockets.push(socket);
        return socket;
      },
    };
    const requestContext = createRequestContextFixture({
      origin: "renderer",
      bearerToken: "stale-stored-token",
    });
    const client = new WsStreamClient({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostStreamRpcRegistry,
      endpoint: () => mockLocalHostEntry,
      hostId: mockLocalHostEntry.hostId,
      bearer: () => requestContext.credentials,
      auth: createStreamAuthRevalidator(service),
      clock: null,
      hostCredentialMint: null,
      onHostCredentialState: null,
      evidence: NO_TRANSPORT_EVIDENCE,
      webSocketFactory: factory,
      dialTimeoutMs: 1_000,
      openAckTimeoutMs: 1_000,
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 5,
      maxBackoffMs: 1_000,
    });
    const statuses: StreamConnectionStatus[] = [];
    const session = client.subscribe("epic.subscribe", { epicId: "e1" });
    session.onStatusChange((streamStatus) => statuses.push(streamStatus));
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);

    sockets[0].fireOpen();
    sockets[0].fireText({
      kind: "fatalError",
      details: {
        code: "UNAUTHORIZED",
        reason: "bearer expired",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });
    await vi.advanceTimersByTimeAsync(50);

    expect(sockets).toHaveLength(2);
    expect(statuses).not.toContain("closed");
    expect(useAuthStore.getState().status).toBe("signing-in");
    session.close();
  });

  it("an unauthorized stream close whose check an interactive sign-in overtakes re-dials instead of going terminal", async () => {
    // The other ordering: the stream's recovery has already sent
    // `/api/v3/user` when the sign-in starts, so the check is fenced by the
    // identity generation after its answer lands. That internal `null` means
    // "stale", not "no context"; reading it as a rejection would close the
    // stream for good under a session the attempt is still deciding.
    vi.useFakeTimers();
    const { service, host } = makeService();
    trackedServices.push(service);
    await host.tokenStore.signIn(
      { token: "stale-stored-token", refreshToken: "stale-stored-refresh" },
      { id: "user-1", email: "test@example.com", name: "Test User" },
    );
    restoreFetch();
    restoreFetch = installFetch(() =>
      Promise.reject(new Error("connection refused")),
    );
    const start = service.start();
    for (let retry = 1; retry < AUTH_FETCH_MAX_ATTEMPTS; retry += 1) {
      await vi.advanceTimersByTimeAsync(authRetryDelayMs(retry));
    }
    await start;
    expect(useAuthStore.getState().status).toBe("unverified");

    let answerHeldCheck: (response: Response) => void = () => undefined;
    const heldCheckAnswer = new Promise<Response>((resolve) => {
      answerHeldCheck = resolve;
    });
    const validationRequests = { value: 0 };
    restoreFetch();
    restoreFetch = installFetch((input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url !== VALIDATION_URL) {
        return Promise.reject(new Error("connection refused"));
      }
      validationRequests.value += 1;
      return heldCheckAnswer;
    });

    const sockets: ScriptedStreamSocket[] = [];
    const factory: IStreamWebSocketFactory = {
      create: () => {
        const socket = new ScriptedStreamSocket();
        sockets.push(socket);
        return socket;
      },
    };
    const requestContext = createRequestContextFixture({
      origin: "renderer",
      bearerToken: "stale-stored-token",
    });
    const client = new WsStreamClient({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostStreamRpcRegistry,
      endpoint: () => mockLocalHostEntry,
      hostId: mockLocalHostEntry.hostId,
      bearer: () => requestContext.credentials,
      auth: createStreamAuthRevalidator(service),
      clock: null,
      hostCredentialMint: null,
      onHostCredentialState: null,
      evidence: NO_TRANSPORT_EVIDENCE,
      webSocketFactory: factory,
      dialTimeoutMs: 1_000,
      openAckTimeoutMs: 1_000,
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 5,
      maxBackoffMs: 1_000,
    });
    const statuses: StreamConnectionStatus[] = [];
    const revalidation = vi.spyOn(service, "revalidateCurrentContext");
    const session = client.subscribe("epic.subscribe", { epicId: "e1" });
    session.onStatusChange((streamStatus) => statuses.push(streamStatus));
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);

    sockets[0].fireOpen();
    sockets[0].fireText({
      kind: "fatalError",
      details: {
        code: "UNAUTHORIZED",
        reason: "bearer expired",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    // Non-vacuity: the recovery's check really is in flight, undecided.
    expect(validationRequests.value).toBe(1);
    expect(sockets).toHaveLength(1);

    await service.signIn();
    expect(useAuthStore.getState().status).toBe("signing-in");

    answerHeldCheck(await okWithProfile());
    await vi.advanceTimersByTimeAsync(50);

    expect(sockets).toHaveLength(2);
    expect(statuses).not.toContain("closed");
    expect(useAuthStore.getState().status).toBe("signing-in");
    await expect(revalidation.mock.results[0]?.value).resolves.toEqual({
      kind: "superseded",
    });
    session.close();
  });

  it("an unauthorized stream close whose check a completed same-user sign-in overtakes re-dials on the new bearer", async () => {
    // The sign-in finishes while the recovery's check is still waiting on the
    // held bearer's answer, so no attempt is running when that answer lands
    // and the check is fenced as stale. The context is live on the new
    // bearer, so `null` ("no context") would close the stream for good under
    // a signed-in session; the check must answer "superseded" instead.
    vi.useFakeTimers();
    const { service, host } = makeService();
    trackedServices.push(service);
    await host.tokenStore.signIn(
      { token: "stale-stored-token", refreshToken: "stale-stored-refresh" },
      { id: "user-1", email: "test@example.com", name: "Test User" },
    );
    restoreFetch();
    restoreFetch = installFetch(() =>
      Promise.reject(new Error("connection refused")),
    );
    const start = service.start();
    for (let retry = 1; retry < AUTH_FETCH_MAX_ATTEMPTS; retry += 1) {
      await vi.advanceTimersByTimeAsync(authRetryDelayMs(retry));
    }
    await start;
    expect(useAuthStore.getState().status).toBe("unverified");

    let answerHeldCheck: (response: Response) => void = () => undefined;
    const heldCheckAnswer = new Promise<Response>((resolve) => {
      answerHeldCheck = resolve;
    });
    const validationRequests = { value: 0 };
    restoreFetch();
    restoreFetch = installFetch((input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url !== VALIDATION_URL) {
        return Promise.reject(new Error("connection refused"));
      }
      validationRequests.value += 1;
      return validationRequests.value === 1 ? heldCheckAnswer : okWithProfile();
    });

    const sockets: ScriptedStreamSocket[] = [];
    const factory: IStreamWebSocketFactory = {
      create: () => {
        const socket = new ScriptedStreamSocket();
        sockets.push(socket);
        return socket;
      },
    };
    const requestContext = createRequestContextFixture({
      origin: "renderer",
      bearerToken: "stale-stored-token",
    });
    const client = new WsStreamClient({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostStreamRpcRegistry,
      endpoint: () => mockLocalHostEntry,
      hostId: mockLocalHostEntry.hostId,
      bearer: () => requestContext.credentials,
      auth: createStreamAuthRevalidator(service),
      clock: null,
      hostCredentialMint: null,
      onHostCredentialState: null,
      evidence: NO_TRANSPORT_EVIDENCE,
      webSocketFactory: factory,
      dialTimeoutMs: 1_000,
      openAckTimeoutMs: 1_000,
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 5,
      maxBackoffMs: 1_000,
    });
    const statuses: StreamConnectionStatus[] = [];
    const revalidation = vi.spyOn(service, "revalidateCurrentContext");
    const session = client.subscribe("epic.subscribe", { epicId: "e1" });
    session.onStatusChange((streamStatus) => statuses.push(streamStatus));
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);

    sockets[0].fireOpen();
    sockets[0].fireText({
      kind: "fatalError",
      details: {
        code: "UNAUTHORIZED",
        reason: "bearer expired",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    // Non-vacuity: the recovery's check really is in flight, undecided.
    expect(validationRequests.value).toBe(1);
    expect(sockets).toHaveLength(1);

    await deviceSignIn(service, host, "fresh-token-b");
    await vi.waitFor(() => {
      expect(useAuthStore.getState().status).toBe("signed-in");
    });
    expect(service.getCurrentSessionSnapshot().token).toBe("fresh-token-b");

    answerHeldCheck(await okWithProfile());
    await vi.advanceTimersByTimeAsync(50);

    expect(sockets).toHaveLength(2);
    expect(statuses).not.toContain("closed");
    expect(useAuthStore.getState().status).toBe("signed-in");
    expect(service.getCurrentSessionSnapshot().token).toBe("fresh-token-b");
    await expect(revalidation.mock.results[0]?.value).resolves.toEqual({
      kind: "superseded",
    });
    session.close();
  });

  it("a refused live revalidation does not demote an interactive sign-in attempt or spend the refresh token", async () => {
    // The mirror of the case above: authn refuses the held bearer, which would
    // rotate it and land `unverified` over the running attempt.
    vi.useFakeTimers();
    const { service, host } = makeService();
    trackedServices.push(service);
    await host.tokenStore.signIn(
      { token: "stale-stored-token", refreshToken: "stale-stored-refresh" },
      { id: "user-1", email: "test@example.com", name: "Test User" },
    );
    restoreFetch();
    restoreFetch = installFetch(() =>
      Promise.reject(new Error("connection refused")),
    );

    const start = service.start();
    for (let retry = 1; retry < AUTH_FETCH_MAX_ATTEMPTS; retry += 1) {
      await vi.advanceTimersByTimeAsync(authRetryDelayMs(retry));
    }
    await start;
    expect(useAuthStore.getState().status).toBe("unverified");

    await service.signIn();
    expect(useAuthStore.getState().status).toBe("signing-in");

    const refreshRequests = { value: 0 };
    restoreFetch();
    restoreFetch = installFetch((input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url === REFRESH_URL) {
        refreshRequests.value += 1;
      }
      return status(401);
    });
    await service.revalidateCurrentContext();

    expect(refreshRequests.value).toBe(0);
    expect(useAuthStore.getState().status).toBe("signing-in");
    expect(service.getDeviceProgress()?.phase).toBe("waiting-approval");
  });

  /**
   * `unverified` is a claim that there is a LOCAL PLANE worth holding the app
   * open for. A shell with no local host has none - and cannot substitute a
   * remote one, because `cloudAuthorized` gates the attach-grant mint, so an
   * unverified session cannot attach a remote host either.
   *
   * Admitting there mounts and routes into an app with NEITHER plane:
   * `admitsLocalPlane` answers on status alone, so all ~24 of its consumers
   * inherit that yes. Refused at the producer instead, which is the only place
   * the invariant those consumers already assume can be made true once.
   */
  describe("the unverified projection requires a local plane to serve", () => {
    it("declines the startup projection on a shell with no local host", async () => {
      // The exact path Codex named (`auth-service.ts`, the startup
      // `network-error` arm): stored credentials on disk, authn unreachable.
      // On desktop this is the whole point of `unverified` - hold the app open
      // around local epics. Here there are none to hold it open for.
      const { service, host } = makeServiceOnShell(false);
      trackedServices.push(service);
      await host.tokenStore.signIn(
        { token: "mobile-stored", refreshToken: "mobile-stored-refresh" },
        { id: "user-1", email: "test@example.com", name: "Test User" },
      );
      restoreFetch();
      restoreFetch = installFetch(() =>
        Promise.reject(new TypeError("fetch failed")),
      );

      await service.start();

      // Not admitted: `admitsLocalPlane` would have said yes on status alone,
      // and every consumer of it would have mounted around a plane that does
      // not exist and cannot be substituted (the attach-grant mint an
      // unverified session would need is gated by `cloudAuthorized`).
      expect(useAuthStore.getState().status).not.toBe("unverified");
      expect(useAuthStore.getState().status).toBe("signed-out");
    });

    it("still projects unverified on a shell that HAS a local host (non-vacuity)", async () => {
      // The control, and it is what makes the assertion above mean anything:
      // same stored credentials, same unreachable authn, same code path - one
      // property different. Without it, a service that simply never reached
      // the projection would pass the test above just as well.
      const { service, host } = makeServiceOnShell(true);
      trackedServices.push(service);
      await host.tokenStore.signIn(
        { token: "desktop-stored", refreshToken: "desktop-stored-refresh" },
        { id: "user-1", email: "test@example.com", name: "Test User" },
      );
      restoreFetch();
      restoreFetch = installFetch(() =>
        Promise.reject(new TypeError("fetch failed")),
      );

      await service.start();

      expect(useAuthStore.getState().status).toBe("unverified");
      expect(service.getCurrentSessionSnapshot().token).toBe("desktop-stored");
    });

    it("lands a terminal verdict loss on signed-out when there is no local plane", async () => {
      const { service, host } = makeServiceOnShell(false);
      trackedServices.push(service);
      await service.start();
      await deviceSignIn(service, host, "mobile-dead-token");
      expect(useAuthStore.getState().status).toBe("signed-in");

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
      // Demoting to `unverified` here would leave an admitted app with neither
      // plane; the auth surface is the honest destination.
      expect(useAuthStore.getState().status).toBe("signed-out");
    });
  });

  /**
   * A verdict loss in ONE window has to reach the others.
   *
   * Main answers a revoke by dropping its own verification and republishing the
   * SAME snapshot, which every window's latch discards as an echo - so a sibling
   * kept reading `signed-in` and spending the refused bearer on cloud work until
   * it happened to revalidate. `ingestCloudAuthorizationRevoked` is the inbound
   * half of that edge.
   */
  describe("an inbound cloud-authorization revoke demotes this window", () => {
    it("demotes a window holding the rejected bearer", async () => {
      const { service, host } = makeService();
      trackedServices.push(service);
      await service.start();
      await deviceSignIn(service, host, "sibling-token");
      expect(useAuthStore.getState().status).toBe("signed-in");

      service.ingestCloudAuthorizationRevoked("sibling-token", null);

      expect(useAuthStore.getState().status).toBe("unverified");
    });

    it("records the loss as ended-elsewhere: the revoke names a bearer, not a verdict", async () => {
      // FIXTURE STATE: a verified window with no `lastError` of its own, which
      // is exactly the sibling's production state - the refusal (an expiry OR
      // a refused account) was observed in the OTHER window. Classifying this
      // `session-rejected` told a user whose account was refused to sign in
      // again.
      const { service, host } = makeService();
      trackedServices.push(service);
      await service.start();
      await deviceSignIn(service, host, "sibling-token");
      expect(useAuthStore.getState().cloudVerdictLoss).toBe("unreachable");
      expect(service.getLastError()).toBeNull();

      service.ingestCloudAuthorizationRevoked("sibling-token", null);

      expect(useAuthStore.getState().cloudVerdictLoss).toBe("ended-elsewhere");
    });

    it("control: a revoke naming a stale bearer leaves the recorded loss alone", async () => {
      const { service, host } = makeService();
      trackedServices.push(service);
      await service.start();
      await deviceSignIn(service, host, "current-token");

      service.ingestCloudAuthorizationRevoked(
        "a-bearer-this-window-replaced",
        null,
      );

      expect(useAuthStore.getState().status).toBe("signed-in");
      expect(useAuthStore.getState().cloudVerdictLoss).toBe("unreachable");
    });

    it("leaves a window holding a DIFFERENT bearer alone", async () => {
      // The fence, and it is not theoretical: windows' IPC is unordered, so a
      // revoke raised before a sibling's fresh sign-in can arrive after it. An
      // unfenced ingest would strip the verification of a session the cloud
      // still vouches for.
      const { service, host } = makeService();
      trackedServices.push(service);
      await service.start();
      await deviceSignIn(service, host, "current-token");
      expect(useAuthStore.getState().status).toBe("signed-in");

      service.ingestCloudAuthorizationRevoked(
        "a-bearer-this-window-replaced",
        null,
      );

      expect(useAuthStore.getState().status).toBe("signed-in");
    });

    it("does not re-announce the revoke it was told about", async () => {
      // The listeners exist to tell copies of this session held OUTSIDE the
      // renderer - which is where this edge CAME from. Re-firing sends it back
      // to main, which revokes and fans out again.
      const { service, host } = makeService();
      trackedServices.push(service);
      await service.start();
      await deviceSignIn(service, host, "echo-token");

      let announcements = 0;
      const subscription = service.onCloudAuthorizationRevoked(() => {
        announcements += 1;
      });

      service.ingestCloudAuthorizationRevoked("echo-token", null);

      expect(useAuthStore.getState().status).toBe("unverified");
      expect(announcements).toBe(0);
      subscription.dispose();
    });
  });
});
