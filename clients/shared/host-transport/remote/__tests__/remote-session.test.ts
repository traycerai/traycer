import {
  NO_TRANSPORT_EVIDENCE,
  type TransportEvidenceReporter,
} from "@traycer-clients/shared/host-selection/transport-evidence";
import type {
  SelectionIncompatibility,
  SelectionTransportKind,
} from "@traycer-clients/shared/host-selection/selection-authority-contract";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { z } from "zod";
import {
  defineFallbackMethodDegrade,
  defineFloorAwareVersionedRpcRegistry,
  defineRpcContract,
  defineUpgradePath,
  defineVersionedRpcRegistry,
  HOST_RESTARTING_FATAL_CODE,
  type FatalErrorDetails,
  type VersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import {
  defineStreamRpcContract,
  defineVersionedStreamRpcRegistry,
  type VersionedStreamRpcRegistry,
} from "@traycer/protocol/framework/versioned-stream-rpc";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import { SERVES_EVERY_INSTALLED_MAJOR } from "@traycer/protocol/framework/capability-manifest";
import {
  createResponderHandshake,
  generateStaticKeyPair,
  DEFAULT_REPLAY_WINDOW_SIZE,
  NoiseSession,
  type NoiseHandshakeState,
  type NoiseKeyPair,
} from "@traycer/protocol/crypto/noise";
import {
  FINE_INBOUND_CREDIT_GRANT_BATCH,
  MuxFrameType,
  NOISE_PROLOGUE,
  QosClass,
  SESSION_CONTROL_STREAM_ID,
  decodeMuxFrame,
  encodeMuxFrame,
  SESSION_CAPABILITY_BODY_COMPRESSION,
  type EncodeMuxFrameInput,
  type MuxFrame,
  type MuxFrameTypeValue,
  type QosClassValue,
} from "@traycer/protocol/host-transport/mux";
import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import {
  HostRequestAbortedError,
  HostRpcError,
  HostTransportFailureError,
  RetryableTransportError,
} from "../../host-messenger";
import {
  getNegotiatedHostMethodVersion,
  getNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "../../negotiated-manifest-registry";
import type { StreamAuthRevalidator } from "@traycer-clients/shared/auth/bearer-revalidator";
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
import {
  BULK_CHUNK_SIZE_BYTES,
  ChunkReassembler,
  encodeMuxMessageBody,
  OutboundChunkSource,
  type OutboundMessage,
  type ReassembledMessage,
} from "@traycer/protocol/host-transport/chunking";
import {
  acquireRemoteSession,
  type RemoteSessionIdentity,
} from "../active-remote-sessions";
import { RemoteSession, type RemoteSessionOptions } from "../remote-session";
import { RemoteStreamClient } from "../remote-stream-client";
import {
  RECONNECT_INITIAL_BACKOFF_MS,
  RECONNECT_MAX_BACKOFF_MS,
  RECONNECT_STABLE_RESET_MS,
} from "../config";
import type {
  StreamCloseReason,
  StreamFrameEnvelope,
} from "../../i-stream-session";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";

// Integration-style tests for the session lifecycle edges a cold audit found
// unrecoverable: an UNAUTHORIZED session fatal (the wake-time expired-bearer
// case) must revalidate + redial rather than brick the session; a genuinely
// terminal fatal must FIRE `onClosed` so owners can rebuild; and a ready
// boundary re-reached after a drop must surface availability-recovered
// evidence. The fake below implements the REAL wire: relay attach_ack, a real
// responder-side Noise-NK handshake, and mux frame encode/decode - so the
// session under test runs its full production connect path (only the network
// and the grant/authn HTTP are faked).
//
// Timing: the session's reconnect backoff starts at 1s (config.ts), so every
// recovery assertion waits with an explicit generous budget rather than
// vitest's 1s `waitFor` / 5s per-test defaults.

const EMPTY_AD = new Uint8Array(0);
const WAIT = { timeout: 10_000, interval: 50 } as const;
const TEST_BUDGET_MS = 15_000;

// Zero-method registries: the session's connect/open/fatal lifecycle under
// test never dispatches a method, and an empty manifest is trivially
// compatible with the fake host echoing an empty manifest back.
const emptyRpcRegistry: VersionedRpcRegistry = defineVersionedRpcRegistry({});
const emptyStreamRegistry: VersionedStreamRpcRegistry =
  defineVersionedStreamRpcRegistry({});
const cursorStreamRegistry = defineVersionedStreamRpcRegistry({
  "cursor.subscribe": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineStreamRpcContract({
            method: "cursor.subscribe",
            schemaVersion: { major: 1, minor: 0 },
            openRequestSchema: z.object({ cursor: z.number().nullable() }),
            serverFrameSchema: z.object({
              kind: z.literal("snapshot"),
              hasBinaryPayload: z.literal(false),
            }),
            clientFrameSchema: z.object({
              kind: z.literal("noop"),
              hasBinaryPayload: z.literal(false),
            }),
          }),
        },
      },
    },
  },
});
const dualMajorCursorStreamRegistry = defineVersionedStreamRpcRegistry({
  "cursor.subscribe": {
    1: {
      latestMinor: 0,
      versions: {
        0: {
          contract: defineStreamRpcContract({
            method: "cursor.subscribe",
            schemaVersion: { major: 1, minor: 0 },
            openRequestSchema: z.object({ cursor: z.number().nullable() }),
            serverFrameSchema: z.object({
              kind: z.literal("snapshot"),
              hasBinaryPayload: z.literal(false),
            }),
            clientFrameSchema: z.object({
              kind: z.literal("noop"),
              hasBinaryPayload: z.literal(false),
            }),
          }),
        },
      },
    },
    2: {
      latestMinor: 1,
      versions: {
        1: {
          contract: defineStreamRpcContract({
            method: "cursor.subscribe",
            schemaVersion: { major: 2, minor: 1 },
            openRequestSchema: z.object({ cursor: z.number().nullable() }),
            serverFrameSchema: z.object({
              kind: z.literal("state"),
              hasBinaryPayload: z.literal(false),
            }),
            clientFrameSchema: z.object({
              kind: z.literal("noop"),
              hasBinaryPayload: z.literal(false),
            }),
          }),
        },
      },
    },
  },
});

type OpenDecision =
  | { readonly kind: "ack" }
  | { readonly kind: "fatal"; readonly details: FatalErrorDetails };

function unauthorizedDetails(): FatalErrorDetails {
  return {
    code: "UNAUTHORIZED",
    reason: "OPEN bearer rejected",
    incompatibleMethods: null,
    upgradeGuidance: null,
  };
}

/**
 * A retryable session-fatal, reused across the wake/forceReconnect suites to
 * arm/escalate the reconnect backoff without ever reaching the ready
 * boundary - the schedule resets ONLY there (`maybeReachReadyBoundary`), so a
 * script that lets the session go ready between failures would never build up
 * an escalation to wake against.
 */
function retryableDropDetails(): FatalErrorDetails {
  return { ...unauthorizedDetails(), retryable: true };
}

class FakeSocket implements StreamWebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: StreamWebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;

  private readonly onSendData: (data: string | Uint8Array) => void;
  private readonly onLocalClose: () => void;

  constructor(
    onSendData: (data: string | Uint8Array) => void,
    onLocalClose: () => void,
  ) {
    this.onSendData = onSendData;
    this.onLocalClose = onLocalClose;
  }

  send(data: string | Uint8Array): void {
    this.onSendData(data);
  }

  close(_code: number, _reason: string): void {
    this.onLocalClose();
  }
}

interface FakeConnection {
  readonly socket: FakeSocket;
  noise: NoiseSession | null;
  handshake: NoiseHandshakeState | null;
  readonly reassembler: ChunkReassembler;
  readonly seqByStream: Map<number, number>;
  /**
   * Host-side R-2 mirror (`r2-host-stream-tombstone`), enforced per
   * connection exactly like `RemoteClientSession.terminalStreamIds`: once the
   * fake sends a FATAL for a stream, every later CLIENT frame for that id -
   * a SUBSCRIBE included - is dropped at ingest, and the harness refuses to
   * send server frames for it. Without this the fake accepted a re-subscribe
   * of a tombstoned id that the production host silently ignores, and a
   * recovery test passed against a client that was in fact permanently dead.
   */
  readonly terminalStreamIds: Set<number>;
  /** Serializes async frame handling so mux ordering matches the wire. */
  queue: Promise<void>;
  closed: boolean;
}

/**
 * The relay + host end of the wire, scripted per test via `decideOpen`. Runs a
 * REAL responder Noise-NK handshake against the session's initiator and
 * answers each in-channel `open{bearer}` with an `openAck` or a session-level
 * `fatal`, recording every bearer presented.
 */
class FakeRelayHost {
  private readonly hostKeys: NoiseKeyPair = generateStaticKeyPair();
  private readonly connections: FakeConnection[] = [];
  /** Every bearer presented across all `open` frames, in arrival order. */
  readonly openBearers: string[] = [];
  /**
   * The `clientIdentity` on every `open`, index-aligned with `openBearers`.
   *
   * Captured raw (`unknown`) rather than typed, deliberately: what a suite
   * needs to prove is that the transport PUT IT ON THE WIRE, and a typed slot
   * would let an absent field read as a shape mismatch rather than as the
   * missing key it is.
   */
  readonly openIdentities: unknown[] = [];
  /** Params carried by every logical subscribe, including reconnect replay. */
  readonly subscribeParams: unknown[] = [];
  /** Schema version carried beside each logical subscribe. */
  readonly subscribeSchemaVersions: unknown[] = [];
  /** streamId of every logical subscribe, index-aligned with `subscribeParams`. */
  readonly subscribeStreamIds: number[] = [];
  /** Every `credits` value from a CREDIT control frame the client sent. */
  readonly creditGrants: number[] = [];
  /** Fired synchronously the instant a CREDIT frame is recorded - lets a test
   * capture ordering evidence (e.g. "was the stream frame already delivered
   * to the consumer?") at the exact tick the grant landed, not on a later poll. */
  onCreditGrant: (() => void) | null = null;
  streamManifest = buildStreamManifest(
    emptyStreamRegistry,
    SERVES_EVERY_INSTALLED_MAJOR,
  );
  /**
   * The OPTIONAL rpc manifest the fake host advertises in `openAck`. Floor
   * stays empty (matching the empty client registries here); optional
   * methods are the interesting surface - they must publish to the
   * negotiated-manifest registry and must NEVER fatal the session, however
   * unknown to the client they are.
   */
  optionalRpcManifest: Record<string, { major: number; minor: number }> = {};
  /** The FLOOR rpc manifest advertised in `openAck` (compat-checked). */
  floorRpcManifest: Record<string, { major: number; minor: number }> = {};
  /**
   * When false the `openAck` omits `optionalRpc` entirely - the shape a peer
   * built before the floor/optional split would send. `sessionManifestsSchema`
   * requires the field, so this exercises the parse-rejection path rather
   * than a silently half-understood manifest.
   */
  sendOptionalRpc = true;
  /** The `capabilities` array this fake host advertises in `openAck` (T5). */
  openAckCapabilities: string[] = [];
  /** Every mux frame decoded off the wire from the CLIENT, pre-reassembly - lets a test read `compressed` per frame exactly as the host would (T5). */
  readonly clientFrames: MuxFrame[] = [];
  /** Every REQUEST frame the client sent: method + on-wire version + params. */
  readonly unaryRequests: {
    method: string;
    schemaVersion: unknown;
    params: unknown;
    streamId: number;
  }[] = [];
  /** Answers the next REQUEST with this result payload. */
  unaryResult: unknown = { ready: true };
  /**
   * When set, auto-RESPONSE carries this error envelope (and a null result)
   * instead of `unaryResult`. Used to pin `WORKTREE_BUSY` holder preservation.
   */
  unaryError: {
    readonly code: string;
    readonly message: string;
    readonly holders?: unknown;
  } | null = null;
  /**
   * When true, a REQUEST is recorded in `unaryRequests` but NOT auto-answered
   * with a RESPONSE - lets a test inject its own terminal frame (e.g. a
   * stream-scoped FATAL) for that request's streamId instead of racing the
   * harness's own reply.
   */
  skipUnaryAutoRespond = false;
  /** streamId of every CLOSE frame the CLIENT sent, in arrival order. */
  readonly closesSent: number[] = [];
  /**
   * Every client frame the R-2 ingest check dropped (streamId + mux frame
   * type). The production host logs these; recording them here is what lets
   * a test observe "the client DID send X, and the host deliberately ignored
   * it" - e.g. the belt-and-braces CLOSE a client sends for a stream the
   * host already condemned with a FATAL.
   */
  readonly droppedTombstonedFrames: { streamId: number; type: number }[] = [];
  /** Unexpected harness-side failures; asserted empty by the tests. */
  readonly errors: unknown[] = [];
  decideOpen: (bearer: string, openIndex: number) => OpenDecision = () => ({
    kind: "ack",
  });
  /** Count of `relay-ping` keepalive frames received from the client. */
  pingCount = 0;
  /**
   * When false, pings are counted but never answered - the half-open-socket
   * shape an OS suspend leaves behind (sends go out, nothing comes back),
   * which is what the wake-probe tests need the wire to look like.
   */
  answerPings = true;

  get hostStaticPublicKey(): Uint8Array {
    return this.hostKeys.publicKey;
  }

  readonly factory: IStreamWebSocketFactory = {
    create: (): StreamWebSocketLike => {
      const connection: FakeConnection = {
        socket: new FakeSocket(
          (data) => this.enqueue(connection, data),
          () => {
            connection.closed = true;
          },
        ),
        noise: null,
        handshake: null,
        reassembler: new ChunkReassembler(undefined),
        seqByStream: new Map(),
        terminalStreamIds: new Set(),
        queue: Promise.resolve(),
        closed: false,
      };
      this.connections.push(connection);
      const sid = this.connections.length;
      queueMicrotask(() => {
        if (connection.closed) {
          return;
        }
        connection.socket.onopen?.({ type: "open" });
        connection.socket.onmessage?.({
          type: "text",
          data: JSON.stringify({ type: "attach_ack", role: "client", sid }),
        });
      });
      return connection.socket;
    },
  };

  /** Relay control frame: the host's leg of the tunnel went away/came back. */
  sendHostAttachment(state: "host_detached" | "host_attached"): void {
    const connection = [...this.connections]
      .reverse()
      .find((entry) => !entry.closed);
    if (connection === undefined) {
      throw new Error("no live connection to signal on");
    }
    connection.socket.onmessage?.({
      type: "text",
      data: JSON.stringify({ type: state }),
    });
  }

  /** Relay control frame: the peer/session was killed for a relay reason. */
  sendRelayKill(type: "peer_gone" | "killed", reason: string): void {
    const connection = this.liveConnection();
    connection.socket.onmessage?.({
      type: "text",
      data: JSON.stringify({ type, reason }),
    });
  }

  /** Server-side drop of the live socket (relay restart / network cut). */
  dropCurrentConnection(): void {
    const connection = [...this.connections]
      .reverse()
      .find((entry) => !entry.closed);
    if (connection === undefined) {
      throw new Error("no live connection to drop");
    }
    connection.closed = true;
    connection.socket.onclose?.({
      code: 1006,
      reason: "server-drop",
      wasClean: false,
    });
  }

  /** The current live connection - shared lookup for the raw-frame helpers below. */
  private liveConnection(): FakeConnection {
    const connection = [...this.connections]
      .reverse()
      .find((entry) => !entry.closed);
    if (connection === undefined) {
      throw new Error("no live connection");
    }
    return connection;
  }

  /**
   * Pushes a single logical STREAM_FRAME to the client through the REAL
   * chunker (`OutboundChunkSource`, same as production `sendMux`) - a body
   * over `BULK_CHUNK_SIZE_BYTES` spans many wire frames automatically. Used
   * by the C1 per-frame credit-accounting regression to drive a transfer
   * long enough to cross `FINE_INBOUND_CREDIT_GRANT_BATCH` mid-flight.
   */
  async sendStreamFrame(
    streamId: number,
    envelope: Record<string, unknown>,
    binary: Uint8Array | null,
    qos: QosClassValue,
  ): Promise<void> {
    const connection = this.liveConnection();
    if (connection.terminalStreamIds.has(streamId)) {
      // The real host tears its resolver down with the FATAL, so no server
      // frame for a terminal id can exist. Loud rather than dropped: a test
      // reaching here is asserting recovery on an id that never recovered.
      throw new Error(
        `test sent a server frame for tombstoned stream ${streamId}`,
      );
    }
    await this.sendMux(connection, {
      type: MuxFrameType.STREAM_FRAME,
      streamId,
      qos,
      json: envelope,
      binary,
    });
  }

  /**
   * Sends a stream-scoped FATAL for `streamId` through the real chunker
   * (`sendMux`, same path as `sendStreamFrame`) - lets a test simulate the
   * host abandoning a pending unary request or a live subscription without
   * ever answering it normally.
   */
  async sendStreamFatal(
    streamId: number,
    details: FatalErrorDetails,
  ): Promise<void> {
    const connection = this.liveConnection();
    // Mirrors `RemoteClientSession`: the host marks the stream terminal
    // whenever it sends a FATAL - retryable or not - and its ingest drops
    // every later client frame for the id, so a client re-open must arrive
    // under a fresh id to be heard.
    connection.terminalStreamIds.add(streamId);
    await this.sendMux(connection, {
      type: MuxFrameType.FATAL,
      streamId,
      qos: QosClass.INTERACTIVE,
      json: { details: { ...details } },
      binary: null,
    });
  }

  /**
   * Sends a stream-scoped CLOSE for `streamId` - the host ending a stream
   * NORMALLY (resolver finished, entity gone benignly). Mirrors
   * `RemoteClientSession.handleStreamClose`: a host-side CLOSE is a terminal
   * path exactly like a FATAL, so the id is tombstoned here too and every
   * later client frame for it is dropped at ingest.
   */
  async sendStreamClose(streamId: number, reason: string): Promise<void> {
    const connection = this.liveConnection();
    connection.terminalStreamIds.add(streamId);
    await this.sendMux(connection, {
      type: MuxFrameType.CLOSE,
      streamId,
      qos: QosClass.INTERACTIVE,
      json: { reason },
      binary: null,
    });
  }

  /**
   * Noise-encrypts one already-built `EncodeMuxFrameInput` WITHOUT delivering
   * it - lets a test build several chunk sequences by hand, encrypt them in
   * whatever order it chooses (the Noise send counter is reserved
   * synchronously per call, so sequential `await`s here still produce a
   * strictly increasing, decryptable counter sequence), and then hand the
   * sealed bytes to `deliverToClient` in an INTERLEAVED order that differs
   * from a naive "one sequence at a time" send.
   */
  async encryptFrame(input: EncodeMuxFrameInput): Promise<Uint8Array> {
    const connection = this.liveConnection();
    const noise = connection.noise;
    if (noise === null) {
      throw new Error("no established noise session");
    }
    return noise.encrypt(encodeMuxFrame(input), EMPTY_AD);
  }

  /**
   * Hands one already-Noise-sealed frame straight to the client's socket
   * `onmessage` - the same call `deliverBinary` makes internally, exposed so
   * a test can fire several of these back-to-back with NO await between
   * them, matching production `onData`'s fire-and-forget per-message entry.
   */
  deliverToClient(bytes: Uint8Array): void {
    this.deliverBinary(this.liveConnection(), bytes);
  }

  private enqueue(connection: FakeConnection, data: string | Uint8Array): void {
    connection.queue = connection.queue
      .then(() => this.handleClientSend(connection, data))
      .catch((error: unknown) => {
        this.errors.push(error);
      });
  }

  private async handleClientSend(
    connection: FakeConnection,
    data: string | Uint8Array,
  ): Promise<void> {
    if (connection.closed) {
      return;
    }
    if (typeof data === "string") {
      if (data === "relay-ping") {
        this.pingCount += 1;
        if (this.answerPings) {
          connection.socket.onmessage?.({ type: "text", data: "relay-pong" });
        }
      }
      // `reauth` control frames need no ack for these tests.
      return;
    }
    if (connection.noise === null) {
      // Handshake msg0: run the responder side and answer with msg1.
      const handshake = await createResponderHandshake(
        this.hostKeys,
        NOISE_PROLOGUE,
      );
      await handshake.readMessage(data);
      const msg1 = await handshake.writeMessage(new Uint8Array(0));
      connection.handshake = handshake;
      connection.noise = NoiseSession.fromHandshake(
        handshake,
        DEFAULT_REPLAY_WINDOW_SIZE,
      );
      this.deliverBinary(connection, msg1);
      return;
    }
    const muxBytes = await connection.noise.decrypt(data, EMPTY_AD);
    const frame = decodeMuxFrame(muxBytes);
    // Recorded BEFORE the tombstone drop below: `clientFrames` is what the
    // CLIENT put on the wire, and a frame the host then drops was still sent.
    // Folding the drop in first would silently shrink the frame/compression
    // accounting the transfer assertions read.
    this.clientFrames.push(frame);
    // R-2 ingest drop, same placement as the production host's `feedInbound`:
    // BEFORE `accept()`, so a tombstoned id can neither seed a fresh
    // reassembler accumulator nor smuggle a SUBSCRIBE through to the handler.
    if (connection.terminalStreamIds.has(frame.streamId)) {
      this.droppedTombstonedFrames.push({
        streamId: frame.streamId,
        type: frame.type,
      });
      return;
    }
    const message = connection.reassembler.accept(frame);
    if (message === null) {
      return;
    }
    await this.handleMuxMessage(connection, message);
  }

  private async handleMuxMessage(
    connection: FakeConnection,
    message: ReassembledMessage,
  ): Promise<void> {
    if (message.type === MuxFrameType.SUBSCRIBE) {
      this.subscribeParams.push(message.json?.params);
      this.subscribeSchemaVersions.push(message.json?.schemaVersion);
      this.subscribeStreamIds.push(message.streamId);
      return;
    }
    if (message.type === MuxFrameType.CREDIT) {
      const json = message.json;
      const credits =
        json !== null && typeof json.credits === "number" ? json.credits : null;
      if (credits !== null) {
        this.creditGrants.push(credits);
        this.onCreditGrant?.();
      }
      return;
    }
    if (message.type === MuxFrameType.REQUEST) {
      const json = message.json ?? {};
      this.unaryRequests.push({
        method: typeof json.method === "string" ? json.method : "",
        schemaVersion: json.schemaVersion,
        params: json.params,
        streamId: message.streamId,
      });
      if (this.skipUnaryAutoRespond) {
        return;
      }
      await this.sendMux(connection, {
        type: MuxFrameType.RESPONSE,
        streamId: message.streamId,
        qos: QosClass.INTERACTIVE,
        json: {
          requestId: typeof json.requestId === "string" ? json.requestId : "",
          method: typeof json.method === "string" ? json.method : "",
          result: this.unaryError === null ? this.unaryResult : null,
          error: this.unaryError,
        },
        binary: null,
      });
      return;
    }
    if (message.type === MuxFrameType.CLOSE) {
      this.closesSent.push(message.streamId);
      return;
    }
    if (
      message.streamId !== SESSION_CONTROL_STREAM_ID ||
      message.type !== MuxFrameType.OPEN
    ) {
      return;
    }
    const bearer =
      message.json !== null && typeof message.json.bearer === "string"
        ? message.json.bearer
        : "";
    const openIndex = this.openBearers.length;
    this.openBearers.push(bearer);
    this.openIdentities.push(message.json?.clientIdentity);
    if (this.stallOpens) {
      // Freeze this attempt mid-flight (the session sits in its opening
      // phase, its own phase timer pending) until the test releases it -
      // the window the forced-intent ordering tests need to aim into.
      this.stalledOpens.push({ connection, bearer, openIndex });
      return;
    }
    await this.respondToOpen(connection, bearer, openIndex);
  }

  /**
   * When true, `open` frames are recorded but not answered until
   * {@link releaseStalledOpens} runs - the in-flight-attach window.
   */
  stallOpens = false;
  private readonly stalledOpens: Array<{
    connection: FakeConnection;
    bearer: string;
    openIndex: number;
  }> = [];

  /** Answers every stalled open, in arrival order, with `decideOpen`'s verdict. */
  async releaseStalledOpens(): Promise<void> {
    const stalled = this.stalledOpens.splice(0);
    for (const open of stalled) {
      await this.respondToOpen(open.connection, open.bearer, open.openIndex);
    }
  }

  private async respondToOpen(
    connection: FakeConnection,
    bearer: string,
    openIndex: number,
  ): Promise<void> {
    const decision = this.decideOpen(bearer, openIndex);
    if (decision.kind === "ack") {
      await this.sendMux(connection, {
        type: MuxFrameType.OPEN_ACK,
        streamId: SESSION_CONTROL_STREAM_ID,
        qos: QosClass.INTERACTIVE,
        json: {
          manifest: this.sendOptionalRpc
            ? {
                rpc: this.floorRpcManifest,
                optionalRpc: this.optionalRpcManifest,
                stream: this.streamManifest,
              }
            : { rpc: this.floorRpcManifest, stream: this.streamManifest },
          capabilities: this.openAckCapabilities,
        },
        binary: null,
      });
      return;
    }
    await this.sendMux(connection, {
      type: MuxFrameType.FATAL,
      streamId: SESSION_CONTROL_STREAM_ID,
      qos: QosClass.INTERACTIVE,
      json: { details: { ...decision.details } },
      binary: null,
    });
  }

  private async sendMux(
    connection: FakeConnection,
    message: OutboundMessage,
  ): Promise<void> {
    const noise = connection.noise;
    if (noise === null || connection.closed) {
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
      const sealed = await noise.encrypt(
        encodeMuxFrame(source.nextFrame()),
        EMPTY_AD,
      );
      this.deliverBinary(connection, sealed);
    }
  }

  private deliverBinary(connection: FakeConnection, bytes: Uint8Array): void {
    if (connection.closed) {
      return;
    }
    connection.socket.onmessage?.({ type: "binary", data: bytes });
  }
}

