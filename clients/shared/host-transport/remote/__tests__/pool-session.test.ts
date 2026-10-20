import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HOST_RESTARTING_FATAL_CODE,
  type FatalErrorDetails,
} from "@traycer/protocol/framework/index";
import {
  SERVES_EVERY_INSTALLED_MAJOR,
  splitConnectionManifest,
} from "@traycer/protocol/framework/capability-manifest";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import {
  createResponderHandshake,
  generateStaticKeyPair,
  DEFAULT_REPLAY_WINDOW_SIZE,
  NoiseSession,
  type NoiseKeyPair,
} from "@traycer/protocol/crypto/noise";
import {
  MuxFrameType,
  NOISE_PROLOGUE,
  QosClass,
  SESSION_CAPABILITY_MEMBER_CREDENTIAL,
  SESSION_CONTROL_STREAM_ID,
  decodeMuxFrame,
  encodeMuxFrame,
  type MemberCredentialHandoff,
} from "@traycer/protocol/host-transport/mux";
import {
  ChunkReassembler,
  OutboundChunkSource,
  nextSeqValue,
  type OutboundMessage,
  type ReassembledMessage,
} from "@traycer/protocol/host-transport/chunking";
import {
  HOST_STANDING_BOUND_MS,
  CLIENT_REAUTH_INTERVAL_MS,
  CLIENT_REAUTH_JITTER_MS,
} from "@traycer/protocol/host-transport/remote/config";
import type { RemoteSessionEvidence } from "@traycer/protocol/host-transport/remote/session";
import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { RESTART_INTENT_EPISODE_MS } from "@traycer-clients/shared/host-selection/selection-authority-engine";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import { HostRpcError } from "../../host-messenger";
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
import { RemoteSession } from "../remote-session";
import { PoolSessionPresence } from "../pool-session-presence";

// The pool is a peer on the SAME wire as a host: these drive the real client
// `RemoteSession` against a scripted peer that speaks the real mux. The peer
// runs in two modes so the pool's wire can be held against a relay host's
// (Noise-sealed behind an attach_ack) rather than against a constant.

const EMPTY_AD = new Uint8Array(0);
const WAIT = { timeout: 10_000, interval: 50 } as const;
const POOL_URL = "wss://pool.test/v1/session";

const FLOOR_RPC_MANIFEST = splitConnectionManifest(
  hostRpcRegistry,
  RELEASED_FLOOR_METHOD_NAMES,
  SERVES_EVERY_INSTALLED_MAJOR,
).manifest;

const MEMBER_HANDOFF: MemberCredentialHandoff = {
  token: "member-token",
  refreshToken: "member-refresh-token",
  familyId: "family-1",
  provisionedAt: "2026-10-19T00:00:00.000Z",
};

type PeerMode = "relay" | "pool";
type DialStep = "accept" | "refuse" | { readonly slowMs: number };

class PeerSocket implements StreamWebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: StreamWebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;

  private readonly onSend: (data: string | Uint8Array) => void;
  private readonly onLocalClose: () => void;

  constructor(
    onSend: (data: string | Uint8Array) => void,
    onLocalClose: () => void,
  ) {
    this.onSend = onSend;
    this.onLocalClose = onLocalClose;
  }

  send(data: string | Uint8Array): void {
    this.onSend(data);
  }

  close(_code: number, _reason: string): void {
    this.onLocalClose();
  }
}

interface PeerConnection {
  readonly socket: PeerSocket;
  noise: NoiseSession | null;
  readonly reassembler: ChunkReassembler;
  readonly seqByStream: Map<number, number>;
  readonly inboundSeqByStream: Map<number, number>;
  queue: Promise<void>;
  closed: boolean;
}

/**
 * The far end of the wire. `pool` is a plain mux behind a direct socket (the
 * socket opening is the attach); `relay` is the host behind the relay, with a
 * real responder-side Noise-NK handshake after an `attach_ack`.
 */
