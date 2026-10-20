import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  defineVersionedRpcRegistry,
  type FatalErrorDetails,
} from "@traycer/protocol/framework/index";
import { defineVersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import type { VersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  createResponderHandshake,
  DEFAULT_REPLAY_WINDOW_SIZE,
  generateStaticKeyPair,
  NoiseSession,
  type NoiseKeyPair,
} from "@traycer/protocol/crypto/noise";
import {
  ChunkReassembler,
  OutboundChunkSource,
} from "@traycer/protocol/host-transport/chunking";
import {
  decodeMuxFrame,
  encodeMuxFrame,
  MuxFrameType,
  NOISE_PROLOGUE,
  QosClass,
  SESSION_CONTROL_STREAM_ID,
} from "@traycer/protocol/host-transport/mux";
import type { OpenFrameBearerSource } from "../../../auth/bearer-source";
import {
  createRemoteHostTransport,
  remoteOpenAuthFor,
} from "../create-remote-transport";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import { hostListItemToDirectoryEntry } from "../../../host-client/remote-fetcher";
import { retireAllRemoteSessions } from "../active-remote-sessions";
import { subscribeTeamMemberRemovedClose } from "../../team-member-removed-close";
import { TEAM_MEMBER_REMOVED_FATAL_CODE } from "../../../host-client/host-connection-reconnect-engine";
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
    openAuth: "user-bearer",
    // This suite is about the BUILD-TIME bearer gate, which runs before any
    // mint closure is constructed, so `cloudAuthorized` is not consulted by
    // anything here. `true` keeps it out of the way: were it `false`, a later
    // reader could mistake a build refusal for a permission refusal, and the
    // two are deliberately different mechanisms.
    cloudAuthorized: () => true,
    auth: null,
    clock: null,
    rpcRegistry: emptyRpcRegistry,
    streamRegistry: emptyStreamRegistry,
    webSocketFactory: {
      create: () => {
        throw new Error("never dialed by this test");
      },
    },
    requestId: () => "req-1",
    proactiveWakeEligible: true,
    mintMemberCredential: null,
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
        openAuth: "user-bearer",
        cloudAuthorized,
        auth: null,
        clock: null,
        rpcRegistry: emptyRpcRegistry,
        streamRegistry: emptyStreamRegistry,
        webSocketFactory,
        requestId: () => "req-1",
        proactiveWakeEligible: true,
        mintMemberCredential: null,
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
        openAuth: "user-bearer",
        cloudAuthorized,
        auth: null,
        clock: null,
        rpcRegistry: emptyRpcRegistry,
        streamRegistry: emptyStreamRegistry,
        webSocketFactory,
        requestId: () => "req-1",
        proactiveWakeEligible: true,
        mintMemberCredential: null,
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

describe("remoteOpenAuthFor", () => {
  function row(overrides: Partial<HostListItem>): HostListItem {
    return {
      hostId: "host-1",
      displayName: null,
      platform: null,
      kind: "personal",
      publicKey: VALID_PUBLIC_KEY,
      createdAt: "2026-01-01T00:00:00.000Z",
      status: {
        connectivity: "connectable",
        viewerReachability: "unknown",
        clientCloud: "ok",
        updateState: "current",
        appVersion: "1.5.0",
        lastSeenAt: null,
      },
      updatePolicy: "manual",
      ...overrides,
    };
  }

  it("presents the user bearer to a personal host", () => {
    expect(
      remoteOpenAuthFor(
        hostListItemToDirectoryEntry(row({}), "wss://relay.invalid"),
      ),
    ).toBe("user-bearer");
  });

  it("presents a session grant, never the user bearer, to a sandbox host in any lifecycle state", () => {
    for (const sandboxState of ["awake", "suspended", null] as const) {
      expect(
        remoteOpenAuthFor(
          hostListItemToDirectoryEntry(
            row({ kind: "sandbox", sandboxState, sandboxFrozen: false }),
            "wss://relay.invalid",
          ),
        ),
      ).toBe("session-grant");
    }
  });
});

// ── Removal close ──
//
// A team host ends a removed member's sessions with a terminal SESSION fatal
// whose code is `TEAM_MEMBER_REMOVED`. Team hosts are reached over the relay,
// so the session that dies is the cached `RemoteSession` this factory builds -
// and the factory is the one place that knows the host it was built for. The
// app learns of the removal through `reportTeamMemberRemovedClose(hostId)`.
//
// DRIVEN FOR REAL, not by poking the session: no part of `RemoteSession` is
// mocked. `E17RemovalRelayHost` below is the minimum of the wire the session's
// own connect path needs - a relay `attach_ack`, a real responder-side Noise
// handshake (the host key in the options is its real public key) and one
// session-level FATAL sent in-channel in answer to the session's `OPEN`, the
// same frame a team host sends. `remote-session.test.ts` carries the full
// `FakeRelayHost` this is cut down from; it is not exported from that suite
// (importing a test file would re-register its describes here).

const E17_EMPTY_AD = new Uint8Array(0);

function e17Hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function e17FatalDetails(code: string): FatalErrorDetails {
  return {
    code,
    reason: `host ended the session with ${code}`,
    incompatibleMethods: null,
    upgradeGuidance: null,
  };
}

class E17RelaySocket implements StreamWebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: StreamWebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;

  private readonly onSendData: (data: string | Uint8Array) => void;

  constructor(onSendData: (data: string | Uint8Array) => void) {
    this.onSendData = onSendData;
  }

  send(data: string | Uint8Array): void {
    this.onSendData(data);
  }

  close(_code: number, _reason: string): void {
    // The session's own close; nothing to model on the host side.
  }
}

