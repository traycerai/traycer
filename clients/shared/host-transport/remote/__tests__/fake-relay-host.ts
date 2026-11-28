import {
  defineVersionedStreamRpcRegistry,
  type VersionedStreamRpcRegistry,
} from "@traycer/protocol/framework/versioned-stream-rpc";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import { SERVES_EVERY_INSTALLED_MAJOR } from "@traycer/protocol/framework/capability-manifest";
import type { FatalErrorDetails } from "@traycer/protocol/framework/index";
import {
  createResponderHandshake,
  generateStaticKeyPair,
  DEFAULT_REPLAY_WINDOW_SIZE,
  NoiseSession,
  type NoiseHandshakeState,
  type NoiseKeyPair,
} from "@traycer/protocol/crypto/noise";
import {
  MuxFrameType,
  NOISE_PROLOGUE,
  QosClass,
  SESSION_CONTROL_STREAM_ID,
  decodeMuxFrame,
  encodeMuxFrame,
  type EncodeMuxFrameInput,
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
import { LogicalStream } from "@traycer/protocol/host-transport/remote/logical-stream";
import type { IStreamSession } from "@traycer/protocol/host-transport/stream-session";
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

const EMPTY_AD = new Uint8Array(0);

export const emptyStreamRegistry: VersionedStreamRpcRegistry =
  defineVersionedStreamRpcRegistry({});

type OpenDecision =
  | { readonly kind: "ack" }
  | { readonly kind: "fatal"; readonly details: FatalErrorDetails };
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
   * As the host's `inboundSeqByStream`: a skipped or repeated seq closes the session
   * (`SESSION_FRAME_SEQUENCE_MISMATCH`), so the fake fails into `errors` too.
   */
  readonly inboundSeqByStream: Map<number, number>;
  /** As the host's `terminalStreamIds`: after a FATAL every later client frame for the id is dropped. */
  readonly terminalStreamIds: Set<number>;
  /** Serializes async frame handling so mux ordering matches the wire. */
  queue: Promise<void>;
  closed: boolean;
}

function presentedGrant(authz: unknown): string {
  if (authz === null || typeof authz !== "object") return "";
  const grant: unknown = Reflect.get(authz, "grant");
  return typeof grant === "string" ? grant : "";
}

type FakeUnaryError = {
  readonly code: string;
  readonly message: string;
  readonly holders?: unknown;
  readonly retryable?: boolean;
  readonly doorReason?: string;
};

/** Barriers on what a fake host receives from its client. */
export class ReceivedMessages {
  private readonly waiters = new Set<(message: ReassembledMessage) => void>();

  /** Resolves on the next message that `matches`; ask before causing it. */
  next(matches: (message: ReassembledMessage) => boolean): Promise<void> {
    return new Promise((resolve) => {
      const waiter = (message: ReassembledMessage): void => {
        if (!matches(message)) return;
        this.waiters.delete(waiter);
        resolve();
      };
      this.waiters.add(waiter);
    });
  }

  arrived(message: ReassembledMessage): void {
    for (const waiter of Array.from(this.waiters)) waiter(message);
  }
}

/** Matches the SUBSCRIBE of this subscription, by its own stream id. */
export function subscribeOf(
  subscription: IStreamSession,
): (message: ReassembledMessage) => boolean {
  if (!(subscription instanceof LogicalStream)) {
    throw new Error("the subscription is not a remote session's stream");
  }
  const streamId = subscription.streamId;
  return (message) =>
    message.type === MuxFrameType.SUBSCRIBE && message.streamId === streamId;
}

/** Matches the CREDENTIAL_UPDATE that carries exactly `bearer`. */
export function credentialUpdateOf(
  bearer: string,
): (message: ReassembledMessage) => boolean {
  return (message) =>
    message.type === MuxFrameType.CREDENTIAL_UPDATE &&
    message.json?.bearer === bearer;
}