class WirePeer {
  readonly mode: PeerMode;
  readonly dialedUrls: string[] = [];
  /** Every `open` payload the client sent, decoded, in arrival order. */
  readonly opens: Record<string, unknown>[] = [];
  /**
   * The plaintext mux bytes (after Noise on the relay fake) of every client
   * frame on the session control stream up to the first `openAck`: the OPEN,
   * with its qos, streamId, seq and flags.
   */
  readonly openPhaseFrames: string[] = [];
  private acked = false;
  /** Every text frame the client sent (keepalive pings, relay control). */
  readonly textFrames: string[] = [];
  readonly requests: { method: string; requestId: string }[] = [];
  /** The json of every CREDENTIAL_UPDATE frame the client sent. */
  readonly credentialUpdates: unknown[] = [];
  readonly errors: unknown[] = [];
  /** How the next dials go; an exhausted plan accepts. */
  dialPlan: DialStep[] = [];
  /** While set, every dial is refused (the socket closes without opening). */
  refuseAll = false;
  openAckCapabilities: string[] = [];
  unaryError: { readonly code: string; readonly message: string } | null = null;

  private readonly hostKeys: NoiseKeyPair = generateStaticKeyPair();
  private readonly connections: PeerConnection[] = [];

  constructor(mode: PeerMode) {
    this.mode = mode;
  }

  get hostStaticPublicKey(): Uint8Array {
    return this.hostKeys.publicKey;
  }

  get connectionCount(): number {
    return this.connections.length;
  }

  readonly factory: IStreamWebSocketFactory = {
    create: (url: string): StreamWebSocketLike => {
      this.dialedUrls.push(url);
      const connection: PeerConnection = {
        socket: new PeerSocket(
          (data) => this.enqueue(connection, data),
          () => {
            connection.closed = true;
          },
        ),
        noise: null,
        reassembler: new ChunkReassembler(undefined),
        seqByStream: new Map(),
        inboundSeqByStream: new Map(),
        queue: Promise.resolve(),
        closed: false,
      };
      this.connections.push(connection);
      const step: DialStep = this.refuseAll
        ? "refuse"
        : (this.dialPlan.shift() ?? "accept");
      const open = (): void => {
        if (connection.closed) {
          return;
        }
        connection.socket.onopen?.({ type: "open" });
        if (this.mode === "relay") {
          connection.socket.onmessage?.({
            type: "text",
            data: JSON.stringify({
              type: "attach_ack",
              role: "client",
              sid: this.connections.length,
            }),
          });
        }
      };
      if (step === "refuse") {
        queueMicrotask(() => {
          connection.closed = true;
          connection.socket.onclose?.({
            code: 1006,
            reason: "dial-refused",
            wasClean: false,
          });
        });
      } else if (step === "accept") {
        queueMicrotask(open);
      } else {
        setTimeout(open, step.slowMs);
      }
      return connection.socket;
    },
  };

  /** The pool's drain: a session FATAL carrying the tombstone, then the socket. */
  async drain(tombstoneId: string): Promise<void> {
    const connection = this.liveConnection();
    await this.sendDrainFatal(connection, tombstoneId);
    connection.closed = true;
    connection.socket.onclose?.({
      code: 1012,
      reason: "service-restart",
      wasClean: true,
    });
  }

  /** The socket dies with no word, as a network cut does. */
  dropLive(): void {
    const connection = this.liveConnection();
    connection.closed = true;
    connection.socket.onclose?.({
      code: 1006,
      reason: "server-drop",
      wasClean: false,
    });
  }

  private liveConnection(): PeerConnection {
    const connection = [...this.connections]
      .reverse()
      .find((entry) => !entry.closed);
    if (connection === undefined) {
      throw new Error("no live connection");
    }
    return connection;
  }

