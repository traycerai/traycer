import { z } from "zod";
import {
  defineFloorAwareVersionedRpcRegistry,
  defineRpcContract,
  defineVersionedRpcRegistry,
  type FatalErrorDetails,
  type VersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import type { VersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import {
  createResponderHandshake,
  DEFAULT_REPLAY_WINDOW_SIZE,
  generateStaticKeyPair,
  NoiseSession,
  type NoiseHandshakeState,
  type NoiseKeyPair,
} from "@traycer/protocol/crypto/noise";
import { SERVES_EVERY_INSTALLED_MAJOR } from "@traycer/protocol/framework/capability-manifest";
import { defineVersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  MuxFrameType,
  NOISE_PROLOGUE,
  SESSION_CONTROL_STREAM_ID,
  QosClass,
  decodeMuxFrame,
  encodeMuxFrame,
  type EncodeMuxFrameInput,
  type MemberCredentialHandoff,
  type MuxFrame,
  type QosClassValue,
} from "@traycer/protocol/host-transport/mux";
import {
  ChunkReassembler,
  nextSeqValue,
  OutboundChunkSource,
  type OutboundMessage,
  type ReassembledMessage,
} from "@traycer/protocol/host-transport/chunking";
import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import type { StreamAuthRevalidator } from "@traycer-clients/shared/auth/bearer-revalidator";
import type {
  IStreamWebSocketFactory,
  StreamWebSocketLike,
  StreamWebSocketMessageEvent,
} from "../host-transport/ws-stream-factory";
import type {
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketOpenEvent,
} from "../host-transport/ws-factory";
import {
  RemoteSession,
  type RemoteSessionOptions,
} from "../host-transport/remote/remote-session";
import { TEST_CLIENT_IDENTITY } from "./client-identity";

/**
 * The relay + host end of the remote wire, shared by the transport suites in
 * `host-transport/remote/__tests__` and by gui-app suites that drive a real
 * `RemoteSession` through the real credential provisioning module.
 */

const EMPTY_AD = new Uint8Array(0);

export const emptyRpcRegistry: VersionedRpcRegistry =
  defineVersionedRpcRegistry({});
const emptyStreamRegistry: VersionedStreamRpcRegistry =
  defineVersionedStreamRpcRegistry({});

type OpenDecision =
  | { readonly kind: "ack" }
  | { readonly kind: "fatal"; readonly details: FatalErrorDetails };

export function unauthorizedDetails(): FatalErrorDetails {
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
export function retryableDropDetails(): FatalErrorDetails {
  return { ...unauthorizedDetails(), retryable: true };
}

export class FakeSocket implements StreamWebSocketLike {
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
   * Host-side H11 mirror (`RemoteClientSession.inboundSeqByStream`): the
   * `seq` due next on each client stream. The production host closes the
   * whole session with `SESSION_FRAME_SEQUENCE_MISMATCH` when an unchunked
   * frame skips or repeats one, so the fake fails the same way - into
   * `errors`, which the suites assert empty. Without it a client that
   * retired a stream's counter and THEN sent the CLOSE (seq 0 where 1 was
   * due) passed every test here and killed every real session on the first
   * unsubscribe.
   */
  readonly inboundSeqByStream: Map<number, number>;
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
export class FakeRelayHost {
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
  /**
   * The reserved `authz` slot on every `open`, index-aligned with
   * `openBearers`. Raw for the reason `openIdentities` is.
   */
  readonly openAuthz: unknown[] = [];
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
    idempotencyKey: string | null;
    callerAgentId: string | null;
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
  /**
   * When true at a connection's open-ack, THAT connection answers nothing
   * afterwards (no unary RESPONSE). A later attach is a new connection and
   * answers normally unless this flag is still set at ITS open-ack.
   */
  silentAfterReady = false;
  private readonly silentConnections = new Set<FakeConnection>();
  /**
   * Withhold the auto-RESPONSE for these method names only; every other
   * method (including the liveness probe) answers normally.
   */
  silentMethods = new Set<string>();
  /** Delay auto-RESPONSE delivery for timer-bound remote unary tests. */
  unaryResponseDelayMs: number | null = null;
  /**
   * Withhold the Noise responder message (msg1) after `attach_ack`, so the
   * session sits in `handshaking`.
   */
  stallNoiseReply = false;
  /** Count of initiator Noise msg0 frames this fake has ingested. */
  noiseInitiatorMessages = 0;
  /** Every auto-RESPONSE this fake actually put on the wire. */
  readonly unaryResponses: {
    method: string;
    error: {
      readonly code: string;
      readonly message: string;
      readonly holders?: unknown;
    } | null;
  }[] = [];
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
  /**
   * Every `cloudAuthorized` value from a CLOUD_VERDICT_UPDATE control frame
   * the client sent, decoded post-reassembly (the raw `clientFrames` log
   * carries `json: null` for a chunked body - this is the actual payload,
   * the way `subscribeParams` is for SUBSCRIBE).
   */
  readonly cloudVerdictUpdates: boolean[] = [];
  /**
   * The reassembled json of every CREDENTIAL_UPDATE control frame the client
   * sent (raw, like `openAuthz`: the point is what the transport put on the
   * wire). Post-reassembly for the reason `cloudVerdictUpdates` is.
   */
  readonly credentialUpdates: unknown[] = [];
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
        inboundSeqByStream: new Map(),
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
    connection.inboundSeqByStream.delete(streamId);
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
    connection.inboundSeqByStream.delete(streamId);
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
    // THE KEEPALIVE LANE DOES NOT QUEUE BEHIND THE MUX LANE. `handleClientSend`
    // awaits a real WebCrypto decrypt for every data frame, and the queue is
    // serial - so a ping sent while two frames are in flight is answered only
    // after both decrypts resolve. Under `shouldAdvanceTime` that real latency
    // becomes fake milliseconds, and on a loaded runner it can exceed the
    // client's 12s awaiting-pong deadline: the socket fails 4004
    // `relay-missed-pongs`, the session rebuilds mid-test, and whatever the
    // test was actually pinning is lost to a teardown it never asked for.
    // (Observed in CI on the D4 error-envelope control, never locally.) A real
    // relay answers pings at its own edge, never behind the host's mux
    // decryption, so this lane is the FAITHFUL order, not a convenience.
    //
    // A MICROTASK, never inline: `send` returning before its answer arrives is
    // the one thing a real socket does guarantee, and the wake probe arms
    // AFTER the forced ping is sent. Answering reentrantly inside `send`
    // clears a probe that does not exist yet, leaves the armed one unanswered,
    // and makes an answered arm look failed - which silently retires nothing
    // and leaks the previous arm's policy into the next redial.
    if (typeof data === "string" && data === "relay-ping") {
      queueMicrotask(() => {
        this.answerKeepalivePing(connection);
      });
      return;
    }
    connection.queue = connection.queue
      .then(() => this.handleClientSend(connection, data))
      .catch((error: unknown) => {
        this.errors.push(error);
      });
  }

  private answerKeepalivePing(connection: FakeConnection): void {
    if (connection.closed) {
      return;
    }
    this.pingCount += 1;
    if (this.answerPings) {
      connection.socket.onmessage?.({ type: "text", data: "relay-pong" });
    }
  }

  private async handleClientSend(
    connection: FakeConnection,
    data: string | Uint8Array,
  ): Promise<void> {
    if (connection.closed) {
      return;
    }
    if (typeof data === "string") {
      // Pings never reach here - `enqueue` answers them off the queue, see
      // its comment. `reauth` control frames need no ack for these tests.
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
      this.noiseInitiatorMessages += 1;
      if (this.stallNoiseReply) {
        return;
      }
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
    // H11 mirror, same placement and predicate as the production host's
    // `feedInbound`: after the tombstone drop, before `accept()`, unchunked
    // frames only (chunk sequences are ordered by the reassembler itself).
    const expectedSeq = connection.inboundSeqByStream.get(frame.streamId);
    if (
      !frame.chunked &&
      expectedSeq !== undefined &&
      frame.seq !== expectedSeq
    ) {
      throw new Error(
        `SESSION_FRAME_SEQUENCE_MISMATCH: frame ${frame.seq} (type ${frame.type}) arrived on stream ${frame.streamId} where ${expectedSeq} was due`,
      );
    }
    const message = connection.reassembler.accept(frame);
    // Advanced only once the reassembler accepted the frame, as on the host.
    connection.inboundSeqByStream.set(frame.streamId, nextSeqValue(frame.seq));
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
    if (message.type === MuxFrameType.CLOUD_VERDICT_UPDATE) {
      const json = message.json;
      if (json !== null && typeof json.cloudAuthorized === "boolean") {
        this.cloudVerdictUpdates.push(json.cloudAuthorized);
      }
      return;
    }
    if (message.type === MuxFrameType.CREDENTIAL_UPDATE) {
      this.credentialUpdates.push(message.json);
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
        idempotencyKey:
          typeof json.idempotencyKey === "string" ? json.idempotencyKey : null,
        callerAgentId:
          typeof json.callerAgentId === "string" ? json.callerAgentId : null,
        streamId: message.streamId,
      });
      const method = typeof json.method === "string" ? json.method : "";
      if (
        this.skipUnaryAutoRespond ||
        this.silentConnections.has(connection) ||
        this.silentMethods.has(method)
      ) {
        return;
      }
      const sendResponse = async (): Promise<void> => {
        await this.sendMux(connection, {
          type: MuxFrameType.RESPONSE,
          streamId: message.streamId,
          qos: QosClass.INTERACTIVE,
          json: {
            requestId: typeof json.requestId === "string" ? json.requestId : "",
            method,
            result: this.unaryError === null ? this.unaryResult : null,
            error: this.unaryError,
          },
          binary: null,
        });
      };
      const responseDelayMs = this.unaryResponseDelayMs;
      if (responseDelayMs === null) {
        await sendResponse();
      } else {
        await new Promise<void>((resolve, reject) => {
          setTimeout(() => {
            sendResponse().then(resolve, reject);
          }, responseDelayMs);
        });
      }
      // AFTER the send resolves, so this records DELIVERY and not the
      // intention to deliver. `sendMux` awaits WebCrypto encryption, and a
      // test that waits on this entry and then jumps virtual time through a
      // verdict window would otherwise race the threadpool: the frame lands
      // after the jump, the verdict finds the counter unmoved, and a control
      // manufactures the very silence drop it exists to disprove.
      this.unaryResponses.push({
        method,
        error: this.unaryError,
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
    this.openAuthz.push(message.json?.authz);
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
      if (this.silentAfterReady) {
        this.silentConnections.add(connection);
      }
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

/** The options `buildSession` uses, exposed so a test can drop a field. */
export function buildSessionOptions(
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
    sessionGrant: null,
    clock: null,
    rpcRegistry: emptyRpcRegistry,
    streamRegistry: emptyStreamRegistry,
    webSocketFactory: relay.factory,
    requestId: () => `req-${(nextRequestId += 1)}`,
    evidence: NO_TRANSPORT_EVIDENCE,
    clientIdentity: TEST_CLIENT_IDENTITY,
    // INERT BY DEFAULT, and that is the point: `null` disables the silence
    // machinery end to end, so every construction in this suite that predates
    // it keeps exactly its old behaviour and no stray probe can appear in a
    // fake-timer test's wire log. The D4 pins opt in explicitly with
    // `HOST_STATUS_LIVENESS_PROBE`, a `host.status` registry and a matching
    // `relay.floorRpcManifest`.
    livenessProbe: null,
    mintMemberCredential: null,
  };
}

const HOST_STATUS_CONTRACT = defineRpcContract({
  method: "host.status",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({}),
  responseSchema: z.object({ ready: z.boolean() }),
});

const WORKTREE_GET_BINDING_CONTRACT = defineRpcContract({
  method: "worktree.getBinding",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({
    epicId: z.string(),
    ownerId: z.string(),
    ownerKind: z.enum(["chat", "terminal-agent"]),
  }),
  responseSchema: z.object({
    binding: z.null(),
    missingWorktreePaths: z.array(z.string()),
  }),
});

/**
 * Both registries are written out longhand, and a `versionedMethod(contract)`
 * helper is deliberately NOT factored out of them:
 * `defineFloorAwareVersionedRpcRegistry` validates each line against the
 * literal method name through a conditional type, so a helper returning the
 * widened `VersionedRpcRegistry[string]` collapses `contract` to `never` at
 * the validator and fails to compile. Same longhand shape as the existing
 * `host.status` templates elsewhere in this file.
 */
export function silenceProbeRegistry(): VersionedRpcRegistry {
  return defineFloorAwareVersionedRpcRegistry(
    ["host.status", "worktree.getBinding"] as const,
    {
      "host.status": {
        1: {
          latestMinor: 0,
          versions: {
            0: {
              contract: HOST_STATUS_CONTRACT,
              upgradeFromPreviousVersion: null,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
      "worktree.getBinding": {
        1: {
          latestMinor: 0,
          versions: {
            0: {
              contract: WORKTREE_GET_BINDING_CONTRACT,
              upgradeFromPreviousVersion: null,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    },
  );
}

/** Pin 12's registry: the probe's method is not in it, so it cannot be sent. */
export function bindingOnlyRegistry(): VersionedRpcRegistry {
  return defineFloorAwareVersionedRpcRegistry(
    ["worktree.getBinding"] as const,
    {
      "worktree.getBinding": {
        1: {
          latestMinor: 0,
          versions: {
            0: {
              contract: WORKTREE_GET_BINDING_CONTRACT,
              upgradeFromPreviousVersion: null,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    },
  );
}

/** Every method the silence pins negotiate; callers name the subset they want. */
export const SILENCE_FLOOR_METHODS: ReadonlyArray<
  "host.status" | "worktree.getBinding"
> = ["host.status", "worktree.getBinding"];

export function applySilenceFloor(
  relay: FakeRelayHost,
  methods: ReadonlyArray<"host.status" | "worktree.getBinding">,
): void {
  const floor: Record<string, { major: number; minor: number }> = {};
  for (const method of methods) {
    floor[method] = { major: 1, minor: 0 };
  }
  relay.floorRpcManifest = floor;
}

export const MEMBER_HANDOFF: MemberCredentialHandoff = {
  token: "member-token",
  refreshToken: "member-refresh-token",
  familyId: "family-1",
  provisionedAt: "2026-10-19T00:00:00.000Z",
};

export function buildMemberCredentialSession(
  relay: FakeRelayHost,
  mint: ((hostId: string) => Promise<MemberCredentialHandoff | null>) | null,
): RemoteSession<VersionedRpcRegistry, VersionedStreamRpcRegistry> {
  applySilenceFloor(relay, SILENCE_FLOOR_METHODS);
  const lease = new MutableBearerLease("token", "user-1");
  return new RemoteSession({
    ...buildSessionOptions(relay, lease, null),
    rpcRegistry: silenceProbeRegistry(),
    mintMemberCredential: mint,
  });
}

export function sendHostStatus(
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
