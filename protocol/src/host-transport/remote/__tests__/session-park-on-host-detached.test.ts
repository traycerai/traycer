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
  createResponderHandshake,
  generateStaticKeyPair,
  type NoiseKeyPair,
} from "../../../crypto/noise";
import {
  CURRENT_CLIENT_COMPATIBILITY_EPOCH,
  defineVersionedRpcRegistry,
  type VersionedRpcRegistry,
} from "../../../framework/index";
import {
  defineVersionedStreamRpcRegistry,
  type VersionedStreamRpcRegistry,
} from "../../../framework/versioned-stream-rpc";
import { NOISE_PROLOGUE } from "../../mux";
import type {
  IStreamWebSocketFactory,
  StreamWebSocketLike,
  StreamWebSocketMessageEvent,
} from "../../stream-websocket";
import type {
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketOpenEvent,
} from "../../websocket";
import type { RemoteSessionAuth } from "../auth";
import {
  NOISE_HANDSHAKE_TIMEOUT_MS,
  SESSION_OPEN_ACK_TIMEOUT_MS,
} from "../config";
import { RemoteSession, type RemoteSessionEvidence } from "../session";

/**
 * `RemoteSession.onHostDetached` (`../session.ts`) PARKS a connection that
 * hears `host_detached` before its ready boundary, instead of leaving the
 * phase timer (`handshake-timeout` / `open-ack-timeout`) to fail it and redial.
 *
 * The relay sends `host_detached` right after `attach_ack` when no host leg is
 * attached, and again in reply to every data frame while that holds. Before
 * the change, the 15 s phase timer fired, reported a refusal and redialled -
 * 15 s timeout, 1-30 s backoff, repeat - for a host that was simply off. Now:
 * the timer is cleared, ONE refusal is reported (`<scope>#<generation>-no-host`),
 * the socket stays open with the scheduler paused, and the relay's
 * `host_attached` is what rebuilds the connection.
 *
 * The fake relay below is deliberately minimal: it speaks the real relay
 * control frames (`attach_ack`, `host_detached`, `host_attached`, the
 * keepalive pong) and, for the `opening` case only, runs a real responder-side
 * Noise-NK handshake so the session genuinely reaches `opening`. It never
 * answers the session `open`, which is exactly the state in which the
 * `open-ack-timeout` used to fire.
 */

const HOST_ID = "host-park";
const ATTACH_URL = "wss://relay.test/attach";
const NO_HOST_ATTEMPT_ID = /^remote-\d+#1-no-host$/;

const emptyRpcRegistry: VersionedRpcRegistry = defineVersionedRpcRegistry({});
const emptyStreamRegistry: VersionedStreamRpcRegistry =
  defineVersionedStreamRpcRegistry({});

class FakeSocket implements StreamWebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: StreamWebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;
  /** Binary frames the session sent: the Noise initiator, then the `open`. */
  readonly binarySends: Uint8Array[] = [];
  closeCalls = 0;

  private readonly onSend: (data: string | Uint8Array) => void;

  constructor(onSend: (data: string | Uint8Array) => void) {
    this.onSend = onSend;
  }

  send(data: string | Uint8Array): void {
    if (typeof data !== "string") {
      this.binarySends.push(data);
    }
    this.onSend(data);
  }

  close(_code: number, _reason: string): void {
    this.closeCalls += 1;
  }

  deliverControl(type: "host_detached" | "host_attached"): void {
    this.onmessage?.({ type: "text", data: JSON.stringify({ type }) });
  }
}

class FakeRelay {
  private readonly hostKeys: NoiseKeyPair = generateStaticKeyPair();
  readonly sockets: FakeSocket[] = [];
  /**
   * While true the relay has no host leg: it sends `host_detached` right after
   * `attach_ack` and answers every client data frame with another one.
   */
  hostless = true;
  /** Run a real responder handshake and deliver msg1 (reaches `opening`). */
  answerHandshake = false;

  get hostStaticPublicKey(): Uint8Array {
    return this.hostKeys.publicKey;
  }

  readonly factory: IStreamWebSocketFactory = {
    create: (): StreamWebSocketLike => {
      const socket: FakeSocket = new FakeSocket((data) =>
        this.onClientSend(socket, data),
      );
      this.sockets.push(socket);
      const sid = this.sockets.length;
      queueMicrotask(() => {
        socket.onopen?.({ type: "open" });
        socket.onmessage?.({
          type: "text",
          data: JSON.stringify({ type: "attach_ack", role: "client", sid }),
        });
        if (this.hostless) {
          socket.deliverControl("host_detached");
        }
      });
      return socket;
    },
  };

  private onClientSend(socket: FakeSocket, data: string | Uint8Array): void {
    if (typeof data === "string") {
      if (data === "relay-ping") {
        queueMicrotask(() => {
          socket.onmessage?.({ type: "text", data: "relay-pong" });
        });
      }
      return;
    }
    if (this.hostless) {
      queueMicrotask(() => {
        socket.deliverControl("host_detached");
      });
      return;
    }
    if (this.answerHandshake && socket.binarySends.length === 1) {
      void this.answerNoiseInitiator(socket, data);
    }
  }