  private enqueue(connection: PeerConnection, data: string | Uint8Array): void {
    if (typeof data === "string") {
      this.textFrames.push(data);
      if (data === "relay-ping") {
        queueMicrotask(() => {
          if (!connection.closed) {
            connection.socket.onmessage?.({ type: "text", data: "relay-pong" });
          }
        });
      }
      return;
    }
    connection.queue = connection.queue
      .then(() => this.handleBinary(connection, data))
      .catch((error: unknown) => {
        this.errors.push(error);
      });
  }

  private async handleBinary(
    connection: PeerConnection,
    data: Uint8Array,
  ): Promise<void> {
    if (connection.closed) {
      return;
    }
    let muxBytes = data;
    if (this.mode === "relay") {
      if (connection.noise === null) {
        const handshake = await createResponderHandshake(
          this.hostKeys,
          NOISE_PROLOGUE,
        );
        await handshake.readMessage(data);
        const msg1 = await handshake.writeMessage(new Uint8Array(0));
        connection.noise = NoiseSession.fromHandshake(
          handshake,
          DEFAULT_REPLAY_WINDOW_SIZE,
        );
        connection.socket.onmessage?.({ type: "binary", data: msg1 });
        return;
      }
      muxBytes = await connection.noise.decrypt(data, EMPTY_AD);
    }
    const frame = decodeMuxFrame(muxBytes);
    if (!this.acked && frame.streamId === SESSION_CONTROL_STREAM_ID) {
      this.openPhaseFrames.push(Buffer.from(muxBytes).toString("hex"));
    }
    const expectedSeq = connection.inboundSeqByStream.get(frame.streamId);
    if (
      !frame.chunked &&
      expectedSeq !== undefined &&
      frame.seq !== expectedSeq
    ) {
      throw new Error(
        `frame ${frame.seq} arrived on stream ${frame.streamId} where ${expectedSeq} was due`,
      );
    }
    const message = connection.reassembler.accept(frame);
    connection.inboundSeqByStream.set(frame.streamId, nextSeqValue(frame.seq));
    if (message !== null) {
      await this.handleMessage(connection, message);
    }
  }

  private async handleMessage(
    connection: PeerConnection,
    message: ReassembledMessage,
  ): Promise<void> {
    if (message.type === MuxFrameType.CREDENTIAL_UPDATE) {
      this.credentialUpdates.push(message.json);
      return;
    }
    if (message.type === MuxFrameType.REQUEST) {
      const json = message.json ?? {};
      const method = typeof json.method === "string" ? json.method : "";
      const requestId =
        typeof json.requestId === "string" ? json.requestId : "";
      this.requests.push({ method, requestId });
      await this.sendMux(connection, {
        type: MuxFrameType.RESPONSE,
        streamId: message.streamId,
        qos: QosClass.INTERACTIVE,
        json: {
          requestId,
          method,
          result: this.unaryError === null ? {} : null,
          error: this.unaryError,
        },
        binary: null,
      });
      return;
    }
    if (
      message.type !== MuxFrameType.OPEN ||
      message.streamId !== SESSION_CONTROL_STREAM_ID
    ) {
      return;
    }
    this.opens.push(message.json ?? {});
    this.acked = true;
    await this.sendMux(connection, {
      type: MuxFrameType.OPEN_ACK,
      streamId: SESSION_CONTROL_STREAM_ID,
      qos: QosClass.INTERACTIVE,
      json: {
        manifest: {
          rpc: FLOOR_RPC_MANIFEST,
          optionalRpc: {},
          stream: buildStreamManifest(
            hostStreamRpcRegistry,
            SERVES_EVERY_INSTALLED_MAJOR,
          ),
        },
        capabilities: this.openAckCapabilities,
      },
      binary: null,
    });
  }