/** One recorded call to a `TransportEvidenceReporter` method, keyed by name. */
type RecordedEvidenceCall =
  | {
      readonly method: "sessionEstablished";
      readonly hostId: string;
      readonly sessionId: string;
      readonly transportKind: SelectionTransportKind;
    }
  | {
      readonly method: "sessionLost";
      readonly hostId: string;
      readonly sessionId: string;
      readonly transportKind: SelectionTransportKind;
    }
  | {
      readonly method: "reportDialSuccess";
      readonly hostId: string;
      readonly attemptId: string;
      readonly transportKind: SelectionTransportKind;
    }
  | {
      readonly method: "reportDialRefusal";
      readonly hostId: string;
      readonly attemptId: string;
      readonly transportKind: SelectionTransportKind;
      readonly refusalDetail: "plan-restricted" | null;
    }
  | {
      readonly method: "reportDialTimeout";
      readonly hostId: string;
      readonly attemptId: string;
      readonly transportKind: SelectionTransportKind;
    }
  | {
      readonly method: "reportDialIndeterminate";
      readonly hostId: string;
      readonly attemptId: string;
      readonly transportKind: SelectionTransportKind;
    }
  | {
      readonly method: "reportCompatVerdict";
      readonly input: {
        readonly hostId: string;
        readonly probedOnSessionId: string | null;
        readonly hostVersion: string | null;
        readonly incompatibility: SelectionIncompatibility | null;
      };
    }
  | {
      readonly method: "reportRestartIntent";
      readonly hostId: string;
      readonly tombstoneId: string;
      readonly expiresAt: number | null;
    };

/**
 * Records every call a transport makes into a `TransportEvidenceReporter`, in
 * arrival order, so a test can assert on sequences and per-method counts
 * rather than only on the latest call (the shape a plain `vi.fn` gives).
 */
class RecordingEvidence implements TransportEvidenceReporter {
  readonly calls: RecordedEvidenceCall[] = [];

  sessionEstablished(
    hostId: string,
    sessionId: string,
    transportKind: SelectionTransportKind,
  ): void {
    this.calls.push({
      method: "sessionEstablished",
      hostId,
      sessionId,
      transportKind,
    });
  }

  sessionLost(
    hostId: string,
    sessionId: string,
    transportKind: SelectionTransportKind,
  ): void {
    this.calls.push({
      method: "sessionLost",
      hostId,
      sessionId,
      transportKind,
    });
  }

  reportDialSuccess(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
  ): void {
    this.calls.push({
      method: "reportDialSuccess",
      hostId,
      attemptId,
      transportKind,
    });
  }

  reportDialRefusal(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
    refusalDetail: "plan-restricted" | null,
  ): void {
    this.calls.push({
      method: "reportDialRefusal",
      hostId,
      attemptId,
      transportKind,
      refusalDetail,
    });
  }

  reportDialTimeout(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
  ): void {
    this.calls.push({
      method: "reportDialTimeout",
      hostId,
      attemptId,
      transportKind,
    });
  }

  reportDialIndeterminate(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
  ): void {
    this.calls.push({
      method: "reportDialIndeterminate",
      hostId,
      attemptId,
      transportKind,
    });
  }

  reportCompatVerdict(input: {
    readonly hostId: string;
    readonly probedOnSessionId: string | null;
    readonly hostVersion: string | null;
    readonly incompatibility: SelectionIncompatibility | null;
  }): void {
    this.calls.push({ method: "reportCompatVerdict", input });
  }

  /** Every recorded call for one method name, narrowed to its own shape. */
  callsNamed<Method extends RecordedEvidenceCall["method"]>(
    method: Method,
  ): (RecordedEvidenceCall & { readonly method: Method })[] {
    return this.calls.filter(
      (call): call is RecordedEvidenceCall & { readonly method: Method } =>
        call.method === method,
    );
  }

  reportRestartIntent(
    hostId: string,
    tombstoneId: string,
    expiresAt: number | null,
  ): void {
    this.calls.push({
      method: "reportRestartIntent",
      hostId,
      tombstoneId,
      expiresAt,
    });
  }
}

function buildSession(
  relay: FakeRelayHost,
  lease: MutableBearerLease,
  auth: StreamAuthRevalidator | null,
): RemoteSession<VersionedRpcRegistry, VersionedStreamRpcRegistry> {
  return new RemoteSession(buildSessionOptions(relay, lease, auth));
}

/** The options `buildSession` uses, exposed so a test can drop a field. */
function buildSessionOptions(
  relay: FakeRelayHost,
  lease: MutableBearerLease,
  auth: StreamAuthRevalidator | null,
): RemoteSessionOptions<VersionedRpcRegistry, VersionedStreamRpcRegistry> {
  let nextRequestId = 0;
  return {
    hostId: "host-1",
    attachBaseUrl: "wss://relay.test/attach",
    hostStaticPublicKey: relay.hostStaticPublicKey,
    grantProvider: () =>
      Promise.resolve({
        kind: "ok" as const,
        grant: { grant: "grant-jws", expiresInSeconds: 300 },
      }),
    bearer: () => lease,
    auth,
    rpcRegistry: emptyRpcRegistry,
    streamRegistry: emptyStreamRegistry,
    webSocketFactory: relay.factory,
    requestId: () => `req-${(nextRequestId += 1)}`,
    evidence: NO_TRANSPORT_EVIDENCE,
    clientIdentity: TEST_CLIENT_IDENTITY,
  };
}

