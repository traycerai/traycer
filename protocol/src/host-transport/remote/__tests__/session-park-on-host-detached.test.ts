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
  HOST_STANDING_BOUND_MS,
  NOISE_HANDSHAKE_TIMEOUT_MS,
  SESSION_OPEN_ACK_TIMEOUT_MS,
} from "../config";
import { RetryableTransportError } from "../rpc-types";
import type { AttachGrantProvider } from "../grant";
import { RemoteSession, type RemoteSessionEvidence } from "../session";

/**
 * `RemoteSession.onHostDetached` (`../session.ts`) PARKS a connection that
 * hears `host_detached` before its ready boundary, instead of leaving the
 * phase timer (`handshake-timeout` / `open-ack-timeout`) to fail it and redial.
 *
 * The relay sends `host_detached` right after `attach_ack` when no host leg is
 * attached, and again in reply to every data frame while that holds. Before
 * the change, the 15 s phase timer fired, reported a refusal and redialled -
 * 15 s timeout, 1-30 s backoff, repeat - for a host that was simply off. Now
 * the phase timer is cleared and the socket stays open with its scheduler
 * paused. The authority still hears of the absence at the old pace: one
 * refusal at once and another every `NOISE_HANDSHAKE_TIMEOUT_MS`
 * (`<scope>#<generation>-no-host-<n>`), with no attach behind any of them. The
 * park ends only through `host_attached` (a rebuild), a caller's
 * `forceReconnect`, or the socket dropping.
 *
 * The fake relay below is deliberately minimal: it speaks the real relay
 * control frames (`attach_ack`, `host_detached`, `host_attached`, the
 * keepalive pong) and, for the hosted cases only, runs a real responder-side
 * Noise-NK handshake so the session genuinely reaches `opening`. It never
 * answers the session `open`, which is exactly the state in which the
 * `open-ack-timeout` used to fire.
 */

const HOST_ID = "host-park";
const ATTACH_URL = "wss://relay.test/attach";
const REFUSAL_ID = /^(remote-\d+)#(\d+)-no-host-(\d+)$/;
const MINUTE_MS = 60_000;
/** Past the open-ack deadline several times over. */
const WELL_PAST_OPEN_ACK_TIMEOUT_MS = SESSION_OPEN_ACK_TIMEOUT_MS * 4;

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
  /** Text frames the session sent, keepalive pings excluded (`reauth`). */
  readonly textSends: string[] = [];
  closeCalls = 0;

  private readonly onSend: (data: string | Uint8Array) => void;

  constructor(onSend: (data: string | Uint8Array) => void) {
    this.onSend = onSend;
  }

  send(data: string | Uint8Array): void {
    if (typeof data === "string") {
      if (data !== "relay-ping") {
        this.textSends.push(data);
      }
    } else {
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
  /** Compute msg1 but hold it in `pendingMsg1` for the test to deliver. */
  holdResponderFrame = false;
  pendingMsg1: {
    readonly socket: FakeSocket;
    readonly bytes: Uint8Array;
  } | null = null;

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

  /** Delivers the held responder frame and, in the SAME tick, a detach. */
  releaseResponderFrameThenDetach(): void {
    const held = this.pendingMsg1;
    if (held === null) {
      throw new Error("no responder frame is being held");
    }
    this.pendingMsg1 = null;
    held.socket.onmessage?.({ type: "binary", data: held.bytes });
    held.socket.deliverControl("host_detached");
  }

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
    if (this.holdResponderFrame) {
      this.pendingMsg1 = { socket, bytes: msg1 };
      return;
    }
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
  /** Fake-clock time of each refusal, index-aligned with its mock calls. */
  readonly refusalTimes: number[];
  readonly reportDialIndeterminate: Mock<
    RemoteSessionEvidence["reportDialIndeterminate"]
  >;
  readonly reportDialSuccess: Mock<RemoteSessionEvidence["reportDialSuccess"]>;
}

function buildEvidence(): EvidenceSpies {
  const reportDialSuccess = vi.fn<RemoteSessionEvidence["reportDialSuccess"]>();
  const refusalTimes: number[] = [];
  const reportDialRefusal = vi.fn<RemoteSessionEvidence["reportDialRefusal"]>(
    () => {
      refusalTimes.push(Date.now());
    },
  );
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
    refusalTimes,
    reportDialIndeterminate,
    reportDialSuccess,
  };
}