  private async sendDrainFatal(
    connection: PeerConnection,
    tombstoneId: string,
  ): Promise<void> {
    const details: FatalErrorDetails = {
      code: HOST_RESTARTING_FATAL_CODE,
      reason: "The service is restarting and expects to be back shortly",
      incompatibleMethods: null,
      upgradeGuidance: null,
      retryable: true,
      restartIntent: { tombstoneId, expiresAt: Date.now() + 30_000 },
    };
    await this.sendMux(connection, {
      type: MuxFrameType.FATAL,
      streamId: SESSION_CONTROL_STREAM_ID,
      qos: QosClass.INTERACTIVE,
      json: { details: { ...details } },
      binary: null,
    });
  }

  private async sendMux(
    connection: PeerConnection,
    message: OutboundMessage,
  ): Promise<void> {
    if (connection.closed) {
      return;
    }
    const source = new OutboundChunkSource(
      message,
      () => {
        const current = connection.seqByStream.get(message.streamId) ?? 0;
        connection.seqByStream.set(message.streamId, current + 1);
        return current;
      },
      false,
    );
    while (!source.done) {
      const plain = encodeMuxFrame(source.nextFrame());
      const noise = connection.noise;
      const sealed =
        this.mode === "relay" && noise !== null
          ? await noise.encrypt(plain, EMPTY_AD)
          : plain;
      connection.socket.onmessage?.({ type: "binary", data: sealed });
    }
  }
}

/** What the pool sink saw, in order, with the session ids left out. */
class RecordingPoolEvidence implements RemoteSessionEvidence<"pool-direct"> {
  readonly log: string[] = [];
  private readonly presence: PoolSessionPresence;

  constructor(presence: PoolSessionPresence) {
    this.presence = presence;
  }

  sessionEstablished(
    hostId: string,
    _sessionId: string,
    _transportKind: "pool-direct",
  ): void {
    this.log.push("established");
    this.presence.sessionEstablished(hostId);
  }

  sessionLost(
    _hostId: string,
    _sessionId: string,
    _transportKind: "pool-direct",
  ): void {
    this.log.push("lost");
    this.presence.sessionLost();
  }

  reportDialSuccess(
    hostId: string,
    _attemptId: string,
    _transportKind: "pool-direct",
  ): void {
    this.log.push("dialSuccess");
    this.presence.reportDialSuccess(hostId);
  }

  reportDialRefusal(
    _hostId: string,
    _attemptId: string,
    _transportKind: "pool-direct",
  ): void {
    this.log.push("dialRefusal");
    this.presence.reportDialRefusal();
  }

  reportDialIndeterminate(
    _hostId: string,
    _attemptId: string,
    _transportKind: "pool-direct",
  ): void {
    this.log.push("dialIndeterminate");
    this.presence.reportDialIndeterminate();
  }

  reportRestartIntent(
    hostId: string,
    tombstoneId: string,
    _expiresAt: number | null,
  ): void {
    this.log.push(`restartIntent:${tombstoneId}`);
    this.presence.reportRestartIntent(hostId, tombstoneId);
  }
}

type HostSession = RemoteSession<
  typeof hostRpcRegistry,
  typeof hostStreamRpcRegistry
>;

function buildPoolSession(
  peer: WirePeer,
  evidence: RemoteSessionEvidence<"pool-direct">,
): HostSession {
  let nextRequestId = 0;
  return new RemoteSession({
    hostId: "pool",
    poolUrl: POOL_URL,
    bearer: () => new MutableBearerLease("user-token", "user-1"),
    auth: null,
    cloudAuthorized: () => true,
    clock: null,
    rpcRegistry: hostRpcRegistry,
    streamRegistry: hostStreamRpcRegistry,
    webSocketFactory: peer.factory,
    requestId: () => `req-${(nextRequestId += 1)}`,
    evidence,
    clientIdentity: TEST_CLIENT_IDENTITY,
    livenessProbe: null,
  });
}