  private async answerNoiseInitiator(
    socket: FakeSocket,
    msg0: Uint8Array,
  ): Promise<void> {
    const handshake = await createResponderHandshake(
      this.hostKeys,
      NOISE_PROLOGUE,
    );
    await handshake.readMessage(msg0);
    const msg1 = await handshake.writeMessage(new Uint8Array(0));
    socket.onmessage?.({ type: "binary", data: msg1 });
  }
}

function hostAuth(): RemoteSessionAuth {
  return {
    missingOpenAuthCause: "missing-host-credential",
    readOpenAuth: () => ({
      bearer: "park-bearer",
      authz: null,
      fingerprint: "park-bearer",
    }),
    readCredentialUpdateBearer: () => "park-bearer",
    currentFingerprint: () => "park-bearer",
    revalidateForReconnect: null,
  };
}

interface EvidenceSpies {
  readonly evidence: RemoteSessionEvidence;
  readonly reportDialRefusal: Mock<RemoteSessionEvidence["reportDialRefusal"]>;
  readonly reportDialIndeterminate: Mock<
    RemoteSessionEvidence["reportDialIndeterminate"]
  >;
  readonly reportDialSuccess: Mock<RemoteSessionEvidence["reportDialSuccess"]>;
}

function buildEvidence(): EvidenceSpies {
  const reportDialSuccess = vi.fn<RemoteSessionEvidence["reportDialSuccess"]>();
  const reportDialRefusal = vi.fn<RemoteSessionEvidence["reportDialRefusal"]>();
  const reportDialIndeterminate =
    vi.fn<RemoteSessionEvidence["reportDialIndeterminate"]>();
  return {
    evidence: {
      sessionEstablished: vi.fn<RemoteSessionEvidence["sessionEstablished"]>(),
      sessionLost: vi.fn<RemoteSessionEvidence["sessionLost"]>(),
      reportDialSuccess,
      reportDialRefusal,
      reportDialIndeterminate,
      reportRestartIntent:
        vi.fn<RemoteSessionEvidence["reportRestartIntent"]>(),
    },
    reportDialRefusal,
    reportDialIndeterminate,
    reportDialSuccess,
  };
}

function buildSession(
  relay: FakeRelay,
  evidence: RemoteSessionEvidence,
): RemoteSession<VersionedRpcRegistry, VersionedStreamRpcRegistry> {
  let nextRequestId = 0;
  return new RemoteSession({
    hostId: HOST_ID,
    attachBaseUrl: ATTACH_URL,
    hostStaticPublicKey: relay.hostStaticPublicKey,
    grantProvider: () =>
      Promise.resolve({
        kind: "ok" as const,
        grant: { grant: "grant-jws", expiresInSeconds: 300 },
      }),
    auth: hostAuth(),
    clock: null,
    rpcRegistry: emptyRpcRegistry,
    streamRegistry: emptyStreamRegistry,
    webSocketFactory: relay.factory,
    requestId: () => `park-req-${(nextRequestId += 1)}`,
    evidence,
    onNegotiatedMethods: null,
    servedStreamMajors: {},
    unaryResponseMs: 30_000,
    clientIdentity: {
      kind: "desktop",
      compatibilityEpoch: CURRENT_CLIENT_COMPATIBILITY_EPOCH,
      appVersion: "0.0.0-test",
    },
    livenessProbe: null,
  });
}

/** Past both phase deadlines and the first reconnect backoff rungs. */
const WELL_PAST_PHASE_TIMEOUTS_MS =
  Math.max(NOISE_HANDSHAKE_TIMEOUT_MS, SESSION_OPEN_ACK_TIMEOUT_MS) * 4;

/** Everything the suite asserts "never happened" for a parked session. */
function expectNoTimeoutDrivenRedial(
  relay: FakeRelay,
  spies: EvidenceSpies,
): void {
  expect(relay.sockets).toHaveLength(1);
  expect(relay.sockets[0]?.closeCalls).toBe(0);
  expect(spies.reportDialIndeterminate).not.toHaveBeenCalled();
  expect(spies.reportDialSuccess).not.toHaveBeenCalled();
  for (const call of spies.reportDialRefusal.mock.calls) {
    expect(call[1]).not.toMatch(/-lost$/);
  }
}

