import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineVersionedRpcRegistry } from "@traycer/protocol/framework/index";
import { defineVersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import type { VersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { OpenFrameBearerSource } from "../../../auth/bearer-source";
import { createRemoteHostTransport } from "../create-remote-transport";
import { retireAllRemoteSessions } from "../active-remote-sessions";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import type {
  IStreamWebSocketFactory,
  StreamWebSocketLike,
  StreamWebSocketMessageEvent,
} from "../../ws-stream-factory";
import type {
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketOpenEvent,
} from "../../ws-factory";

const emptyRpcRegistry: VersionedRpcRegistry = defineVersionedRpcRegistry({});
const emptyStreamRegistry: VersionedStreamRpcRegistry =
  defineVersionedStreamRpcRegistry({});

// 32 bytes of hex - a well-formed host static key, so the bearer gate under
// test is what decides the outcome, not key parsing.
const VALID_PUBLIC_KEY = "ab".repeat(32);

function transportFor(bearerSource: OpenFrameBearerSource | null) {
  return createRemoteHostTransport<
    VersionedRpcRegistry,
    VersionedStreamRpcRegistry
  >({
    clientIdentity: TEST_CLIENT_IDENTITY,
    hostId: "host-null-bearer-test",
    userId: "user-null-bearer-test",
    relayAttachUrl: "wss://relay.invalid/attach",
    authnBaseUrl: "https://authn.invalid",
    hostPublicKey: VALID_PUBLIC_KEY,
    bearer: () => bearerSource,
    // This suite is about the BUILD-TIME bearer gate, which runs before any
    // mint closure is constructed, so `cloudAuthorized` is not consulted by
    // anything here. `true` keeps it out of the way: were it `false`, a later
    // reader could mistake a build refusal for a permission refusal, and the
    // two are deliberately different mechanisms.
    cloudAuthorized: () => true,
    auth: null,
    rpcRegistry: emptyRpcRegistry,
    streamRegistry: emptyStreamRegistry,
    webSocketFactory: {
      create: () => {
        throw new Error("never dialed by this test");
      },
    },
    requestId: () => "req-1",
    proactiveWakeEligible: true,
    evidence: NO_TRANSPORT_EVIDENCE,
  });
}

describe("createRemoteHostTransport bearer gate", () => {
  it("refuses to build - and so to cache - a session with no auth context", () => {
    // The bearer thunk is a live read, so a session built while it is null
    // could later dial once a context appears, while keyed under an epoch
    // label divorced from that context. Building must degrade to the same
    // `null` as an unconnectable target, not mint a cache entry.
    expect(transportFor(null)).toBeNull();

    // A RELEASED lease is the same verdict through a different shape: the
    // source object survives (still labelling the retired epoch) but its
    // bearer read throws. Letting it into the cache would present the stale
    // epoch as newest and supersede the live context's entry, while the
    // session it builds could never mint.
    const releasedSource: OpenFrameBearerSource = {
      getBearerToken: () => {
        throw new Error("credential lease released");
      },
      identity: { userId: "user-null-bearer-test" },
    };
    expect(transportFor(releasedSource)).toBeNull();

    // The third enumerated refusal: a source that reads fine but holds an
    // EMPTY token. It cannot authorize a grant mint any more than a released
    // lease can - only the failure would come later, from authn, after the
    // session was already cached under that epoch.
    const emptyTokenSource: OpenFrameBearerSource = {
      getBearerToken: () => "",
      identity: { userId: "user-null-bearer-test" },
    };
    expect(transportFor(emptyTokenSource)).toBeNull();

    // Non-vacuity contrast: the identical options WITH a live auth context
    // build fine - the null verdicts above came from the bearer gate, not
    // from some other option being malformed.
    const bearerSource: OpenFrameBearerSource = {
      getBearerToken: () => "bearer-token",
      identity: { userId: "user-null-bearer-test" },
    };
    const built = transportFor(bearerSource);
    expect(built).not.toBeNull();
    built?.session.close();
  });
});

// ── Option D: `cloudAuthorized` gates ONLY the attach-grant mint closure ──
//
// Distinct from the build-time bearer gate above (`transportFor`/`null`),
// which runs once, before any mint closure exists, and degrades to an
// unbuildable ("unconnectable") transport. `cloudAuthorized` instead gates a
// closure that is read on EVERY attach attempt, from inside an already-built,
// already-cached session - so the session it produces must stay alive and
// keep retrying while refused, and must be able to mint the moment the flag
// flips, with no rebuild. Both properties are asserted through the REAL
// `RemoteSession` connect loop (`session.start()`), not by re-deriving the
// mint closure's logic in the test.
//
// `WAIT`/`TEST_BUDGET_MS` mirror `remote-session.test.ts`'s own timing note:
// the reconnect ladder starts at `RECONNECT_INITIAL_BACKOFF_MS` (1s, see
// `../config`), so assertions that need a SECOND attempt wait with a
// generous explicit budget rather than vitest's 1s/5s defaults.
const WAIT = { timeout: 10_000, interval: 50 } as const;
const TEST_BUDGET_MS = 15_000;

/**
 * A `StreamWebSocketLike` that never fires anything back. These tests only
 * need to observe whether the relay socket was CREATED AT ALL - the proof
 * that the mint closure produced `kind: "ok"` and the session moved past the
 * grant gate - not whether a full attach/handshake completes.
 */
class InertFakeSocket implements StreamWebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: StreamWebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;

  send(_data: string | Uint8Array): void {
    // Never exercised - see the class doc.
  }

  close(_code: number, _reason: string): void {
    // Never exercised - see the class doc.
  }
}

/**
 * Releases this test's one consumer reference AND forces the underlying
 * cached `RemoteSession` closed for real.
 *
 * `session.close()` alone is not enough: the object `createRemoteHostTransport`
 * hands back is a per-consumer VIEW onto a ref-counted, keep-warm-cached
 * session (`active-remote-sessions.ts`), so releasing the last reference only
 * SCHEDULES a teardown after `REMOTE_SESSION_LINGER_MS` (60s) - during which
 * the real session keeps its reconnect backoff timer alive. Calling
 * `retireAllRemoteSessions()` right after immediately force-closes any entry
 * whose refCount just dropped to zero, which is exactly what a test that
 * called `session.start()` needs so no background timer outlives it.
 */
function closeAndRetire(session: { readonly close: () => void }): void {
  session.close();
  retireAllRemoteSessions();
}

describe("createRemoteHostTransport cloudAuthorized gate (Option D — mint-only)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it(
    "cloudAuthorized() => false yields an unavailable grant; the session schedules a retry and never goes terminal",
    async () => {
      const cloudAuthorizedCalls: number[] = [];
      const cloudAuthorized = (): boolean => {
        cloudAuthorizedCalls.push(cloudAuthorizedCalls.length);
        return false;
      };
      const warnMessages: string[] = [];
      const warnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation((message: unknown) => {
          warnMessages.push(String(message));
        });
      const createCalls: string[] = [];
      const webSocketFactory: IStreamWebSocketFactory = {
        create: (url: string): StreamWebSocketLike => {
          createCalls.push(url);
          return new InertFakeSocket();
        },
      };
      const bearerSource: OpenFrameBearerSource = {
        getBearerToken: () => "user-bearer-token",
        identity: { userId: "user-gate-b-test" },
      };

      const built = createRemoteHostTransport<
        VersionedRpcRegistry,
        VersionedStreamRpcRegistry
      >({
        clientIdentity: TEST_CLIENT_IDENTITY,
        hostId: "host-gate-b-test",
        userId: "user-gate-b-test",
        relayAttachUrl: "wss://relay.invalid/attach",
        authnBaseUrl: "https://authn.invalid",
        hostPublicKey: VALID_PUBLIC_KEY,
        bearer: () => bearerSource,
        cloudAuthorized,
        auth: null,
        rpcRegistry: emptyRpcRegistry,
        streamRegistry: emptyStreamRegistry,
        webSocketFactory,
        requestId: () => "req-1",
        proactiveWakeEligible: true,
        evidence: NO_TRANSPORT_EVIDENCE,
      });
      expect(built).not.toBeNull();
      if (built === null) {
        throw new Error("expected a built transport");
      }
      const session = built.session;
      let closedFired = false;
      session.onClosed(() => {
        closedFired = true;
      });

      try {
        session.start();

        // The grant provider resolved to `unavailable` FOR THE RIGHT REASON:
        // this is grant-client.ts's own "no user bearer available" wording,
        // which fires ONLY when the mint closure's `getBearerToken()` returned
        // null - i.e. only when `cloudAuthorized()` refused. A network fault or
        // a bad host key would read completely differently here, so this pins
        // the MECHANISM rather than an effect that could be absent for an
        // unrelated reason.
        await vi.waitFor(() => {
          expect(warnMessages.length).toBeGreaterThan(0);
        }, WAIT);
        expect(warnMessages[0]).toContain("no user bearer available");

        // NOT terminal: the session stays alive rather than closing.
        expect(session.isClosed()).toBe(false);
        expect(session.terminalFatal()).toBeNull();
        expect(closedFired).toBe(false);
        // The mint never succeeded, so the relay was never even dialed.
        expect(createCalls).toEqual([]);

        // A retry IS scheduled on its own: the gate re-probes without any
        // external nudge, proving this is backoff and not a stall.
        await vi.waitFor(() => {
          expect(cloudAuthorizedCalls.length).toBeGreaterThanOrEqual(2);
        }, WAIT);
        expect(session.isClosed()).toBe(false);
        expect(session.terminalFatal()).toBeNull();
      } finally {
        closeAndRetire(session);
        warnSpy.mockRestore();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "the gate lives INSIDE the mint closure: a session built while cloudAuthorized() is false mints successfully once the flag flips true, with NO rebuild of the transport",
    async () => {
      // `canProvideBearer` is probed ONCE at build time and the session is
      // cached on `authEpochFor(bearerSource)` - an identity of the SOURCE
      // OBJECT that a verdict transition does not change (see
      // `create-remote-transport.ts`'s `cloudAuthorized` doc). A build-time
      // gate would therefore leave a session permanently unable to mint; this
      // test flips a mutable boolean the closure reads LIVE, on the SAME
      // session `createRemoteHostTransport` is called exactly once to build.
      let authorized = false;
      const cloudAuthorized = (): boolean => authorized;

      const fetchMock = vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              grant: "jws-flip-test",
              role: "client",
              expires_in: 120,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const warnMessages: string[] = [];
      const warnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation((message: unknown) => {
          warnMessages.push(String(message));
        });
      const createCalls: string[] = [];
      const webSocketFactory: IStreamWebSocketFactory = {
        create: (url: string): StreamWebSocketLike => {
          createCalls.push(url);
          return new InertFakeSocket();
        },
      };
      const bearerSource: OpenFrameBearerSource = {
        getBearerToken: () => "user-bearer-token",
        identity: { userId: "user-gate-c-test" },
      };

      const built = createRemoteHostTransport<
        VersionedRpcRegistry,
        VersionedStreamRpcRegistry
      >({
        clientIdentity: TEST_CLIENT_IDENTITY,
        hostId: "host-gate-c-test",
        userId: "user-gate-c-test",
        relayAttachUrl: "wss://relay.invalid/attach",
        authnBaseUrl: "https://authn.invalid",
        hostPublicKey: VALID_PUBLIC_KEY,
        bearer: () => bearerSource,
        cloudAuthorized,
        auth: null,
        rpcRegistry: emptyRpcRegistry,
        streamRegistry: emptyStreamRegistry,
        webSocketFactory,
        requestId: () => "req-1",
        proactiveWakeEligible: true,
        evidence: NO_TRANSPORT_EVIDENCE,
      });
      expect(built).not.toBeNull();
      if (built === null) {
        throw new Error("expected a built transport");
      }
      // The ONE session/transport this test ever builds - nothing below
      // rebuilds it; `authorized` toggles the same closure the session already
      // holds a reference to.
      const session = built.session;

      try {
        session.start();

        // First attempt, flag still false: the mint refuses before it ever
        // reaches the network - the discriminating, not merely absent, signal.
        await vi.waitFor(() => {
          expect(warnMessages.length).toBeGreaterThan(0);
        }, WAIT);
        expect(warnMessages[0]).toContain("no user bearer available");
        expect(fetchMock).not.toHaveBeenCalled();
        expect(createCalls).toEqual([]);

        // Flip the SAME closure's read.
        authorized = true;

        // The next retry (already scheduled by the first failure) now mints
        // successfully and the session proceeds to dial the relay - reaching
        // the socket factory is only possible once the grant resolves
        // `kind: "ok"`, which only a successful mint produces.
        await vi.waitFor(() => {
          expect(createCalls.length).toBeGreaterThan(0);
        }, WAIT);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(String(url)).toBe(
          "https://authn.invalid/api/v3/hosts/host-gate-c-test/attach-grant",
        );
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bearer user-bearer-token",
        );
      } finally {
        closeAndRetire(session);
        warnSpy.mockRestore();
      }
    },
    TEST_BUDGET_MS,
  );
});