function buildRelaySession(
  peer: WirePeer,
  mint: ((hostId: string) => Promise<MemberCredentialHandoff | null>) | null,
): HostSession {
  let nextRequestId = 0;
  return new RemoteSession({
    hostId: "host-1",
    attachBaseUrl: "wss://relay.test/attach",
    hostStaticPublicKey: peer.hostStaticPublicKey,
    grantProvider: () =>
      Promise.resolve({
        kind: "ok" as const,
        grant: { grant: "grant-jws", expiresInSeconds: 300 },
      }),
    bearer: () => new MutableBearerLease("user-token", "user-1"),
    auth: null,
    sessionGrant: null,
    cloudAuthorized: () => true,
    clock: null,
    rpcRegistry: hostRpcRegistry,
    streamRegistry: hostStreamRpcRegistry,
    webSocketFactory: peer.factory,
    requestId: () => `req-${(nextRequestId += 1)}`,
    evidence: NO_TRANSPORT_EVIDENCE,
    clientIdentity: TEST_CLIENT_IDENTITY,
    livenessProbe: null,
    mintMemberCredential: mint,
  });
}

function sendHostStatus(session: HostSession): Promise<unknown> {
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

/** Steps fake time forward until `condition` holds, or fails after `maxMs`. */
async function advanceUntil(
  condition: () => boolean,
  maxMs: number,
): Promise<void> {
  const stepMs = 100;
  for (let elapsed = 0; elapsed <= maxMs; elapsed += stepMs) {
    if (condition()) {
      return;
    }
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  throw new Error(`condition not reached within ${maxMs}ms of fake time`);
}

async function settled<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  const tracked = promise.finally(() => {
    done = true;
  });
  tracked.catch(() => undefined);
  await advanceUntil(() => done, 5_000);
  return promise;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a pool session on the one remote session wire", () => {
  it("opens with exactly the bytes a relay session sends, and reaches ready on the floor-only ack", async () => {
    const relayPeer = new WirePeer("relay");
    const relay = buildRelaySession(relayPeer, null);
    const poolPeer = new WirePeer("pool");
    const pool = buildPoolSession(
      poolPeer,
      new RecordingPoolEvidence(new PoolSessionPresence(() => Date.now())),
    );
    try {
      relay.start();
      pool.start();
      await vi.waitFor(() => expect(relay.isReady()).toBe(true), WAIT);
      await vi.waitFor(() => expect(pool.isReady()).toBe(true), WAIT);

      expect(poolPeer.dialedUrls).toEqual([POOL_URL]);
      expect(poolPeer.opens).toHaveLength(1);
      expect(poolPeer.openPhaseFrames.length).toBeGreaterThan(0);
      expect(poolPeer.openPhaseFrames).toEqual(relayPeer.openPhaseFrames);
      expect(poolPeer.errors).toEqual([]);
    } finally {
      relay.close();
      pool.close();
    }
  });

  it("presents no authz and never requests or spends a member credential, even when the ack offers it", async () => {
    const poolPeer = new WirePeer("pool");
    poolPeer.openAckCapabilities = [SESSION_CAPABILITY_MEMBER_CREDENTIAL];
    const pool = buildPoolSession(
      poolPeer,
      new RecordingPoolEvidence(new PoolSessionPresence(() => Date.now())),
    );
    // The control: the same offer on a relay session with a minter wired
    // DOES hand a credential over, so its absence below is the pool's
    // doing and not the fake's.
    const relayPeer = new WirePeer("relay");
    relayPeer.openAckCapabilities = [SESSION_CAPABILITY_MEMBER_CREDENTIAL];
    const relay = buildRelaySession(relayPeer, () =>
      Promise.resolve(MEMBER_HANDOFF),
    );
    try {
      relay.start();
      pool.start();
      await vi.waitFor(() => expect(relay.isReady()).toBe(true), WAIT);
      await vi.waitFor(() => expect(pool.isReady()).toBe(true), WAIT);
      await vi.waitFor(
        () => expect(relayPeer.credentialUpdates).toHaveLength(1),
        WAIT,
      );

      expect(poolPeer.opens[0].authz).toBeNull();
      expect(poolPeer.opens[0].capabilities).not.toContain(
        SESSION_CAPABILITY_MEMBER_CREDENTIAL,
      );
      expect(poolPeer.credentialUpdates).toEqual([]);
    } finally {
      relay.close();
      pool.close();
    }
  });

  it("runs no reauth loop and no host-standing watchdog: an hour of quiet keeps the one connection ready", async () => {
    vi.useFakeTimers();
    const peer = new WirePeer("pool");
    const pool = buildPoolSession(
      peer,
      new RecordingPoolEvidence(new PoolSessionPresence(() => Date.now())),
    );
    try {
      pool.start();
      await advanceUntil(() => pool.isReady(), 5_000);

      const pastEveryRelayTimer =
        Math.max(
          HOST_STANDING_BOUND_MS,
          CLIENT_REAUTH_INTERVAL_MS + CLIENT_REAUTH_JITTER_MS,
        ) + 60_000;
      await vi.advanceTimersByTimeAsync(pastEveryRelayTimer);

      expect(pool.isReady()).toBe(true);
      expect(peer.connectionCount).toBe(1);
      // A relay reauth would be a control text frame; only keepalives go out.
      expect(peer.textFrames.length).toBeGreaterThan(0);
      expect(peer.textFrames.every((frame) => frame === "relay-ping")).toBe(
        true,
      );
    } finally {
      pool.close();
    }
  });

  it("does not resend a method the peer refused with E_HOST_UNSUPPORTED on the same connection, and sends it again after a redial", async () => {
    vi.useFakeTimers();
    const peer = new WirePeer("pool");
    peer.unaryError = {
      code: "E_HOST_UNSUPPORTED",
      message: "host.status is not served here",
    };
    const pool = buildPoolSession(
      peer,
      new RecordingPoolEvidence(new PoolSessionPresence(() => Date.now())),
    );
    try {
      pool.start();
      await advanceUntil(() => pool.isReady(), 5_000);

      const first = await settled(
        sendHostStatus(pool).catch((e: unknown) => e),
      );
      expect(first).toBeInstanceOf(HostRpcError);
      expect(peer.requests).toHaveLength(1);

      const second = await settled(
        sendHostStatus(pool).catch((e: unknown) => e),
      );
      expect(second).toBeInstanceOf(HostRpcError);
      if (
        !(first instanceof HostRpcError) ||
        !(second instanceof HostRpcError)
      ) {
        throw new Error("both calls must reject with the peer's refusal");
      }
      expect(second.code).toBe("E_HOST_UNSUPPORTED");
      expect(second.code).toBe(first.code);
      expect(second.message).toBe(first.message);
      expect(peer.requests).toHaveLength(1);

      peer.dropLive();
      peer.unaryError = null;
      await advanceUntil(() => !pool.isReady(), 1_000);
      await advanceUntil(() => pool.isReady(), 30_000);

      await settled(sendHostStatus(pool));
      expect(peer.requests).toHaveLength(2);
    } finally {
      pool.close();
    }
  });
});