describe("RemoteSession parks on host_detached before the ready boundary", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("clears the handshake timer, reports ONE no-host refusal, and never redials while the host stays away", async () => {
    const relay = new FakeRelay();
    const spies = buildEvidence();
    const session = buildSession(relay, spies.evidence);
    try {
      session.start();
      // attach_ack, the relay's immediate host_detached, then the session's
      // Noise initiator - which the hostless relay answers with a SECOND
      // host_detached. Both must have been delivered before we assert.
      await vi.waitFor(() => {
        expect(relay.sockets).toHaveLength(1);
        expect(relay.sockets[0]?.binarySends).toHaveLength(1);
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(spies.reportDialRefusal).toHaveBeenCalledTimes(1);
      expect(spies.reportDialRefusal).toHaveBeenCalledWith(
        HOST_ID,
        expect.stringMatching(NO_HOST_ATTEMPT_ID),
        "remote-relay",
        null,
      );

      // Far past the 15 s handshake deadline and several backoff rungs: the
      // cleared timer must not fire, so nothing is redialled, nothing closes
      // and no second outcome of any kind is reported.
      await vi.advanceTimersByTimeAsync(WELL_PAST_PHASE_TIMEOUTS_MS);

      expectNoTimeoutDrivenRedial(relay, spies);
      expect(spies.reportDialRefusal).toHaveBeenCalledTimes(1);
      expect(session.isClosed()).toBe(false);
      expect(session.isReady()).toBe(false);
    } finally {
      session.close();
    }
  });

  it("treats a second host_detached while already parked as a no-op", async () => {
    const relay = new FakeRelay();
    const spies = buildEvidence();
    const session = buildSession(relay, spies.evidence);
    try {
      session.start();
      await vi.waitFor(() => {
        expect(relay.sockets[0]?.binarySends).toHaveLength(1);
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(spies.reportDialRefusal).toHaveBeenCalledTimes(1);

      // The relay repeats itself for every further client frame; deliver two
      // more by hand, with time passing between them.
      relay.sockets[0]?.deliverControl("host_detached");
      await vi.advanceTimersByTimeAsync(1_000);
      relay.sockets[0]?.deliverControl("host_detached");
      await vi.advanceTimersByTimeAsync(WELL_PAST_PHASE_TIMEOUTS_MS);

      expect(spies.reportDialRefusal).toHaveBeenCalledTimes(1);
      expectNoTimeoutDrivenRedial(relay, spies);
      expect(session.isClosed()).toBe(false);
    } finally {
      session.close();
    }
  });

  it("clears the open-ack timer on host_detached during opening, with the same single refusal and no redial", async () => {
    const relay = new FakeRelay();
    relay.hostless = false;
    relay.answerHandshake = true;
    const spies = buildEvidence();
    const session = buildSession(relay, spies.evidence);
    try {
      session.start();
      // msg0, then (after the real responder replied) the session's `open`
      // frame: two binary sends means the session is in `opening`, waiting on
      // an `openAck` this relay will never relay.
      await vi.waitFor(() => {
        expect(relay.sockets[0]?.binarySends).toHaveLength(2);
      });
      expect(spies.reportDialRefusal).not.toHaveBeenCalled();

      relay.sockets[0]?.deliverControl("host_detached");
      expect(spies.reportDialRefusal).toHaveBeenCalledTimes(1);
      expect(spies.reportDialRefusal).toHaveBeenCalledWith(
        HOST_ID,
        expect.stringMatching(NO_HOST_ATTEMPT_ID),
        "remote-relay",
        null,
      );

      // A repeat while parked, then well past the 15 s open-ack deadline.
      relay.sockets[0]?.deliverControl("host_detached");
      await vi.advanceTimersByTimeAsync(WELL_PAST_PHASE_TIMEOUTS_MS);

      expect(spies.reportDialRefusal).toHaveBeenCalledTimes(1);
      expectNoTimeoutDrivenRedial(relay, spies);
      expect(session.isClosed()).toBe(false);
    } finally {
      session.close();
    }
  });

  it("rebuilds through a fresh attach when host_attached follows the park", async () => {
    const relay = new FakeRelay();
    const spies = buildEvidence();
    const session = buildSession(relay, spies.evidence);
    try {
      session.start();
      await vi.waitFor(() => {
        expect(relay.sockets[0]?.binarySends).toHaveLength(1);
      });
      await vi.advanceTimersByTimeAsync(WELL_PAST_PHASE_TIMEOUTS_MS);
      expectNoTimeoutDrivenRedial(relay, spies);
      expect(spies.reportDialRefusal).toHaveBeenCalledTimes(1);

      // The host is back: the relay's one `host_attached` site fires, and the
      // session abandons the parked socket for a fresh attach.
      relay.hostless = false;
      relay.sockets[0]?.deliverControl("host_attached");

      // The redial waits out its first backoff rung (1 s, jittered).
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => {
        expect(relay.sockets).toHaveLength(2);
      });
      expect(relay.sockets[0]?.closeCalls).toBe(1);
      // The rebuild is the client's own decision, not a host verdict: no
      // second refusal was banked against the host for it.
      expect(spies.reportDialRefusal).toHaveBeenCalledTimes(1);
      expect(session.isClosed()).toBe(false);
    } finally {
      session.close();
    }
  });
});