export class FakeRelayHost {
  readonly received = new ReceivedMessages();
  private readonly hostKeys: NoiseKeyPair = generateStaticKeyPair();
  private readonly connections: FakeConnection[] = [];
  readonly openBearers: string[] = [];
  /** A client open's bearer is empty; this is the credential. */
  readonly openGrants: string[] = [];
  /** Raw: an absent field must read as a missing key, not a shape mismatch. */
  readonly openIdentities: unknown[] = [];
  readonly openAuthz: unknown[] = [];
  /** Raw, as `openIdentities` is: each open's `capabilities` field. */
  readonly openCapabilities: unknown[] = [];
  readonly subscribeParams: unknown[] = [];
  readonly subscribeSchemaVersions: unknown[] = [];
  readonly subscribeStreamIds: number[] = [];
  readonly creditGrants: number[] = [];
  onCreditGrant: (() => void) | null = null;
  streamManifest = buildStreamManifest(
    emptyStreamRegistry,
    SERVES_EVERY_INSTALLED_MAJOR,
  );
  /** Optional methods must publish to the negotiated registry and never fatal the session. */
  optionalRpcManifest: Record<string, { major: number; minor: number }> = {};
  floorRpcManifest: Record<string, { major: number; minor: number }> = {};
  /**
   * False omits `optionalRpc`, as a peer before the floor/optional split sends; the
   * schema requires it, so this exercises the parse rejection.
   */
  sendOptionalRpc = true;
  openAckCapabilities: string[] = [];
  readonly clientFrames: MuxFrame[] = [];
  readonly unaryRequests: {
    method: string;
    schemaVersion: unknown;
    params: unknown;
    idempotencyKey: string | null;
    callerAgentId: string | null;
    streamId: number;
  }[] = [];
  readonly unaryRequestConnectionIds: number[] = [];
  unaryResult: unknown = { ready: true };
  unaryError: FakeUnaryError | null = null;
  readonly unaryResponseQueue: Array<{
    readonly error: FakeUnaryError | null;
    readonly result: unknown;
  }> = [];
  unaryResponseFor:
    | ((request: { readonly method: string; readonly params: unknown }) => {
        readonly result: unknown;
        readonly error: {
          readonly code: string;
          readonly message: string;
          readonly holders: unknown | undefined;
        } | null;
      })
    | null = null;
  skipUnaryAutoRespond = false;
  /** Read at each connection's open-ack: a later attach answers normally unless still set. */
  silentAfterReady = false;
  private readonly silentConnections = new Set<FakeConnection>();
  silentMethods = new Set<string>();
  unaryResponseDelayMs: number | null = null;
  stallNoiseReply = false;
  stallOpenIndex: number | null = null;
  noiseInitiatorMessages = 0;
  readonly unaryResponses: {
    method: string;
    error: FakeUnaryError | null;
  }[] = [];
  readonly closesSent: number[] = [];
  readonly droppedTombstonedFrames: { streamId: number; type: number }[] = [];
  /** Post-reassembly: `clientFrames` carries `json: null` for a chunked body. */
  readonly cloudVerdictUpdates: boolean[] = [];
  readonly credentialUpdates: unknown[] = [];
  readonly errors: unknown[] = [];
  decideOpen: (bearer: string, openIndex: number) => OpenDecision = () => ({
    kind: "ack",
  });
  pingCount = 0;
  /** False: the half-open socket an OS suspend leaves, for the wake-probe tests. */
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

  sendRelayKill(type: "peer_gone" | "killed", reason: string): void {
    const connection = this.liveConnection();
    connection.socket.onmessage?.({
      type: "text",
      data: JSON.stringify({ type, reason }),
    });
  }

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

  private liveConnection(): FakeConnection {
    const connection = [...this.connections]
      .reverse()
      .find((entry) => !entry.closed);
    if (connection === undefined) {
      throw new Error("no live connection");
    }
    return connection;
  }