function okGrantProvider(): Mock<AttachGrantProvider> {
  return vi.fn<AttachGrantProvider>(() =>
    Promise.resolve({
      kind: "ok" as const,
      grant: { grant: "grant-jws", expiresInSeconds: 300 },
    }),
  );
}

function buildSession(
  relay: FakeRelay,
  evidence: RemoteSessionEvidence,
  grantProvider: AttachGrantProvider,
): RemoteSession<VersionedRpcRegistry, VersionedStreamRpcRegistry> {
  let nextRequestId = 0;
  return new RemoteSession({
    hostId: HOST_ID,
    attachBaseUrl: ATTACH_URL,
    hostStaticPublicKey: relay.hostStaticPublicKey,
    grantProvider,
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

/** One parsed `<scope>#<generation>-no-host-<n>` refusal attempt id. */
interface NoHostRefusal {
  readonly scope: string;
  readonly generation: number;
  readonly n: number;
}

/** Every refusal reported so far; fails on any id that is not a no-host id. */
function noHostRefusals(spies: EvidenceSpies): NoHostRefusal[] {
  return spies.reportDialRefusal.mock.calls.map(
    ([hostId, attemptId, transportKind, detail]) => {
      expect(hostId).toBe(HOST_ID);
      expect(transportKind).toBe("remote-relay");
      expect(detail).toBeNull();
      const match = REFUSAL_ID.exec(attemptId);
      if (match === null) {
        throw new Error(`unexpected refusal attempt id ${attemptId}`);
      }
      return {
        scope: match[1] ?? "",
        generation: Number(match[2]),
        n: Number(match[3]),
      };
    },
  );
}

/** The numbers reported for one generation, in arrival order. */
function refusalNumbers(
  spies: EvidenceSpies,
  generation: number,
): readonly number[] {
  return noHostRefusals(spies)
    .filter((refusal) => refusal.generation === generation)
    .map((refusal) => refusal.n);
}

/** Start a hostless session and wait until it is parked after its initiator. */
async function startParked(
  relay: FakeRelay,
  session: RemoteSession<VersionedRpcRegistry, VersionedStreamRpcRegistry>,
): Promise<void> {
  session.start();
  // attach_ack, the relay's immediate host_detached, then the session's Noise
  // initiator - which the hostless relay answers with a SECOND host_detached.
  await vi.waitFor(() => {
    expect(relay.sockets[0]?.binarySends).toHaveLength(1);
  });
  await vi.advanceTimersByTimeAsync(0);
}

/** Moves the fake clock to `ms` after the first refusal (the park's start). */
async function advanceToSinceFirstRefusal(
  spies: EvidenceSpies,
  ms: number,
): Promise<void> {
  const parkedAt = spies.refusalTimes[0];
  if (parkedAt === undefined) {
    throw new Error("the session has not reported a refusal yet");
  }
  await vi.advanceTimersByTimeAsync(parkedAt + ms - Date.now());
}

/** A parked session never opened, closed or lost a socket. */
function expectStillOneParkedSocket(
  relay: FakeRelay,
  spies: EvidenceSpies,
): void {
  expect(relay.sockets).toHaveLength(1);
  expect(relay.sockets[0]?.closeCalls).toBe(0);
  expect(spies.reportDialIndeterminate).not.toHaveBeenCalled();
  expect(spies.reportDialSuccess).not.toHaveBeenCalled();
}

interface CallOutcome {
  settled: boolean;
  error: unknown;
}

/** Tracks a call's settlement as it happens; read it after the clock moved. */
function trackOutcome(call: Promise<unknown>): CallOutcome {
  const outcome: CallOutcome = { settled: false, error: null };
  void call.then(
    () => {
      outcome.settled = true;
    },
    (error: unknown) => {
      outcome.settled = true;
      outcome.error = error;
    },
  );
  return outcome;
}

function hostStatusCall(
  session: RemoteSession<VersionedRpcRegistry, VersionedStreamRpcRegistry>,
): Promise<unknown> {
  return session.sendUnary(
    "host.status",
    {},
    null,
    null,
    null,
    undefined,
    false,
    null,
  );
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

  it("clears the handshake timer and re-reports a numbered refusal every 15 s while parked, with no socket opened or closed", async () => {
    const relay = new FakeRelay();
    const spies = buildEvidence();
    const session = buildSession(relay, spies.evidence, okGrantProvider());
    try {
      await startParked(relay, session);

      // At once: refusal 1, and the relay's second host_detached (the reply
      // to the Noise initiator) added nothing.
      expect(refusalNumbers(spies, 1)).toEqual([1]);
      const [first] = noHostRefusals(spies);
      expect(spies.reportDialRefusal).toHaveBeenCalledWith(
        HOST_ID,
        `${first?.scope}#1-no-host-1`,
        "remote-relay",
        null,
      );

      // Every report after the first arrives exactly one handshake timeout
      // after the one before it - the pace the phase timer gave the authority.
      await vi.advanceTimersByTimeAsync(NOISE_HANDSHAKE_TIMEOUT_MS * 2);
      expect(refusalNumbers(spies, 1)).toEqual([1, 2, 3]);
      expect(spies.refusalTimes[1]).toBe(
        (spies.refusalTimes[0] ?? 0) + NOISE_HANDSHAKE_TIMEOUT_MS,
      );
      expect(spies.refusalTimes[2]).toBe(
        (spies.refusalTimes[1] ?? 0) + NOISE_HANDSHAKE_TIMEOUT_MS,
      );

      // Far past the old redial loop's reach: still the one parked socket,
      // and only the cadence has spoken.
      await vi.advanceTimersByTimeAsync(NOISE_HANDSHAKE_TIMEOUT_MS * 4);
      expect(refusalNumbers(spies, 1)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expectStillOneParkedSocket(relay, spies);
      expect(session.isClosed()).toBe(false);
      expect(session.isReady()).toBe(false);
    } finally {
      session.close();
    }
  });

  it("does not reset or double the cadence when host_detached repeats while parked", async () => {
    const relay = new FakeRelay();
    const spies = buildEvidence();
    const session = buildSession(relay, spies.evidence, okGrantProvider());
    try {
      await startParked(relay, session);
      expect(refusalNumbers(spies, 1)).toEqual([1]);

      // Repeats straddling the first timer boundary, and one just before it.
      relay.sockets[0]?.deliverControl("host_detached");
      await advanceToSinceFirstRefusal(spies, 14_000);
      relay.sockets[0]?.deliverControl("host_detached");
      await advanceToSinceFirstRefusal(spies, 15_500);
      relay.sockets[0]?.deliverControl("host_detached");
      await advanceToSinceFirstRefusal(spies, 29_000);
      relay.sockets[0]?.deliverControl("host_detached");
      await advanceToSinceFirstRefusal(spies, 31_000);

      // t = 31 s: exactly the 0 / 15 / 30 s reports, whatever arrived.
      expect(refusalNumbers(spies, 1)).toEqual([1, 2, 3]);
      expectStillOneParkedSocket(relay, spies);
    } finally {
      session.close();
    }
  });

  it("keeps the same cadence, and never opens, when host_detached lands during opening", async () => {
    const relay = new FakeRelay();
    relay.hostless = false;
    relay.answerHandshake = true;
    const spies = buildEvidence();
    const session = buildSession(relay, spies.evidence, okGrantProvider());
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
      expect(refusalNumbers(spies, 1)).toEqual([1]);

      // A repeat while parked, then past the 15 s open-ack deadline: the
      // cadence continues, nothing redials.
      relay.sockets[0]?.deliverControl("host_detached");
      await advanceToSinceFirstRefusal(spies, 31_000);
      expect(refusalNumbers(spies, 1)).toEqual([1, 2, 3]);
      expect(relay.sockets).toHaveLength(1);
      expect(relay.sockets[0]?.closeCalls).toBe(0);
      expect(spies.reportDialIndeterminate).not.toHaveBeenCalled();
      expect(session.isClosed()).toBe(false);

      // The responder frame armed the 15-minute host-standing watchdog. A park
      // entered during `opening` must clear it: the relay has declared the
      // host absent and the cadence above is that absence's evidence, so a
      // lapse here would be a redial for a host already known to be away.
      await advanceToSinceFirstRefusal(spies, HOST_STANDING_BOUND_MS + MINUTE_MS);
      expect(relay.sockets).toHaveLength(1);
      expect(relay.sockets[0]?.closeCalls).toBe(0);
      expect(spies.reportDialIndeterminate).not.toHaveBeenCalled();
      expect(session.isClosed()).toBe(false);
    } finally {
      session.close();
    }
  });

  it("ends the cadence at host_attached, rebuilds through a fresh attach, and restarts at -no-host-1 if the new generation parks", async () => {
    const relay = new FakeRelay();
    const spies = buildEvidence();
    const session = buildSession(relay, spies.evidence, okGrantProvider());
    try {
      await startParked(relay, session);
      await advanceToSinceFirstRefusal(spies, 31_000);
      expect(refusalNumbers(spies, 1)).toEqual([1, 2, 3]);
      expectStillOneParkedSocket(relay, spies);

      // The host announces itself (the relay's one `host_attached` site) but
      // is still hostless for the NEXT attach, which therefore parks again.
      relay.sockets[0]?.deliverControl("host_attached");
      // The redial waits out its first backoff rung (1 s, jittered), and its
      // dial passes through real async work (key import).
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => {
        expect(relay.sockets).toHaveLength(2);
      });
      expect(relay.sockets[0]?.closeCalls).toBe(1);

      await vi.advanceTimersByTimeAsync(NOISE_HANDSHAKE_TIMEOUT_MS * 2 + 1_000);
      // The old generation's cadence is over: still exactly 1, 2, 3.
      expect(refusalNumbers(spies, 1)).toEqual([1, 2, 3]);
      // The new generation numbers its own park from 1, on its own cadence.
      const second = refusalNumbers(spies, 2);
      expect(second.slice(0, 3)).toEqual([1, 2, 3]);
      expect(relay.sockets).toHaveLength(2);
      expect(session.isClosed()).toBe(false);
    } finally {
      session.close();
    }
  });

  it("fails a call parked in awaitReadyBoundary retryably the moment the pre-ready host_detached lands", async () => {
    const relay = new FakeRelay();
    const spies = buildEvidence();
    const session = buildSession(relay, spies.evidence, okGrantProvider());
    try {
      // `sendUnary` starts the session and parks, before any attach landed.
      const outcome = trackOutcome(hostStatusCall(session));
      expect(outcome.settled).toBe(false);
      await vi.waitFor(() => {
        expect(relay.sockets[0]?.binarySends).toHaveLength(1);
      });
      await vi.advanceTimersByTimeAsync(0);

      // Promptly - not at a 30 s unary timeout, and not never.
      expect(outcome.settled).toBe(true);
      expect(outcome.error).toBeInstanceOf(RetryableTransportError);

      await vi.advanceTimersByTimeAsync(MINUTE_MS);
      expectStillOneParkedSocket(relay, spies);
    } finally {
      session.close();
    }
  });

  it("rejects a NEW call issued while already parked, immediately, without waiting or redialling", async () => {
    const relay = new FakeRelay();
    const spies = buildEvidence();
    const session = buildSession(relay, spies.evidence, okGrantProvider());
    try {
      await startParked(relay, session);
      expect(refusalNumbers(spies, 1)).toEqual([1]);

      const outcome = trackOutcome(hostStatusCall(session));
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome.settled).toBe(true);
      expect(outcome.error).toBeInstanceOf(RetryableTransportError);

      await vi.advanceTimersByTimeAsync(MINUTE_MS);
      expectStillOneParkedSocket(relay, spies);
    } finally {
      session.close();
    }
  });

  it("keeps the relay leg alive while parked: the re-auth loop mints a grant and sends reauth on the SAME socket", async () => {
    const relay = new FakeRelay();
    const spies = buildEvidence();
    const grantProvider = okGrantProvider();
    const session = buildSession(relay, spies.evidence, grantProvider);
    try {
      await startParked(relay, session);
      const mintsAtPark = grantProvider.mock.calls.length;
      expect(relay.sockets[0]?.textSends).toEqual([]);

      // The cadence is CLIENT_REAUTH_INTERVAL_MS plus up to 5 minutes of
      // jitter, so 51 minutes always covers the first fire.
      await vi.advanceTimersByTimeAsync(51 * MINUTE_MS);

      expect(grantProvider.mock.calls.length).toBeGreaterThan(mintsAtPark);
      const reauthFrames = (relay.sockets[0]?.textSends ?? []).map(
        (text): unknown => JSON.parse(text),
      );
      expect(reauthFrames).toContainEqual({
        type: "reauth",
        grant: "grant-jws",
      });
      expect(relay.sockets).toHaveLength(1);
      expect(relay.sockets[0]?.closeCalls).toBe(0);
      expect(spies.reportDialIndeterminate).not.toHaveBeenCalled();
    } finally {
      session.close();
    }
  });

  it("redials at once on forceReconnect while parked, and the new attach parks again from -no-host-1", async () => {
    const relay = new FakeRelay();
    const spies = buildEvidence();
    const session = buildSession(relay, spies.evidence, okGrantProvider());
    try {
      await startParked(relay, session);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(refusalNumbers(spies, 1)).toEqual([1]);

      session.forceReconnect("retry");
      expect(relay.sockets[0]?.closeCalls).toBe(1);

      // No backoff and no host_attached: the force pulls the redial to now.
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => {
        expect(relay.sockets).toHaveLength(2);
      });
      await vi.waitFor(() => {
        expect(relay.sockets[1]?.binarySends).toHaveLength(1);
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(refusalNumbers(spies, 2)).toEqual([1]);
      expect(spies.reportDialRefusal).toHaveBeenLastCalledWith(
        HOST_ID,
        expect.stringMatching(/^remote-\d+#2-no-host-1$/),
        "remote-relay",
        null,
      );
      // The old generation's cadence stopped with its socket.
      await vi.advanceTimersByTimeAsync(NOISE_HANDSHAKE_TIMEOUT_MS + 1_000);
      expect(refusalNumbers(spies, 1)).toEqual([1]);
      expect(relay.sockets).toHaveLength(2);
    } finally {
      session.close();
    }
  });

  it("does not send `open` when host_detached lands before the responder-frame read completes", async () => {
    const relay = new FakeRelay();
    relay.hostless = false;
    relay.answerHandshake = true;
    relay.holdResponderFrame = true;
    const spies = buildEvidence();
    const session = buildSession(relay, spies.evidence, okGrantProvider());
    try {
      session.start();
      await vi.waitFor(() => {
        expect(relay.pendingMsg1).not.toBeNull();
      });

      // The responder frame starts its async read; the detach arrives in the
      // same tick, before that read can complete.
      relay.releaseResponderFrameThenDetach();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(WELL_PAST_OPEN_ACK_TIMEOUT_MS);

      // Only the Noise initiator was ever sent: no `open`, so no open-ack
      // timer, no timeout-driven redial.
      expect(relay.sockets[0]?.binarySends).toHaveLength(1);
      expect(relay.sockets).toHaveLength(1);
      expect(relay.sockets[0]?.closeCalls).toBe(0);
      expect(spies.reportDialIndeterminate).not.toHaveBeenCalled();
      // Parked, so the cadence (and only it) has been speaking.
      expect(refusalNumbers(spies, 1).slice(0, 2)).toEqual([1, 2]);
    } finally {
      session.close();
    }
  });
});