describe("a pool replica draining under a session", () => {
  it("reports restart intent before loss on every drain, never a dial indeterminate, and holds the announced restart through a refused and a slow redial until it lapses", async () => {
    vi.useFakeTimers();
    const presence = new PoolSessionPresence(() => Date.now());
    const evidence = new RecordingPoolEvidence(presence);
    const peer = new WirePeer("pool");
    const pool = buildPoolSession(peer, evidence);
    let notifications = 0;
    presence.subscribe(() => {
      notifications += 1;
    });
    try {
      pool.start();
      await advanceUntil(() => pool.isReady(), 5_000);

      // Drain 1: the next redial is refused, the one after is slow. The hold
      // survives both and ends only when the session is established.
      const countOf = (call: string): number =>
        evidence.log.filter((entry) => entry === call).length;
      peer.dialPlan = ["refuse", { slowMs: 5_000 }];
      await peer.drain("t1");
      expect(presence.isRestartExpected("pool")).toBe(true);
      const refusalsAfterDrain = countOf("dialRefusal");
      await advanceUntil(
        () => countOf("dialRefusal") > refusalsAfterDrain,
        5_000,
      );
      expect(pool.isReady()).toBe(false);
      expect(presence.isRestartExpected("pool")).toBe(true);
      // The slow dial is in flight: dialed, not yet open.
      await advanceUntil(() => peer.connectionCount >= 3, 10_000);
      expect(countOf("established")).toBe(1);
      expect(pool.isReady()).toBe(false);
      expect(presence.isRestartExpected("pool")).toBe(true);
      await advanceUntil(() => pool.isReady(), 60_000);
      expect(countOf("established")).toBe(2);
      expect(presence.isRestartExpected("pool")).toBe(false);

      // Drain 2 straight after, with the pool then refusing every redial: the
      // hold lapses one episode after its first receipt and notifies.
      peer.refuseAll = true;
      const drainedAt = Date.now();
      await peer.drain("t2");
      expect(presence.isRestartExpected("pool")).toBe(true);
      const beforeLapse = notifications;
      await vi.advanceTimersByTimeAsync(RESTART_INTENT_EPISODE_MS - 1_000);
      expect(presence.isRestartExpected("pool")).toBe(true);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(Date.now() - drainedAt).toBeGreaterThan(RESTART_INTENT_EPISODE_MS);
      expect(presence.isRestartExpected("pool")).toBe(false);
      expect(notifications).toBeGreaterThan(beforeLapse);
      expect(pool.isReady()).toBe(false);

      peer.refuseAll = false;
      await advanceUntil(() => pool.isReady(), 60_000);

      const decisive = evidence.log.filter(
        (call) =>
          call === "established" ||
          call === "lost" ||
          call.startsWith("restartIntent:"),
      );
      expect(decisive).toEqual([
        "established",
        "restartIntent:t1",
        "lost",
        "established",
        "restartIntent:t2",
        "lost",
        "established",
      ]);
      expect(evidence.log).not.toContain("dialIndeterminate");
      expect(peer.errors).toEqual([]);
    } finally {
      pool.close();
    }
  });
});