  /** Through the real chunker, so a large body spans many frames and crosses the credit batch. */
  async sendStreamFrame(
    streamId: number,
    envelope: Record<string, unknown>,
    binary: Uint8Array | null,
    qos: QosClassValue,
  ): Promise<void> {
    const connection = this.liveConnection();
    if (connection.terminalStreamIds.has(streamId)) {
      // The real host tears its resolver down with the FATAL: no server frame for a terminal id exists.
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

  async sendStreamFatal(
    streamId: number,
    details: FatalErrorDetails,
  ): Promise<void> {
    const connection = this.liveConnection();
    // The host tombstones a stream on any FATAL, so a re-open must use a fresh id.
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
   * A `REAUTH_NOTICE` on the session control stream: the host speaking in the
   * channel with nothing to say, which keeps a long-lived session's standing
   * watchdog fed.
   */
  async sendSignOfLife(): Promise<void> {
    await this.sendMux(this.liveConnection(), {
      type: MuxFrameType.REAUTH_NOTICE,
      streamId: SESSION_CONTROL_STREAM_ID,
      qos: QosClass.INTERACTIVE,
      json: {},
      binary: null,
    });
  }

  /** A host-side CLOSE tombstones the id as a FATAL does. */
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
   * The Noise counter is reserved synchronously per call, so frames encrypted in any
   * order still decrypt when delivered interleaved.
   */
  async encryptFrame(input: EncodeMuxFrameInput): Promise<Uint8Array> {
    const connection = this.liveConnection();
    const noise = connection.noise;
    if (noise === null) {
      throw new Error("no established noise session");
    }
    return noise.encrypt(encodeMuxFrame(input), EMPTY_AD);
  }

  /** No await between calls, as production `onData` fires per message. */
  deliverToClient(bytes: Uint8Array): void {
    this.deliverBinary(this.liveConnection(), bytes);
  }

  private enqueue(connection: FakeConnection, data: string | Uint8Array): void {
    // Pings skip the mux queue: behind WebCrypto decrypts a ping can miss the 12s pong
    // deadline; a real relay answers at its edge. A microtask, not inline: the wake
    // probe arms after the ping is sent.
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
      return;
    }
    if (connection.noise === null) {
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
    // Recorded before the tombstone drop: a frame the host drops was still sent.
    this.clientFrames.push(frame);
    // Before `accept()`, as the host's `feedInbound`: a tombstoned id must not seed a
    // reassembler or pass a SUBSCRIBE.
    if (connection.terminalStreamIds.has(frame.streamId)) {
      this.droppedTombstonedFrames.push({
        streamId: frame.streamId,
        type: frame.type,
      });
      return;
    }
    // As the host's `feedInbound`: unchunked frames only; the reassembler orders chunks.
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
    this.received.arrived(message);
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
      this.unaryRequestConnectionIds.push(this.connections.indexOf(connection));
      const method = typeof json.method === "string" ? json.method : "";
      const queuedResponse = this.unaryResponseQueue.shift();
      if (
        this.skipUnaryAutoRespond ||
        this.silentConnections.has(connection) ||
        this.silentMethods.has(method)
      ) {
        return;
      }
      const responseOverride =
        this.unaryResponseFor?.({
          method,
          params: json.params,
        }) ?? null;
      const sendResponse = async (): Promise<void> => {
        const error =
          queuedResponse === undefined ? this.unaryError : queuedResponse.error;
        const result =
          queuedResponse === undefined
            ? this.unaryResult
            : queuedResponse.result;
        const response = responseOverride ?? {
          result: error === null ? result : null,
          error,
        };
        await this.sendMux(connection, {
          type: MuxFrameType.RESPONSE,
          streamId: message.streamId,
          qos: QosClass.INTERACTIVE,
          json: {
            requestId: typeof json.requestId === "string" ? json.requestId : "",
            method,
            result: response.result,
            error: response.error,
          },
          binary: null,
        });
        this.unaryResponses.push({ method, error: response.error });
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
      // After the send resolves, so this records delivery: `sendMux` awaits encryption,
      // and a test that jumps virtual time on this entry would race it.
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
    const grant = presentedGrant(message.json?.authz);
    const openIndex = this.openBearers.length;
    this.openBearers.push(bearer);
    this.openGrants.push(grant);
    this.openIdentities.push(message.json?.clientIdentity);
    this.openAuthz.push(message.json?.authz);
    this.openCapabilities.push(message.json?.capabilities);
    if (this.stallOpens || this.stallOpenIndex === openIndex) {
      // The host decides on the token in `authz`.
      this.stalledOpens.push({ connection, bearer: grant, openIndex });
      return;
    }
    await this.respondToOpen(connection, grant, openIndex);
  }

  stallOpens = false;
  private readonly stalledOpens: Array<{
    connection: FakeConnection;
    bearer: string;
    openIndex: number;
  }> = [];

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