/**
 * The relay and host end of one wire: attaches, completes the Noise handshake,
 * and answers the session's first `OPEN` with a session-level FATAL carrying
 * `fatal`. Counts the `OPEN`s it saw, so a test can tell one session from two.
 */
class E17RemovalRelayHost {
  readonly hostKeys: NoiseKeyPair = generateStaticKeyPair();
  /** Unexpected harness-side failures; asserted empty by the tests. */
  readonly errors: unknown[] = [];
  openFramesSeen = 0;

  private readonly fatal: FatalErrorDetails;

  constructor(fatal: FatalErrorDetails) {
    this.fatal = fatal;
  }

  get hostPublicKeyHex(): string {
    return e17Hex(this.hostKeys.publicKey);
  }

  readonly factory: IStreamWebSocketFactory = {
    create: (): StreamWebSocketLike => {
      let noise: NoiseSession | null = null;
      let nextSeq = 0;
      let queue: Promise<void> = Promise.resolve();
      const reassembler = new ChunkReassembler(undefined);
      const socket = new E17RelaySocket((data) => {
        if (typeof data === "string") {
          // Keepalive pings and reauth control frames need no answer here.
          return;
        }
        queue = queue
          .then(async () => {
            if (noise === null) {
              const handshake = await createResponderHandshake(
                this.hostKeys,
                NOISE_PROLOGUE,
              );
              await handshake.readMessage(data);
              const msg1 = await handshake.writeMessage(new Uint8Array(0));
              noise = NoiseSession.fromHandshake(
                handshake,
                DEFAULT_REPLAY_WINDOW_SIZE,
              );
              socket.onmessage?.({ type: "binary", data: msg1 });
              return;
            }
            const frame = decodeMuxFrame(
              await noise.decrypt(data, E17_EMPTY_AD),
            );
            const message = reassembler.accept(frame);
            if (
              message === null ||
              message.type !== MuxFrameType.OPEN ||
              message.streamId !== SESSION_CONTROL_STREAM_ID
            ) {
              return;
            }
            this.openFramesSeen += 1;
            const source = new OutboundChunkSource(
              {
                type: MuxFrameType.FATAL,
                streamId: SESSION_CONTROL_STREAM_ID,
                qos: QosClass.INTERACTIVE,
                json: { details: { ...this.fatal } },
                binary: null,
              },
              () => {
                const current = nextSeq;
                nextSeq += 1;
                return current;
              },
              false,
            );
            while (!source.done) {
              const sealed = await noise.encrypt(
                encodeMuxFrame(source.nextFrame()),
                E17_EMPTY_AD,
              );
              socket.onmessage?.({ type: "binary", data: sealed });
            }
          })
          .catch((error: unknown) => {
            this.errors.push(error);
          });
      });
      queueMicrotask(() => {
        socket.onopen?.({ type: "open" });
        socket.onmessage?.({
          type: "text",
          data: JSON.stringify({ type: "attach_ack", role: "client", sid: 1 }),
        });
      });
      return socket;
    },
  };
}