describe("PoolSessionPresence", () => {
  it("opens one fixed hold on the first tombstone, ignores its repeat, and lapses at the end of the episode", () => {
    vi.useFakeTimers();
    const presence = new PoolSessionPresence(() => Date.now());
    let notifications = 0;
    presence.subscribe(() => {
      notifications += 1;
    });

    presence.reportRestartIntent("pool", "t1");
    expect(presence.isRestartExpected("pool")).toBe(true);
    expect(notifications).toBe(1);

    vi.advanceTimersByTime(RESTART_INTENT_EPISODE_MS / 2);
    presence.reportRestartIntent("pool", "t1");
    expect(notifications).toBe(1);

    vi.advanceTimersByTime(RESTART_INTENT_EPISODE_MS / 2 - 1);
    expect(presence.isRestartExpected("pool")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(presence.isRestartExpected("pool")).toBe(false);
    expect(notifications).toBe(2);
  });

  it("ends the hold when a session is established, and neither a refused nor an indeterminate dial ends it", () => {
    vi.useFakeTimers();
    const presence = new PoolSessionPresence(() => Date.now());
    presence.reportRestartIntent("pool", "t1");

    presence.reportDialRefusal();
    presence.reportDialIndeterminate();
    expect(presence.isRestartExpected("pool")).toBe(true);

    presence.sessionEstablished("pool");
    expect(presence.isRestartExpected("pool")).toBe(false);
  });
});