describe("RemoteSession client identity", () => {
  it(
    "sends the configured identity on the session open frame, and again on every redial",
    async () => {
      // The redial half is the part worth driving rather than reasoning
      // about: each attach re-authenticates and is therefore re-admitted from
      // scratch, so an identity sent only on the first `open` would leave
      // every reconnect looking like a legacy client to a floored host.
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("valid-token", "user-1");
      relay.decideOpen = (_bearer, openIndex) =>
        openIndex === 0
          ? {
              kind: "fatal",
              details: { ...unauthorizedDetails(), retryable: true },
            }
          : { kind: "ack" };
      const session = new RemoteSession(
        buildSessionOptions(relay, lease, {
          revalidateForReconnect: () => Promise.resolve("rotated" as const),
        }),
      );
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        expect(relay.openIdentities.length).toBeGreaterThanOrEqual(2);
        for (const identity of relay.openIdentities) {
          expect(identity).toEqual({
            kind: TEST_CLIENT_IDENTITY.kind,
            compatibilityEpoch: TEST_CLIENT_IDENTITY.compatibilityEpoch,
            appVersion: TEST_CLIENT_IDENTITY.appVersion,
          });
        }
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "omits only a null appVersion, never the identity or the epoch",
    async () => {
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("valid-token", "user-1");
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        clientIdentity: {
          kind: "cli",
          compatibilityEpoch: 2,
          appVersion: null,
        },
      });
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        expect(relay.openIdentities[0]).toEqual({
          kind: "cli",
          compatibilityEpoch: 2,
        });
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe("RemoteSession UNAUTHORIZED session-fatal recovery", () => {
  it(
    "publishes the readiness DOWN edge when a READY session takes an UNAUTHORIZED fatal - the one drop that used to skip it",
    async () => {
      // `handleUnauthorizedSessionFatal` was the only `dropConnection` caller
      // without a `syncReadinessLatch()`, so `subscribeReadinessLost` never
      // fired and `hasReadyRemoteSession` held a stale `true` for the whole
      // revalidate-and-backoff window - the class that subscription exists to
      // close. The sync now lives in `dropConnection` itself.
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("valid-token", "user-1");
      const auth: StreamAuthRevalidator = {
        revalidateForReconnect: () => {
          lease.rotate("fresh-token");
          return Promise.resolve("rotated");
        },
      };
      const session = buildSession(relay, lease, auth);
      let lostEvents = 0;
      session.subscribeReadinessLost(() => {
        lostEvents += 1;
      });
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        expect(lostEvents).toBe(0);

        // A session-level UNAUTHORIZED on an already-READY session (a
        // mid-session credential rejection), not an open-frame rejection.
        await relay.sendStreamFatal(
          SESSION_CONTROL_STREAM_ID,
          unauthorizedDetails(),
        );
        // The DOWN edge fires with the drop (the frame is delivered
        // asynchronously through the relay); the redial that follows reaches
        // a new ready boundary on its own and emits no second edge.
        await vi.waitFor(() => expect(lostEvents).toBe(1), WAIT);
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        expect(lostEvents).toBe(1);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "revalidates and redials with the fresh bearer instead of terminally closing",
    async () => {
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("expired-token", "user-1");
      // The host rejects the stale bearer exactly the way the production host
      // does at a wake-time re-attach: a session-level FATAL{UNAUTHORIZED}.
      relay.decideOpen = (bearer) =>
        bearer === "fresh-token"
          ? { kind: "ack" }
          : { kind: "fatal", details: unauthorizedDetails() };
      let revalidateCalls = 0;
      const auth: StreamAuthRevalidator = {
        revalidateForReconnect: () => {
          revalidateCalls += 1;
          lease.rotate("fresh-token");
          return Promise.resolve("rotated");
        },
      };
      const session = buildSession(relay, lease, auth);
      let closedEvents = 0;
      session.onClosed(() => {
        closedEvents += 1;
      });
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        // The recovery presented the rejected bearer once, then the rotated
        // one - and never closed the session on the way.
        expect(relay.openBearers).toEqual(["expired-token", "fresh-token"]);
        expect(revalidateCalls).toBe(1);
        expect(session.isClosed()).toBe(false);
        expect(closedEvents).toBe(0);
        expect(relay.errors).toEqual([]);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "goes terminal - and fires onClosed - when revalidation reports the credential rejected",
    async () => {
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("dead-token", "user-1");
      relay.decideOpen = () => ({
        kind: "fatal",
        details: unauthorizedDetails(),
      });
      let revalidateCalls = 0;
      const auth: StreamAuthRevalidator = {
        revalidateForReconnect: () => {
          revalidateCalls += 1;
          return Promise.resolve("rejected");
        },
      };
      const session = buildSession(relay, lease, auth);
      let closedEvents = 0;
      session.onClosed(() => {
        closedEvents += 1;
      });
      try {
        session.start();
        await vi.waitFor(() => expect(session.isClosed()).toBe(true), WAIT);
        // Terminal BECAUSE the revalidation said so - the recovery path ran
        // exactly once and stopped, rather than never being consulted.
        expect(revalidateCalls).toBe(1);
        expect(closedEvents).toBe(1);
        expect(relay.openBearers).toEqual(["dead-token"]);
        expect(relay.errors).toEqual([]);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "treats a retryable UNAUTHORIZED fatal as a transport drop - reconnects without spending a revalidation",
    async () => {
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("valid-token", "user-1");
      // The transient host-side rejection (its JWKS fetch timed out): same
      // wire code, but flagged retryable - the credential is fine.
      relay.decideOpen = (_bearer, openIndex) =>
        openIndex === 0
          ? {
              kind: "fatal",
              details: { ...unauthorizedDetails(), retryable: true },
            }
          : { kind: "ack" };
      const revalidate = vi.fn(() => Promise.resolve("rotated" as const));
      // A RECORDING reporter, not `NO_TRANSPORT_EVIDENCE`. This test modelled
      // the exact trigger shape for a real classification defect and could not
      // see it, because an inert reporter records nothing to assert on: the
      // session reconnected correctly the whole time while filing a confirmed
      // refusal against a host that was answering. A test that drives the
      // right scenario through a blind instrument reads as coverage and is
      // not.
      const recorder = new RecordingEvidence();
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, {
          revalidateForReconnect: revalidate,
        }),
        evidence: recorder,
      });
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        expect(relay.openBearers).toEqual(["valid-token", "valid-token"]);
        expect(revalidate).not.toHaveBeenCalled();
        expect(relay.errors).toEqual([]);

        // THE CLASSIFICATION: a retryable UNAUTHORIZED is the credential plane
        // failing in front of a live host. It must never be recorded as a
        // confirmed refusal - three of those reach the death streak and fail
        // the window away from a host that never stopped answering.
        expect(recorder.callsNamed("reportDialRefusal")).toEqual([]);
        // The control, so the empty set above is a real exclusion rather than
        // a reporter that was never called at all: the drop WAS reported, as
        // indeterminate, against this host.
        expect(
          recorder.callsNamed("reportDialIndeterminate").map((c) => c.hostId),
        ).toEqual(["host-1"]);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "treats a SYNCHRONOUSLY thrown revalidation as transient, not an unhandled rejection",
    async () => {
      // `revalidateForReconnect` is typed to RETURN a promise, but nothing stops
      // an implementation throwing before it returns one. Called bare, that
      // throw skips the `.catch` that maps a failed revalidation to
      // "network-error" and the `finally` that clears the budget timer, then
      // escapes the `void`-discarded recovery task — an unhandled rejection,
      // with the session parked in "reconnecting" and no redial armed.
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("stale-token", "user-1");
      let opens = 0;
      relay.decideOpen = () => {
        opens += 1;
        return opens === 1
          ? { kind: "fatal", details: unauthorizedDetails() }
          : { kind: "ack" };
      };
      let revalidateCalls = 0;
      const auth: StreamAuthRevalidator = {
        revalidateForReconnect: () => {
          revalidateCalls += 1;
          throw new Error("revalidation threw before returning a promise");
        },
      };
      const rejections: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        rejections.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);

      const session = buildSession(relay, lease, auth);
      try {
        session.start();
        // Recovers: the throw is transient, so the normal backoff redials.
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        expect(revalidateCalls).toBe(1);
        // "network-error" leaves the bearer untouched - the redial presents the
        // same one, and this never counts toward the give-up bound.
        expect(relay.openBearers).toEqual(["stale-token", "stale-token"]);
        expect(session.isClosed()).toBe(false);
        await Promise.resolve();
        expect(rejections).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "closes cleanly when the consumer wired NO revalidator at all (not just null)",
    async () => {
      // `auth` is required by the type, but untyped consumers (the connect-path
      // E2E harness, ad-hoc probes) can omit it entirely. An `undefined`
      // sliding past a `!== null` check calls `.revalidateForReconnect()` on
      // nothing, and the TypeError lands in a floating promise on the reconnect
      // path — the session dies as an unhandled rejection instead of closing
      // with the host's own UNAUTHORIZED reason.
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("dead-token", "user-1");
      relay.decideOpen = () => ({
        kind: "fatal",
        details: unauthorizedDetails(),
      });
      const rejections: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        rejections.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);

      // Build with the property ABSENT, exactly as an untyped caller would.
      const options = buildSessionOptions(relay, lease, null);
      delete (options as { auth?: unknown }).auth;
      const session = new RemoteSession(options);
      try {
        session.start();
        await vi.waitFor(() => expect(session.isClosed()).toBe(true), WAIT);
        // Degrades exactly like `auth: null`: terminal, no crash.
        expect(relay.openBearers).toEqual(["dead-token"]);
        expect(relay.errors).toEqual([]);
        await Promise.resolve();
        expect(rejections).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe("RemoteSession terminal close notification", () => {
  it(
    "fires onClosed (through RemoteStreamClient) when a non-recoverable session fatal closes the session",
    async () => {
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("valid-token", "user-1");
      relay.decideOpen = () => ({
        kind: "fatal",
        details: {
          code: "INCOMPATIBLE",
          reason: "manifest mismatch",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      });
      const revalidate = vi.fn(() => Promise.resolve("rotated" as const));
      const session = buildSession(relay, lease, {
        revalidateForReconnect: revalidate,
      });
      const streamClient = new RemoteStreamClient(session);
      let closedEvents = 0;
      streamClient.onClosed(() => {
        closedEvents += 1;
      });
      try {
        session.start();
        await vi.waitFor(
          () => expect(streamClient.isClosed()).toBe(true),
          WAIT,
        );
        // The auth hook is for UNAUTHORIZED only - an INCOMPATIBLE fatal must
        // stay terminal and must not spend a revalidation.
        expect(closedEvents).toBe(1);
        expect(revalidate).not.toHaveBeenCalled();
        expect(relay.errors).toEqual([]);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe("RemoteSession relay policy kills", () => {
  // Exact-delay assertions below: pin the redial jitter to its ceiling so the
  // capped rung schedules at precisely RECONNECT_MAX_BACKOFF_MS.
  let jitterPin: MockInstance<() => number>;
  beforeEach(() => {
    jitterPin = vi.spyOn(Math, "random").mockReturnValue(1);
  });
  afterEach(() => {
    jitterPin.mockRestore();
  });

  it.each(["peer_gone", "killed"] as const)(
    "%s{policy_violation} drops without going terminal and schedules the capped reconnect",
    async (controlType) => {
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("valid-token", "user-1");
      const recorder = new RecordingEvidence();
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        evidence: recorder,
      });
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);

        // MUST clear before the kill. The ready boundary arms the ladder
        // probation timer at RECONNECT_STABLE_RESET_MS, which is the same
        // 30_000 as RECONNECT_MAX_BACKOFF_MS - so without this the assertion
        // below is satisfied by that timer no matter what the backoff
        // scheduled, and it passed for months against a redial that was
        // actually armed at 16s.
        setTimeoutSpy.mockClear();

        relay.sendRelayKill(controlType, "policy_violation");

        expect(session.isReady()).toBe(false);
        expect(session.isClosed()).toBe(false);
        expect(session.terminalFatal()).toBeNull();
        expect(setTimeoutSpy).toHaveBeenCalledWith(
          expect.any(Function),
          RECONNECT_MAX_BACKOFF_MS,
        );
        const indeterminates = recorder.callsNamed("reportDialIndeterminate");
        expect(indeterminates).toHaveLength(1);
        expect(indeterminates[0].hostId).toBe("host-1");
        expect(indeterminates[0].transportKind).toBe("remote-relay");
        expect(recorder.callsNamed("reportDialRefusal")).toHaveLength(0);
      } finally {
        session.close();
        setTimeoutSpy.mockRestore();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "peer_gone{revoked} remains terminal with an UNAUTHORIZED verdict",
    async () => {
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("valid-token", "user-1");
      const session = buildSession(relay, lease, null);
      let closedEvents = 0;
      session.onClosed(() => {
        closedEvents += 1;
      });
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);

        relay.sendRelayKill("peer_gone", "revoked");

        await vi.waitFor(() => expect(session.isClosed()).toBe(true), WAIT);
        expect(closedEvents).toBe(1);
        expect(session.terminalFatal()).toEqual({
          code: "UNAUTHORIZED",
          reason: "Host access was revoked",
          incompatibleMethods: null,
          upgradeGuidance: null,
        });
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  it.each(["peer_gone", "killed"] as const)(
    "%s{future_reason} is parsed as a capped retryable transport loss",
    async (controlType) => {
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("valid-token", "user-1");
      const recorder = new RecordingEvidence();
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        evidence: recorder,
      });
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);

        // Same constant collision as the arm above - clear, or the cap
        // assertion is answered by the probation timer rather than by the
        // redial this test is about.
        setTimeoutSpy.mockClear();

        relay.sendRelayKill(controlType, "future_reason");

        expect(session.isReady()).toBe(false);
        expect(session.isClosed()).toBe(false);
        expect(session.terminalFatal()).toBeNull();
        expect(setTimeoutSpy).toHaveBeenCalledWith(
          expect.any(Function),
          RECONNECT_MAX_BACKOFF_MS,
        );
        expect(setTimeoutSpy).not.toHaveBeenCalledWith(
          expect.any(Function),
          RECONNECT_INITIAL_BACKOFF_MS,
        );
        const indeterminates = recorder.callsNamed("reportDialIndeterminate");
        expect(indeterminates).toHaveLength(1);
        expect(indeterminates[0].hostId).toBe("host-1");
        expect(indeterminates[0].transportKind).toBe("remote-relay");
        expect(recorder.callsNamed("reportDialRefusal")).toHaveLength(0);
      } finally {
        session.close();
        setTimeoutSpy.mockRestore();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe("RemoteSession plan-restricted entitlement denial", () => {
  it(
    "goes terminal on a plan-restricted mint - one mint, no relay dial, no revalidation spend",
    async () => {
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("valid-token", "user-1");
      const revalidate = vi.fn(() => Promise.resolve("rotated" as const));
      let mintCalls = 0;
      let nextRequestId = 0;
      const session = new RemoteSession({
        hostId: "host-1",
        attachBaseUrl: "wss://relay.test/attach",
        hostStaticPublicKey: relay.hostStaticPublicKey,
        grantProvider: () => {
          mintCalls += 1;
          return Promise.resolve({ kind: "plan-restricted" as const });
        },
        bearer: () => lease,
        auth: { revalidateForReconnect: revalidate },
        rpcRegistry: emptyRpcRegistry,
        streamRegistry: emptyStreamRegistry,
        webSocketFactory: relay.factory,
        requestId: () => `req-${(nextRequestId += 1)}`,
        evidence: NO_TRANSPORT_EVIDENCE,
        clientIdentity: TEST_CLIENT_IDENTITY,
      });
      const streamClient = new RemoteStreamClient(session);
      let closedEvents = 0;
      streamClient.onClosed(() => {
        closedEvents += 1;
      });
      try {
        session.start();
        await vi.waitFor(
          () => expect(streamClient.isClosed()).toBe(true),
          WAIT,
        );
        // Terminal, not a backoff loop: exactly one mint, and the relay was
        // never dialed with a grant the account is not entitled to.
        expect(closedEvents).toBe(1);
        expect(mintCalls).toBe(1);
        expect(relay.openBearers).toEqual([]);
        // An entitlement denial is NOT an auth failure - no revalidation.
        expect(revalidate).not.toHaveBeenCalled();
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe("RemoteSession availability-recovered evidence", () => {
  it(
    "fires (through RemoteStreamClient) at EVERY ready boundary - the clean first open AND a post-drop re-attach",
    async () => {
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("valid-token", "user-1");
      const session = buildSession(relay, lease, null);
      const streamClient = new RemoteStreamClient(session);
      let recoveredEvents = 0;
      streamClient.subscribeAvailabilityRecovered(() => {
        recoveredEvents += 1;
      });
      let closedEvents = 0;
      streamClient.onClosed(() => {
        closedEvents += 1;
      });
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        // The clean first open IS evidence: queries that raced this dial have
        // already errored pre-send and this is their only automatic refetch
        // signal (the 15-20s stranded Providers card). Exactly one emission.
        expect(recoveredEvents).toBe(1);

        relay.dropCurrentConnection();
        await vi.waitFor(() => expect(recoveredEvents).toBe(2), WAIT);
        // The second emission was a reconnect, not a terminal close.
        expect(session.isReady()).toBe(true);
        expect(closedEvents).toBe(0);
        expect(relay.openBearers).toEqual(["valid-token", "valid-token"]);
        expect(relay.errors).toEqual([]);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe("RemoteSession reconnect ladder accounting", () => {
  // Exact-delay assertions below: pin the redial jitter to its ceiling so
  // rung delays equal their un-jittered bases.
  let jitterPin: MockInstance<() => number>;
  beforeEach(() => {
    jitterPin = vi.spyOn(Math, "random").mockReturnValue(1);
  });
  afterEach(() => {
    jitterPin.mockRestore();
  });

  // `RECONNECT_STABLE_RESET_MS` and `RECONNECT_MAX_BACKOFF_MS` are BOTH
  // 30_000, and the ready boundary arms the former. Any assertion that "the
  // backoff was the cap" which does not first clear the spy is therefore
  // satisfied by the probation timer regardless of what the backoff actually
  // scheduled - which is why the arms below clear before acting.

  it(
    "cancels the ladder-reset probation timer on the host_detached edge",
    async () => {
      // `host_detached` does NOT run through `handleConnectionLost`, so it is
      // the one loss edge that never reached the funnel's
      // `clearStableResetTimer`. Left running, the probation timer counts a
      // host that is ABSENT as sustained health and resets `reconnectAttempt`
      // to 0 - so the full reconnect that `host_attached` then triggers is
      // handed the immediate rung, which is precisely the flapping-host
      // hammering the probation window exists to prevent.
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("valid-token", "user-1");
      const session = buildSession(relay, lease, null);
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);

        // Premise: exactly one probation timer is armed, at the ready
        // boundary. If this ever picks up a second 30s timer the handle
        // assertion below would be testing the wrong one.
        const armed = setTimeoutSpy.mock.results
          .filter(
            (_result, index) =>
              setTimeoutSpy.mock.calls[index][1] === RECONNECT_STABLE_RESET_MS,
          )
          .map((result) => result.value);
        expect(armed).toHaveLength(1);

        clearTimeoutSpy.mockClear();
        relay.sendHostAttachment("host_detached");

        expect(clearTimeoutSpy).toHaveBeenCalledWith(armed[0]);
      } finally {
        session.close();
        setTimeoutSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "cancels the ladder-reset probation timer when an UNAUTHORIZED session fatal drops a ready session",
    async () => {
      // The third loss edge that bypassed the funnel, and the one the
      // `host_detached` fix above does NOT cover:
      // `handleUnauthorizedSessionFatal` calls `dropConnection()` directly and
      // then awaits credential revalidation. Revalidation is a network round
      // trip against the auth plane, so the disconnected window is open-ended
      // - and for as long as the probation timer runs through it, an ABSENT
      // host is being counted as sustained health. If it expires there,
      // `reconnectAttempt` returns to 0 and the redial that revalidation
      // finally triggers is handed the immediate rung, hammering a host that
      // has just refused this client's credential.
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("valid-token", "user-1");
      // Held open deliberately. Letting revalidation resolve would redial, and
      // the next ready boundary calls `clearStableResetTimer` on its way to
      // arming a fresh probation timer - which would satisfy the assertion
      // below through the RECOVERY path rather than the drop, and the test
      // would pass against the unfixed code. The bug lives entirely in the
      // window this pause holds open.
      let releaseRevalidation: () => void = () => undefined;
      const auth: StreamAuthRevalidator = {
        revalidateForReconnect: () =>
          new Promise((resolve) => {
            releaseRevalidation = () => resolve("rotated");
          }),
      };
      const session = buildSession(relay, lease, auth);
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);

        // Premise, same as the sibling above: exactly one 30s timer exists, so
        // this fingerprints the probation timer and not `RECONNECT_MAX_BACKOFF_MS`.
        const armed = setTimeoutSpy.mock.results
          .filter(
            (_result, index) =>
              setTimeoutSpy.mock.calls[index][1] === RECONNECT_STABLE_RESET_MS,
          )
          .map((result) => result.value);
        expect(armed).toHaveLength(1);

        clearTimeoutSpy.mockClear();
        await relay.sendStreamFatal(
          SESSION_CONTROL_STREAM_ID,
          unauthorizedDetails(),
        );
        await vi.waitFor(() => expect(session.isReady()).toBe(false), WAIT);

        expect(clearTimeoutSpy).toHaveBeenCalledWith(armed[0]);
      } finally {
        releaseRevalidation();
        session.close();
        setTimeoutSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "a congestion kill after the session reached ready redials at the full cap, not one rung under it",
    async () => {
      // `raiseReconnectBackoffToMax` solves for the ATTEMPT whose backoff is
      // the cap, but post-ready `scheduleReconnect` reads rung `attempt - 1`
      // (rung 0 is the immediate recovery redial). Ignoring that offset lands
      // one rung short - 16s against a promised 30s - so a relay
      // `policy_violation`, which is a congestion signal, redials an already
      // overloaded relay at half the interval it claims to.
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("valid-token", "user-1");
      const session = new RemoteSession(
        buildSessionOptions(relay, lease, null),
      );
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        setTimeoutSpy.mockClear();

        relay.sendRelayKill("killed", "policy_violation");

        const delays = setTimeoutSpy.mock.calls.map((call) => call[1]);
        expect(delays).toContain(RECONNECT_MAX_BACKOFF_MS);
        // The value the regression actually produces: rung 4 of the doubling
        // ladder rather than rung 5. Derived from the constants so it tracks
        // them if they move.
        //
        // It was written as `RECONNECT_MAX_BACKOFF_MS / 2` (15_000), which is
        // not a rung of a ladder that doubles from 1_000 and therefore could
        // never fail - the positive assertion above was carrying this test on
        // its own. Same family as the 30_000 collision this file works around
        // in three places: an assertion naming a plausible number rather than
        // a reachable one.
        expect(delays).not.toContain(RECONNECT_INITIAL_BACKOFF_MS * 2 ** 4);
      } finally {
        session.close();
        setTimeoutSpy.mockRestore();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "reports reattach duration from the moment the link was lost, including the backoff wait",
    async () => {
      // The clock used to start at `beginConnect`, so the backoff the client
      // imposed on ITSELF was excluded: a 1s wait plus a 5ms dial logged
      // "reattached in 5ms" against 1005ms of real user downtime, and the
      // budget the line exists to make falsifiable could not be checked.
      //
      // Two drops, because the FIRST post-ready drop takes the immediate rung
      // (0ms) and would leave nothing to exclude. The second pays rung 0 of
      // the ladder, `RECONNECT_INITIAL_BACKOFF_MS`, which is what must show up
      // in the total.
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("valid-token", "user-1");
      const session = buildSession(relay, lease, null);
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);

        relay.sendRelayKill("killed", "host_gone");
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);

        infoSpy.mockClear();
        // The ready boundary arms a 30s probation timer, but the rung under
        // test is 1s. Clear first so this proves the reconnect timer itself,
        // not a timer left by the preceding recovery.
        setTimeoutSpy.mockClear();
        relay.sendRelayKill("killed", "host_gone");
        expect(setTimeoutSpy).toHaveBeenCalledWith(
          expect.any(Function),
          RECONNECT_INITIAL_BACKOFF_MS,
        );
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);

        const line = infoSpy.mock.calls
          .map((call) => String(call[0]))
          .find((text) => text.includes("reattached in"));
        expect(line).toBeDefined();
        const total = Number(/reattached in (\d+)ms/.exec(line ?? "")?.[1]);
        const wait = Number(/wait=(\d+)ms/.exec(line ?? "")?.[1]);
        // `wait` is the difference between integer-millisecond `Date.now()`
        // stamps, while the real timer may be armed from the event loop's
        // clock sample taken one tick before the loss handler's stamp. A
        // genuine 1,000ms timer can therefore log 999ms; one millisecond is
        // the full possible skew because both printed stamps have 1ms units.
        // The exact 1,000ms arm is asserted above, independently of this
        // observation boundary.
        expect(wait).toBeGreaterThanOrEqual(RECONNECT_INITIAL_BACKOFF_MS - 1);
        expect(total).toBeGreaterThanOrEqual(wait);
      } finally {
        session.close();
        infoSpy.mockRestore();
        setTimeoutSpy.mockRestore();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe("RemoteSession host_detached readiness evidence", () => {
  it(
    "stops answering ready and rejects sends as retryable while the host leg is detached, then recovers through the full re-attach",
    async () => {
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("valid-token", "user-1");
      const session = buildSession(relay, lease, null);
      let recoveredEvents = 0;
      session.subscribeAvailabilityRecovered(() => {
        recoveredEvents += 1;
      });
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        expect(recoveredEvents).toBe(1);

        // Relay says the HOST's leg is gone. The session keeps its socket and
        // its "ready" phase while it waits - but the scheduler is paused and
        // nothing will drain it, so answering "ready" would be the standing
        // lie R4-B5 kills (Settings rendering Online, off this session, for a
        // host that is OFF - for up to the 15-min standing bound), and an
        // enqueued unary would just die at the 30s timeout as NON-retryable.
        relay.sendHostAttachment("host_detached");
        expect(session.isReady()).toBe(false);
        expect(session.isClosed()).toBe(false);

        const error: unknown = await session
          .sendUnary("host.status", {}, null, undefined)
          .then(
            () => null,
            (reason: unknown) => reason,
          );
        expect(error).toBeInstanceOf(RetryableTransportError);

        // `host_attached` out of detached means the host rebuilt its Noise
        // state - the session routes it through a FULL re-attach, whose ready
        // boundary restores the evidence and fires availability recovery.
        relay.sendHostAttachment("host_attached");
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        expect(recoveredEvents).toBe(2);
        expect(relay.errors).toEqual([]);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "retracts the AUTHORITY session on host_detached (the socket stays), and re-announces at the re-attach's ready boundary",
    async () => {
      // The arm above pins the readiness LATCH (`isReady()`), which is what
      // `hasReadyRemoteSession` reads. This one pins the other announcement
      // this connection makes: the selection authority's session, whose
      // presence suppresses every death verdict for the host and pins its
      // lease `ready`. It used to survive the detach, reasoning from the
      // latch - a different consumer - so a remote host whose box lost power
      // read `ready` in every window, refusals against it were dropped, no
      // corpse ceiling armed, and failover waited on the 15-minute standing
      // bound (re-armed by every attach, so measured from the LAST attach).
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("valid-token", "user-1");
      const recorder = new RecordingEvidence();
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        evidence: recorder,
      });
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        const established = recorder.callsNamed("sessionEstablished");
        expect(established).toHaveLength(1);
        const firstSessionId = established[0].sessionId;
        // Premise: nothing retracted yet.
        expect(recorder.callsNamed("sessionLost")).toEqual([]);

        relay.sendHostAttachment("host_detached");
        // The socket is kept (the re-attach path depends on it) ...
        expect(session.isClosed()).toBe(false);
        // ... and the authority session is retracted, by name, at once.
        const lost = recorder.callsNamed("sessionLost");
        expect(lost).toHaveLength(1);
        expect(lost[0].sessionId).toBe(firstSessionId);
        expect(lost[0].hostId).toBe("host-1");

        // The re-attach redials and reaches a NEW ready boundary, which
        // announces a fresh session under the next connect generation.
        relay.sendHostAttachment("host_attached");
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        const reestablished = recorder.callsNamed("sessionEstablished");
        expect(reestablished).toHaveLength(2);
        expect(reestablished[1].sessionId).not.toBe(firstSessionId);
        expect(recorder.callsNamed("sessionLost")).toHaveLength(1);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe("RemoteStreamClient dynamic subscribe params", () => {
  it(
    "selects an installed older stream major advertised by an RC host",
    async () => {
      const relay = new FakeRelayHost();
      relay.streamManifest = {
        "cursor.subscribe": { major: 1, minor: 0 },
      };
      const lease = new MutableBearerLease("valid-token", "user-1");
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        streamRegistry: dualMajorCursorStreamRegistry,
      });
      const streamClient = new RemoteStreamClient<
        VersionedRpcRegistry,
        typeof dualMajorCursorStreamRegistry
      >(session);
      const stream = streamClient.subscribe("cursor.subscribe", {
        cursor: null,
      });
      try {
        await vi.waitFor(
          () => expect(relay.subscribeParams).toHaveLength(1),
          WAIT,
        );
        expect(relay.subscribeSchemaVersions[0]).toEqual({
          major: 1,
          minor: 0,
          supportedMajors: [1, 2],
        });
        expect(relay.errors).toEqual([]);
      } finally {
        stream.close();
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "re-reads the current params before a reconnect re-subscribes",
    async () => {
      const relay = new FakeRelayHost();
      relay.streamManifest = buildStreamManifest(
        cursorStreamRegistry,
        SERVES_EVERY_INSTALLED_MAJOR,
      );
      const lease = new MutableBearerLease("valid-token", "user-1");
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        streamRegistry: cursorStreamRegistry,
      });
      const streamClient = new RemoteStreamClient<
        VersionedRpcRegistry,
        typeof cursorStreamRegistry
      >(session);
      let cursor: number | null = null;
      const stream = streamClient.subscribeWithParamsProvider(
        "cursor.subscribe",
        () => ({ cursor }),
      );
      try {
        await vi.waitFor(
          () => expect(relay.subscribeParams).toHaveLength(1),
          WAIT,
        );
        expect(relay.subscribeParams[0]).toEqual({ cursor: null });

        // Advance application state while the first physical connection is
        // live. Freezing the provider at stream creation makes this assertion
        // fail with the original null cursor (the required ablation).
        cursor = 42;
        relay.dropCurrentConnection();
        await vi.waitFor(
          () => expect(relay.subscribeParams).toHaveLength(2),
          WAIT,
        );
        expect(relay.subscribeParams[1]).toEqual({ cursor: 42 });
        expect(relay.errors).toEqual([]);
      } finally {
        stream.close();
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe("RemoteSession dial-failure logging", () => {
  // These pin the WIRING, not the throttle itself (dial-failure-log.test.ts
  // owns that): a failing connect loop must produce a line saying WHY, and a
  // recovered session must say it recovered. The console is the sink on
  // purpose - shared OSS transport code has no logger seam, and the desktop
  // shell forwards renderer console output into its log file.

  function sessionLines(
    calls: ReadonlyArray<ReadonlyArray<unknown>>,
  ): string[] {
    return calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith("[remote-session]"));
  }

  it(
    "logs a grant-mint failure once, with its detail, and suppresses identical retries",
    async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("token", "user-1");
      let mintCalls = 0;
      const options = buildSessionOptions(relay, lease, null);
      const session = new RemoteSession({
        ...options,
        grantProvider: () => {
          mintCalls += 1;
          return Promise.resolve({
            kind: "unavailable" as const,
            detail: "authn answered HTTP 500",
            context: "signing key missing",
          });
        },
      });
      try {
        session.start();
        // Three attempts land inside ~4s of backoff (0s, 1s, 3s).
        await vi.waitFor(() => expect(mintCalls).toBeGreaterThanOrEqual(3), {
          timeout: 10_000,
          interval: 50,
        });
        const lines = sessionLines(warnSpy.mock.calls);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain("could not mint an attach grant");
        expect(lines[0]).toContain("authn answered HTTP 500");
        expect(lines[0]).toMatch(/retrying in \d+ms/);
      } finally {
        session.close();
        warnSpy.mockRestore();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "names a pre-attach_ack socket close for what it cannot distinguish (DNS / refused / rejected upgrade)",
    async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("token", "user-1");
      // A factory whose sockets die instantly with the browser's opaque
      // 1006/empty close - exactly what a nonexistent relay hostname
      // produced in the real outage.
      const deadFactory: IStreamWebSocketFactory = {
        create: (): StreamWebSocketLike => {
          const socket = new FakeSocket(
            () => undefined,
            () => undefined,
          );
          queueMicrotask(() => {
            socket.onclose?.({ code: 1006, reason: "", wasClean: false });
          });
          return socket;
        },
      };
      const options = buildSessionOptions(relay, lease, null);
      const session = new RemoteSession({
        ...options,
        webSocketFactory: deadFactory,
      });
      try {
        session.start();
        await vi.waitFor(
          () =>
            expect(sessionLines(warnSpy.mock.calls).length).toBeGreaterThan(0),
          { timeout: 10_000, interval: 50 },
        );
        const line = sessionLines(warnSpy.mock.calls)[0];
        expect(line).toContain("code=1006");
        expect(line).toContain("before attach_ack");
        expect(line).toContain("DNS failure");
      } finally {
        session.close();
        warnSpy.mockRestore();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "logs the recovery line once a previously-failing session has HELD ready for the dwell",
    async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("token", "user-1");
      let mintCalls = 0;
      const options = buildSessionOptions(relay, lease, null);
      // The dwell timer has to be armed against the fake implementation to be
      // firable at all, so this precedes the session's construction.
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const session = new RemoteSession({
        ...options,
        grantProvider: () => {
          mintCalls += 1;
          if (mintCalls < 3) {
            return Promise.resolve({
              kind: "unavailable" as const,
              detail: "authn answered HTTP 500",
              context: "",
            });
          }
          return Promise.resolve({
            kind: "ok" as const,
            grant: { grant: "grant-jws", expiresInSeconds: 300 },
          });
        },
      });
      // Matched on the recovery wording rather than the line prefix: the
      // session writes other `[remote-session]` info lines (an early redial),
      // and this suite is about the failure log's own recovery statement.
      const recoveryLines = (): string[] =>
        infoSpy.mock.calls
          .map((call) => String(call[0]))
          .filter((line) => line.includes("recovered after"));
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        // Reaching ready is not recovery. A connection that opens and dies
        // seconds later reaches this boundary every time, so the log must not
        // announce a recovery the connection has not yet earned.
        expect(recoveryLines()).toEqual([]);

        vi.advanceTimersByTime(RECONNECT_STABLE_RESET_MS + 1_000);

        const recoveries = recoveryLines();
        expect(recoveries).toHaveLength(1);
        expect(recoveries[0]).toContain(
          "recovered after 2 consecutive failures",
        );
        expect(relay.errors).toEqual([]);
      } finally {
        session.close();
        vi.useRealTimers();
        warnSpy.mockRestore();
        infoSpy.mockRestore();
      }
    },
    TEST_BUDGET_MS,
  );

  it("rejects on a TERMINAL session as a non-retryable transport failure", async () => {
    // "Not ready" covers two opposite futures. A dialing session will become
    // ready; a closed one never will - `close()` is terminal and `start()`
    // only re-dials from idle. Waiting on a closed session would park forever,
    // and calling it retryable would make the retry wrapper spend its whole
    // budget on a session that cannot answer (the Providers panel did exactly
    // that). A CLOSED session must reject immediately, non-retryable.
    const relay = new FakeRelayHost();
    const lease = new MutableBearerLease("token", "user-1");
    const session = buildSession(relay, lease, null);
    session.close();
    expect(session.isClosed()).toBe(true);

    const error: unknown = await session
      .sendUnary("host.status", {}, null, undefined)
      .then(
        () => null,
        (reason: unknown) => reason,
      );

    expect(error).toBeInstanceOf(HostTransportFailureError);
    expect(error).not.toBeInstanceOf(RetryableTransportError);
  });

  it(
    "awaits the ready boundary and then sends while the session is still dialing",
    async () => {
      // D5.2: a still-dialing session is no longer rejected pre-send. The
      // call parks on the session's own phase machine and dispatches once the
      // fake relay completes the attach - which is the contract every consumer
      // that races a fresh remote session's first dial now depends on.
      const statusContract = defineRpcContract({
        method: "host.status",
        schemaVersion: { major: 1, minor: 0 } as const,
        requestSchema: z.object({}),
        responseSchema: z.object({ ready: z.boolean() }),
      });
      const statusRegistry: VersionedRpcRegistry =
        defineFloorAwareVersionedRpcRegistry(["host.status"] as const, {
          "host.status": {
            1: {
              latestMinor: 0,
              versions: {
                0: {
                  contract: statusContract,
                  upgradeFromPreviousVersion: null,
                },
              },
              downgradePathsFromLatest: {},
            },
          },
        });
      const relay = new FakeRelayHost();
      relay.floorRpcManifest = { "host.status": { major: 1, minor: 0 } };
      relay.unaryResult = { ready: true };
      const lease = new MutableBearerLease("token", "user-1");
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        rpcRegistry: statusRegistry,
      });
      try {
        session.start();
        expect(session.isReady()).toBe(false);
        expect(session.isClosed()).toBe(false);

        const resultPromise = session.sendUnary(
          "host.status",
          {},
          null,
          undefined,
        );
        // Still not ready when the call is issued - the await-ready path must
        // hold rather than reject.
        expect(session.isReady()).toBe(false);

        const result = await resultPromise;
        expect(session.isReady()).toBe(true);
        expect(result).toEqual({ ready: true });
        expect(relay.unaryRequests).toHaveLength(1);
        expect(relay.unaryRequests[0]?.method).toBe("host.status");
        expect(relay.errors).toEqual([]);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "rejects an in-flight sendUnary as retryable when the attach attempt fails mid-dial",
    async () => {
      // A parked caller is riding THIS attach attempt: if the socket drops
      // before ready, the wait must reject RetryableTransportError (pre-send,
      // so the caller's retry license buys a fresh attach) rather than hang.
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("token", "user-1");
      // Factory whose sockets die before the handshake can finish - same
      // shape as a DNS/refused mid-dial.
      const deadFactory: IStreamWebSocketFactory = {
        create: (): StreamWebSocketLike => {
          const socket = new FakeSocket(
            () => undefined,
            () => undefined,
          );
          queueMicrotask(() => {
            socket.onclose?.({
              code: 1006,
              reason: "mid-dial-drop",
              wasClean: false,
            });
          });
          return socket;
        },
      };
      const options = buildSessionOptions(relay, lease, null);
      const session = new RemoteSession({
        ...options,
        webSocketFactory: deadFactory,
      });
      try {
        session.start();
        const error: unknown = await session
          .sendUnary("host.status", {}, null, undefined)
          .then(
            () => null,
            (reason: unknown) => reason,
          );
        // RetryableTransportError extends HostTransportFailureError - the
        // pin is that the class carries the retry license (subclass), not a
        // terminal transport failure alone.
        expect(error).toBeInstanceOf(RetryableTransportError);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "rejects an in-flight sendUnary as non-retryable when the session goes terminal mid-wait",
    async () => {
      // A plan-restricted grant is terminal: a parked caller must get
      // HostTransportFailureError (with fatal details), not hang forever and
      // not inherit a retry license for a session that will never answer.
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("token", "user-1");
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        grantProvider: () =>
          Promise.resolve({ kind: "plan-restricted" as const }),
      });
      try {
        session.start();
        const error: unknown = await session
          .sendUnary("host.status", {}, null, undefined)
          .then(
            () => null,
            (reason: unknown) => reason,
          );
        expect(error).toBeInstanceOf(HostTransportFailureError);
        expect(error).not.toBeInstanceOf(RetryableTransportError);
        expect(
          (error as HostTransportFailureError).fatalDetails,
        ).not.toBeNull();
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "rejects a parked sendUnary when the caller's authority aborts mid-dial",
    async () => {
      // Parking on the phase machine only became safe once the caller could
      // still get out. A cancelled TanStack read (or a replaced host binding)
      // aborts its authority; without this the call stayed parked for the
      // whole dial, holding the request coordinator's active slot, and then
      // dispatched to the host anyway at the ready boundary.
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("token", "user-1");
      const session = buildSession(relay, lease, null);
      const controller = new AbortController();
      try {
        session.start();
        expect(session.isReady()).toBe(false);
        const pending = session.sendUnary(
          "host.status",
          {},
          controller.signal,
          undefined,
        );
        controller.abort();

        const error: unknown = await pending.then(
          () => null,
          (reason: unknown) => reason,
        );
        expect(error).toBeInstanceOf(HostRequestAbortedError);
        // Never dispatched: the abort landed before any frame was enqueued,
        // and the session going ready afterwards must not resurrect it.
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        expect(relay.unaryRequests).toHaveLength(0);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "does not dispatch a request whose authority aborted between the ready boundary and the send",
    async () => {
      // The ordering the post-wait recheck exists for, and the one the abort
      // LISTENER cannot catch. Queuing the abort as a microtask from the
      // availability listener puts it ahead of the waiter's own continuation:
      // `settleReadyWaiters(true)` resolves (and DISPOSES this waiter's abort
      // listener) first, then the queued abort runs, and only then does
      // `sendUnary` resume - already past every guard except the recheck
      // immediately before the enqueue.
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("token", "user-1");
      const session = buildSession(relay, lease, null);
      const controller = new AbortController();
      session.subscribeAvailabilityRecovered(() => {
        queueMicrotask(() => {
          controller.abort();
        });
      });
      try {
        session.start();
        const error: unknown = await session
          .sendUnary("host.status", {}, controller.signal, undefined)
          .then(
            () => null,
            (reason: unknown) => reason,
          );
        expect(error).toBeInstanceOf(HostRequestAbortedError);
        // Never reached the wire, even though the session DID become ready.
        expect(session.isReady()).toBe(true);
        expect(relay.unaryRequests).toHaveLength(0);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe("RemoteSession negotiated-manifest publication", () => {
  // The registry is module-level by design (a host's manifest is a property
  // of the host process, not of one messenger), so these tests reset it.
  beforeEach(() => {
    resetNegotiatedManifests();
  });

  it(
    "publishes the openAck's merged rpc manifest at the ready boundary - optional methods included",
    async () => {
      const relay = new FakeRelayHost();
      // Methods the CLIENT's registry does not know: exactly the shape of an
      // optional (non-floor) method a newer host advertises - the case that
      // silently failed closed when the remote path did not publish.
      relay.optionalRpcManifest = {
        "host.usage.summary": { major: 1, minor: 0 },
        "workspace.writeFile": { major: 2, minor: 1 },
      };
      const lease = new MutableBearerLease("token", "user-1");
      const session = buildSession(relay, lease, null);
      // Fail-closed before any handshake: unknown, never false.
      expect(getNegotiatedHostMethods("host-1")).toBeNull();
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        expect(getNegotiatedHostMethods("host-1")).toEqual(
          new Set(["host.usage.summary", "workspace.writeFile"]),
        );
        expect(relay.errors).toEqual([]);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "refreshes the published set on re-attach - a host upgraded under a live session self-corrects",
    async () => {
      const relay = new FakeRelayHost();
      relay.optionalRpcManifest = {
        "host.usage.summary": { major: 1, minor: 0 },
      };
      const lease = new MutableBearerLease("token", "user-1");
      const session = buildSession(relay, lease, null);
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        expect(getNegotiatedHostMethods("host-1")).toEqual(
          new Set(["host.usage.summary"]),
        );
        // The host restarts on a newer binary advertising one more optional
        // method; the client's re-attach after the drop must overwrite the
        // stale entry without an app restart.
        relay.optionalRpcManifest = {
          "host.usage.summary": { major: 1, minor: 0 },
          "host.newly.added": { major: 1, minor: 0 },
        };
        relay.dropCurrentConnection();
        await vi.waitFor(
          () =>
            expect(getNegotiatedHostMethods("host-1")).toEqual(
              new Set(["host.usage.summary", "host.newly.added"]),
            ),
          WAIT,
        );
        expect(relay.errors).toEqual([]);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  /**
   * The version half of the same publish, mirroring `WsRpcClient`'s pin in
   * `ws-rpc-client.test.ts`. A2/critique finding 5: without the exact
   * negotiated `{major, minor}` per method, a same-major feature gate cannot
   * tell a V12 host from a V11 host that silently degraded the request.
   */
  it(
    "records the exact negotiated version from the session openAck",
    async () => {
      const relay = new FakeRelayHost();
      relay.optionalRpcManifest = {
        "host.usage.summary": { major: 2, minor: 4 },
      };
      const lease = new MutableBearerLease("token", "user-1");
      const session = buildSession(relay, lease, null);
      expect(
        getNegotiatedHostMethodVersion("host-1", "host.usage.summary"),
      ).toBeNull();
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        expect(
          getNegotiatedHostMethodVersion("host-1", "host.usage.summary"),
        ).toEqual({ major: 2, minor: 4 });
        expect(relay.errors).toEqual([]);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe("RemoteSession absent optional method", () => {
  // A method the client knows and the host never advertised. Before the
  // floor/optional split this was unreachable - the handshake fataled on the
  // skew - so the remote path had no degrade at all and would have answered a
  // generic RPC_ERROR. Callers key off E_HOST_UNSUPPORTED (the run-settings
  // write queue suppresses exactly that code to fall back to legacy
  // persist-on-next-send), so a generic error reads as a real failure.
  const unsupportedV10 = defineRpcContract({
    method: "host.syntheticUnsupported",
    schemaVersion: { major: 1, minor: 0 } as const,
    requestSchema: z.object({}),
    responseSchema: z.object({ ok: z.boolean() }),
  });
  // Typed as the erased `VersionedRpcRegistry` at the declaration (same shape
  // as `emptyRpcRegistry` above) so the session can take it directly - the
  // repo bans chained/`as unknown` assertions, and none is needed here.
  const unsupportedRegistry: VersionedRpcRegistry =
    defineFloorAwareVersionedRpcRegistry([] as const, {
      "host.syntheticUnsupported": {
        degrade: { kind: "unsupported" },
        1: {
          latestMinor: 0,
          versions: {
            0: { contract: unsupportedV10, upgradeFromPreviousVersion: null },
          },
          downgradePathsFromLatest: {},
        },
      },
    });

  it(
    "applies the declared unsupported degrade instead of a generic RPC_ERROR",
    async () => {
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("token", "user-1");
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        rpcRegistry: unsupportedRegistry,
      });
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        const error: unknown = await session
          .sendUnary("host.syntheticUnsupported", {}, null, undefined)
          .then(
            () => null,
            (reason: unknown) => reason,
          );
        expect(error).toBeInstanceOf(HostRpcError);
        expect((error as HostRpcError).code).toBe("E_HOST_UNSUPPORTED");
        expect(
          (error as HostRpcError).fatalDetails?.upgradeGuidance
            ?.hostShouldUpgrade,
        ).toBe(true);
        expect(relay.errors).toEqual([]);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe("RemoteSession fallback degrade version anchoring", () => {
  // `degrade.to` names version 1.0 while the target's canonical is 1.1. The
  // request handed to the fallback is ALREADY adapted to 1.0, so dispatching
  // it at canonical would validate `{}` against 1.1's `{verbose}` schema and
  // transform the response with the wrong contract. Re-entering the public
  // `sendUnary` would do exactly that - hence the version-preserving internal
  // dispatch this pins.
  const statusV10 = defineRpcContract({
    method: "host.status",
    schemaVersion: { major: 1, minor: 0 } as const,
    requestSchema: z.object({}),
    responseSchema: z.object({ ready: z.boolean() }),
  });
  const statusV11 = defineRpcContract({
    method: "host.status",
    schemaVersion: { major: 1, minor: 1 } as const,
    requestSchema: z.object({ verbose: z.boolean() }),
    responseSchema: z.object({ ready: z.boolean(), detail: z.string() }),
  });
  const skewFallbackV10 = defineRpcContract({
    method: "host.syntheticSkewFallback",
    schemaVersion: { major: 1, minor: 0 } as const,
    requestSchema: z.object({ label: z.string() }),
    // `detailSeen` is the DISCRIMINATOR: `detail` exists only on the 1.1
    // response, so it is true exactly when the response was decoded (and
    // upgraded) at canonical instead of at the declared 1.0.
    responseSchema: z.object({ summary: z.string(), detailSeen: z.boolean() }),
  });
  const upgradeStatus = defineUpgradePath<typeof statusV10, typeof statusV11>({
    from: statusV10.schemaVersion,
    to: statusV11.schemaVersion,
    upgradeRequest: () => ({ verbose: false }),
    upgradeResponse: (response) => ({
      ready: response.ready,
      detail: "upgraded",
    }),
  });
  const skewRegistry: VersionedRpcRegistry =
    defineFloorAwareVersionedRpcRegistry(["host.status"] as const, {
      "host.status": {
        1: {
          latestMinor: 1,
          versions: {
            0: { contract: statusV10, upgradeFromPreviousVersion: null },
            1: {
              contract: statusV11,
              upgradeFromPreviousVersion: upgradeStatus,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
      "host.syntheticSkewFallback": {
        degrade: defineFallbackMethodDegrade<
          typeof skewFallbackV10,
          typeof statusV10,
          "host.status"
        >({
          kind: "fallback",
          to: { method: "host.status", major: 1, minor: 0 },
          adaptRequest: () => ({}),
          adaptResponse: (response) => ({
            summary: response.ready ? "ready" : "not-ready",
            detailSeen: Object.prototype.hasOwnProperty.call(
              response,
              "detail",
            ),
          }),
        }),
        1: {
          latestMinor: 0,
          versions: {
            0: { contract: skewFallbackV10, upgradeFromPreviousVersion: null },
          },
          downgradePathsFromLatest: {},
        },
      },
    });

  it(
    "dispatches the fallback at degrade.to, not the target's canonical version",
    async () => {
      const relay = new FakeRelayHost();
      // The host has the older 1.0 target on its FLOOR and NOT the
      // fallback's own (optional) method.
      relay.floorRpcManifest = { "host.status": { major: 1, minor: 0 } };
      relay.unaryResult = { ready: true };
      const lease = new MutableBearerLease("token", "user-1");
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        rpcRegistry: skewRegistry,
      });
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        const result: unknown = await session.sendUnary(
          "host.syntheticSkewFallback",
          { label: "x" },
          null,
          undefined,
        );
        // adaptResponse ran over the DECLARED 1.0 response shape: no `detail`
        // key, i.e. no canonical-version upgrade was applied on the way back.
        expect(result).toEqual({ summary: "ready", detailSeen: false });
        // ONE request, sent as host.status anchored at the DECLARED 1.0 -
        // canonical 1.1 here would have rejected the adapted `{}` payload.
        expect(relay.unaryRequests).toHaveLength(1);
        expect(relay.unaryRequests[0]?.method).toBe("host.status");
        expect(relay.unaryRequests[0]?.schemaVersion).toEqual({
          major: 1,
          minor: 0,
        });
        expect(relay.unaryRequests[0]?.params).toEqual({});
        expect(relay.errors).toEqual([]);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe("RemoteSession wake", () => {
  it("pulls a redial forward from an escalated backoff instead of waiting it out", async () => {
    const relay = new FakeRelayHost();
    const lease = new MutableBearerLease("token", "user-1");
    // Four failed opens escalate the armed backoff through 1s/2s/4s to the
    // 8s step before the fifth is allowed to succeed.
    relay.decideOpen = (_bearer, openIndex) =>
      openIndex < 4
        ? { kind: "fatal", details: retryableDropDetails() }
        : { kind: "ack" };
    const session = buildSession(relay, lease, null);
    try {
      session.start();
      await vi.waitFor(() => expect(relay.openBearers).toHaveLength(4), {
        timeout: 12_000,
        interval: 50,
      });
      // A beat for the 4th fatal's async round trip to land and the 8s
      // backoff to actually be armed before waking it.
      await new Promise((resolve) => setTimeout(resolve, 300));
      session.wake("app-resumed", null);
      // The collapsed redial is a sub-second draw, so a budget well under
      // the armed tier's JITTERED minimum (8s halved, not 8s) is what makes
      // this an honest check rather than a race with the schedule.
      await vi.waitFor(() => expect(session.isReady()).toBe(true), {
        timeout: 2_500,
        interval: 50,
      });
      expect(relay.openBearers).toHaveLength(5);
      expect(relay.errors).toEqual([]);
    } finally {
      session.close();
    }
  }, 20_000);

  it(
    "does not dial instantly on wake - the collapse is a jittered sub-second draw, never zero",
    async () => {
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("token", "user-1");
      // A single failed open arms the 1s (initial) backoff.
      relay.decideOpen = (_bearer, openIndex) =>
        openIndex === 0
          ? { kind: "fatal", details: retryableDropDetails() }
          : { kind: "ack" };
      const session = buildSession(relay, lease, null);
      try {
        session.start();
        await vi.waitFor(() => expect(relay.openBearers).toHaveLength(1), WAIT);
        session.wake("app-resumed", null);
        // Shortly after the wake, no new dial has begun: the draw is bounded
        // below by half the initial backoff, so an immediate dial is not a
        // thing this can produce however loudly it is woken.
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(relay.openBearers).toHaveLength(1);
        // It still redials, on roughly the schedule the failure armed.
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        expect(relay.openBearers).toHaveLength(2);
        expect(relay.errors).toEqual([]);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  it("a burst of wakes during an escalated backoff produces exactly one extra dial", async () => {
    const relay = new FakeRelayHost();
    const lease = new MutableBearerLease("token", "user-1");
    // Three failed opens escalate the armed backoff to the 4s step.
    relay.decideOpen = (_bearer, openIndex) =>
      openIndex < 3
        ? { kind: "fatal", details: retryableDropDetails() }
        : { kind: "ack" };
    const session = buildSession(relay, lease, null);
    try {
      session.start();
      await vi.waitFor(() => expect(relay.openBearers).toHaveLength(3), {
        timeout: 8_000,
        interval: 50,
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      // Five wakes in a row - the app-switch-flapping case. The armed timer
      // carries ONE collapse, spent by the first of these; the rest find it
      // already spent and draw nothing, so no wake can outbid another.
      for (let i = 0; i < 5; i += 1) {
        session.wake(`app-resumed-${i}`, null);
      }
      await vi.waitFor(() => expect(session.isReady()).toBe(true), {
        timeout: 3_000,
        interval: 50,
      });
      // Exactly one extra dial, not five.
      expect(relay.openBearers).toHaveLength(4);
      expect(relay.errors).toEqual([]);
    } finally {
      session.close();
    }
  }, 15_000);

  it(
    "never lengthens a pending redial - repeated wakes on the initial backoff still dial on roughly the original schedule",
    async () => {
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("token", "user-1");
      relay.decideOpen = (_bearer, openIndex) =>
        openIndex === 0
          ? { kind: "fatal", details: retryableDropDetails() }
          : { kind: "ack" };
      const session = buildSession(relay, lease, null);
      try {
        session.start();
        await vi.waitFor(() => expect(relay.openBearers).toHaveLength(1), WAIT);
        const armedAt = Date.now();
        session.wake("wake-1", null);
        await new Promise((resolve) => setTimeout(resolve, 100));
        session.wake("wake-2", null);
        await new Promise((resolve) => setTimeout(resolve, 100));
        session.wake("wake-3", null);
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        const elapsedMs = Date.now() - armedAt;
        // One extra dial, and no wake pushed the deadline out: a draw landing
        // later than the deadline already armed is discarded rather than
        // applied, so waking a session can never cost it time.
        expect(relay.openBearers).toHaveLength(2);
        expect(elapsedMs).toBeLessThan(1_800);
        expect(relay.errors).toEqual([]);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "leaves a healthy, ready session untouched",
    async () => {
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("token", "user-1");
      const session = buildSession(relay, lease, null);
      let recoveredEvents = 0;
      session.subscribeAvailabilityRecovered(() => {
        recoveredEvents += 1;
      });
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        expect(relay.openBearers).toHaveLength(1);
        expect(recoveredEvents).toBe(1);

        session.wake("app-resumed", null);
        // Nothing to poke or collapse on a healthy session - give it a beat
        // and confirm it neither re-dialed nor re-fired recovery evidence.
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(session.isReady()).toBe(true);
        expect(relay.openBearers).toHaveLength(1);
        expect(recoveredEvents).toBe(1);
        expect(relay.errors).toEqual([]);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "does not poke a session that is mid-dial or in backoff - no ping traffic reaches the wire",
    async () => {
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("token", "user-1");
      // A single failed open leaves the session in backoff, never ready.
      relay.decideOpen = (_bearer, openIndex) =>
        openIndex === 0
          ? { kind: "fatal", details: retryableDropDetails() }
          : { kind: "ack" };
      const session = buildSession(relay, lease, null);
      try {
        session.start();
        await vi.waitFor(() => expect(relay.openBearers).toHaveLength(1), WAIT);

        // `wake` only pokes the socket of an already-ready session - a
        // connection that is mid-dial or sitting in backoff has nothing to
        // poke, so no keepalive traffic should reach the wire from this call.
        session.wake("app-resumed", null);
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(relay.pingCount).toBe(0);

        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        expect(relay.errors).toEqual([]);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "is a no-op on a closed session - it neither throws nor dials",
    async () => {
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("token", "user-1");
      relay.decideOpen = () => ({
        kind: "fatal",
        details: {
          code: "INCOMPATIBLE",
          reason: "manifest mismatch",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      });
      const session = buildSession(relay, lease, null);
      try {
        session.start();
        await vi.waitFor(() => expect(session.isClosed()).toBe(true), WAIT);
        const dialsBeforeWake = relay.openBearers.length;

        expect(() => session.wake("app-resumed", null)).not.toThrow();
        await new Promise((resolve) => setTimeout(resolve, 300));

        expect(relay.openBearers).toHaveLength(dialsBeforeWake);
        expect(session.isClosed()).toBe(true);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  it("keeps its escalation after a wake-driven redial that also fails - wake never resets the attempt counter", async () => {
    const relay = new FakeRelayHost();
    const lease = new MutableBearerLease("token", "user-1");
    relay.decideOpen = (_bearer, openIndex) =>
      openIndex < 3
        ? { kind: "fatal", details: retryableDropDetails() }
        : { kind: "ack" };
    const session = buildSession(relay, lease, null);
    try {
      session.start();
      // Two failures escalate the armed backoff to the 2s step.
      await vi.waitFor(() => expect(relay.openBearers).toHaveLength(2), {
        timeout: 6_000,
        interval: 50,
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      session.wake("app-resumed", null);
      // The woken redial (the third open) fails too - a real host outage,
      // not a resumed one. If `wake` had reset the attempt counter, THIS
      // failure would arm a fresh 1s backoff instead of continuing the
      // escalation to 4s.
      await vi.waitFor(() => expect(relay.openBearers).toHaveLength(3), {
        timeout: 3_000,
        interval: 50,
      });
      const armedAt = Date.now();
      // Give a reset-attempt bug every chance to fire: a restarted schedule
      // arms the initial tier, whose jittered draw tops out at 1s, so its
      // redial would already have landed well inside this window. The
      // continued escalation's own jittered minimum sits above it.
      await new Promise((resolve) => setTimeout(resolve, 1_800));
      expect(relay.openBearers).toHaveLength(3);
      await vi.waitFor(() => expect(session.isReady()).toBe(true), {
        timeout: 5_000,
        interval: 50,
      });
      expect(relay.openBearers).toHaveLength(4);
      expect(Date.now() - armedAt).toBeGreaterThanOrEqual(1_800);
      expect(relay.errors).toEqual([]);
    } finally {
      session.close();
    }
  }, 15_000);

  it("probes on the caller's deadline - a muted socket is dropped and re-dialed on the short probe, not the default one", async () => {
    const relay = new FakeRelayHost();
    const lease = new MutableBearerLease("token", "user-1");
    const session = buildSession(relay, lease, null);
    try {
      session.start();
      await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
      expect(relay.openBearers).toHaveLength(1);
      // The half-open shape an OS suspend leaves: sends go out, nothing
      // answers.
      relay.answerPings = false;
      session.wake("app-resumed", {
        timeoutMs: 250,
        immediateRedialOnFailure: false,
      });
      // The 250ms probe deadline fails the socket and the recovery redial
      // (immediate rung - this session was stable) dials again, all well
      // inside a second. Under the default 10s deadline nothing would have
      // moved yet - this window is what proves the caller's deadline was the
      // one armed.
      await vi.waitFor(() => expect(relay.openBearers).toHaveLength(2), {
        timeout: 1_200,
        interval: 25,
      });
      expect(relay.errors).toEqual([]);
    } finally {
      session.close();
    }
  }, 10_000);

  it("keeps the default wake-probe deadline when the caller supplies no tuning", async () => {
    const relay = new FakeRelayHost();
    const lease = new MutableBearerLease("token", "user-1");
    const session = buildSession(relay, lease, null);
    try {
      session.start();
      await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
      relay.answerPings = false;
      session.wake("app-resumed", null);
      await vi.waitFor(() => expect(relay.pingCount).toBeGreaterThan(0), WAIT);
      // The probe is in flight on the 10s default deadline, so well past the
      // mobile deadline the socket is still trusted and no redial has begun.
      // The discriminating window against the test above.
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(relay.openBearers).toHaveLength(1);
      expect(session.isReady()).toBe(true);
      expect(relay.errors).toEqual([]);
    } finally {
      session.close();
    }
  }, 10_000);

  it("a default-tuned wake joining an in-flight probe does not retract the arming wake's redial policy", async () => {
    const relay = new FakeRelayHost();
    const lease = new MutableBearerLease("token", "user-1");
    // Reach ready with the ladder escalated, exactly as the rung-skip test
    // below - the latch is only observable when a rung would otherwise wait.
    relay.decideOpen = (_bearer, openIndex) =>
      openIndex < 2
        ? { kind: "fatal", details: retryableDropDetails() }
        : { kind: "ack" };
    const session = buildSession(relay, lease, null);
    try {
      session.start();
      await vi.waitFor(() => expect(session.isReady()).toBe(true), {
        timeout: 8_000,
        interval: 50,
      });
      expect(relay.openBearers).toHaveLength(3);
      relay.answerPings = false;
      // The burst a real resume produces: the mobile resume arms the probe
      // with its policy, then a default-tuned trigger (`wake-online` crossing
      // the same edge) joins the SAME in-flight probe. The joiner must not
      // rewrite the policy the armed probe was started under.
      session.wake("app-resumed", {
        timeoutMs: 250,
        immediateRedialOnFailure: true,
      });
      session.wake("network-online", null);
      await vi.waitFor(() => expect(relay.openBearers).toHaveLength(4), {
        timeout: 900,
        interval: 25,
      });
      await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
      expect(relay.errors).toEqual([]);
    } finally {
      session.close();
    }
  }, 15_000);

  it("a failed probe with immediateRedialOnFailure skips the armed backoff rung", async () => {
    const relay = new FakeRelayHost();
    const lease = new MutableBearerLease("token", "user-1");
    // Two failed opens escalate the ladder before the third is allowed to
    // succeed, so the session reaches ready with its attempt counter NOT at
    // zero (the stable reset needs 30s of sustained health it will not get).
    relay.decideOpen = (_bearer, openIndex) =>
      openIndex < 2
        ? { kind: "fatal", details: retryableDropDetails() }
        : { kind: "ack" };
    const session = buildSession(relay, lease, null);
    try {
      session.start();
      await vi.waitFor(() => expect(session.isReady()).toBe(true), {
        timeout: 8_000,
        interval: 50,
      });
      expect(relay.openBearers).toHaveLength(3);
      relay.answerPings = false;
      session.wake("app-resumed", {
        timeoutMs: 250,
        immediateRedialOnFailure: true,
      });
      // Probe fails at ~250ms; the loss funnel arms the escalated rung
      // (jittered floor 1s), and the latch pulls that redial to NOW. The
      // fourth open landing inside 900ms is therefore only reachable with
      // the rung skipped: 250ms (probe) + a same-tick redial.
      await vi.waitFor(() => expect(relay.openBearers).toHaveLength(4), {
        timeout: 900,
        interval: 25,
      });
      await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
      expect(relay.errors).toEqual([]);
    } finally {
      session.close();
    }
  }, 15_000);

  it("a stronger poke UPGRADES an in-flight default arm - reverse order of the joined-burst case", async () => {
    const relay = new FakeRelayHost();
    const lease = new MutableBearerLease("token", "user-1");
    relay.decideOpen = (_bearer, openIndex) =>
      openIndex < 2
        ? { kind: "fatal", details: retryableDropDetails() }
        : { kind: "ack" };
    const session = buildSession(relay, lease, null);
    try {
      session.start();
      await vi.waitFor(() => expect(session.isReady()).toBe(true), {
        timeout: 8_000,
        interval: 50,
      });
      expect(relay.openBearers).toHaveLength(3);
      relay.answerPings = false;
      // The online edge arms first: 10s deadline, no immediate redial. The
      // measured resume lands second with STRONGER evidence - under
      // first-poke-owns it would be discarded and the user would sit out the
      // 10s arm; monotonic merge shortens the deadline and raises the policy.
      session.wake("network-online", null);
      session.wake("app-resumed", {
        timeoutMs: 250,
        immediateRedialOnFailure: true,
      });
      await vi.waitFor(() => expect(relay.openBearers).toHaveLength(4), {
        timeout: 900,
        interval: 25,
      });
      await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
      expect(relay.errors).toEqual([]);
    } finally {
      session.close();
    }
  }, 15_000);

  it("an answered arm retires its policy - the next arm starts from its own arguments", async () => {
    const relay = new FakeRelayHost();
    const lease = new MutableBearerLease("token", "user-1");
    relay.decideOpen = (_bearer, openIndex) =>
      openIndex < 2
        ? { kind: "fatal", details: retryableDropDetails() }
        : { kind: "ack" };
    const session = buildSession(relay, lease, null);
    try {
      session.start();
      await vi.waitFor(() => expect(session.isReady()).toBe(true), {
        timeout: 8_000,
        interval: 50,
      });
      expect(relay.openBearers).toHaveLength(3);
      // First arm: immediate-redial policy, and the relay ANSWERS it.
      const pingsBefore = relay.pingCount;
      session.wake("app-resumed", {
        timeoutMs: 3_000,
        immediateRedialOnFailure: true,
      });
      await vi.waitFor(
        () => expect(relay.pingCount).toBe(pingsBefore + 1),
        WAIT,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      // Second arm, after the answer: NO immediate-redial policy, and this
      // one fails. If retirement leaked the first arm's policy, the redial
      // would land inside the rung's jittered floor - the exact leak the
      // raise-only alternative to arm-scoped ownership would have had.
      relay.answerPings = false;
      session.wake("app-resumed-again", {
        timeoutMs: 250,
        immediateRedialOnFailure: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(relay.openBearers).toHaveLength(3);
      await vi.waitFor(() => expect(session.isReady()).toBe(true), {
        timeout: 8_000,
        interval: 50,
      });
      expect(relay.openBearers).toHaveLength(4);
      expect(relay.errors).toEqual([]);
    } finally {
      session.close();
    }
  }, 15_000);

  it("an ordinary server drop while the arm is unanswered inherits its immediate-redial policy", async () => {
    const relay = new FakeRelayHost();
    const lease = new MutableBearerLease("token", "user-1");
    relay.decideOpen = (_bearer, openIndex) =>
      openIndex < 2
        ? { kind: "fatal", details: retryableDropDetails() }
        : { kind: "ack" };
    const session = buildSession(relay, lease, null);
    try {
      session.start();
      await vi.waitFor(() => expect(session.isReady()).toBe(true), {
        timeout: 8_000,
        interval: 50,
      });
      expect(relay.openBearers).toHaveLength(3);
      relay.answerPings = false;
      session.wake("app-resumed", {
        timeoutMs: 3_000,
        immediateRedialOnFailure: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      // The socket dies with an ORDINARY close (1006 server-drop), before
      // the arm's own deadline. That close is negative wake-probe evidence
      // all the same - the user is still watching - so it inherits the arm's
      // policy rather than being reserved for the synthetic timeout tuple.
      relay.dropCurrentConnection();
      await vi.waitFor(() => expect(relay.openBearers).toHaveLength(4), {
        timeout: 900,
        interval: 25,
      });
      await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
      expect(relay.errors).toEqual([]);
    } finally {
      session.close();
    }
  }, 15_000);

  it("an ordinary server drop AFTER the arm was answered follows the normal rung", async () => {
    const relay = new FakeRelayHost();
    const lease = new MutableBearerLease("token", "user-1");
    relay.decideOpen = (_bearer, openIndex) =>
      openIndex < 2
        ? { kind: "fatal", details: retryableDropDetails() }
        : { kind: "ack" };
    const session = buildSession(relay, lease, null);
    try {
      session.start();
      await vi.waitFor(() => expect(session.isReady()).toBe(true), {
        timeout: 8_000,
        interval: 50,
      });
      expect(relay.openBearers).toHaveLength(3);
      const pingsBefore = relay.pingCount;
      session.wake("app-resumed", {
        timeoutMs: 3_000,
        immediateRedialOnFailure: true,
      });
      await vi.waitFor(
        () => expect(relay.pingCount).toBe(pingsBefore + 1),
        WAIT,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      // Liveness was proven; the arm is retired. A drop now is an ordinary
      // loss and waits out its rung - the discriminating arm against the
      // inherit-on-unanswered case above.
      relay.dropCurrentConnection();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(relay.openBearers).toHaveLength(3);
      await vi.waitFor(() => expect(session.isReady()).toBe(true), {
        timeout: 8_000,
        interval: 50,
      });
      expect(relay.openBearers).toHaveLength(4);
      expect(relay.errors).toEqual([]);
    } finally {
      session.close();
    }
  }, 15_000);

  it("a failed probe WITHOUT immediateRedialOnFailure keeps the armed backoff rung", async () => {
    const relay = new FakeRelayHost();
    const lease = new MutableBearerLease("token", "user-1");
    relay.decideOpen = (_bearer, openIndex) =>
      openIndex < 2
        ? { kind: "fatal", details: retryableDropDetails() }
        : { kind: "ack" };
    const session = buildSession(relay, lease, null);
    try {
      session.start();
      await vi.waitFor(() => expect(session.isReady()).toBe(true), {
        timeout: 8_000,
        interval: 50,
      });
      expect(relay.openBearers).toHaveLength(3);
      relay.answerPings = false;
      session.wake("app-resumed", {
        timeoutMs: 250,
        immediateRedialOnFailure: false,
      });
      // The same probe failure, without the latch: the redial waits out the
      // escalated rung (jittered floor 1s past the ~250ms probe). Still only
      // three opens at the window where the latched arm above had four - the
      // two arms MUST read differently or the gate is decorative.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(relay.openBearers).toHaveLength(3);
      await vi.waitFor(() => expect(session.isReady()).toBe(true), {
        timeout: 8_000,
        interval: 50,
      });
      expect(relay.openBearers).toHaveLength(4);
      expect(relay.errors).toEqual([]);
    } finally {
      session.close();
    }
  }, 15_000);

  /**
   * A one-method registry for the two `sendUnary` cases below, which need a
   * real dispatchable method rather than the suite's empty registries.
   */
  function statusRpcRegistry(): VersionedRpcRegistry {
    const statusContract = defineRpcContract({
      method: "host.status",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({}),
      responseSchema: z.object({ ready: z.boolean() }),
    });
    return defineFloorAwareVersionedRpcRegistry(["host.status"] as const, {
      "host.status": {
        1: {
          latestMinor: 0,
          versions: {
            0: { contract: statusContract, upgradeFromPreviousVersion: null },
          },
          downgradePathsFromLatest: {},
        },
      },
    });
  }

  it("a request merely ARRIVING during backoff does not collapse it", async () => {
    const relay = new FakeRelayHost();
    relay.floorRpcManifest = { "host.status": { major: 1, minor: 0 } };
    relay.unaryResult = { ready: true };
    const lease = new MutableBearerLease("token", "user-1");
    // Three failed opens leave the armed backoff on the 4s step (2-4s once
    // jitter is applied), which is far longer than a collapsed redial.
    relay.decideOpen = (_bearer, openIndex) =>
      openIndex < 3
        ? { kind: "fatal", details: retryableDropDetails() }
        : { kind: "ack" };
    const session = new RemoteSession({
      ...buildSessionOptions(relay, lease, null),
      rpcRegistry: statusRpcRegistry(),
    });
    try {
      session.start();
      await vi.waitFor(() => expect(relay.openBearers).toHaveLength(3), {
        timeout: 8_000,
        interval: 50,
      });
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Demand alone earns nothing. The call parks on the attempt the
      // backoff already owns; it does NOT hurry it. If arriving were enough,
      // ambient polling reads would collapse the long tiers continuously and
      // an unavailable host would be dialed in a loop.
      const pending = session.sendUnary("host.status", {}, null, undefined);
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      // A collapse would have dialed by now (its draw tops out at 1s); the
      // jittered 4s tier cannot have fired this early.
      expect(relay.openBearers).toHaveLength(3);

      await expect(pending).resolves.toEqual({ ready: true });
      expect(relay.errors).toEqual([]);
    } finally {
      session.close();
    }
  }, 15_000);

  it("wakes once the parked request has PROVABLY failed pre-send - the caller-Retry path", async () => {
    const relay = new FakeRelayHost();
    relay.floorRpcManifest = { "host.status": { major: 1, minor: 0 } };
    relay.unaryResult = { ready: true };
    const lease = new MutableBearerLease("token", "user-1");
    // Three failures: the parked call rides the third and is rejected by it,
    // which is the moment the wake is earned. The fourth open succeeds.
    relay.decideOpen = (_bearer, openIndex) =>
      openIndex < 3
        ? { kind: "fatal", details: retryableDropDetails() }
        : { kind: "ack" };
    const session = new RemoteSession({
      ...buildSessionOptions(relay, lease, null),
      rpcRegistry: statusRpcRegistry(),
    });
    try {
      session.start();
      // Park while the second failure's backoff is armed, so this caller
      // rides the third attempt and sees it fail.
      await vi.waitFor(() => expect(relay.openBearers).toHaveLength(2), {
        timeout: 6_000,
        interval: 50,
      });
      await expect(
        session.sendUnary("host.status", {}, null, undefined),
      ).rejects.toBeInstanceOf(RetryableTransportError);
      // Still pre-send, so the caller keeps its retry license - and the
      // failure it just proved has accelerated the NEXT redial rather than
      // leaving it on the tier that failure escalated to.
      const rejectedAt = Date.now();
      await vi.waitFor(() => expect(session.isReady()).toBe(true), {
        timeout: 2_500,
        interval: 50,
      });
      expect(Date.now() - rejectedAt).toBeLessThan(2_500);
      expect(relay.openBearers).toHaveLength(4);
      expect(relay.errors).toEqual([]);
    } finally {
      session.close();
    }
  }, 15_000);

  it("does not wake for a caller whose own request authority was aborted", async () => {
    const relay = new FakeRelayHost();
    relay.floorRpcManifest = { "host.status": { major: 1, minor: 0 } };
    relay.unaryResult = { ready: true };
    const lease = new MutableBearerLease("token", "user-1");
    relay.decideOpen = (_bearer, openIndex) =>
      openIndex < 3
        ? { kind: "fatal", details: retryableDropDetails() }
        : { kind: "ack" };
    const session = new RemoteSession({
      ...buildSessionOptions(relay, lease, null),
      rpcRegistry: statusRpcRegistry(),
    });
    const controller = new AbortController();
    try {
      session.start();
      await vi.waitFor(() => expect(relay.openBearers).toHaveLength(3), {
        timeout: 8_000,
        interval: 50,
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const pending = session.sendUnary(
        "host.status",
        {},
        controller.signal,
        undefined,
      );
      controller.abort();
      // An abandoned read is not evidence anybody is waiting, so its
      // rejection carries no wake - the abort error is not retryable.
      await expect(pending).rejects.toBeInstanceOf(HostRequestAbortedError);
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(relay.openBearers).toHaveLength(3);
    } finally {
      session.close();
    }
  }, 15_000);

  it("does not forgive the failure streak until the connection has SURVIVED", async () => {
    const relay = new FakeRelayHost();
    const lease = new MutableBearerLease("token", "user-1");
    // Three failures escalate to the 8s step, then the session goes ready.
    relay.decideOpen = (_bearer, openIndex) =>
      openIndex < 3
        ? { kind: "fatal", details: retryableDropDetails() }
        : { kind: "ack" };
    const session = buildSession(relay, lease, null);
    try {
      session.start();
      await vi.waitFor(() => expect(session.isReady()).toBe(true), {
        timeout: 12_000,
        interval: 50,
      });
      expect(relay.openBearers).toHaveLength(4);

      // Lose the connection well inside the proving dwell. Reaching ready
      // was not evidence this connection WORKS - a socket that opens and
      // dies seconds later reaches that boundary every time - so the streak
      // must still be at its escalated tier.
      session.requestSessionReconnect("forced-drop");
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      // Forgiving at the boundary would have armed a fresh sub-second
      // backoff and redialed inside this window; the escalated tier (4-8s
      // jittered) cannot have.
      expect(relay.openBearers).toHaveLength(4);

      await vi.waitFor(() => expect(session.isReady()).toBe(true), {
        timeout: 10_000,
        interval: 50,
      });
      expect(relay.openBearers).toHaveLength(5);
      expect(relay.errors).toEqual([]);
    } finally {
      session.close();
    }
  }, 25_000);

  /**
   * The two dwell cases below install fake timers BEFORE the session starts,
   * and that ordering is the whole test.
   *
   * A fake-timer implementation does not adopt timers already scheduled
   * against the real one, so switching over after the session has settled
   * leaves the dwell timer running natively: `advanceTimersByTime` cannot fire
   * it, and `clearTimeout` against it cannot be observed. Both cases then pass
   * or fail for reasons unrelated to what they assert - the cancellation case
   * in particular would pass whether or not the detach clears anything, which
   * is the one outcome a regression must never have.
   *
   * `shouldAdvanceTime` keeps the clock moving on its own, so the real Noise
   * handshake this harness performs still completes while the dwell stays
   * under the test's control.
   */
  function useDwellControlledTimers(): void {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  }

  it("forgives the streak once the connection has held for the whole dwell", async () => {
    const relay = new FakeRelayHost();
    const lease = new MutableBearerLease("token", "user-1");
    // Three failures escalate to the 8s step before the session goes ready.
    relay.decideOpen = (_bearer, openIndex) =>
      openIndex < 3
        ? { kind: "fatal", details: retryableDropDetails() }
        : { kind: "ack" };
    // Before `start()`: the dwell timer must be armed against the fake
    // implementation for this test to be able to fire it at all.
    useDwellControlledTimers();
    const session = buildSession(relay, lease, null);
    try {
      session.start();
      await vi.waitFor(() => expect(session.isReady()).toBe(true), {
        timeout: 12_000,
        interval: 50,
      });
      expect(relay.openBearers).toHaveLength(4);

      // Held, attached, and undisturbed for the full dwell: this connection
      // has proven itself, so the streak behind it is forgiven.
      vi.advanceTimersByTime(RECONNECT_STABLE_RESET_MS + 1_000);

      session.requestSessionReconnect("forced-drop");
      // Back at the fastest tier - the redial lands inside a window the
      // escalated tier could not have reached.
      await vi.waitFor(() => expect(session.isReady()).toBe(true), {
        timeout: 2_500,
        interval: 50,
      });
      expect(relay.openBearers).toHaveLength(5);
      expect(relay.errors).toEqual([]);
    } finally {
      session.close();
      vi.useRealTimers();
    }
  }, 25_000);

  it("cancels the pardon when the host leg detaches during the dwell", async () => {
    const relay = new FakeRelayHost();
    const lease = new MutableBearerLease("token", "user-1");
    relay.decideOpen = (_bearer, openIndex) =>
      openIndex < 3
        ? { kind: "fatal", details: retryableDropDetails() }
        : { kind: "ack" };
    useDwellControlledTimers();
    const session = buildSession(relay, lease, null);
    try {
      session.start();
      await vi.waitFor(() => expect(session.isReady()).toBe(true), {
        timeout: 12_000,
        interval: 50,
      });

      // The host's uplink goes away. This is the loss that keeps its socket
      // and its Noise session, so nothing tears the connection down - yet
      // the mux is carrying nothing and `isReady` says so. A dwell that ran
      // to completion through this would pardon a streak on the strength of
      // a connection that spent the whole window dead.
      relay.sendHostAttachment("host_detached");
      expect(session.isReady()).toBe(false);
      // Fires the dwell timer for real if the detach left it armed - which
      // is what makes this a regression rather than a formality.
      vi.advanceTimersByTime(RECONNECT_STABLE_RESET_MS + 1_000);

      session.requestSessionReconnect("forced-drop");
      // Still escalated: a pardoned streak would have redialed well inside
      // this window, and the escalated tier cannot.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(relay.openBearers).toHaveLength(4);
    } finally {
      session.close();
      vi.useRealTimers();
    }
  }, 25_000);

  it("RemoteStreamClient.reconnectAll wakes its OWN session and no other", async () => {
    const relay = new FakeRelayHost();
    const lease = new MutableBearerLease("token", "user-1");
    // Three failed opens escalate the armed backoff to the 4s step.
    relay.decideOpen = (_bearer, openIndex) =>
      openIndex < 3
        ? { kind: "fatal", details: retryableDropDetails() }
        : { kind: "ack" };
    const session = buildSession(relay, lease, null);
    const wakeSpy = vi.spyOn(session, "wake");
    // Built over an acquired view, as production does, so this also covers
    // the view's ownership guard: a client whose consumer has released must
    // not be able to hurry a session it no longer holds.
    const identity: RemoteSessionIdentity = {
      hostId: "host-reconnect-all-sweep",
      userId: "user-1",
      hostPublicKey: "public-key",
      relayAttachUrl: "wss://relay.test/attach",
      authRecovery: "revalidate",
      authEpoch: "epoch-1",
    };
    const view = acquireRemoteSession(
      identity,
      { proactiveWakeEligible: true },
      () => session,
    );
    const streamClient = new RemoteStreamClient(view);
    try {
      view.start();
      await vi.waitFor(() => expect(relay.openBearers).toHaveLength(3), {
        timeout: 8_000,
        interval: 50,
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      // The client answers for its OWN session and nothing else - a session
      // in backoff is not ready, whatever any other cached session for the
      // host may be doing.
      expect(streamClient.isReady()).toBe(false);
      streamClient.reconnectAll("wake-resume", {
        probeFirst: true,
        wakeProbe: null,
      });
      expect(wakeSpy).toHaveBeenCalledWith("wake-resume", null);
      // Behaviourally: the collapsed sub-second redial, far sooner than the
      // escalated 4s tier (2-4s jittered) would have allowed.
      await vi.waitFor(() => expect(view.isReady()).toBe(true), {
        timeout: 1_800,
        interval: 50,
      });
      expect(streamClient.isReady()).toBe(true);
      expect(relay.openBearers).toHaveLength(4);

      // Released: the client is now a stale callback, and its reconnect must
      // stop reaching the session.
      view.close();
      const wakesBeforeRelease = wakeSpy.mock.calls.length;
      streamClient.reconnectAll("stale-callback", {
        probeFirst: true,
        wakeProbe: null,
      });
      expect(wakeSpy.mock.calls).toHaveLength(wakesBeforeRelease);
      expect(relay.errors).toEqual([]);
    } finally {
      session.close();
      wakeSpy.mockRestore();
    }
  }, 15_000);
});

describe("RemoteSession forceReconnect", () => {
  it("drops a ready session's socket and redials with no backoff wait", async () => {
    const relay = new FakeRelayHost();
    const lease = new MutableBearerLease("token", "user-1");
    const session = buildSession(relay, lease, null);
    let readinessLost = 0;
    session.subscribeReadinessLost(() => {
      readinessLost += 1;
    });
    try {
      session.start();
      await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
      expect(relay.openBearers).toHaveLength(1);
      session.forceReconnect("user-retry");
      // The drop is synchronous and the redial immediate - no probe window,
      // no backoff draw. A `wake` on the same healthy session provably dials
      // nothing (see the wake suite); this MUST dial, that is the contract
      // difference.
      await vi.waitFor(() => expect(relay.openBearers).toHaveLength(2), {
        timeout: 800,
        interval: 25,
      });
      await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
      expect(readinessLost).toBeGreaterThanOrEqual(1);
      expect(relay.errors).toEqual([]);
    } finally {
      session.close();
    }
  }, 10_000);

  it("pulls a pending escalated backoff to NOW - faster than a wake's jittered collapse can", async () => {
    const relay = new FakeRelayHost();
    const lease = new MutableBearerLease("token", "user-1");
    // Three failed opens escalate the armed backoff to the 4s step.
    relay.decideOpen = (_bearer, openIndex) =>
      openIndex < 3
        ? { kind: "fatal", details: retryableDropDetails() }
        : { kind: "ack" };
    const session = buildSession(relay, lease, null);
    try {
      session.start();
      await vi.waitFor(() => expect(relay.openBearers).toHaveLength(3), {
        timeout: 8_000,
        interval: 50,
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      session.forceReconnect("network-path-changed");
      // A wake's collapse draw is bounded BELOW by 500ms (half the initial
      // backoff); the forced redial is not a draw at all. Landing the fourth
      // open inside 450ms is therefore only reachable through the forced
      // path.
      await vi.waitFor(() => expect(relay.openBearers).toHaveLength(4), {
        timeout: 450,
        interval: 10,
      });
      await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
      expect(relay.errors).toEqual([]);
    } finally {
      session.close();
    }
  }, 15_000);

  it("is a no-op on a closed session - it neither throws nor dials", async () => {
    const relay = new FakeRelayHost();
    const lease = new MutableBearerLease("token", "user-1");
    relay.decideOpen = () => ({
      kind: "fatal",
      details: {
        code: "INCOMPATIBLE",
        reason: "manifest mismatch",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });
    const session = buildSession(relay, lease, null);
    try {
      session.start();
      await vi.waitFor(() => expect(session.isClosed()).toBe(true), WAIT);
      const dialsBefore = relay.openBearers.length;
      expect(() => session.forceReconnect("user-retry")).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(relay.openBearers).toHaveLength(dialsBefore);
      expect(session.isClosed()).toBe(true);
    } finally {
      session.close();
    }
  }, 10_000);

  it("a force during an in-flight attach is retained and spent on THAT attempt's failure", async () => {
    const relay = new FakeRelayHost();
    const lease = new MutableBearerLease("token", "user-1");
    relay.stallOpens = true;
    relay.decideOpen = (_bearer, openIndex) =>
      openIndex === 0
        ? { kind: "fatal", details: retryableDropDetails() }
        : { kind: "ack" };
    const session = buildSession(relay, lease, null);
    try {
      session.start();
      await vi.waitFor(() => expect(relay.openBearers).toHaveLength(1), WAIT);
      // The iOS-unfreeze ordering: the resume/network event runs while the
      // pre-suspend attach is still nominally in flight. The force can
      // neither drop (nothing attached) nor hurry it - but it must not
      // evaporate either.
      session.forceReconnect("network-path-changed");
      relay.stallOpens = false;
      const releasedAt = Date.now();
      await relay.releaseStalledOpens();
      // The stalled attempt fails; without the retained intent the loss
      // would arm the first rung (jittered floor 500ms). The retained force
      // pulls exactly that wait to zero.
      await vi.waitFor(() => expect(relay.openBearers).toHaveLength(2), {
        timeout: 400,
        interval: 10,
      });
      expect(Date.now() - releasedAt).toBeLessThan(400);
      await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
      expect(relay.errors).toEqual([]);
    } finally {
      session.close();
    }
  }, 10_000);

  it("without a force, the same stalled-attach failure waits its rung - the discriminating arm", async () => {
    const relay = new FakeRelayHost();
    const lease = new MutableBearerLease("token", "user-1");
    relay.stallOpens = true;
    relay.decideOpen = (_bearer, openIndex) =>
      openIndex === 0
        ? { kind: "fatal", details: retryableDropDetails() }
        : { kind: "ack" };
    const session = buildSession(relay, lease, null);
    try {
      session.start();
      await vi.waitFor(() => expect(relay.openBearers).toHaveLength(1), WAIT);
      relay.stallOpens = false;
      await relay.releaseStalledOpens();
      await new Promise((resolve) => setTimeout(resolve, 250));
      // Still one open: a never-ready session's first failure arms the
      // jittered initial rung (floor 500ms), which the forced arm above
      // provably beat.
      expect(relay.openBearers).toHaveLength(1);
      await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
      expect(relay.errors).toEqual([]);
    } finally {
      session.close();
    }
  }, 10_000);

  it("a force during a stalled GRANT mint is spent when that pre-dial path fails - not only the loss funnel", async () => {
    const relay = new FakeRelayHost();
    const lease = new MutableBearerLease("token", "user-1");
    // A grant provider the test releases by hand: first mint hangs until
    // released and then FAILS (the pre-dial lander that schedules its
    // reconnect directly, without ever reaching the connection-loss funnel);
    // every later mint succeeds.
    let releaseFirstMint = (): void => undefined;
    const firstMint = new Promise<void>((resolve) => {
      releaseFirstMint = resolve;
    });
    let mintIndex = 0;
    const session = new RemoteSession({
      ...buildSessionOptions(relay, lease, null),
      grantProvider: async () => {
        mintIndex += 1;
        if (mintIndex === 1) {
          await firstMint;
          return {
            kind: "unavailable" as const,
            detail: "authn 503",
            context: "",
          };
        }
        return {
          kind: "ok" as const,
          grant: { grant: "grant-jws", expiresInSeconds: 300 },
        };
      },
    });
    try {
      session.start();
      await vi.waitFor(() => expect(mintIndex).toBe(1), WAIT);
      // The demand lands while the mint is still in flight - same iOS
      // ordering as the stalled-attach case, different failure lander.
      session.forceReconnect("network-path-changed");
      const releasedAt = Date.now();
      releaseFirstMint();
      // The failed mint arms the first rung (jittered floor 500ms); the
      // retained force must pull that wait to zero from THIS lander too.
      await vi.waitFor(() => expect(mintIndex).toBe(2), {
        timeout: 400,
        interval: 10,
      });
      expect(Date.now() - releasedAt).toBeLessThan(400);
      await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
      expect(relay.errors).toEqual([]);
    } finally {
      session.close();
    }
  }, 10_000);

  it("without a force, the failed grant mint waits its rung - the pre-dial control arm", async () => {
    const relay = new FakeRelayHost();
    const lease = new MutableBearerLease("token", "user-1");
    let mintIndex = 0;
    const session = new RemoteSession({
      ...buildSessionOptions(relay, lease, null),
      grantProvider: async () => {
        mintIndex += 1;
        if (mintIndex === 1) {
          return {
            kind: "unavailable" as const,
            detail: "authn 503",
            context: "",
          };
        }
        return {
          kind: "ok" as const,
          grant: { grant: "grant-jws", expiresInSeconds: 300 },
        };
      },
    });
    try {
      session.start();
      await vi.waitFor(() => expect(mintIndex).toBe(1), WAIT);
      await new Promise((resolve) => setTimeout(resolve, 250));
      // Inside the rung's jittered floor (500ms): no forced demand, no early
      // dial - the discriminating control for the forced grant arm above.
      expect(mintIndex).toBe(1);
      await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
      expect(relay.errors).toEqual([]);
    } finally {
      session.close();
    }
  }, 10_000);

  it("a force during a stalled PRE-SOCKET rejection (grant provider throws) is spent on that lander too", async () => {
    const relay = new FakeRelayHost();
    const lease = new MutableBearerLease("token", "user-1");
    let releaseFirstMint = (): void => undefined;
    const firstMint = new Promise<void>((resolve) => {
      releaseFirstMint = resolve;
    });
    let mintIndex = 0;
    const session = new RemoteSession({
      ...buildSessionOptions(relay, lease, null),
      grantProvider: async () => {
        mintIndex += 1;
        if (mintIndex === 1) {
          await firstMint;
          // The awaited pre-socket path REJECTS - the `beginConnectGuarded`
          // catch lander, distinct from a structured `unavailable` result.
          throw new Error("grant fetch transport failure");
        }
        return {
          kind: "ok" as const,
          grant: { grant: "grant-jws", expiresInSeconds: 300 },
        };
      },
    });
    try {
      session.start();
      await vi.waitFor(() => expect(mintIndex).toBe(1), WAIT);
      session.forceReconnect("network-path-changed");
      const releasedAt = Date.now();
      releaseFirstMint();
      await vi.waitFor(() => expect(mintIndex).toBe(2), {
        timeout: 400,
        interval: 10,
      });
      expect(Date.now() - releasedAt).toBeLessThan(400);
      await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
      expect(relay.errors).toEqual([]);
    } finally {
      session.close();
    }
  }, 10_000);

  it("a force arriving AFTER a pre-dial lander already armed its rung pulls that timer now", async () => {
    const relay = new FakeRelayHost();
    const lease = new MutableBearerLease("token", "user-1");
    let mintIndex = 0;
    const session = new RemoteSession({
      ...buildSessionOptions(relay, lease, null),
      grantProvider: async () => {
        mintIndex += 1;
        if (mintIndex === 1) {
          return {
            kind: "unavailable" as const,
            detail: "authn 503",
            context: "",
          };
        }
        return {
          kind: "ok" as const,
          grant: { grant: "grant-jws", expiresInSeconds: 300 },
        };
      },
    });
    try {
      session.start();
      await vi.waitFor(() => expect(mintIndex).toBe(1), WAIT);
      // Let the lander finish arming its rung. The phase still reads
      // `connecting` here - a force keyed on `reconnecting` would fall
      // through to pending ownership with no future failure left to spend it.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const forcedAt = Date.now();
      session.forceReconnect("user-retry");
      await vi.waitFor(() => expect(mintIndex).toBe(2), {
        timeout: 300,
        interval: 10,
      });
      expect(Date.now() - forcedAt).toBeLessThan(300);
      await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
      expect(relay.errors).toEqual([]);
    } finally {
      session.close();
    }
  }, 10_000);

  it("a spent force skips ONE wait without pardoning the ladder - the next failure waits its escalated rung", async () => {
    // Deterministic jitter: with `Math.random()` pinned at 0.5, the rungs
    // are exact - rung 0 waits 750ms, rung 1 waits 1500ms - so the pardoning
    // mutation cannot hide in the random tail (an un-stubbed [500ms, 1s)
    // rung-0 draw can exceed a fixed probe window and stay green).
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const relay = new FakeRelayHost();
    const lease = new MutableBearerLease("token", "user-1");
    relay.stallOpens = true;
    // A never-ready pair: the forced attempt and the one after it both fail,
    // so the ladder is the only thing pacing the third dial.
    relay.decideOpen = (_bearer, openIndex) =>
      openIndex < 2
        ? { kind: "fatal", details: retryableDropDetails() }
        : { kind: "ack" };
    const session = buildSession(relay, lease, null);
    try {
      session.start();
      await vi.waitFor(() => expect(relay.openBearers).toHaveLength(1), WAIT);
      session.forceReconnect("network-path-changed");
      relay.stallOpens = false;
      await relay.releaseStalledOpens();
      // The forced skip: the second dial lands immediately.
      await vi.waitFor(() => expect(relay.openBearers).toHaveLength(2), {
        timeout: 400,
        interval: 10,
      });
      // Its failure was UNFORCED, and the first failure already spent attempt
      // #1 - so this wait is deterministically rung 1 = 1500ms. A helper that
      // pardoned `reconnectAttempt` when spending the force would wait
      // exactly rung 0 = 750ms instead, so the 1000ms probe below fails the
      // mutant on every run, not merely on most draws.
      const secondFailureAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(relay.openBearers).toHaveLength(2);
      await vi.waitFor(() => expect(session.isReady()).toBe(true), {
        timeout: 8_000,
        interval: 50,
      });
      expect(relay.openBearers).toHaveLength(3);
      expect(Date.now() - secondFailureAt).toBeGreaterThanOrEqual(1_400);
      expect(relay.errors).toEqual([]);
    } finally {
      session.close();
      randomSpy.mockRestore();
    }
  }, 15_000);

  it("the ready boundary retires an in-flight force even when the rung it would zero is NONZERO", async () => {
    // The discriminating order for the ready-boundary clear: the trivially
    // green version drops a rung-0 session, where a stale surviving intent
    // only zeroes a wait that was already zero. Here the reattach that gets
    // forced rides an ESCALATED ladder, reaches ready inside the survival
    // window (no forgiveness), and then drops - so a stale intent for that
    // generation would zero a deterministic 1500ms rung. Deleting the ready
    // clear turns the probe below red.
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const relay = new FakeRelayHost();
    const lease = new MutableBearerLease("token", "user-1");
    // Two failures escalate; the third open is the forced reattach and acks.
    relay.decideOpen = (_bearer, openIndex) =>
      openIndex < 2
        ? { kind: "fatal", details: retryableDropDetails() }
        : { kind: "ack" };
    const session = buildSession(relay, lease, null);
    try {
      session.start();
      // Let the two failures land, then stall the THIRD generation mid-open.
      await vi.waitFor(() => expect(relay.openBearers).toHaveLength(2), {
        timeout: 8_000,
        interval: 50,
      });
      relay.stallOpens = true;
      await vi.waitFor(() => expect(relay.openBearers).toHaveLength(3), {
        timeout: 8_000,
        interval: 50,
      });
      // Force while generation 3 is in flight with no armed timer: the
      // intent is recorded against exactly that generation.
      session.forceReconnect("network-path-changed");
      relay.stallOpens = false;
      await relay.releaseStalledOpens();
      // Generation 3 reaches ready. The ladder is NOT forgiven (survival
      // needs 30s), and the recorded force must be consumed here, unspent.
      await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);

      // Drop inside the survival window: this loss belongs to generation 3 -
      // the very generation the stale intent (if the ready clear were
      // deleted) would match and zero.
      relay.dropCurrentConnection();
      const droppedAt = Date.now();
      // attempt=2, recovery offset 1 -> rung 1 is deterministically 1500ms.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(relay.openBearers).toHaveLength(3);
      await vi.waitFor(() => expect(relay.openBearers).toHaveLength(4), {
        timeout: 8_000,
        interval: 50,
      });
      expect(Date.now() - droppedAt).toBeGreaterThanOrEqual(1_400);
      await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
      expect(relay.errors).toEqual([]);
    } finally {
      session.close();
      randomSpy.mockRestore();
    }
  }, 20_000);

  it("multiple forces during one in-flight generation buy exactly one skip", async () => {
    const relay = new FakeRelayHost();
    const lease = new MutableBearerLease("token", "user-1");
    relay.stallOpens = true;
    relay.decideOpen = (_bearer, openIndex) =>
      openIndex === 0
        ? { kind: "fatal", details: retryableDropDetails() }
        : { kind: "ack" };
    const session = buildSession(relay, lease, null);
    try {
      session.start();
      await vi.waitFor(() => expect(relay.openBearers).toHaveLength(1), WAIT);
      session.forceReconnect("network-path-changed");
      session.forceReconnect("user-retry");
      session.forceReconnect("network-path-changed");
      relay.stallOpens = false;
      await relay.releaseStalledOpens();
      await vi.waitFor(() => expect(relay.openBearers).toHaveLength(2), {
        timeout: 400,
        interval: 10,
      });
      await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
      // One skip, one redial - a burst of demands is not a dial storm.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(relay.openBearers).toHaveLength(2);
      expect(relay.errors).toEqual([]);
    } finally {
      session.close();
    }
  }, 10_000);

  it("a force during an in-flight UNAUTHORIZED revalidation is spent on both outcome arms", async () => {
    for (const outcome of ["network-error", "rotated"] as const) {
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("token", "user-1");
      // First open: UNAUTHORIZED (recoverable via the revalidator); later
      // opens succeed.
      relay.decideOpen = (_bearer, openIndex) =>
        openIndex === 0
          ? { kind: "fatal", details: unauthorizedDetails() }
          : { kind: "ack" };
      let releaseRevalidation = (): void => undefined;
      const revalidationHeld = new Promise<void>((resolve) => {
        releaseRevalidation = resolve;
      });
      const session = buildSession(relay, lease, {
        revalidateForReconnect: async () => {
          await revalidationHeld;
          // "rotated" must present a DIFFERENT bearer than the rejected one
          // or the no-progress bound trips; rotate the lease in place.
          if (outcome === "rotated") {
            lease.rotate("token-rotated");
          }
          return outcome;
        },
      });
      try {
        session.start();
        await vi.waitFor(() => expect(relay.openBearers).toHaveLength(1), WAIT);
        // The revalidation is now in flight (the UNAUTHORIZED fatal dropped
        // the connection first). A resume/network force lands here.
        await new Promise((resolve) => setTimeout(resolve, 100));
        session.forceReconnect("network-path-changed");
        const releasedAt = Date.now();
        releaseRevalidation();
        await vi.waitFor(() => expect(relay.openBearers).toHaveLength(2), {
          timeout: 400,
          interval: 10,
        });
        expect(Date.now() - releasedAt).toBeLessThan(400);
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        expect(relay.errors).toEqual([]);
      } finally {
        session.close();
      }
    }
  }, 20_000);

  it("without a force, both revalidation arms wait their rung - the discriminating controls", async () => {
    for (const outcome of ["network-error", "rotated"] as const) {
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("token", "user-1");
      relay.decideOpen = (_bearer, openIndex) =>
        openIndex === 0
          ? { kind: "fatal", details: unauthorizedDetails() }
          : { kind: "ack" };
      let releaseRevalidation = (): void => undefined;
      const revalidationHeld = new Promise<void>((resolve) => {
        releaseRevalidation = resolve;
      });
      const session = buildSession(relay, lease, {
        revalidateForReconnect: async () => {
          await revalidationHeld;
          if (outcome === "rotated") {
            lease.rotate("token-rotated");
          }
          return outcome;
        },
      });
      try {
        session.start();
        await vi.waitFor(() => expect(relay.openBearers).toHaveLength(1), WAIT);
        await new Promise((resolve) => setTimeout(resolve, 100));
        releaseRevalidation();
        await new Promise((resolve) => setTimeout(resolve, 250));
        // Inside the rung's jittered floor: no force, no early dial.
        expect(relay.openBearers).toHaveLength(1);
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        expect(relay.errors).toEqual([]);
      } finally {
        session.close();
      }
    }
  }, 20_000);

  it("a force during the handshake followed by a terminal fatal clears the intent and stays closed", async () => {
    const relay = new FakeRelayHost();
    const lease = new MutableBearerLease("token", "user-1");
    relay.stallOpens = true;
    relay.decideOpen = () => ({
      kind: "fatal",
      details: {
        code: "INCOMPATIBLE",
        reason: "manifest mismatch",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });
    const session = buildSession(relay, lease, null);
    try {
      session.start();
      await vi.waitFor(() => expect(relay.openBearers).toHaveLength(1), WAIT);
      session.forceReconnect("network-path-changed");
      relay.stallOpens = false;
      await relay.releaseStalledOpens();
      await vi.waitFor(() => expect(session.isClosed()).toBe(true), WAIT);
      // Terminal means every recorded demand died with the loop: no zombie
      // dial fires on the pulled-forward intent.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(relay.openBearers).toHaveLength(1);
      expect(session.isClosed()).toBe(true);
    } finally {
      session.close();
    }
  }, 10_000);

  it("reaching ready consumes an in-flight force - no later loss inherits it", async () => {
    const relay = new FakeRelayHost();
    const lease = new MutableBearerLease("token", "user-1");
    relay.stallOpens = true;
    relay.decideOpen = (_bearer, openIndex) =>
      openIndex === 1
        ? { kind: "fatal", details: retryableDropDetails() }
        : { kind: "ack" };
    const session = buildSession(relay, lease, null);
    try {
      session.start();
      await vi.waitFor(() => expect(relay.openBearers).toHaveLength(1), WAIT);
      session.forceReconnect("network-path-changed");
      relay.stallOpens = false;
      await relay.releaseStalledOpens();
      // The forced generation SUCCEEDS - the intent is satisfied and consumed.
      await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
      // A later ordinary outage: the drop redials immediately (recovery
      // rung), that redial fails, and the NEXT wait must be the ladder's -
      // a stale surviving intent would zero it.
      relay.dropCurrentConnection();
      await vi.waitFor(() => expect(relay.openBearers).toHaveLength(2), WAIT);
      const failedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(relay.openBearers).toHaveLength(2);
      await vi.waitFor(() => expect(session.isReady()).toBe(true), {
        timeout: 8_000,
        interval: 50,
      });
      expect(relay.openBearers).toHaveLength(3);
      expect(Date.now() - failedAt).toBeGreaterThanOrEqual(250);
      expect(relay.errors).toEqual([]);
    } finally {
      session.close();
    }
  }, 15_000);

  it("reports a forced drop as indeterminate, never as a host refusal", async () => {
    const relay = new FakeRelayHost();
    const lease = new MutableBearerLease("valid-token", "user-1");
    const recorder = new RecordingEvidence();
    const session = new RemoteSession({
      ...buildSessionOptions(relay, lease, null),
      evidence: recorder,
    });
    try {
      session.start();
      await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
      const refusalsBefore = recorder.callsNamed("reportDialRefusal").length;

      session.forceReconnect("user-retry");
      await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
      expect(relay.openBearers).toHaveLength(2);

      // The teardown was OUR decision, not host evidence: it must land as
      // indeterminate and must not advance the confirmed-death streak. The
      // provenance mutation (client-initiated -> host-transport-plane) turns
      // exactly this assertion red.
      expect(
        recorder.callsNamed("reportDialIndeterminate").length,
      ).toBeGreaterThan(0);
      expect(recorder.callsNamed("reportDialRefusal")).toHaveLength(
        refusalsBefore,
      );
    } finally {
      session.close();
    }
  }, 10_000);
});

describe("RemoteSession openAck without optionalRpc", () => {
  // The registry is module-level, so a sibling suite's successful handshake
  // would otherwise leave this host's entry populated.
  beforeEach(() => {
    resetNegotiatedManifests();
  });

  it(
    "refuses a manifest missing the required optionalRpc rather than half-reading it",
    async () => {
      const relay = new FakeRelayHost();
      // The pre-split frame shape. `sessionManifestsSchema` requires
      // `optionalRpc`, so this is rejected at parse - it never reaches the
      // floor compat check, and the merged legacy set is never mistaken for a
      // floor. The session stays un-ready and retries rather than proceeding
      // on a manifest it did not understand.
      relay.sendOptionalRpc = false;
      const lease = new MutableBearerLease("token", "user-1");
      const session = buildSession(relay, lease, null);
      try {
        session.start();
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(session.isReady()).toBe(false);
        expect(getNegotiatedHostMethods("host-1")).toBeNull();
        expect(session.isClosed()).toBe(false);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe("RemoteSession inbound bulk credit accounting (C1: per-FRAME, not per-message)", () => {
  it(
    "grants credits after FINE_INBOUND_CREDIT_GRANT_BATCH FRAMES - mid-transfer, before the logical STREAM_FRAME finishes reassembling",
    async () => {
      // The deadlock this pins: the old code counted consumed BULK frames
      // per completed logical MESSAGE, so a single message spanning more
      // than `FINE_INBOUND_CREDIT_GRANT_BATCH` chunk frames would never itself
      // trigger a grant - the peer's send credits would run out and the
      // transfer would stall forever. Accounting per FRAME (remote-session's
      // `onData`, right after decrypt) grants mid-transfer instead.
      const relay = new FakeRelayHost();
      relay.streamManifest = buildStreamManifest(
        cursorStreamRegistry,
        SERVES_EVERY_INSTALLED_MAJOR,
      );
      const lease = new MutableBearerLease("valid-token", "user-1");
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        streamRegistry: cursorStreamRegistry,
      });
      const stream = session.subscribe("cursor.subscribe", { cursor: null });
      let messageDelivered = false;
      stream.onServerFrame(() => {
        messageDelivered = true;
      });
      // Captured at the exact tick the FIRST credit grant lands - proves the
      // grant fires before the (much later) full-message delivery callback,
      // rather than relying on a later poll racing both events.
      let creditSeenBeforeDelivery: boolean | null = null;
      relay.onCreditGrant = () => {
        if (creditSeenBeforeDelivery === null) {
          creditSeenBeforeDelivery = !messageDelivered;
        }
      };
      try {
        await vi.waitFor(
          () => expect(relay.subscribeStreamIds).toHaveLength(1),
          WAIT,
        );
        const streamId = relay.subscribeStreamIds[0];

        // Comfortably over FINE_INBOUND_CREDIT_GRANT_BATCH frames at the real
        // BULK_CHUNK_SIZE_BYTES chunk cap - a transfer the old per-MESSAGE
        // accounting would never have granted credits for mid-flight.
        const frameCount = FINE_INBOUND_CREDIT_GRANT_BATCH + 5;
        const binary = new Uint8Array(BULK_CHUNK_SIZE_BYTES * frameCount);
        await relay.sendStreamFrame(
          streamId,
          { kind: "snapshot", hasBinaryPayload: true },
          binary,
          QosClass.BULK,
        );

        await vi.waitFor(() => expect(messageDelivered).toBe(true), WAIT);
        // Exactly one grant, of exactly the batch size: `frameCount` crossed
        // the batch boundary once (at frame FINE_INBOUND_CREDIT_GRANT_BATCH)
        // and the remaining 5 frames were not enough to cross it again.
        expect(relay.creditGrants).toEqual([FINE_INBOUND_CREDIT_GRANT_BATCH]);
        expect(creditSeenBeforeDelivery).toBe(true);
        expect(relay.errors).toEqual([]);
      } finally {
        stream.close();
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe("RemoteSession body compression is gated on the host's openAck advert (T5, B2)", () => {
  it(
    "no outbound frame is compressed when the host's openAck omits SESSION_CAPABILITY_BODY_COMPRESSION",
    async () => {
      const relay = new FakeRelayHost();
      relay.streamManifest = buildStreamManifest(
        cursorStreamRegistry,
        SERVES_EVERY_INSTALLED_MAJOR,
      );
      // Explicit and empty: this host advertises nothing.
      relay.openAckCapabilities = [];
      const lease = new MutableBearerLease("valid-token", "user-1");
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        streamRegistry: cursorStreamRegistry,
      });
      const stream = session.subscribe("cursor.subscribe", { cursor: null });
      try {
        await vi.waitFor(
          () => expect(relay.subscribeStreamIds).toHaveLength(1),
          WAIT,
        );
        const streamId = relay.subscribeStreamIds[0];
        relay.clientFrames.length = 0;

        // Large AND highly compressible - if compression were happening at
        // all, this body would trigger it.
        const binary = new Uint8Array(BULK_CHUNK_SIZE_BYTES * 3).fill(0x41);
        session.sendStreamFrame(
          streamId,
          { kind: "snapshot", hasBinaryPayload: true },
          binary,
        );

        await vi.waitFor(
          () => expect(relay.clientFrames.length).toBeGreaterThan(1),
          WAIT,
        );
        expect(relay.clientFrames.some((f) => f.compressed)).toBe(false);
        expect(relay.errors).toEqual([]);
      } finally {
        stream.close();
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "a large compressible body IS compressed once the host's openAck advertises SESSION_CAPABILITY_BODY_COMPRESSION",
    async () => {
      const relay = new FakeRelayHost();
      relay.streamManifest = buildStreamManifest(
        cursorStreamRegistry,
        SERVES_EVERY_INSTALLED_MAJOR,
      );
      relay.openAckCapabilities = [SESSION_CAPABILITY_BODY_COMPRESSION];
      const lease = new MutableBearerLease("valid-token", "user-1");
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        streamRegistry: cursorStreamRegistry,
      });
      const stream = session.subscribe("cursor.subscribe", { cursor: null });
      try {
        await vi.waitFor(
          () => expect(relay.subscribeStreamIds).toHaveLength(1),
          WAIT,
        );
        const streamId = relay.subscribeStreamIds[0];
        relay.clientFrames.length = 0;

        const binary = new Uint8Array(BULK_CHUNK_SIZE_BYTES * 3).fill(0x41);
        session.sendStreamFrame(
          streamId,
          { kind: "snapshot", hasBinaryPayload: true },
          binary,
        );

        await vi.waitFor(
          () => expect(relay.clientFrames.length).toBeGreaterThan(1),
          WAIT,
        );
        expect(relay.clientFrames.some((f) => f.compressed)).toBe(true);
        expect(relay.errors).toEqual([]);
      } finally {
        stream.close();
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "the `open` frame itself is never compressed, whichever way the host advertises - it is the one frame that must stay readable by a host of any vintage",
    async () => {
      const relay = new FakeRelayHost();
      relay.openAckCapabilities = [SESSION_CAPABILITY_BODY_COMPRESSION];
      // A large, highly compressible bearer token: the `open` frame's body must
      // exceed COMPRESSION_MIN_PAYLOAD_BYTES so this test actually exercises the
      // gate rather than passing merely because a small `open` body was never
      // going to be compressed either way, capability advert or not.
      const lease = new MutableBearerLease("a".repeat(8192), "user-1");
      const session = buildSession(relay, lease, null);
      try {
        session.start();
        await vi.waitFor(() => expect(relay.openBearers).toHaveLength(1), WAIT);
        expect(relay.clientFrames.some((f) => f.compressed)).toBe(false);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe("RemoteSession concurrent inbound chunk-sequence reassembly (C3, client side)", () => {
  it(
    "reassembles several interleaved chunk sequences correctly when delivered without awaiting between wire frames",
    async () => {
      // The production `onData` handler is fire-and-forget per `onmessage`
      // call (Noise decrypt is the only await, entered synchronously in
      // arrival order - see the ORDERING INVARIANT comment above `onData`).
      // This drives several DISTINCT streams' chunk sequences interleaved
      // frame-by-frame through that same entry point, delivered in one tight
      // synchronous burst, and asserts every sequence reassembles to its own
      // stream with no cross-stream splice.
      const relay = new FakeRelayHost();
      relay.streamManifest = buildStreamManifest(
        cursorStreamRegistry,
        SERVES_EVERY_INSTALLED_MAJOR,
      );
      const lease = new MutableBearerLease("valid-token", "user-1");
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        streamRegistry: cursorStreamRegistry,
      });
      const labels = ["alpha", "beta", "gamma"] as const;
      const streams = labels.map(() =>
        session.subscribe("cursor.subscribe", { cursor: null }),
      );
      const received = new Map<number, StreamFrameEnvelope>();
      const closedLabels: string[] = [];
      streams.forEach((stream, index) => {
        stream.onServerFrame((envelope) => {
          received.set(index, envelope);
        });
        stream.onStatusChange((status) => {
          if (status === "closed") {
            closedLabels.push(labels[index]);
          }
        });
      });
      try {
        await vi.waitFor(
          () => expect(relay.subscribeStreamIds).toHaveLength(3),
          WAIT,
        );
        const streamIds = relay.subscribeStreamIds;

        // Three independent 3-chunk sequences, one per stream.
        const sequences = streamIds.map((streamId, index) => {
          const label = labels[index];
          const json = { kind: "snapshot", hasBinaryPayload: true, label };
          const binary = new TextEncoder().encode(
            `${label}-payload-${"x".repeat(64)}`,
          );
          const body = encodeMuxMessageBody(json, binary);
          const chunkCount = 3;
          const sliceSize = Math.ceil(body.length / chunkCount);
          const frames: EncodeMuxFrameInput[] = [];
          for (let i = 0; i < chunkCount; i += 1) {
            const start = i * sliceSize;
            const end = Math.min(start + sliceSize, body.length);
            frames.push({
              type: MuxFrameType.STREAM_FRAME,
              streamId,
              seq: i,
              qos: QosClass.INTERACTIVE,
              chunked: true,
              chunkFirst: i === 0,
              chunkLast: end >= body.length,
              compressed: false,
              json: null,
              binary: body.subarray(start, end),
            });
          }
          return { label, json, frames };
        });

        // Interleave frame-by-frame across the three sequences (alpha0,
        // beta0, gamma0, alpha1, beta1, gamma1, ...) rather than sending one
        // whole sequence before starting the next.
        const interleaved: EncodeMuxFrameInput[] = [];
        for (let i = 0; i < 3; i += 1) {
          for (const sequence of sequences) {
            interleaved.push(sequence.frames[i]);
          }
        }

        // Encrypt sequentially (the Noise send counter must be reserved in
        // this exact order for the counter sequence to stay decryptable),
        // THEN deliver every sealed frame with no await between calls.
        const sealed: Uint8Array[] = [];
        for (const frame of interleaved) {
          sealed.push(await relay.encryptFrame(frame));
        }
        for (const bytes of sealed) {
          relay.deliverToClient(bytes);
        }

        await vi.waitFor(() => expect(received.size).toBe(3), WAIT);
        sequences.forEach((sequence, index) => {
          expect(received.get(index)).toEqual(sequence.json);
        });
        expect(closedLabels).toEqual([]);
        expect(session.isReady()).toBe(true);
        expect(relay.errors).toEqual([]);
      } finally {
        streams.forEach((stream) => stream.close());
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe("RemoteSession per-stream inbound error routing", () => {
  it(
    "fails only the corrupted stream on a chunk-sequence mismatch - the session stays ready and an untouched sibling stream keeps working",
    async () => {
      const relay = new FakeRelayHost();
      relay.streamManifest = buildStreamManifest(
        cursorStreamRegistry,
        SERVES_EVERY_INSTALLED_MAJOR,
      );
      const lease = new MutableBearerLease("valid-token", "user-1");
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        streamRegistry: cursorStreamRegistry,
      });
      const streamA = session.subscribe("cursor.subscribe", { cursor: null });
      const streamB = session.subscribe("cursor.subscribe", { cursor: null });
      let streamAClosedReason: StreamCloseReason | null = null;
      streamA.onStatusChange((status, reason) => {
        if (status === "closed") {
          streamAClosedReason = reason;
        }
      });
      let streamBDelivered: StreamFrameEnvelope | null = null;
      streamB.onServerFrame((envelope) => {
        streamBDelivered = envelope;
      });
      try {
        await vi.waitFor(
          () => expect(relay.subscribeStreamIds).toHaveLength(2),
          WAIT,
        );
        const [streamIdA, streamIdB] = relay.subscribeStreamIds;

        // Stream A: a corrupt chunk sequence - a valid CHUNK_FIRST followed
        // by a continuation whose `seq` skips ahead (must be 1, sent as 5),
        // tripping `ChunkSequenceMismatchError` (a `ChunkReassemblyError`
        // subclass) on THIS stream only.
        const bodyA = encodeMuxMessageBody(
          { kind: "snapshot", hasBinaryPayload: true },
          new TextEncoder().encode("x".repeat(200)),
        );
        const half = Math.ceil(bodyA.length / 2);
        const firstFrame: EncodeMuxFrameInput = {
          type: MuxFrameType.STREAM_FRAME,
          streamId: streamIdA,
          seq: 0,
          qos: QosClass.INTERACTIVE,
          chunked: true,
          chunkFirst: true,
          chunkLast: false,
          compressed: false,
          json: null,
          binary: bodyA.subarray(0, half),
        };
        const skippedFrame: EncodeMuxFrameInput = {
          type: MuxFrameType.STREAM_FRAME,
          streamId: streamIdA,
          seq: 5,
          qos: QosClass.INTERACTIVE,
          chunked: true,
          chunkFirst: false,
          chunkLast: true,
          compressed: false,
          json: null,
          binary: bodyA.subarray(half),
        };
        const sealedFirst = await relay.encryptFrame(firstFrame);
        const sealedSkipped = await relay.encryptFrame(skippedFrame);
        relay.deliverToClient(sealedFirst);
        relay.deliverToClient(sealedSkipped);

        await vi.waitFor(
          () => expect(streamAClosedReason).not.toBeNull(),
          WAIT,
        );
        expect(streamAClosedReason).toEqual({
          kind: "fatalError",
          details: expect.objectContaining({
            code: "STREAM_CHUNK_REASSEMBLY_FAILED",
          }),
        });
        // The Noise decrypt succeeded - only THIS stream is condemned; the
        // session itself must not have been dropped/reconnected over it.
        expect(session.isClosed()).toBe(false);
        expect(relay.openBearers).toHaveLength(1);

        // Stream B, never touched by the corruption, still delivers a
        // perfectly normal frame afterward - proving the shared connection
        // (and this stream's own reassembly state) survived stream A's fatal
        // untouched.
        const normalEnvelope = { kind: "snapshot", hasBinaryPayload: false };
        await relay.sendStreamFrame(
          streamIdB,
          normalEnvelope,
          null,
          QosClass.INTERACTIVE,
        );
        await vi.waitFor(() => expect(streamBDelivered).not.toBeNull(), WAIT);
        expect(streamBDelivered).toEqual(normalEnvelope);
        // `isReady()` requires every LIVE subscription to have delivered at
        // least one frame (Architecture's ready-boundary evidence): stream A
        // was condemned and dropped out of `subscriptions` on its fatal, and
        // stream B just delivered its first frame above - so the boundary is
        // reached only now, which is itself further proof the connection
        // never reconnected (a reconnect would have re-armed a NEW
        // generation and required B to be resubscribed AND re-delivered).
        expect(session.isReady()).toBe(true);
        expect(relay.errors).toEqual([]);
      } finally {
        streamB.close();
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "fails only the corrupted stream on an undecodable COMPRESSED frame - a deterministic mis-encode must not become a reconnect loop",
    async () => {
      // The asymmetry this closes. `inflateFramePayload` throws
      // `MuxFrameDecodeError`, which the per-stream router did not recognise,
      // so one malformed compressed frame tore down the whole session - and a
      // peer that mis-encodes DETERMINISTICALLY then loops: drop, reconnect,
      // re-request the same body, fail again. That loop is what per-stream
      // routing exists to prevent, and it is the exact failure shape this
      // epic's ruling rules out.
      //
      // Safe to route per-stream because the fault is provably confined to one
      // stream by the time it is thrown: `decodeMuxFrame` already parsed the
      // header OUTSIDE this try (a header fault has no stream to blame and
      // stays session-fatal), the Noise decrypt already succeeded, and
      // `inflateFramePayload` is a pure per-frame function - raw deflate with
      // a fresh output buffer, holding no state across frames or streams that
      // a bad payload could poison.
      const relay = new FakeRelayHost();
      relay.streamManifest = buildStreamManifest(
        cursorStreamRegistry,
        SERVES_EVERY_INSTALLED_MAJOR,
      );
      const lease = new MutableBearerLease("valid-token", "user-1");
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        streamRegistry: cursorStreamRegistry,
      });
      const streamA = session.subscribe("cursor.subscribe", { cursor: null });
      const streamB = session.subscribe("cursor.subscribe", { cursor: null });
      let streamAClosedReason: StreamCloseReason | null = null;
      streamA.onStatusChange((status, reason) => {
        if (status === "closed") {
          streamAClosedReason = reason;
        }
      });
      let streamBDelivered: StreamFrameEnvelope | null = null;
      streamB.onServerFrame((envelope) => {
        streamBDelivered = envelope;
      });
      try {
        await vi.waitFor(
          () => expect(relay.subscribeStreamIds).toHaveLength(2),
          WAIT,
        );
        const [streamIdA, streamIdB] = relay.subscribeStreamIds;

        // A frame FLAGGED compressed whose payload is not a valid deflate
        // stream: a well-formed 4-byte plaintext-length header (so it clears
        // the length and bound checks) followed by bytes `inflateSync` cannot
        // decode. This is the mis-encoding shape, not a truncation.
        const corrupt = new Uint8Array(4 + 8);
        new DataView(corrupt.buffer).setUint32(0, 64);
        corrupt.set([9, 9, 9, 9, 9, 9, 9, 9], 4);
        const corruptFrame: EncodeMuxFrameInput = {
          type: MuxFrameType.STREAM_FRAME,
          streamId: streamIdA,
          seq: 0,
          qos: QosClass.BULK,
          chunked: false,
          chunkFirst: false,
          chunkLast: false,
          compressed: true,
          json: null,
          binary: corrupt,
        };
        relay.deliverToClient(await relay.encryptFrame(corruptFrame));

        await vi.waitFor(
          () => expect(streamAClosedReason).not.toBeNull(),
          WAIT,
        );
        expect(streamAClosedReason).toEqual({
          kind: "fatalError",
          details: expect.objectContaining({
            code: "STREAM_BODY_DECODE_FAILED",
          }),
        });

        // The loop this prevents, asserted as the absence of a redial: the
        // session was never dropped, so the host never saw a second `open`.
        expect(session.isClosed()).toBe(false);
        expect(relay.openBearers).toHaveLength(1);

        // And the sibling stream, which shares the connection and the
        // reassembler, is untouched.
        const normalEnvelope = { kind: "snapshot", hasBinaryPayload: false };
        await relay.sendStreamFrame(
          streamIdB,
          normalEnvelope,
          null,
          QosClass.INTERACTIVE,
        );
        await vi.waitFor(() => expect(streamBDelivered).not.toBeNull(), WAIT);
        expect(streamBDelivered).toEqual(normalEnvelope);
        expect(session.isReady()).toBe(true);
        expect(relay.openBearers).toHaveLength(1);
        expect(relay.errors).toEqual([]);
      } finally {
        streamB.close();
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  // An "over-cap sequence via a shrunk-cap reassembler" sub-case
  // (`MuxMessageSizeError` routing) is intentionally NOT covered here.
  // `RemoteSession` constructs the client-side `ActiveConnection.reassembler`
  // as a fixed `new ChunkReassembler(undefined)` (remote-session.ts) with no
  // seam for a test to inject a smaller `maxMessageBytes` cap for one session
  // under test. Exercising `MuxMessageSizeError` routing honestly would
  // require either genuinely exceeding `MAX_MUX_MESSAGE_BYTES` (512 MiB - not
  // viable in a unit test) or adding an injection seam to `RemoteSession`,
  // which this task's brief forbids touching. Skipped; flagged for whoever
  // owns that seam decision.
});

describe("RemoteSession WORKTREE_BUSY holder preservation", () => {
  const statusContract = defineRpcContract({
    method: "host.status",
    schemaVersion: { major: 1, minor: 0 } as const,
    requestSchema: z.object({}),
    responseSchema: z.object({ ready: z.boolean() }),
  });
  const statusRegistry: VersionedRpcRegistry =
    defineFloorAwareVersionedRpcRegistry(["host.status"] as const, {
      "host.status": {
        1: {
          latestMinor: 0,
          versions: {
            0: {
              contract: statusContract,
              upgradeFromPreviousVersion: null,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    });

  const holders = [
    {
      ownerRef: {
        epicId: "epic-1",
        ownerKind: "chat" as const,
        ownerId: "chat-1",
      },
      holdKind: "chat-turn" as const,
      activity: "working" as const,
      label: "Chat is mid-turn",
    },
  ];

  it(
    "keeps holders on a WORKTREE_BUSY unary error",
    async () => {
      const relay = new FakeRelayHost();
      relay.floorRpcManifest = { "host.status": { major: 1, minor: 0 } };
      relay.unaryError = {
        code: "WORKTREE_BUSY",
        message: "in use",
        holders,
      };
      const lease = new MutableBearerLease("token", "user-1");
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        rpcRegistry: statusRegistry,
      });
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        const error: unknown = await session
          .sendUnary("host.status", {}, null, undefined)
          .then(
            () => null,
            (reason: unknown) => reason,
          );
        expect(error).toBeInstanceOf(HostRpcError);
        expect(error).toMatchObject({
          code: "WORKTREE_BUSY",
          message: "in use",
        });
        expect((error as HostRpcError).holders).toEqual(holders);
      } finally {
        session.close();
      }
    },
    WAIT.timeout,
  );

  it(
    "leaves holders null when a WORKTREE_BUSY envelope omits them",
    async () => {
      const relay = new FakeRelayHost();
      relay.floorRpcManifest = { "host.status": { major: 1, minor: 0 } };
      relay.unaryError = { code: "WORKTREE_BUSY", message: "in use" };
      const lease = new MutableBearerLease("token", "user-1");
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        rpcRegistry: statusRegistry,
      });
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        const error: unknown = await session
          .sendUnary("host.status", {}, null, undefined)
          .then(
            () => null,
            (reason: unknown) => reason,
          );
        expect(error).toBeInstanceOf(HostRpcError);
        expect((error as HostRpcError).holders).toBeNull();
      } finally {
        session.close();
      }
    },
    WAIT.timeout,
  );

  it(
    "rejects a WORKTREE_BUSY mux error with malformed holders promptly, keeping code/message",
    async () => {
      const relay = new FakeRelayHost();
      relay.floorRpcManifest = { "host.status": { major: 1, minor: 0 } };
      relay.unaryError = {
        code: "WORKTREE_BUSY",
        message: "in use",
        holders: [{ not: "a holder" }],
      };
      const lease = new MutableBearerLease("token", "user-1");
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        rpcRegistry: statusRegistry,
      });
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        const error: unknown = await session
          .sendUnary("host.status", {}, null, undefined)
          .then(
            () => null,
            (reason: unknown) => reason,
          );
        expect(error).toBeInstanceOf(HostRpcError);
        expect(error).not.toBeInstanceOf(HostTransportFailureError);
        expect(error).toMatchObject({
          code: "WORKTREE_BUSY",
          message: "in use",
        });
        expect((error as HostRpcError).holders).toBeNull();
      } finally {
        session.close();
      }
    },
    WAIT.timeout,
  );

  it(
    "still accepts a non-busy mux error whose holders field is malformed",
    async () => {
      const relay = new FakeRelayHost();
      relay.floorRpcManifest = { "host.status": { major: 1, minor: 0 } };
      relay.unaryError = {
        code: "RPC_ERROR",
        message: "resolver failed",
        holders: [{ not: "a holder" }],
      };
      const lease = new MutableBearerLease("token", "user-1");
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        rpcRegistry: statusRegistry,
      });
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        const error: unknown = await session
          .sendUnary("host.status", {}, null, undefined)
          .then(
            () => null,
            (reason: unknown) => reason,
          );
        expect(error).toBeInstanceOf(HostRpcError);
        expect(error).not.toBeInstanceOf(HostTransportFailureError);
        expect(error).toMatchObject({
          code: "RPC_ERROR",
          message: "resolver failed",
        });
        expect((error as HostRpcError).holders).toBeNull();
      } finally {
        session.close();
      }
    },
    WAIT.timeout,
  );
});

describe("RemoteSession pending-unary FATAL rejection (S3)", () => {
  // A host-side per-stream FATAL for a still-pending unary request must
  // reject the caller promptly - not after the 30s unary timeout - and must
  // CLOSE the stream back to the host so it stops producing for an id this
  // side has already tombstoned. Mirrors `failStreamOnInboundError`'s
  // `rejectUnary` path, exercised here through a REAL stream-scoped FATAL
  // frame instead of a reassembly error.
  const statusContract = defineRpcContract({
    method: "host.status",
    schemaVersion: { major: 1, minor: 0 } as const,
    requestSchema: z.object({}),
    responseSchema: z.object({ ready: z.boolean() }),
  });
  const statusRegistry: VersionedRpcRegistry =
    defineFloorAwareVersionedRpcRegistry(["host.status"] as const, {
      "host.status": {
        1: {
          latestMinor: 0,
          versions: {
            0: { contract: statusContract, upgradeFromPreviousVersion: null },
          },
          downgradePathsFromLatest: {},
        },
      },
    });

  // The caller's response budget has to reach the remote unary TIMER, not just
  // the messenger. It used to be dropped on the reasoning that the mux session
  // owns its own response-wait semantics - so a method sized for a slow
  // host-side probe (`host.getRateLimitUsage` allows ~180s) was silently cut
  // off at the shared 30s default on every REMOTE host, while the local
  // transport honored it.
  it(
    "arms the unary timer with the CALLER's budget, not the shared default",
    async () => {
      const relay = new FakeRelayHost();
      relay.floorRpcManifest = { "host.status": { major: 1, minor: 0 } };
      // The host never answers; only the timer can settle these.
      relay.skipUnaryAutoRespond = true;
      const lease = new MutableBearerLease("valid-token", "user-1");
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        rpcRegistry: statusRegistry,
      });
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);

        // A budget far BELOW the 30s default, so only a timer that honors the
        // argument can fire this fast.
        const budgeted = session.sendUnary("host.status", {}, null, 60);
        // The positive control: same request, no budget. If the argument were
        // still ignored, both would behave identically - and this one must NOT
        // settle inside the window, or the assertion above proves nothing.
        const defaulted = session.sendUnary("host.status", {}, null, undefined);
        let defaultedSettled = false;
        void defaulted.then(
          () => {
            defaultedSettled = true;
          },
          () => {
            defaultedSettled = true;
          },
        );

        const error: unknown = await budgeted.then(
          () => null,
          (reason: unknown) => reason,
        );
        expect((error as HostRpcError).message).toContain(
          "timed out awaiting a response",
        );
        // Dispatched-but-unheard, not a delivered answer. A caller that can
        // recover from an unheard read (the rate-limit queue collects the
        // host's gauge cache shortly after) can only do so if it can TELL, and
        // a plain `HostRpcError` reads as an answer. Same line `WsRpcClient`
        // draws once the request is on the wire.
        expect(error).toBeInstanceOf(HostTransportFailureError);
        // ...but still NOT retryable: the host may already have applied it, so
        // nothing should resend on its own.
        expect(error).not.toBeInstanceOf(RetryableTransportError);
        expect(defaultedSettled).toBe(false);
      } finally {
        session.close();
      }
    },
    WAIT.timeout,
  );

  it(
    "rejects the pending sendUnary promptly with the FATAL's code, and the client CLOSEs the stream",
    async () => {
      const relay = new FakeRelayHost();
      relay.floorRpcManifest = { "host.status": { major: 1, minor: 0 } };
      // The harness must NOT auto-answer this REQUEST - the whole point is
      // that the host abandons it with a stream-scoped FATAL instead.
      relay.skipUnaryAutoRespond = true;
      const lease = new MutableBearerLease("valid-token", "user-1");
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        rpcRegistry: statusRegistry,
      });
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);

        const pending = session.sendUnary("host.status", {}, null, undefined);
        await vi.waitFor(
          () => expect(relay.unaryRequests).toHaveLength(1),
          WAIT,
        );
        const streamId = relay.unaryRequests[0]?.streamId;
        if (streamId === undefined) {
          throw new Error("no REQUEST recorded");
        }

        await relay.sendStreamFatal(streamId, {
          code: "RPC_ERROR",
          reason: "host abandoned the request mid-flight",
          incompatibleMethods: null,
          upgradeGuidance: null,
        });

        // Settles well inside a normal `await` - nowhere near the 30s unary
        // timeout, which this pins is NOT what settled the promise.
        const error: unknown = await pending.then(
          () => null,
          (reason: unknown) => reason,
        );
        expect(error).toBeInstanceOf(HostRpcError);
        expect((error as HostRpcError).fatalDetails?.code).toBe("RPC_ERROR");

        // The client tells the host it is done with the stream - the host
        // must not keep producing/pacing for an id this side already
        // tombstoned. The host tombstoned the id itself when it sent the
        // FATAL, so its R-2 ingest DROPS this CLOSE rather than processing
        // it - the drop record is the evidence the client sent it at all.
        await vi.waitFor(
          () =>
            expect(
              relay.droppedTombstonedFrames.some(
                (frame) =>
                  frame.streamId === streamId &&
                  frame.type === MuxFrameType.CLOSE,
              ),
            ).toBe(true),
          WAIT,
        );
        // The FATAL was stream-scoped, not session-level - the session
        // itself survives untouched.
        expect(session.isClosed()).toBe(false);
        expect(session.isReady()).toBe(true);
        expect(relay.errors).toEqual([]);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe("RemoteSession poisoned inbound on a subscription stream (S2 / S4-client)", () => {
  it(
    "fails the poisoned stream and notifies the host (S2), then refuses to resurrect an accumulator for the withheld genuine chunks (S4-client)",
    async () => {
      const relay = new FakeRelayHost();
      relay.streamManifest = buildStreamManifest(
        cursorStreamRegistry,
        SERVES_EVERY_INSTALLED_MAJOR,
      );
      const lease = new MutableBearerLease("valid-token", "user-1");
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        streamRegistry: cursorStreamRegistry,
      });
      // A sibling stream, subscribed BEFORE the attack, so it can prove
      // afterward that the poisoned stream's failure stayed local to itself.
      const streamA = session.subscribe("cursor.subscribe", { cursor: null });
      const streamB = session.subscribe("cursor.subscribe", { cursor: null });
      let streamAClosedReason: StreamCloseReason | null = null;
      streamA.onStatusChange((status, reason) => {
        if (status === "closed") {
          streamAClosedReason = reason;
        }
      });
      let streamBDelivered: StreamFrameEnvelope | null = null;
      streamB.onServerFrame((envelope) => {
        streamBDelivered = envelope;
      });
      try {
        await vi.waitFor(
          () => expect(relay.subscribeStreamIds).toHaveLength(2),
          WAIT,
        );
        const [streamIdA, streamIdB] = relay.subscribeStreamIds;

        // A genuine 3-chunk sequence for stream A. Only the FINAL chunk is
        // delivered first (adversarial reorder - the relay withholds the
        // genuine CHUNK_FIRST and middle chunk) - no CHUNK_FIRST for this
        // streamId has EVER been sent, so `accept()` throws a bare
        // `ChunkReassemblyError` (a continuation with no accumulator at
        // all), not a sequence mismatch.
        const bodyA = encodeMuxMessageBody(
          { kind: "snapshot", hasBinaryPayload: true },
          new TextEncoder().encode("y".repeat(300)),
        );
        const third = Math.ceil(bodyA.length / 3);
        const genuineFrames: EncodeMuxFrameInput[] = [
          {
            type: MuxFrameType.STREAM_FRAME,
            streamId: streamIdA,
            seq: 0,
            qos: QosClass.INTERACTIVE,
            chunked: true,
            chunkFirst: true,
            chunkLast: false,
            compressed: false,
            json: null,
            binary: bodyA.subarray(0, third),
          },
          {
            type: MuxFrameType.STREAM_FRAME,
            streamId: streamIdA,
            seq: 1,
            qos: QosClass.INTERACTIVE,
            chunked: true,
            chunkFirst: false,
            chunkLast: false,
            compressed: false,
            json: null,
            binary: bodyA.subarray(third, 2 * third),
          },
          {
            type: MuxFrameType.STREAM_FRAME,
            streamId: streamIdA,
            seq: 2,
            qos: QosClass.INTERACTIVE,
            chunked: true,
            chunkFirst: false,
            chunkLast: true,
            compressed: false,
            json: null,
            binary: bodyA.subarray(2 * third),
          },
        ];

        // S2: deliver ONLY the final chunk. No accumulator exists for this
        // streamId, so this trips `ChunkReassemblyError` ->
        // `failStreamOnInboundError`.
        const sealedFinal = await relay.encryptFrame(genuineFrames[2]);
        relay.deliverToClient(sealedFinal);

        await vi.waitFor(
          () => expect(streamAClosedReason).not.toBeNull(),
          WAIT,
        );
        expect(streamAClosedReason).toEqual({
          kind: "fatalError",
          details: expect.objectContaining({
            code: "STREAM_CHUNK_REASSEMBLY_FAILED",
          }),
        });
        // The failure is communicated to the host, not silently local-only:
        // the client CLOSEs the stream it just condemned.
        await vi.waitFor(
          () => expect(relay.closesSent).toContain(streamIdA),
          WAIT,
        );
        expect(session.pendingReassemblyCount).toBe(0);
        expect(session.isClosed()).toBe(false);

        // S4-client: the relay now delivers the withheld GENUINE start-chunk
        // and middle chunk for the SAME (now-tombstoned) streamId. Pre-R-2
        // this would call `reassembler.accept()` before ever checking
        // whether the streamId already failed, starting a fresh,
        // uncollectable accumulator.
        const closesBeforeReplay = relay.closesSent.length;
        const sealedFirst = await relay.encryptFrame(genuineFrames[0]);
        const sealedMiddle = await relay.encryptFrame(genuineFrames[1]);
        relay.deliverToClient(sealedFirst);
        relay.deliverToClient(sealedMiddle);
        // Give the fire-and-forget `onData` handler a tick to run.
        await Promise.resolve();
        await Promise.resolve();

        // No accumulator got created, and no duplicate CLOSE was sent - the
        // frames were dropped outright as tombstoned.
        expect(session.pendingReassemblyCount).toBe(0);
        expect(relay.closesSent.length).toBe(closesBeforeReplay);
        // The session survived untouched - not force-closed over a single
        // condemned stream.
        expect(session.isClosed()).toBe(false);

        // A sibling stream, subscribed before the attack, still works.
        const normalEnvelope = { kind: "snapshot", hasBinaryPayload: false };
        await relay.sendStreamFrame(
          streamIdB,
          normalEnvelope,
          null,
          QosClass.INTERACTIVE,
        );
        await vi.waitFor(() => expect(streamBDelivered).not.toBeNull(), WAIT);
        expect(streamBDelivered).toEqual(normalEnvelope);
        expect(session.isReady()).toBe(true);
        expect(relay.errors).toEqual([]);
      } finally {
        streamB.close();
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe("RemoteSession evidence classification (redesign P1.3 invariant 5)", () => {
  it(
    "plan-restricted attach-grant denial reports exactly one refusal, never an indeterminate",
    async () => {
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("valid-token", "user-1");
      const recorder = new RecordingEvidence();
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        grantProvider: () =>
          Promise.resolve({ kind: "plan-restricted" as const }),
        evidence: recorder,
      });
      try {
        session.start();
        await vi.waitFor(() => expect(session.isClosed()).toBe(true), WAIT);

        const refusals = recorder.callsNamed("reportDialRefusal");
        expect(refusals).toHaveLength(1);
        expect(refusals[0].refusalDetail).toBe("plan-restricted");
        expect(refusals[0].hostId).toBe("host-1");
        expect(refusals[0].transportKind).toBe("remote-relay");
        expect(recorder.callsNamed("reportDialIndeterminate")).toHaveLength(0);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "an unavailable attach-grant mint (signed out / revoked / authn 5xx) reports exactly one indeterminate, never a refusal",
    async () => {
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("valid-token", "user-1");
      const recorder = new RecordingEvidence();
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        grantProvider: () =>
          Promise.resolve({
            kind: "unavailable" as const,
            detail: "authn answered HTTP 500",
            context: "",
          }),
        evidence: recorder,
      });
      try {
        session.start();
        await vi.waitFor(
          () => expect(recorder.calls.length).toBeGreaterThan(0),
          WAIT,
        );

        const indeterminates = recorder.callsNamed("reportDialIndeterminate");
        expect(indeterminates).toHaveLength(1);
        expect(indeterminates[0].hostId).toBe("host-1");
        expect(indeterminates[0].transportKind).toBe("remote-relay");
        // The classification rule's whole point: a credential/authn-plane
        // failure must never be counted as a refusal, or one authn outage
        // would reach the confirmed-death streak on every remote host at
        // once and fail the whole fleet over (module header, transport
        // -evidence.ts).
        expect(recorder.callsNamed("reportDialRefusal")).toHaveLength(0);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe("RemoteSession evidence retraction on terminal-fatal (redesign P1.3)", () => {
  it(
    "a session that reached ready and then goes terminal-fatal still retracts through sessionLost, and a fresh session's connection-loss refusal is not suppressed afterward",
    async () => {
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("valid-token", "user-1");
      const recorder = new RecordingEvidence();
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        evidence: recorder,
      });
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);

        const established = recorder.callsNamed("sessionEstablished");
        expect(established).toHaveLength(1);
        const announcedSessionId = established[0].sessionId;

        // Drive a genuine terminal-fatal (not a plain drop): a session-level
        // FATAL whose code is neither `retryable` nor `UNAUTHORIZED` stays
        // terminal via `goTerminalFatal`, exactly like the existing
        // "terminal close notification" describe block above.
        await relay.sendStreamFatal(SESSION_CONTROL_STREAM_ID, {
          code: "INCOMPATIBLE",
          reason: "manifest mismatch",
          incompatibleMethods: null,
          upgradeGuidance: null,
        });
        await vi.waitFor(() => expect(session.isClosed()).toBe(true), WAIT);

        const lost = recorder.callsNamed("sessionLost");
        expect(lost).toHaveLength(1);
        expect(lost[0].sessionId).toBe(announcedSessionId);
        expect(lost[0].hostId).toBe("host-1");

        // A fresh session/generation for the SAME host must still be able to
        // produce refusal evidence afterward - proving `teardownConnection`'s
        // retraction really ran and left no phantom "still live" session
        // suppressing later death evidence for this host (module header,
        // `announcedSessionId`).
        const deadFactory: IStreamWebSocketFactory = {
          create: (): StreamWebSocketLike => {
            const socket = new FakeSocket(
              () => undefined,
              () => undefined,
            );
            queueMicrotask(() => {
              socket.onclose?.({ code: 1006, reason: "", wasClean: false });
            });
            return socket;
          },
        };
        const freshSession = new RemoteSession({
          ...buildSessionOptions(relay, lease, null),
          webSocketFactory: deadFactory,
          evidence: recorder,
        });
        try {
          freshSession.start();
          await vi.waitFor(
            () =>
              expect(
                recorder.callsNamed("reportDialRefusal").length,
              ).toBeGreaterThan(0),
            WAIT,
          );
          const freshRefusals = recorder.callsNamed("reportDialRefusal");
          expect(freshRefusals).toHaveLength(1);
          expect(freshRefusals[0].hostId).toBe("host-1");
          expect(freshRefusals[0].refusalDetail).toBeNull();
        } finally {
          freshSession.close();
        }
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe("RemoteSession connection-loss attempt id is distinct from its generation's success id (redesign P1.3)", () => {
  it(
    "the connection-loss refusal after a ready boundary uses a suffixed id, not the dial-success attempt id",
    async () => {
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("valid-token", "user-1");
      const recorder = new RecordingEvidence();
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        evidence: recorder,
      });
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);

        const successes = recorder.callsNamed("reportDialSuccess");
        expect(successes).toHaveLength(1);
        const successAttemptId = successes[0].attemptId;

        relay.dropCurrentConnection();
        await vi.waitFor(
          () =>
            expect(
              recorder.callsNamed("reportDialRefusal").length,
            ).toBeGreaterThan(0),
          WAIT,
        );

        const refusals = recorder.callsNamed("reportDialRefusal");
        expect(refusals).toHaveLength(1);
        const lostAttemptId = refusals[0].attemptId;
        // Not deduped away: reusing the generation's own dial-success id
        // here would collide with the authority's per-attempt-id dedup and
        // swallow the very first refusal after a live session died.
        expect(lostAttemptId).not.toBe(successAttemptId);
        expect(lostAttemptId).toBe(`${successAttemptId}-lost`);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe("RemoteSession restart tombstone forwarding (P1.4 / D5 / M1)", () => {
  it(
    "a session-level FATAL carrying restartIntent + retryable:true reports exactly one reportRestartIntent with the right hostId/tombstoneId/expiresAt, and the session reconnects instead of going terminal",
    async () => {
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("valid-token", "user-1");
      const recorder = new RecordingEvidence();
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        evidence: recorder,
      });
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);

        await relay.sendStreamFatal(SESSION_CONTROL_STREAM_ID, {
          code: HOST_RESTARTING_FATAL_CODE,
          reason: "The host is restarting and expects to be back shortly",
          incompatibleMethods: null,
          upgradeGuidance: null,
          retryable: true,
          restartIntent: {
            tombstoneId: "tombstone-c1",
            expiresAt: 1_700_000_000_000,
          },
        });

        await vi.waitFor(
          () =>
            expect(
              recorder.callsNamed("reportRestartIntent").length,
            ).toBeGreaterThan(0),
          WAIT,
        );
        const tombstones = recorder.callsNamed("reportRestartIntent");
        expect(tombstones).toHaveLength(1);
        expect(tombstones[0].hostId).toBe("host-1");
        expect(tombstones[0].tombstoneId).toBe("tombstone-c1");
        expect(tombstones[0].expiresAt).toBe(1_700_000_000_000);

        // The session must NOT go terminal - it reconnects, exactly like any
        // other retryable session-fatal.
        expect(session.isClosed()).toBe(false);
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "a session-level FATAL with NO restartIntent produces zero reportRestartIntent calls - old-host compat",
    async () => {
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("valid-token", "user-1");
      const recorder = new RecordingEvidence();
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        evidence: recorder,
      });
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);

        await relay.sendStreamFatal(SESSION_CONTROL_STREAM_ID, {
          code: "SOME_TRANSIENT_CODE",
          reason: "a transient host-side rejection carrying no tombstone",
          incompatibleMethods: null,
          upgradeGuidance: null,
          retryable: true,
        });

        // Positive control in the SAME test: the retryable path DOES still
        // run and produce its ordinary loss evidence, so the absence of a
        // tombstone report below is not because nothing happened at all.
        await vi.waitFor(
          () =>
            expect(
              recorder.callsNamed("reportDialRefusal").length,
            ).toBeGreaterThan(0),
          WAIT,
        );
        expect(recorder.callsNamed("reportRestartIntent")).toHaveLength(0);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "the tombstone report does not replace the ordinary connection-loss evidence - both are present, in order",
    async () => {
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("valid-token", "user-1");
      const recorder = new RecordingEvidence();
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        evidence: recorder,
      });
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);

        await relay.sendStreamFatal(SESSION_CONTROL_STREAM_ID, {
          code: HOST_RESTARTING_FATAL_CODE,
          reason: "restarting",
          incompatibleMethods: null,
          upgradeGuidance: null,
          retryable: true,
          restartIntent: { tombstoneId: "tombstone-c3", expiresAt: null },
        });

        await vi.waitFor(
          () =>
            expect(
              recorder.callsNamed("reportDialRefusal").length,
            ).toBeGreaterThan(0),
          WAIT,
        );

        const restartIntentIndex = recorder.calls.findIndex(
          (call) => call.method === "reportRestartIntent",
        );
        const dialRefusalIndex = recorder.calls.findIndex(
          (call) => call.method === "reportDialRefusal",
        );
        expect(restartIntentIndex).toBeGreaterThanOrEqual(0);
        expect(dialRefusalIndex).toBeGreaterThanOrEqual(0);
        // Two honest reports, not one that tries to mean both: the tombstone
        // is filed before the funnel retracts liveness and reports the loss.
        expect(restartIntentIndex).toBeLessThan(dialRefusalIndex);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "a FATAL carrying restartIntent with retryable absent still reports the tombstone - every arm reports it, not only the retryable one",
    async () => {
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("valid-token", "user-1");
      const recorder = new RecordingEvidence();
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        evidence: recorder,
      });
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);

        await relay.sendStreamFatal(SESSION_CONTROL_STREAM_ID, {
          code: "INCOMPATIBLE",
          reason: "manifest mismatch",
          incompatibleMethods: null,
          upgradeGuidance: null,
          restartIntent: { tombstoneId: "tombstone-c4", expiresAt: null },
        });

        await vi.waitFor(() => expect(session.isClosed()).toBe(true), WAIT);

        const tombstones = recorder.callsNamed("reportRestartIntent");
        expect(tombstones).toHaveLength(1);
        expect(tombstones[0].tombstoneId).toBe("tombstone-c4");
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe("RemoteSession F7: a caller-requested reconnect is self-evidence, not host evidence", () => {
  it(
    "a caller-requested reconnect (LogicalStream.requestReconnect -> requestSessionReconnect) reports reportDialIndeterminate, NOT reportDialRefusal",
    async () => {
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("valid-token", "user-1");
      const recorder = new RecordingEvidence();
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        evidence: recorder,
      });
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);

        // `RemoteSession.requestSessionReconnect` is the exact
        // `LogicalStreamPort` member `LogicalStream.requestReconnect()`
        // delegates to in production (see `logical-stream.ts`); calling it
        // directly here avoids simulating a full subscribe/restore cycle
        // through the fake relay while still driving the SAME funnel arm.
        session.requestSessionReconnect("caller-requested-reconnect");

        await vi.waitFor(
          () =>
            expect(
              recorder.callsNamed("reportDialIndeterminate").length,
            ).toBeGreaterThan(0),
          WAIT,
        );
        expect(recorder.callsNamed("reportDialRefusal")).toHaveLength(0);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "a genuine relay-socket close still reports reportDialRefusal - the control arm proving the caller-requested test above was not bought by a silenced funnel",
    async () => {
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("valid-token", "user-1");
      const recorder = new RecordingEvidence();
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        evidence: recorder,
      });
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);

        relay.dropCurrentConnection();

        await vi.waitFor(
          () =>
            expect(
              recorder.callsNamed("reportDialRefusal").length,
            ).toBeGreaterThan(0),
          WAIT,
        );
        expect(recorder.callsNamed("reportDialRefusal")).toHaveLength(1);
        expect(recorder.callsNamed("reportDialIndeterminate")).toHaveLength(0);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "the missing-bearer path reports indeterminate - credential plane, never dialed the host",
    async () => {
      const relay = new FakeRelayHost();
      // Empty from the start: every attach attempt fails to present a
      // bearer at `sendOpenFrame`, so this drives the SAME `not-host-evidence`
      // funnel arm without needing a mid-session credential drop.
      const lease = new MutableBearerLease("", "user-1");
      const recorder = new RecordingEvidence();
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        evidence: recorder,
      });
      try {
        session.start();
        await vi.waitFor(
          () =>
            expect(
              recorder.callsNamed("reportDialIndeterminate").length,
            ).toBeGreaterThan(0),
          WAIT,
        );
        expect(recorder.callsNamed("reportDialRefusal")).toHaveLength(0);
        expect(session.isReady()).toBe(false);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    "three consecutive caller-requested reconnects produce ZERO refusals - three app-driven reconnects must not reach the confirmed-death streak on a host that never stopped answering",
    async () => {
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("valid-token", "user-1");
      const recorder = new RecordingEvidence();
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        evidence: recorder,
      });
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);

        for (let attempt = 0; attempt < 3; attempt += 1) {
          session.requestSessionReconnect("caller-requested-reconnect");
          await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        }

        expect(recorder.callsNamed("reportDialRefusal")).toHaveLength(0);
        expect(
          recorder.callsNamed("reportDialIndeterminate").length,
        ).toBeGreaterThanOrEqual(3);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );
});

describe("RemoteSession reconnect backoff ladder (T5, B6)", () => {
  // These assertions bound EXACT rung delays, so the equal jitter every
  // non-immediate rung carries is pinned to its ceiling (factor 1.0 = the
  // un-jittered base). The jitter's own behaviour is covered by the wake and
  // escalation suites, which assert ranges against real randomness.
  let jitterPin: MockInstance<() => number>;
  beforeEach(() => {
    jitterPin = vi.spyOn(Math, "random").mockReturnValue(1);
  });
  afterEach(() => {
    jitterPin.mockRestore();
  });

  /** A socket factory whose every dial fails immediately (a dead relay hostname) - drives the ladder without ever needing a real handshake. */
  function alwaysFailFactory(onCreate: () => void): IStreamWebSocketFactory {
    return {
      create: (): StreamWebSocketLike => {
        onCreate();
        const socket = new FakeSocket(
          () => undefined,
          () => undefined,
        );
        Promise.resolve().then(() => {
          socket.onclose?.({ code: 1006, reason: "", wasClean: false });
        });
        return socket;
      },
    };
  }

  it("after a session has reached ready, the next drop redials at 0ms and only THEN climbs to RECONNECT_INITIAL_BACKOFF_MS", async () => {
    // REAL timers, deliberately: `beginConnect` runs a genuine WebCrypto
    // key generation (`NoiseChannel.begin`) before it ever reaches the
    // socket factory, and that operation does not resolve under
    // `vi.useFakeTimers()` (confirmed empirically - the very first dial
    // attempt never landed even after advancing 130s of fake time). The
    // doubling-and-cap ARITHMETIC is already proven in isolation by
    // `backoff.test.ts`; this test's job is only to prove RemoteSession
    // wires `reconnectAttempt` through that formula, including the rung-0
    // special case - so it observes the first two real rungs, not the
    // full climb to the 30s cap.
    //
    // The session MUST reach ready before the measured drop, and that is
    // the whole point rather than setup noise: the immediate rung is a
    // RECOVERY affordance, gated on `hasReachedReadyOnce`. A session that
    // has never connected deliberately keeps the original ladder, because
    // its retries are evidence about host liveness and doubling their rate
    // would hammer a host that is legitimately down. An earlier version of
    // this test measured a never-ready session and asserted 0ms, which
    // pinned exactly the behaviour that gating removed.
    const relay = new FakeRelayHost();
    const lease = new MutableBearerLease("valid-token", "user-1");
    let firstDialTaken = false;
    const redialTimestamps: number[] = [];
    const succeedOnceThenFail: IStreamWebSocketFactory = {
      create: (url: string): StreamWebSocketLike => {
        if (!firstDialTaken) {
          firstDialTaken = true;
          return relay.factory.create(url);
        }
        redialTimestamps.push(Date.now());
        const socket = new FakeSocket(
          () => undefined,
          () => undefined,
        );
        Promise.resolve().then(() => {
          socket.onclose?.({ code: 1006, reason: "", wasClean: false });
        });
        return socket;
      },
    };
    const session = new RemoteSession({
      ...buildSessionOptions(relay, lease, null),
      webSocketFactory: succeedOnceThenFail,
    });
    try {
      session.start();
      await vi.waitFor(() => expect(session.isReady()).toBe(true), {
        timeout: 10_000,
        interval: 20,
      });

      const droppedAt = Date.now();
      relay.dropCurrentConnection();
      await vi.waitFor(
        () => expect(redialTimestamps.length).toBeGreaterThanOrEqual(2),
        { timeout: 8_000, interval: 20 },
      );

      // Rung 0: the redial after losing a HEALTHY session is immediate -
      // allow scheduling jitter, not a full second.
      expect(redialTimestamps[0] - droppedAt).toBeLessThan(200);
      // Rung 1: the real INITIAL_BACKOFF_MS, proving the rung-0 special
      // case does not leak into later rungs.
      const secondGap = redialTimestamps[1] - redialTimestamps[0];
      expect(secondGap).toBeGreaterThanOrEqual(RECONNECT_INITIAL_BACKOFF_MS);
      expect(secondGap).toBeLessThan(RECONNECT_INITIAL_BACKOFF_MS + 300);
    } finally {
      session.close();
    }
  }, 12_000);

  it("a session that has NEVER reached ready keeps the original ladder - its first failure waits RECONNECT_INITIAL_BACKOFF_MS, not 0ms", async () => {
    // The other half of the gate, and the one with real consequences: a
    // never-connected session's retries feed the host-liveness evidence
    // machinery, so granting them the immediate rung would both hammer a
    // host that is legitimately down and accelerate the death-streak logic
    // that reads those attempts. Two evidence-classification tests in this
    // file fail if this regresses, which is the coupling that makes this
    // behaviour load-bearing rather than cosmetic.
    const relay = new FakeRelayHost();
    const lease = new MutableBearerLease("valid-token", "user-1");
    const createTimestamps: number[] = [];
    const session = new RemoteSession({
      ...buildSessionOptions(relay, lease, null),
      webSocketFactory: alwaysFailFactory(() => {
        createTimestamps.push(Date.now());
      }),
    });
    try {
      session.start();
      await vi.waitFor(
        () => expect(createTimestamps.length).toBeGreaterThanOrEqual(2),
        { timeout: 8_000, interval: 20 },
      );
      const firstGap = createTimestamps[1] - createTimestamps[0];
      expect(firstGap).toBeGreaterThanOrEqual(RECONNECT_INITIAL_BACKOFF_MS);
    } finally {
      session.close();
    }
  }, 10_000);

  it("the ladder resets to rung 0 only after RECONNECT_STABLE_RESET_MS of sustained ready - a session that already climbed the ladder once and drops again soon after reaching ready does NOT get rung 0 a second time", async () => {
    // The flapping case, stated explicitly and set up honestly: rung 0 is
    // legitimately available to a session's very FIRST-ever failure (that
    // is the whole point of the feature), so proving the ladder does NOT
    // reset on a quick re-drop requires this session to have already
    // consumed rung 0 once, via one real failure, BEFORE it ever reaches
    // ready. Only then does a second drop shortly after ready expose
    // whether the reset is real or premature.
    const relay = new FakeRelayHost();
    const lease = new MutableBearerLease("valid-token", "user-1");
    let failuresLeft = 1;
    const flakyFactory: IStreamWebSocketFactory = {
      create: (url: string): StreamWebSocketLike => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          const socket = new FakeSocket(
            () => undefined,
            () => undefined,
          );
          Promise.resolve().then(() => {
            socket.onclose?.({ code: 1006, reason: "", wasClean: false });
          });
          return socket;
        }
        return relay.factory.create(url);
      },
    };
    const session = new RemoteSession({
      ...buildSessionOptions(relay, lease, null),
      webSocketFactory: flakyFactory,
    });
    try {
      session.start();
      // The one prior failure resolves and redials (rung 0, immediate),
      // which this time succeeds via the real relay factory.
      await vi.waitFor(() => expect(session.isReady()).toBe(true), {
        timeout: 10_000,
        interval: 20,
      });
      expect(failuresLeft).toBe(0);

      // Comfortably short of RECONNECT_STABLE_RESET_MS: the ladder reset
      // timer has not fired yet when the connection drops again.
      expect(RECONNECT_STABLE_RESET_MS).toBeGreaterThan(300);

      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      relay.dropCurrentConnection();
      await vi.waitFor(() => expect(setTimeoutSpy).toHaveBeenCalled(), {
        timeout: 2_000,
        interval: 20,
      });

      // This session already spent rung 0 on its first-ever failure, so
      // this second, post-ready drop must continue the ladder rather than
      // restart it - or a host that accepts and immediately drops
      // sessions gets hammered at the fastest rung forever.
      expect(setTimeoutSpy).toHaveBeenCalledWith(
        expect.any(Function),
        RECONNECT_INITIAL_BACKOFF_MS,
      );
      expect(setTimeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 0);
      setTimeoutSpy.mockRestore();
    } finally {
      session.close();
    }
  }, 12_000);

  it("connection loss cancels the pending stable-reset timer", async () => {
    const relay = new FakeRelayHost();
    const lease = new MutableBearerLease("valid-token", "user-1");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const session = new RemoteSession(buildSessionOptions(relay, lease, null));
    try {
      session.start();
      await vi.waitFor(() => expect(session.isReady()).toBe(true), {
        timeout: 10_000,
        interval: 20,
      });

      // Identify the EXACT timer handle `armStableResetTimer` scheduled at
      // the ready boundary (its delay is the unique fingerprint), so this
      // test proves the SPECIFIC timer was cancelled - not merely that
      // *some* `clearTimeout` call happened to fire around the same time.
      const stableResetCallIndexes = setTimeoutSpy.mock.calls
        .map((call, index) =>
          call[1] === RECONNECT_STABLE_RESET_MS ? index : -1,
        )
        .filter((index) => index >= 0);
      // `RECONNECT_MAX_BACKOFF_MS` is also 30_000, so a second match would
      // mean this test is about to fingerprint the backoff handle instead.
      // Safe today only because the session reaches ready on the first dial
      // and no capped backoff timer exists; an edit that adds a prior failure
      // to the setup would silently select the wrong one, and the assertion
      // would then pass or fail for a reason unrelated to its name.
      expect(stableResetCallIndexes).toHaveLength(1);
      const stableResetHandle =
        setTimeoutSpy.mock.results[stableResetCallIndexes[0]].value;

      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
      relay.dropCurrentConnection();
      await vi.waitFor(() => expect(clearTimeoutSpy).toHaveBeenCalled(), {
        timeout: 2_000,
        interval: 20,
      });

      expect(clearTimeoutSpy).toHaveBeenCalledWith(stableResetHandle);
      clearTimeoutSpy.mockRestore();
    } finally {
      session.close();
      setTimeoutSpy.mockRestore();
    }
  }, 10_000);
});

describe("RemoteSession per-stream retryable FATAL recovery", () => {
  // `retryable` has to mean the same thing on both transports. On the local
  // socket a retryable close is followed by the session's own reconnect, which
  // re-subscribes the stream; here the stream used to be disposed and dropped
  // from `subscriptions` with nothing left to revive it. Consumers read only
  // the flag, so they silenced their error UI for a stream that was in fact
  // permanently dead - strictly worse than the visible failure it replaced.
  it(
    "re-subscribes the stream instead of disposing it, and reports reconnecting rather than closed",
    async () => {
      const relay = new FakeRelayHost();
      relay.streamManifest = buildStreamManifest(
        cursorStreamRegistry,
        SERVES_EVERY_INSTALLED_MAJOR,
      );
      const lease = new MutableBearerLease("valid-token", "user-1");
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        streamRegistry: cursorStreamRegistry,
      });
      const stream = session.subscribe("cursor.subscribe", { cursor: null });
      const statuses: string[] = [];
      stream.onStatusChange((status) => {
        statuses.push(status);
      });
      let framesDelivered = 0;
      stream.onServerFrame(() => {
        framesDelivered += 1;
      });
      try {
        await vi.waitFor(
          () => expect(relay.subscribeStreamIds).toHaveLength(1),
          WAIT,
        );
        const streamId = relay.subscribeStreamIds[0];

        await relay.sendStreamFatal(streamId, {
          code: "EPIC_INIT_FAILED",
          reason: "cloud unreachable while opening",
          retryable: true,
          incompatibleMethods: null,
          upgradeGuidance: null,
        });

        // The recovery is a real re-subscribe on the wire, not merely a status
        // the client invented for itself. With the fake enforcing the host's
        // R-2 ingest drop, a re-subscribe of the tombstoned id would never
        // even be recorded here - so reaching length 2 already proves the
        // re-open rode an id the host will answer.
        await vi.waitFor(
          () => expect(relay.subscribeStreamIds.length).toBeGreaterThan(1),
          WAIT,
        );
        expect(statuses).toContain("reconnecting");
        expect(statuses).not.toContain("closed");
        // The verdict killed the old id on both peers, so the re-open must
        // ride a FRESH one - `config.ts`: stream ids are never reused within
        // a session.
        expect(relay.subscribeStreamIds[1]).not.toBe(streamId);

        await relay.sendStreamFrame(
          relay.subscribeStreamIds[relay.subscribeStreamIds.length - 1],
          { kind: "snapshot", hasBinaryPayload: false },
          null,
          QosClass.INTERACTIVE,
        );
        await vi.waitFor(() => expect(framesDelivered).toBe(1), WAIT);
        // Delivering a frame transitions the stream back to open.
        expect(statuses[statuses.length - 1]).toBe("open");
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  // The other direction, so the recovery cannot swallow a real verdict: an
  // adjudicated fatal must still end the stream terminally.
  it(
    "still disposes the stream terminally when the FATAL is not retryable",
    async () => {
      const relay = new FakeRelayHost();
      relay.streamManifest = buildStreamManifest(
        cursorStreamRegistry,
        SERVES_EVERY_INSTALLED_MAJOR,
      );
      const lease = new MutableBearerLease("valid-token", "user-1");
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        streamRegistry: cursorStreamRegistry,
      });
      const stream = session.subscribe("cursor.subscribe", { cursor: null });
      const statuses: string[] = [];
      stream.onStatusChange((status) => {
        statuses.push(status);
      });
      try {
        await vi.waitFor(
          () => expect(relay.subscribeStreamIds).toHaveLength(1),
          WAIT,
        );
        const streamId = relay.subscribeStreamIds[0];

        await relay.sendStreamFatal(streamId, unauthorizedDetails());

        await vi.waitFor(() => expect(statuses).toContain("closed"), WAIT);
        // No re-subscribe was ever issued for it.
        expect(relay.subscribeStreamIds).toHaveLength(1);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  // The interleaving the per-stream timer alone cannot cover: the session
  // drops DURING the reopen backoff. The re-dial clears every pending
  // per-stream timer and the next openAck replays the subscription itself -
  // and the replay must carry the FRESH id the fatal re-keyed the stream to,
  // because the old id is tombstoned on the client (`handleRelayFrame` would
  // discard every frame it earned) even though the new host session would
  // happily answer it.
  it(
    "recovers a retryable-fatal stream when the session reconnects during the reopen backoff",
    async () => {
      const relay = new FakeRelayHost();
      relay.streamManifest = buildStreamManifest(
        cursorStreamRegistry,
        SERVES_EVERY_INSTALLED_MAJOR,
      );
      const lease = new MutableBearerLease("valid-token", "user-1");
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        streamRegistry: cursorStreamRegistry,
      });
      const stream = session.subscribe("cursor.subscribe", { cursor: null });
      const statuses: string[] = [];
      stream.onStatusChange((status) => {
        statuses.push(status);
      });
      let framesDelivered = 0;
      stream.onServerFrame(() => {
        framesDelivered += 1;
      });
      try {
        await vi.waitFor(
          () => expect(relay.subscribeStreamIds).toHaveLength(1),
          WAIT,
        );
        const streamId = relay.subscribeStreamIds[0];

        await relay.sendStreamFatal(streamId, {
          code: "EPIC_INIT_FAILED",
          reason: "cloud unreachable while opening",
          retryable: true,
          incompatibleMethods: null,
          upgradeGuidance: null,
        });
        // The fatal must be PROCESSED (tombstone set, reopen scheduled) before
        // the drop, or the drop can outrun the frame and the test exercises a
        // plain reconnect instead of the fatal-then-drop interleaving. The
        // first `reconnecting` can only come from the fatal handler here - no
        // drop has happened yet.
        await vi.waitFor(
          () => expect(statuses).toContain("reconnecting"),
          WAIT,
        );
        // Kill the socket before the 1s reopen backoff can fire, so recovery
        // has to ride the session-level handshake replay, not the timer.
        relay.dropCurrentConnection();

        await vi.waitFor(
          () => expect(relay.subscribeStreamIds.length).toBeGreaterThan(1),
          WAIT,
        );
        // The replay rides the re-keyed id, not the tombstoned one.
        expect(relay.subscribeStreamIds[1]).not.toBe(streamId);
        await relay.sendStreamFrame(
          relay.subscribeStreamIds[relay.subscribeStreamIds.length - 1],
          { kind: "snapshot", hasBinaryPayload: false },
          null,
          QosClass.INTERACTIVE,
        );
        await vi.waitFor(() => expect(framesDelivered).toBe(1), WAIT);
        expect(statuses[statuses.length - 1]).toBe("open");
        expect(statuses).not.toContain("closed");
        // The drop cleared the pending per-stream reopen, so the handshake
        // replay is the ONLY re-subscribe - a surviving timer would have sent
        // a duplicate SUBSCRIBE for a stream that already recovered.
        expect(relay.subscribeStreamIds).toHaveLength(2);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  // One broken resolver must not make the whole remote host look unavailable.
  // The ready boundary waits for every subscribed id to earn a frame, and a
  // stream in its private retryable-FATAL loop can never earn one - so before
  // the exemption, `isReady()` stayed false forever, the session was never
  // announced, availability recovery never fired, and the reconnect backoff
  // never reset, while every other stream exchanged frames on a healthy mux.
  it(
    "reaches the ready boundary while one stream is stuck in its retryable-FATAL loop",
    async () => {
      const relay = new FakeRelayHost();
      relay.streamManifest = buildStreamManifest(
        cursorStreamRegistry,
        SERVES_EVERY_INSTALLED_MAJOR,
      );
      const lease = new MutableBearerLease("valid-token", "user-1");
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        streamRegistry: cursorStreamRegistry,
      });
      let recoveredEvents = 0;
      session.subscribeAvailabilityRecovered(() => {
        recoveredEvents += 1;
      });
      const healthy = session.subscribe("cursor.subscribe", { cursor: null });
      // The broken stream: subscribed like any other; the retryable verdict
      // below is what parks it in its private reopen loop.
      session.subscribe("cursor.subscribe", { cursor: null });
      let healthyFrames = 0;
      healthy.onServerFrame(() => {
        healthyFrames += 1;
      });
      try {
        await vi.waitFor(
          () => expect(relay.subscribeStreamIds).toHaveLength(2),
          WAIT,
        );
        const [healthyId, brokenId] = relay.subscribeStreamIds;

        // The healthy stream earns its frame; the broken one gets the
        // retryable verdict that re-keys it and parks it on the reopen
        // backoff - the loop this layer deliberately lets run forever.
        await relay.sendStreamFrame(
          healthyId,
          { kind: "snapshot", hasBinaryPayload: false },
          null,
          QosClass.INTERACTIVE,
        );
        await relay.sendStreamFatal(brokenId, {
          code: "EPIC_INIT_FAILED",
          reason: "cloud unreachable while opening",
          retryable: true,
          incompatibleMethods: null,
          upgradeGuidance: null,
        });

        await vi.waitFor(() => expect(healthyFrames).toBe(1), WAIT);
        // The boundary completes despite the retry-looping stream: the
        // session is ready and the recovery edge (the only automatic signal
        // that un-strands pre-dial query errors) has fired.
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        expect(recoveredEvents).toBe(1);
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );

  // The retry-state ledger has to empty on EVERY terminal path. A delivered
  // frame clears it, a non-retryable FATAL clears it, a caller close clears
  // it - but a HOST close of a reopened stream that had not yet earned its
  // first frame did not, and in this long-lived shared session those entries
  // accumulated per short-lived stream forever.
  it(
    "clears the per-stream retry state when the host CLOSEs a reopened stream before its first frame",
    async () => {
      const relay = new FakeRelayHost();
      relay.streamManifest = buildStreamManifest(
        cursorStreamRegistry,
        SERVES_EVERY_INSTALLED_MAJOR,
      );
      const lease = new MutableBearerLease("valid-token", "user-1");
      const session = new RemoteSession({
        ...buildSessionOptions(relay, lease, null),
        streamRegistry: cursorStreamRegistry,
      });
      const stream = session.subscribe("cursor.subscribe", { cursor: null });
      const statuses: string[] = [];
      stream.onStatusChange((status) => {
        statuses.push(status);
      });
      try {
        await vi.waitFor(
          () => expect(relay.subscribeStreamIds).toHaveLength(1),
          WAIT,
        );
        const streamId = relay.subscribeStreamIds[0];

        await relay.sendStreamFatal(streamId, {
          code: "EPIC_INIT_FAILED",
          reason: "cloud unreachable while opening",
          retryable: true,
          incompatibleMethods: null,
          upgradeGuidance: null,
        });
        // The reopen rides a fresh id (the verdict tombstoned the old one).
        await vi.waitFor(
          () => expect(relay.subscribeStreamIds.length).toBeGreaterThan(1),
          WAIT,
        );
        const reopenedId =
          relay.subscribeStreamIds[relay.subscribeStreamIds.length - 1];
        expect(reopenedId).not.toBe(streamId);
        // The retry loop is live: an attempt is on the books awaiting the
        // first frame that would clear it.
        expect(session.streamReopenStateForTests().attempts).toBe(1);

        // The host ends the reopened stream normally BEFORE any frame - the
        // one terminal path that leaked the entry.
        await relay.sendStreamClose(reopenedId, "resolver finished");
        await vi.waitFor(() => expect(statuses).toContain("closed"), WAIT);
        expect(session.streamReopenStateForTests()).toEqual({
          timers: 0,
          attempts: 0,
        });
      } finally {
        session.close();
      }
    },
    TEST_BUDGET_MS,
  );
});