describe("createRemoteHostTransport reports a TEAM_MEMBER_REMOVED session close", () => {
  let reported: Mock<(hostId: string) => void>;
  let unsubscribe: (() => void) | null = null;

  beforeEach(() => {
    reported = vi.fn<(hostId: string) => void>();
    unsubscribe = subscribeTeamMemberRemovedClose(reported);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              grant: "jws-e17-removal",
              role: "client",
              expires_in: 120,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
  });

  afterEach(() => {
    // Every case closes its sessions in `finally`; this is the backstop that
    // keeps the process-wide session cache from leaking a keep-warm entry (and
    // its listeners) into the next case or suite.
    retireAllRemoteSessions();
    unsubscribe?.();
    unsubscribe = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function transportOnRelay(
    relay: E17RemovalRelayHost,
    hostId: string,
    bearerSource: OpenFrameBearerSource,
  ) {
    return createRemoteHostTransport<
      VersionedRpcRegistry,
      VersionedStreamRpcRegistry
    >({
      clientIdentity: TEST_CLIENT_IDENTITY,
      hostId,
      userId: bearerSource.identity.userId,
      relayAttachUrl: "wss://relay.invalid/attach",
      authnBaseUrl: "https://authn.invalid",
      hostPublicKey: relay.hostPublicKeyHex,
      bearer: () => bearerSource,
      openAuth: "user-bearer",
      cloudAuthorized: () => true,
      auth: null,
      clock: null,
      rpcRegistry: emptyRpcRegistry,
      streamRegistry: emptyStreamRegistry,
      webSocketFactory: relay.factory,
      requestId: () => "req-e17",
      proactiveWakeEligible: true,
      mintMemberCredential: null,
      evidence: NO_TRANSPORT_EVIDENCE,
    });
  }

  function bearerFor(userId: string): OpenFrameBearerSource {
    return {
      getBearerToken: () => "e17-bearer-token",
      identity: { userId },
    };
  }

  it(
    "reports the host exactly once when its session closes on a TEAM_MEMBER_REMOVED fatal, however many consumers share the session",
    async () => {
      const relay = new E17RemovalRelayHost(
        e17FatalDetails(TEAM_MEMBER_REMOVED_FATAL_CODE),
      );
      const bearerSource = bearerFor("user-e17-removed");
      // Two consumers of one host: the same bearer source and host key land on
      // one cached session, so one close must be one report, not one each.
      const first = transportOnRelay(relay, "host-e17-removed", bearerSource);
      const second = transportOnRelay(relay, "host-e17-removed", bearerSource);
      if (first === null || second === null) {
        throw new Error("expected both transports to build");
      }
      try {
        first.session.start();
        await vi.waitFor(() => {
          expect(first.session.isClosed()).toBe(true);
        }, WAIT);

        // Positive controls: it was a TERMINAL close, with the removal code,
        // of the one session both consumers share - so the report below is
        // about the right event and not about nothing having run.
        expect(first.session.terminalFatal()?.code).toBe(
          TEAM_MEMBER_REMOVED_FATAL_CODE,
        );
        expect(second.session.isClosed()).toBe(true);
        expect(relay.openFramesSeen).toBe(1);
        expect(relay.errors).toEqual([]);

        expect(reported.mock.calls).toEqual([["host-e17-removed"]]);

        // Releasing the closed session afterwards is not a second close.
        closeAndRetire(first.session);
        closeAndRetire(second.session);
        expect(reported.mock.calls).toEqual([["host-e17-removed"]]);
      } finally {
        closeAndRetire(first.session);
        closeAndRetire(second.session);
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "reports nothing when the session closes terminally on a fatal with another code",
    async () => {
      const relay = new E17RemovalRelayHost(e17FatalDetails("INCOMPATIBLE"));
      const built = transportOnRelay(
        relay,
        "host-e17-incompatible",
        bearerFor("user-e17-incompatible"),
      );
      if (built === null) {
        throw new Error("expected a built transport");
      }
      try {
        built.session.start();
        await vi.waitFor(() => {
          expect(built.session.isClosed()).toBe(true);
        }, WAIT);

        // Positive control: the same wire, the same terminal close - only the
        // code differs - so the empty report list is the code's doing.
        expect(built.session.terminalFatal()?.code).toBe("INCOMPATIBLE");
        expect(relay.openFramesSeen).toBe(1);
        expect(relay.errors).toEqual([]);

        expect(reported).not.toHaveBeenCalled();
      } finally {
        closeAndRetire(built.session);
      }
    },
    TEST_BUDGET_MS,
  );

  it("reports nothing when the caller closes the session", () => {
    const relay = new E17RemovalRelayHost(
      e17FatalDetails(TEAM_MEMBER_REMOVED_FATAL_CODE),
    );
    const built = transportOnRelay(
      relay,
      "host-e17-caller-close",
      bearerFor("user-e17-caller-close"),
    );
    if (built === null) {
      throw new Error("expected a built transport");
    }
    let closedEvents = 0;
    built.session.onClosed(() => {
      closedEvents += 1;
    });
    built.session.start();

    closeAndRetire(built.session);

    // Positive control: the session did close, and as a CALLER close - no
    // fatal on it. The host never got the chance to send its removal fatal.
    expect(closedEvents).toBe(1);
    expect(built.session.terminalFatal()).toBeNull();
    expect(reported).not.toHaveBeenCalled();
  });
});
