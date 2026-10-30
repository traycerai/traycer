import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { z } from "zod";
import {
  createResponderHandshake,
  DEFAULT_REPLAY_WINDOW_SIZE,
  generateStaticKeyPair,
  NoiseSession,
  type NoiseKeyPair,
} from "../../../crypto/noise";
import {
  CURRENT_CLIENT_COMPATIBILITY_EPOCH,
  defineFloorAwareVersionedRpcRegistry,
  defineRpcContract,
  UNARY_CAPABILITY_IDEMPOTENCY_KEY,
  type VersionedRpcRegistry,
} from "../../../framework/index";
import { SERVES_EVERY_INSTALLED_MAJOR } from "../../../framework/capability-manifest";
import { buildStreamManifest } from "../../../framework/stream-compat";
import {
  defineStreamRpcContract,
  defineVersionedStreamRpcRegistry,
  type VersionedStreamRpcRegistry,
} from "../../../framework/versioned-stream-rpc";
import {
  CHUNK_PACE_BURST_FRAMES,
  ChunkReassembler,
  encodeMuxMessageBody,
  OutboundChunkSource,
  type OutboundMessage,
  type ReassembledMessage,
} from "../../chunking";
import {
  decodeMuxFrame,
  encodeMuxFrame,
  MuxFrameType,
  NOISE_PROLOGUE,
  QosClass,
  SESSION_CAPABILITY_RESUME,
  SESSION_CONTROL_STREAM_ID,
  type EncodeMuxFrameInput,
  type ResumePayload,
} from "../../mux";
import type {
  IStreamWebSocketFactory,
  StreamWebSocketLike,
  StreamWebSocketMessageEvent,
} from "../../stream-websocket";
import type {
  IStreamSession,
  StreamConnectionStatus,
  StreamContinuity,
} from "../../stream-session";
import type {
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketOpenEvent,
} from "../../websocket";
import type { RemoteSessionAuth } from "../auth";
import {
  RESUME_ACK_MS,
  RESUME_HOLD_MS,
  RESUME_MASK_MS,
  SESSION_LIVENESS_PROBE_TIMEOUT_MS,
  SESSION_SILENCE_TIMEOUT_MS,
} from "../config";
import type { AttachGrantProvider } from "../grant";
import {
  encodeResumeFrame,
  parseResumeFrame,
  ResumeLedger,
} from "../../resume-ledger";
import {
  HostTransportFailureError,
  mayHaveReachedHost,
  RetryableTransportError,
} from "../rpc-types";
import { NoiseChannel } from "../noise-channel";
import { PriorityScheduler } from "../scheduler";
import {
  RemoteSession,
  type RemoteSessionEvidence,
  type SessionLivenessProbe,
} from "../session";

/**
 * `RemoteSession` over a host that advertises `session.resume`: the host leg of
 * relay session continuity. The fake relay + host below run a real responder
 * Noise session, so every frame in both directions is really sealed and opened,
 * and keep their own `ResumeLedger`, so a RESUME is answered from real counts.
 * The relay's behaviour is a plain model: while the host leg is away, frames in
 * either direction are lost (they still count in the sender's ledger), and
 * `host_detached` / `host_attached` are the only control frames it sends.
 */

const HOST_ID = "host-resume";
const ATTACH_URL = "wss://relay.test/attach";
const EMPTY_AD = new Uint8Array(0);
const STATUS_METHOD = "host.status";
const STREAM_METHOD = "cursor.subscribe";

/** Captured before fake timers: the real event loop lets Noise's async work finish. */
const realSetTimeout = globalThis.setTimeout;
function realDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    realSetTimeout(resolve, ms);
  });
}

const statusContract = defineRpcContract({
  method: STATUS_METHOD,
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({}),
  responseSchema: z.object({ ready: z.boolean() }),
});

const rpcRegistry: VersionedRpcRegistry = defineFloorAwareVersionedRpcRegistry(
  [STATUS_METHOD] as const,
  {
    "host.status": {
      1: {
        latestMinor: 0,
        versions: {
          0: { contract: statusContract, upgradeFromPreviousVersion: null },
        },
        downgradePathsFromLatest: {},
      },
    },
  },
);

const streamRegistry: VersionedStreamRpcRegistry =
  defineVersionedStreamRpcRegistry({
    "cursor.subscribe": {
      1: {
        latestMinor: 0,
        versions: {
          0: {
            contract: defineStreamRpcContract({
              method: STREAM_METHOD,
              schemaVersion: { major: 1, minor: 0 },
              openRequestSchema: z.object({ cursor: z.number().nullable() }),
              serverFrameSchema: z.object({
                kind: z.literal("tick"),
                n: z.number(),
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

// ---- The host's RESUME wire encoding: the one place that knows its shape ---- //

/** The host's RESUME answering `clientResume`, stating the host's own count. */
function encodeHostResume(
  clientResume: ResumePayload,
  hostReceived: number,
): Uint8Array {
  return encodeResumeFrame(hostReceived, clientResume.attempt);
}

/** A RESUME envelope whose payload cannot parse. */
function malformedResumeFrame(): Uint8Array {
  return encodeMuxFrame({
    type: MuxFrameType.RESUME,
    streamId: SESSION_CONTROL_STREAM_ID,
    seq: 0,
    qos: QosClass.INTERACTIVE,
    chunked: false,
    chunkFirst: false,
    chunkLast: false,
    compressed: false,
    json: null,
    binary: encodeMuxMessageBody({ received: "not-a-count" }, null),
  });
}

// ---- Fake relay + host ------------------------------------------------------ //

class FakeSocket implements StreamWebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: StreamWebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;
  closed = false;
  /** Binary frames the client put on this socket, lost or not. */
  binarySends = 0;

  private readonly onSend: (data: string | Uint8Array) => void;

  constructor(onSend: (data: string | Uint8Array) => void) {
    this.onSend = onSend;
  }

  send(data: string | Uint8Array): void {
    if (typeof data !== "string") {
      this.binarySends += 1;
    }
    this.onSend(data);
  }

  close(_code: number, _reason: string): void {
    this.closed = true;
  }
}

interface HostConnection {
  readonly index: number;
  readonly socket: FakeSocket;
  noise: NoiseSession | null;
  /** The host's own ring and receive count. */
  readonly ledger: ResumeLedger;
  readonly reassembler: ChunkReassembler;
  readonly seqByStream: Map<number, number>;
  readonly streamIds: number[];
  queue: Promise<void>;
  /** Client frames are lost on the way to the host. */
  dropInbound: boolean;
  /** Host frames are lost on the way to the client. */
  dropOutbound: boolean;
}

interface ClientFrameRecord {
  readonly connection: number;
  readonly type: number;
  readonly streamId: number;
}

interface PendingRequest {
  readonly connection: HostConnection;
  readonly streamId: number;
  readonly requestId: string;
}

type ResumeReply = "answer" | "silent" | "fatal" | "overclaim" | "malformed";

type RelayControl = "host_detached" | "host_attached";

class FakeHost {
  private readonly keys: NoiseKeyPair = generateStaticKeyPair();
  readonly connections: HostConnection[] = [];
  readonly urls: string[] = [];
  /** Every opened client frame, in the order the host read it. */
  readonly clientFrames: ClientFrameRecord[] = [];
  /** Every RESUME the client sent, as parsed. */
  readonly resumes: ResumePayload[] = [];
  readonly openCapabilities: unknown[] = [];
  readonly subscribedStreams: number[] = [];
  /** Method of every REQUEST read, in order. */
  readonly requestMethods: string[] = [];
  /** streamId of every REQUEST read, in order. */
  readonly requestStreamIds: number[] = [];
  readonly pendingRequests: PendingRequest[] = [];
  /** streamId of every client STREAM_FRAME read, in order. */
  readonly clientStreamFrames: number[] = [];
  handshakes = 0;
  opens = 0;
  advertiseResume = true;
  /** The host deduplicates unary idempotency keys. */
  advertiseIdempotencyKey = false;
  resumeReply: ResumeReply = "answer";
  /** Answer the first frame of each SUBSCRIBE with a snapshot tick (n = 0). */
  autoTick = true;
  holdUnary = false;
  /** Host frames are sealed but kept back until {@link releaseHeld}. */
  holdOutbound = false;
  private held: { readonly connection: HostConnection; bytes: Uint8Array }[] =
    [];

  get publicKey(): Uint8Array {
    return this.keys.publicKey;
  }

  readonly factory: IStreamWebSocketFactory = {
    create: (url: string): StreamWebSocketLike => {
      this.urls.push(url);
      const connection: HostConnection = {
        index: this.connections.length,
        socket: new FakeSocket((data) => this.onClientSend(connection, data)),
        noise: null,
        ledger: new ResumeLedger(() => undefined),
        reassembler: new ChunkReassembler(undefined),
        seqByStream: new Map(),
        streamIds: [],
        queue: Promise.resolve(),
        dropInbound: false,
        dropOutbound: false,
      };
      this.connections.push(connection);
      const sid = this.connections.length;
      queueMicrotask(() => {
        connection.socket.onopen?.({ type: "open" });
        connection.socket.onmessage?.({
          type: "text",
          data: JSON.stringify({ type: "attach_ack", role: "client", sid }),
        });
      });
      return connection.socket;
    },
  };

  live(): HostConnection {
    const connection = [...this.connections]
      .reverse()
      .find((entry) => !entry.socket.closed);
    if (connection === undefined) {
      throw new Error("no live connection");
    }
    return connection;
  }

  // -- Relay behaviour ----------------------------------------------------- //

  /** The host leg goes away; the relay says so. Frames both ways are lost. */
  detach(): void {
    this.loseLeg();
    this.control("host_detached");
  }

  /** The host leg goes away and the relay does not say so (or it was missed). */
  loseLeg(): void {
    const connection = this.live();
    connection.dropInbound = true;
    connection.dropOutbound = true;
  }

  /** The host leg is back; the relay says so. */
  attach(): void {
    const connection = this.live();
    connection.dropInbound = false;
    connection.dropOutbound = false;
    this.control("host_attached");
  }

  control(type: RelayControl): void {
    this.live().socket.onmessage?.({
      type: "text",
      data: JSON.stringify({ type }),
    });
  }

  /** A host-sent terminal session FATAL on stream 0. */
  async sendSessionFatal(code: string): Promise<void> {
    await this.sendMux(this.live(), {
      type: MuxFrameType.FATAL,
      streamId: SESSION_CONTROL_STREAM_ID,
      qos: QosClass.INTERACTIVE,
      json: {
        details: {
          code,
          reason: "the host refused this session",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      },
      binary: null,
    });
  }

  /** The relay socket drops from the server side. */
  dropSocket(code: number, reason: string): void {
    this.live().socket.onclose?.({ code, reason, wasClean: false });
  }

  // -- Host behaviour ------------------------------------------------------ //

  /** Seals one stream frame for the client's first subscription. */
  async tick(n: number): Promise<void> {
    await this.tickOn(this.live(), n);
  }

  private async tickOn(connection: HostConnection, n: number): Promise<void> {
    const streamId = connection.streamIds[0];
    if (streamId === undefined) {
      throw new Error("no subscription on this connection");
    }
    await this.sendMux(connection, {
      type: MuxFrameType.STREAM_FRAME,
      streamId,
      qos: QosClass.INTERACTIVE,
      json: { kind: "tick", n, hasBinaryPayload: false },
      binary: null,
    });
  }

  /** Answers a held (or lost) unary with a normal RESPONSE. */
  async respondTo(request: PendingRequest): Promise<void> {
    await this.sendMux(request.connection, {
      type: MuxFrameType.RESPONSE,
      streamId: request.streamId,
      qos: QosClass.INTERACTIVE,
      json: {
        requestId: request.requestId,
        method: STATUS_METHOD,
        result: { ready: true },
        error: null,
      },
      binary: null,
    });
  }

  /** The host's RESUME for `resume`, then the client's gap, resealed. */
  async answerResume(
    connection: HostConnection,
    resume: ResumePayload,
  ): Promise<void> {
    await this.sealAndDeliver(
      connection,
      encodeHostResume(resume, connection.ledger.received),
    );
    const gap = connection.ledger.gapFrom(resume.received);
    if (gap.kind !== "gap") {
      throw new Error("the fake host cannot recover the client's count");
    }
    for (const plaintext of gap.frames) {
      await this.sealAndDeliver(connection, plaintext);
    }
  }

  /** Delivers everything held, in order. */
  releaseHeld(): void {
    for (const frame of this.held.splice(0)) {
      frame.connection.socket.onmessage?.({
        type: "binary",
        data: frame.bytes,
      });
    }
  }

  /** Delivers everything held, then a relay control frame, in one tick. */
  releaseHeldThen(type: RelayControl): void {
    const frames = this.held.splice(0);
    for (const frame of frames) {
      frame.connection.socket.onmessage?.({
        type: "binary",
        data: frame.bytes,
      });
    }
    this.control(type);
  }

  settle(): Promise<void> {
    return Promise.all(this.connections.map((entry) => entry.queue)).then(() =>
      realDelay(20),
    );
  }

  // -- Plumbing ------------------------------------------------------------ //

  private onClientSend(
    connection: HostConnection,
    data: string | Uint8Array,
  ): void {
    if (typeof data === "string") {
      if (data === "relay-ping") {
        queueMicrotask(() => {
          connection.socket.onmessage?.({ type: "text", data: "relay-pong" });
        });
      }
      return;
    }
    connection.queue = connection.queue
      .then(() => this.handleClientData(connection, data))
      .catch((error: unknown) => {
        throw error instanceof Error ? error : new Error(String(error));
      });
  }

  private async handleClientData(
    connection: HostConnection,
    data: Uint8Array,
  ): Promise<void> {
    if (connection.dropInbound) {
      return;
    }
    if (connection.noise === null) {
      const handshake = await createResponderHandshake(
        this.keys,
        NOISE_PROLOGUE,
      );
      await handshake.readMessage(data);
      const msg1 = await handshake.writeMessage(new Uint8Array(0));
      connection.noise = NoiseSession.fromHandshake(
        handshake,
        DEFAULT_REPLAY_WINDOW_SIZE,
      );
      this.handshakes += 1;
      connection.socket.onmessage?.({ type: "binary", data: msg1 });
      return;
    }
    const plaintext = await connection.noise.decrypt(data, EMPTY_AD);
    const frame = decodeMuxFrame(plaintext);
    this.clientFrames.push({
      connection: connection.index,
      type: frame.type,
      streamId: frame.streamId,
    });
    connection.ledger.receive(plaintext);
    if (frame.type === MuxFrameType.RESUME) {
      const resume = parseResumeFrame(frame);
      if (resume === null) {
        throw new Error("the client sent a malformed RESUME");
      }
      this.resumes.push(resume);
      await this.replyToResume(connection, resume);
      return;
    }
    const message = connection.reassembler.accept(frame);
    if (message !== null) {
      await this.handleMessage(connection, message);
    }
  }

  private async replyToResume(
    connection: HostConnection,
    resume: ResumePayload,
  ): Promise<void> {
    switch (this.resumeReply) {
      case "silent":
        return;
      case "answer":
        await this.answerResume(connection, resume);
        return;
      case "overclaim":
        await this.sealAndDeliver(
          connection,
          encodeHostResume(resume, 1_000_000),
        );
        return;
      case "malformed":
        await this.sealAndDeliver(connection, malformedResumeFrame());
        return;
      case "fatal":
        await this.sendMux(connection, {
          type: MuxFrameType.FATAL,
          streamId: SESSION_CONTROL_STREAM_ID,
          qos: QosClass.INTERACTIVE,
          json: {
            details: {
              code: "RESUME_REFUSED",
              reason: "the host cannot resume this session",
              incompatibleMethods: null,
              upgradeGuidance: null,
            },
          },
          binary: null,
        });
        return;
    }
  }

  private async handleMessage(
    connection: HostConnection,
    message: ReassembledMessage,
  ): Promise<void> {
    const json = message.json ?? {};
    if (
      message.streamId === SESSION_CONTROL_STREAM_ID &&
      message.type === MuxFrameType.OPEN
    ) {
      this.opens += 1;
      this.openCapabilities.push(json.capabilities);
      await this.sendMux(connection, {
        type: MuxFrameType.OPEN_ACK,
        streamId: SESSION_CONTROL_STREAM_ID,
        qos: QosClass.INTERACTIVE,
        json: {
          manifest: {
            rpc: { [STATUS_METHOD]: { major: 1, minor: 0 } },
            optionalRpc: {},
            stream: buildStreamManifest(
              streamRegistry,
              SERVES_EVERY_INSTALLED_MAJOR,
            ),
          },
          capabilities: [
            ...(this.advertiseResume ? [SESSION_CAPABILITY_RESUME] : []),
            ...(this.advertiseIdempotencyKey
              ? [UNARY_CAPABILITY_IDEMPOTENCY_KEY]
              : []),
          ],
        },
        binary: null,
      });
      return;
    }
    if (message.type === MuxFrameType.SUBSCRIBE) {
      connection.streamIds.push(message.streamId);
      this.subscribedStreams.push(message.streamId);
      if (this.autoTick) {
        await this.tickOn(connection, 0);
      }
      return;
    }
    if (message.type === MuxFrameType.STREAM_FRAME) {
      this.clientStreamFrames.push(message.streamId);
      return;
    }
    if (message.type === MuxFrameType.REQUEST) {
      this.requestMethods.push(
        typeof json.method === "string" ? json.method : "",
      );
      this.requestStreamIds.push(message.streamId);
      const request: PendingRequest = {
        connection,
        streamId: message.streamId,
        requestId: typeof json.requestId === "string" ? json.requestId : "",
      };
      this.pendingRequests.push(request);
      if (!this.holdUnary) {
        await this.respondTo(request);
      }
    }
  }

  private async sendMux(
    connection: HostConnection,
    message: OutboundMessage,
  ): Promise<void> {
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
      const frame: EncodeMuxFrameInput = source.nextFrame();
      const plaintext = encodeMuxFrame(frame);
      connection.ledger.append(plaintext);
      await this.sealAndDeliver(connection, plaintext);
    }
  }

  private async sealAndDeliver(
    connection: HostConnection,
    plaintext: Uint8Array,
  ): Promise<void> {
    if (connection.noise === null) {
      throw new Error("no established noise session");
    }
    const bytes = await connection.noise.encrypt(plaintext, EMPTY_AD);
    if (connection.dropOutbound || connection.socket.closed) {
      return;
    }
    if (this.holdOutbound) {
      this.held.push({ connection, bytes });
      return;
    }
    connection.socket.onmessage?.({ type: "binary", data: bytes });
  }
}

// ---- Session fixture ---------------------------------------------------------- //

interface EvidenceSpies {
  readonly evidence: RemoteSessionEvidence;
  readonly sessionEstablished: Mock<
    RemoteSessionEvidence["sessionEstablished"]
  >;
  readonly sessionLost: Mock<RemoteSessionEvidence["sessionLost"]>;
  readonly reportDialSuccess: Mock<RemoteSessionEvidence["reportDialSuccess"]>;
}

function buildEvidence(): EvidenceSpies {
  const sessionEstablished =
    vi.fn<RemoteSessionEvidence["sessionEstablished"]>();
  const sessionLost = vi.fn<RemoteSessionEvidence["sessionLost"]>();
  const reportDialSuccess = vi.fn<RemoteSessionEvidence["reportDialSuccess"]>();
  return {
    evidence: {
      sessionEstablished,
      sessionLost,
      reportDialSuccess,
      reportDialRefusal: vi.fn<RemoteSessionEvidence["reportDialRefusal"]>(),
      reportDialIndeterminate:
        vi.fn<RemoteSessionEvidence["reportDialIndeterminate"]>(),
      reportRestartIntent:
        vi.fn<RemoteSessionEvidence["reportRestartIntent"]>(),
    },
    sessionEstablished,
    sessionLost,
    reportDialSuccess,
  };
}

function hostAuth(): RemoteSessionAuth {
  return {
    missingOpenAuthCause: "missing-host-credential",
    readOpenAuth: () => ({
      bearer: "resume-bearer",
      authz: null,
      fingerprint: "resume-bearer",
    }),
    readCredentialUpdateBearer: () => "resume-bearer",
    currentFingerprint: () => "resume-bearer",
    revalidateForReconnect: null,
  };
}

interface FixtureConfig {
  readonly advertiseResume: boolean;
  readonly advertiseIdempotencyKey: boolean;
  readonly autoTick: boolean;
  readonly livenessProbe: SessionLivenessProbe | null;
}

const LIVE: FixtureConfig = {
  advertiseResume: true,
  advertiseIdempotencyKey: false,
  autoTick: true,
  livenessProbe: null,
};

interface StatusEvent {
  readonly status: StreamConnectionStatus;
  readonly continuity: StreamContinuity;
}

const HELD: StatusEvent = { status: "reconnecting", continuity: "held" };
const CONTINUED: StatusEvent = { status: "open", continuity: "continued" };
const REBUILDING: StatusEvent = { status: "reconnecting", continuity: null };

type Session = RemoteSession<VersionedRpcRegistry, VersionedStreamRpcRegistry>;

interface Fixture {
  readonly host: FakeHost;
  readonly session: Session;
  readonly spies: EvidenceSpies;
  /** `n` of every tick the subscription received, in delivery order. */
  readonly ticks: number[];
  readonly stream: IStreamSession;
  /** Every status transition the subscription saw once the session was ready. */
  readonly statuses: StatusEvent[];
  readonly readinessLost: Mock<() => void>;
  readonly recovered: Mock<() => void>;
}

const opened: Session[] = [];

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 2_500; attempt += 1) {
    if (condition()) {
      return;
    }
    await realDelay(2);
  }
  throw new Error("condition was not reached");
}

/** Moves the fake clock, then lets the real async work it started finish. */
async function step(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await realDelay(20);
}

/** Moves the fake clock in quarter-second steps until `condition` holds. */
async function advanceUntil(
  condition: () => boolean,
  maxMs: number,
): Promise<void> {
  for (let elapsed = 0; elapsed < maxMs; elapsed += 250) {
    if (condition()) {
      return;
    }
    await step(250);
  }
  if (!condition()) {
    throw new Error("condition was not reached in time");
  }
}

async function readyFixture(config: FixtureConfig): Promise<Fixture> {
  const host = new FakeHost();
  host.advertiseResume = config.advertiseResume;
  host.advertiseIdempotencyKey = config.advertiseIdempotencyKey;
  host.autoTick = config.autoTick;
  const spies = buildEvidence();
  const grants = vi.fn<AttachGrantProvider>(() =>
    Promise.resolve({
      kind: "ok" as const,
      grant: { grant: "grant-jws", expiresInSeconds: 300 },
    }),
  );
  let nextRequestId = 0;
  const session: Session = new RemoteSession({
    hostId: HOST_ID,
    attachBaseUrl: ATTACH_URL,
    hostStaticPublicKey: host.publicKey,
    grantProvider: grants,
    auth: hostAuth(),
    clock: null,
    rpcRegistry,
    streamRegistry,
    webSocketFactory: host.factory,
    requestId: () => `resume-req-${(nextRequestId += 1)}`,
    evidence: spies.evidence,
    onNegotiatedMethods: null,
    servedStreamMajors: {},
    unaryResponseMs: 30_000,
    clientIdentity: {
      kind: "desktop",
      compatibilityEpoch: CURRENT_CLIENT_COMPATIBILITY_EPOCH,
      appVersion: "0.0.0-test",
    },
    livenessProbe: config.livenessProbe,
    mintMemberCredential: null,
  });
  opened.push(session);
  const ticks: number[] = [];
  const statuses: StatusEvent[] = [];
  const stream = session.subscribe(STREAM_METHOD, { cursor: null });
  stream.onServerFrame((envelope) => {
    ticks.push(typeof envelope.n === "number" ? envelope.n : -1);
  });
  await until(() => session.isReady());
  if (config.autoTick) {
    await until(() => ticks.length === 1);
  }
  stream.onStatusChange((status, _reason, _retryCause, continuity) => {
    statuses.push({ status, continuity });
  });
  const readinessLost = vi.fn<() => void>();
  const recovered = vi.fn<() => void>();
  session.subscribeReadinessLost(readinessLost);
  session.subscribeAvailabilityRecovered(recovered);
  return {
    host,
    session,
    spies,
    stream,
    ticks,
    statuses,
    readinessLost,
    recovered,
  };
}

function callStatus(session: Session): Promise<unknown> {
  return callWithKey(session, null);
}

function callWithKey(
  session: Session,
  idempotencyKey: string | null,
): Promise<unknown> {
  return session.sendUnary(
    STATUS_METHOD,
    {},
    idempotencyKey,
    null,
    null,
    undefined,
    false,
    null,
  );
}

/**
 * A status call carrying `bytes` of padding. The registry does not project a
 * request whose version both sides share, so the padding goes on the wire and
 * chunks into 64 KiB frames; the fake host reads only the method.
 */
function callPadded(session: Session, bytes: number): Promise<unknown> {
  const padded = { padding: "x".repeat(bytes) };
  return session.sendUnary(
    STATUS_METHOD,
    padded,
    null,
    null,
    null,
    undefined,
    false,
    null,
  );
}

interface CallOutcome {
  settled: boolean;
  value: unknown;
  error: unknown;
}

function track(call: Promise<unknown>): CallOutcome {
  const outcome: CallOutcome = { settled: false, value: null, error: null };
  void call.then(
    (value) => {
      outcome.settled = true;
      outcome.value = value;
    },
    (error: unknown) => {
      outcome.settled = true;
      outcome.error = error;
    },
  );
  return outcome;
}

/** `n` for 0..last, the order a subscription that lost nothing would read. */
function range(last: number): number[] {
  return Array.from({ length: last + 1 }, (_, n) => n);
}

const LOST_CALLS = 100;

/**
 * Seals `count` calls the relay then loses, and returns once every one is on
 * the socket and the pacer's bucket is full again. Sealing is real async work
 * and the pacer's timer is fake, so the clock must be walked until the
 * outcome is seen: a single jump leaves a share of the calls queued unsealed,
 * and the gap is then not the size the test means.
 */
async function loseCalls(
  fixture: Fixture,
  count: number,
): Promise<CallOutcome[]> {
  const socket = fixture.host.live().socket;
  const before = socket.binarySends;
  fixture.host.live().dropInbound = true;
  const calls: CallOutcome[] = [];
  for (let index = 0; index < count; index += 1) {
    calls.push(track(callStatus(fixture.session)));
  }
  await advanceUntil(() => socket.binarySends - before >= count, 20_000);
  await step(1_000);
  return calls;
}

/**
 * Attaches the host and waits for the CLIENT's replay to stall on the pacer:
 * the RESUME and one burst of gap frames sealed on the socket. Fake time is
 * frozen, so nothing more can be sealed until it moves. The host's count
 * follows the client's and is only waited for, never read as proof.
 */
async function attachIntoReplay(fixture: Fixture): Promise<void> {
  const { host } = fixture;
  const socket = host.live().socket;
  const before = socket.binarySends;
  host.attach();
  await until(() => socket.binarySends - before >= 1 + CHUNK_PACE_BURST_FRAMES);
  expect(socket.binarySends - before).toBe(1 + CHUNK_PACE_BURST_FRAMES);
  await until(() => host.requestStreamIds.length === CHUNK_PACE_BURST_FRAMES);
}

describe("RemoteSession host-leg resume", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const session of opened.splice(0)) {
      session.close();
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("resume on host_attached", () => {
    it("host_detached then host_attached resolves an in-flight unary and keeps a subscription's frame order, on the same socket and Noise session", async () => {
      const fixture = await readyFixture(LIVE);
      const { host, session } = fixture;
      expect(host.openCapabilities[0]).toContain(SESSION_CAPABILITY_RESUME);
      host.holdUnary = true;
      const call = track(callStatus(session));
      await until(() => host.pendingRequests.length === 1);
      const readiness: boolean[] = [];

      host.detach();
      readiness.push(session.isReady());
      await host.tick(1);
      const [request] = host.pendingRequests;
      if (request === undefined) {
        throw new Error("the unary never reached the host");
      }
      await host.respondTo(request);
      await step(1_000);
      readiness.push(session.isReady());

      host.attach();
      await until(() => host.resumes.length === 1);
      readiness.push(session.isReady());
      await until(() => call.settled && fixture.ticks.length === 2);
      await host.tick(2);
      await until(() => fixture.ticks.length === 3);
      readiness.push(session.isReady());

      expect(call.value).toEqual({ ready: true });
      expect(fixture.ticks).toEqual(range(2));
      expect(readiness).toEqual([true, true, true, true]);
      expect(fixture.readinessLost).not.toHaveBeenCalled();
      expect(host.connections).toHaveLength(1);
      expect(host.handshakes).toBe(1);
      expect(host.opens).toBe(1);
      expect(host.subscribedStreams).toHaveLength(1);
      expect(fixture.statuses).toEqual([]);
    });

    it("host_attached alone does the same", async () => {
      const fixture = await readyFixture(LIVE);
      const { host, session } = fixture;
      host.holdUnary = true;
      const call = track(callStatus(session));
      await until(() => host.pendingRequests.length === 1);

      // The detach was missed: the host leg dropped and came back unannounced.
      host.loseLeg();
      await host.tick(1);
      const [request] = host.pendingRequests;
      if (request === undefined) {
        throw new Error("the unary never reached the host");
      }
      await host.respondTo(request);
      host.attach();
      await until(() => call.settled && fixture.ticks.length === 2);
      await host.tick(2);
      await until(() => fixture.ticks.length === 3);

      expect(call.value).toEqual({ ready: true });
      expect(fixture.ticks).toEqual(range(2));
      expect(session.isReady()).toBe(true);
      expect(fixture.readinessLost).not.toHaveBeenCalled();
      expect(host.connections).toHaveLength(1);
      expect(host.handshakes).toBe(1);
      expect(host.opens).toBe(1);
      expect(host.subscribedStreams).toHaveLength(1);
      expect(fixture.statuses).toEqual([]);
    });
  });

  describe("inbound counting across the exchange", () => {
    it("dispatches a frame still decrypting at host_attached once, and counts it in the RESUME", async () => {
      const fixture = await readyFixture(LIVE);
      const { host } = fixture;
      const connection = host.live();
      // A burst, so the inbound decrypt chain is still working when the
      // control frame lands in the same tick.
      host.holdOutbound = true;
      for (let n = 1; n <= 20; n += 1) {
        await host.tick(n);
      }
      host.holdOutbound = false;

      host.releaseHeldThen("host_attached");
      await until(() => host.resumes.length === 1);
      await until(() => fixture.ticks.length === 21);
      await host.settle();

      expect(host.resumes[0]?.received).toBe(connection.ledger.sent);
      expect(fixture.ticks).toEqual(range(20));
      expect(host.connections).toHaveLength(1);
    });

    it("discards frames arriving between host_attached and the host's RESUME without counting them, so a resend is delivered once", async () => {
      const fixture = await readyFixture(LIVE);
      const { host } = fixture;
      const connection = host.live();
      host.resumeReply = "silent";

      host.control("host_attached");
      await until(() => host.resumes.length === 1);
      await host.tick(5);
      await host.settle();
      expect(fixture.ticks).toEqual([0]);

      host.resumeReply = "answer";
      const firstResume = host.resumes[0];
      if (firstResume === undefined) {
        throw new Error("no RESUME reached the host");
      }
      await host.answerResume(connection, firstResume);
      await until(() => fixture.ticks.length === 2);

      // A second exchange states the count the client now holds. A frame
      // counted when it was discarded would be one too many.
      host.control("host_attached");
      await until(() => host.resumes.length === 2);
      await host.settle();

      expect(fixture.ticks).toEqual([0, 5]);
      expect(host.resumes[1]?.received).toBe(connection.ledger.sent);
      expect(host.connections).toHaveLength(1);
      expect(fixture.session.isReady()).toBe(true);
    });
  });

  describe("mask, down and hold", () => {
    it("holds streams at mask expiry, announcing nothing inside the mask, and a host_attached within the hold continues them on the resumed edge", async () => {
      const fixture = await readyFixture(LIVE);
      const { host, session, spies } = fixture;
      const [firstSession] = spies.sessionEstablished.mock.calls;
      const [firstAttempt] = spies.reportDialSuccess.mock.calls;

      host.detach();
      await host.tick(1);
      const negotiated = fixture.stream.getNegotiatedSchemaVersion();
      expect(negotiated).not.toBeNull();
      await step(RESUME_MASK_MS - 1);
      expect(session.isReady()).toBe(true);
      expect(spies.sessionLost).not.toHaveBeenCalled();
      // Inside the mask nothing is announced, to the strip or to a stream.
      expect(fixture.statuses).toEqual([]);

      await step(1);
      expect(session.isReady()).toBe(false);
      expect(spies.sessionLost).toHaveBeenCalledTimes(1);
      expect(spies.sessionLost.mock.calls[0]?.[1]).toBe(firstSession?.[1]);
      expect(fixture.readinessLost).toHaveBeenCalledTimes(1);
      expect(fixture.statuses).toEqual([HELD]);
      expect(fixture.stream.getNegotiatedSchemaVersion()).toEqual(negotiated);

      await step(15_000);
      host.attach();
      await until(() => session.isReady());
      await until(() => fixture.ticks.length === 2);
      await host.tick(2);
      await until(() => fixture.ticks.length === 3);

      expect(fixture.ticks).toEqual(range(2));
      expect(fixture.statuses).toEqual([HELD, CONTINUED]);
      expect(fixture.stream.getNegotiatedSchemaVersion()).toEqual(negotiated);
      expect(spies.sessionEstablished).toHaveBeenCalledTimes(2);
      expect(spies.sessionEstablished.mock.calls[1]?.[1]).not.toBe(
        firstSession?.[1],
      );
      expect(spies.reportDialSuccess).toHaveBeenCalledTimes(2);
      expect(spies.reportDialSuccess.mock.calls[1]?.[1]).not.toBe(
        firstAttempt?.[1],
      );
      expect(fixture.recovered).toHaveBeenCalledTimes(1);
      expect(host.connections).toHaveLength(1);
      expect(host.handshakes).toBe(1);
      expect(host.subscribedStreams).toHaveLength(1);
    });

    it("turns streams reconnecting exactly when the hold passes, with no host_attached, and a later host_attached rebuilds without a RESUME", async () => {
      const fixture = await readyFixture(LIVE);
      const { host, session } = fixture;

      host.detach();
      await step(RESUME_HOLD_MS - 1);
      expect(fixture.statuses).toEqual([HELD]);

      await step(1);
      expect(fixture.statuses).toEqual([HELD, REBUILDING]);
      expect(fixture.stream.getNegotiatedSchemaVersion()).toBeNull();
      expect(session.isReady()).toBe(false);
      expect(host.connections).toHaveLength(1);

      host.attach();
      await advanceUntil(() => host.connections.length === 2, 10_000);
      await advanceUntil(() => session.isReady(), 10_000);

      expect(host.handshakes).toBe(2);
      expect(host.opens).toBe(2);
      await until(() => host.subscribedStreams.length === 2);
      await host.settle();
      expect(host.subscribedStreams).toHaveLength(2);
      expect(host.resumes).toEqual([]);
      expect(host.connections[0]?.socket.closed).toBe(true);
    });

    it("still resumes when host_attached lands one millisecond inside the hold", async () => {
      const fixture = await readyFixture(LIVE);
      const { host, session } = fixture;

      host.detach();
      await step(RESUME_HOLD_MS - 1);
      expect(fixture.statuses).toEqual([HELD]);
      host.attach();
      await until(() => session.isReady());

      expect(host.resumes).toHaveLength(1);
      expect(host.connections).toHaveLength(1);
      expect(host.handshakes).toBe(1);
      expect(fixture.statuses).toEqual([HELD, CONTINUED]);
    });

    it("delivers a client frame sent while a stream is held exactly once, after the gap, on resume", async () => {
      const fixture = await readyFixture(LIVE);
      const { host, session } = fixture;
      const connection = host.live();

      // A client frame the relay lost, so the gap is not empty.
      connection.dropInbound = true;
      const lost = track(callStatus(session));
      await step(100);
      host.control("host_detached");
      await step(RESUME_MASK_MS);
      expect(fixture.statuses).toEqual([HELD]);
      fixture.stream.sendClientFrame(
        { kind: "noop", hasBinaryPayload: false },
        null,
      );
      await step(1_000);
      expect(host.clientStreamFrames).toEqual([]);

      const resumed = host.clientFrames.length;
      connection.dropInbound = false;
      connection.dropOutbound = false;
      host.control("host_attached");
      await until(() => host.clientStreamFrames.length === 1);
      await until(() => lost.settled);
      await host.settle();

      expect(host.clientStreamFrames).toHaveLength(1);
      expect(
        host.clientFrames.slice(resumed).map((frame) => frame.type),
      ).toEqual([
        MuxFrameType.RESUME,
        MuxFrameType.REQUEST,
        MuxFrameType.STREAM_FRAME,
      ]);
      expect(fixture.statuses).toEqual([HELD, CONTINUED]);
    });

    it("discards a client frame sent while a stream is held when the resume is refused and the session rebuilds", async () => {
      const fixture = await readyFixture(LIVE);
      const { host, session } = fixture;
      host.resumeReply = "fatal";

      host.detach();
      await step(RESUME_MASK_MS);
      expect(fixture.statuses).toEqual([HELD]);
      fixture.stream.sendClientFrame(
        { kind: "noop", hasBinaryPayload: false },
        null,
      );

      host.attach();
      await advanceUntil(() => host.connections.length === 2, 10_000);
      await advanceUntil(() => session.isReady(), 10_000);
      await until(() => fixture.statuses.length >= 3);
      await host.settle();

      expect(fixture.statuses).toEqual([
        HELD,
        REBUILDING,
        { status: "open", continuity: null },
      ]);
      await until(() => host.subscribedStreams.length === 2);
      await host.settle();
      expect(host.subscribedStreams).toHaveLength(2);
      expect(host.clientStreamFrames).toEqual([]);
    });

    it("keeps a stream whose subscribe was never answered reconnecting through the resumed edge until its first frame", async () => {
      const fixture = await readyFixture({ ...LIVE, autoTick: false });
      const { host, session } = fixture;
      await until(() => host.subscribedStreams.length === 1);

      host.detach();
      await step(RESUME_MASK_MS);
      expect(fixture.statuses).toEqual([HELD]);

      host.attach();
      await until(() => session.isReady());
      await host.settle();
      expect(fixture.statuses).toEqual([HELD]);

      await host.tick(0);
      await until(() => fixture.ticks.length === 1);
      expect(fixture.statuses).toEqual([
        HELD,
        { status: "open", continuity: null },
      ]);
      expect(host.subscribedStreams).toHaveLength(1);
    });

    it("never retracts later than the mask for a host that does not return, and never re-announces", async () => {
      const fixture = await readyFixture(LIVE);
      const { host, session, spies } = fixture;

      host.detach();
      await step(RESUME_MASK_MS - 1);
      expect(spies.sessionLost).not.toHaveBeenCalled();
      await step(1);
      expect(spies.sessionLost).toHaveBeenCalledTimes(1);

      await step(RESUME_HOLD_MS);
      expect(spies.sessionLost).toHaveBeenCalledTimes(1);
      expect(spies.sessionEstablished).toHaveBeenCalledTimes(1);
      expect(session.isReady()).toBe(false);
    });
  });

  describe("calls", () => {
    it("rejects a call queued during the mask pre-send retryable, and a sealed call as it always was, when the resume fails", async () => {
      const fixture = await readyFixture(LIVE);
      const { host, session } = fixture;
      host.holdUnary = true;
      const sealed = track(callStatus(session));
      await until(() => host.pendingRequests.length === 1);

      host.detach();
      const queued = track(callStatus(session));
      await step(1_000);
      host.resumeReply = "silent";
      host.attach();
      await until(() => host.resumes.length === 1);
      await step(RESUME_ACK_MS);

      expect(queued.settled).toBe(true);
      expect(queued.error).toBeInstanceOf(RetryableTransportError);
      expect(mayHaveReachedHost(queued.error)).toBe(false);
      expect(sealed.settled).toBe(true);
      expect(sealed.error).toBeInstanceOf(HostTransportFailureError);
      expect(sealed.error).not.toBeInstanceOf(RetryableTransportError);
      expect(mayHaveReachedHost(sealed.error)).toBe(true);
      // The queued call was never sealed, so the host never read it.
      expect(host.requestMethods).toEqual([STATUS_METHOD]);
    });
  });

  describe("calls that never left", () => {
    const UNARY_RESPONSE_MS = 30_000;

    /** Waits until the resumed edge has reached the subscription. */
    async function untilContinued(fixture: Fixture): Promise<void> {
      const { statuses } = fixture;
      await until(
        () => statuses[statuses.length - 1]?.continuity === "continued",
      );
      await fixture.host.settle();
    }

    function closesFor(host: FakeHost, streamId: number): number {
      return host.clientFrames.filter(
        (frame) =>
          frame.type === MuxFrameType.CLOSE && frame.streamId === streamId,
      ).length;
    }

    it.each([
      { name: "an unkeyed", key: null, advertiseIdempotencyKey: false },
      { name: "a keyed", key: "idem-1", advertiseIdempotencyKey: true },
    ])(
      "rejects $name call queued in the mask pre-send at its budget, holds the session, and the host never reads it",
      async ({ key, advertiseIdempotencyKey }) => {
        const fixture = await readyFixture({
          ...LIVE,
          advertiseIdempotencyKey,
        });
        const { host, session, statuses } = fixture;

        host.detach();
        const call = track(callWithKey(session, key));
        await step(0);
        await step(UNARY_RESPONSE_MS - 1);
        expect(call.settled).toBe(false);
        await step(1);
        await until(() => call.settled);

        expect(call.error).toBeInstanceOf(RetryableTransportError);
        expect(call.error).toMatchObject({
          message: `Remote unary '${STATUS_METHOD}' timed out before it was sent`,
          replaySafetyFromKey: false,
        });
        expect(mayHaveReachedHost(call.error)).toBe(false);
        // Still held on the same connection: nothing rebuilt.
        expect(host.connections).toHaveLength(1);
        expect(statuses[statuses.length - 1]).toEqual(HELD);

        host.attach();
        await until(() => host.resumes.length === 1);
        await untilContinued(fixture);

        expect(host.handshakes).toBe(1);
        expect(host.requestMethods).toEqual([]);
        expect(
          host.clientFrames.filter(
            (frame) => frame.type === MuxFrameType.CLOSE,
          ),
        ).toEqual([]);
      },
    );

    it("keeps a sealed call's budget expiry ambiguous inside the hold, and its CLOSE reaches the host after the resume", async () => {
      const fixture = await readyFixture(LIVE);
      const { host, session } = fixture;
      host.holdUnary = true;
      const sealed = track(callStatus(session));
      await until(() => host.pendingRequests.length === 1);
      const sealedStream = host.requestStreamIds[0] ?? -1;

      host.detach();
      await step(UNARY_RESPONSE_MS);
      await until(() => sealed.settled);

      expect(sealed.error).toBeInstanceOf(HostTransportFailureError);
      expect(sealed.error).not.toBeInstanceOf(RetryableTransportError);
      expect(mayHaveReachedHost(sealed.error)).toBe(true);
      expect(host.connections).toHaveLength(1);

      host.attach();
      await until(() => host.resumes.length === 1);
      await untilContinued(fixture);
      await until(() => closesFor(host, sealedStream) > 0);

      expect(closesFor(host, sealedStream)).toBe(1);
    });

    it("sends no liveness probe and rebuilds nothing when that budget expires inside the hold", async () => {
      const fixture = await readyFixture({
        ...LIVE,
        livenessProbe: { method: STATUS_METHOD, params: {} },
      });
      const { host, session } = fixture;

      host.detach();
      const call = track(callStatus(session));
      await step(UNARY_RESPONSE_MS);
      await until(() => call.settled);
      // Past the verdict a probe would have asked for.
      await step(SESSION_LIVENESS_PROBE_TIMEOUT_MS + 1_000);
      expect(host.connections).toHaveLength(1);

      host.attach();
      await until(() => host.resumes.length === 1);
      await untilContinued(fixture);

      // A probe would have queued behind the hold and gone out with the resume.
      expect(host.requestMethods).toEqual([]);
      expect(host.connections).toHaveLength(1);
    });

    it("sends no liveness probe when that budget expires inside a resume exchange, where the host is ready but its RESUME is still out", async () => {
      const fixture = await readyFixture({
        ...LIVE,
        livenessProbe: { method: STATUS_METHOD, params: {} },
      });
      const { host, session } = fixture;
      // The window of in-channel silence a probe needs has passed.
      await step(SESSION_SILENCE_TIMEOUT_MS + 1_000);
      host.holdOutbound = true;
      host.attach();
      await until(() => host.resumes.length === 1);

      const budgetMs = 2_000;
      const call = track(
        session.sendUnary(
          STATUS_METHOD,
          {},
          null,
          null,
          null,
          budgetMs,
          false,
          null,
        ),
      );
      await step(budgetMs);
      await until(() => call.settled);
      expect(call.error).toBeInstanceOf(RetryableTransportError);

      // A call made now queues behind the exchange, and its answer says the
      // exchange is over and the queue has drained.
      const marker = track(callStatus(session));
      host.holdOutbound = false;
      host.releaseHeld();
      await until(() => marker.settled);

      // A probe would have queued ahead of the marker and gone out with it.
      expect(marker.value).toEqual({ ready: true });
      expect(host.requestMethods).toEqual([STATUS_METHOD]);
      expect(host.connections).toHaveLength(1);
    });

    it("tells a sealed and a never-sealed call apart when the session closes", async () => {
      const fixture = await readyFixture(LIVE);
      const { host, session } = fixture;
      host.holdUnary = true;
      const sealed = track(callStatus(session));
      await until(() => host.pendingRequests.length === 1);
      host.detach();
      const queued = track(callStatus(session));
      await step(0);

      session.close();
      await until(() => sealed.settled && queued.settled);

      for (const outcome of [sealed, queued]) {
        expect(outcome.error).toMatchObject({
          message: "Remote session closed",
        });
        expect(outcome.error).not.toBeInstanceOf(RetryableTransportError);
      }
      expect(mayHaveReachedHost(sealed.error)).toBe(true);
      expect(mayHaveReachedHost(queued.error)).toBe(false);
    });

    /** Holds the next seal open until `release`, through the real cipher. */
    function holdNextSeal(): { reached: () => boolean; release: () => void } {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const encryptSpy = vi
        .spyOn(NoiseChannel.prototype, "encrypt")
        .mockImplementationOnce(async function (
          this: NoiseChannel,
          frame: Uint8Array,
        ) {
          await gate;
          return this.encrypt(frame);
        });
      return {
        reached: () => encryptSpy.mock.calls.length === 1,
        release: () => release(),
      };
    }

    /**
     * Holds the next seal, so the scheduler (one write at a time) has pulled
     * and is still sealing the first call's frame while the rest of the calls
     * wait in its queue unsealed. Resolves the held seal on the returned
     * `release`, which the caller reaches only after its assertions.
     */
    async function strandBehindSeal(
      fixture: Fixture,
      count: number,
    ): Promise<{ calls: CallOutcome[]; release: () => void }> {
      const { host, session } = fixture;
      host.holdUnary = true;
      const seal = holdNextSeal();
      const calls: CallOutcome[] = [];
      for (let index = 0; index < count; index += 1) {
        calls.push(track(callStatus(session)));
      }
      await until(() => seal.reached());
      await step(0);
      expect(host.requestStreamIds).toEqual([]);
      return { calls, release: seal.release };
    }

    it("rejects the calls queued behind a seal pre-send on a connection without resume, and the call being sealed as ever, when it drops", async () => {
      const fixture = await readyFixture({ ...LIVE, advertiseResume: false });
      const { host } = fixture;
      const { calls, release } = await strandBehindSeal(fixture, 4);

      host.dropSocket(1006, "server-drop");
      await until(() => calls.every((call) => call.settled));
      release();

      const [sealing, ...queued] = calls;
      expect(sealing?.error).toBeInstanceOf(HostTransportFailureError);
      expect(sealing?.error).not.toBeInstanceOf(RetryableTransportError);
      expect(mayHaveReachedHost(sealing?.error)).toBe(true);
      for (const call of queued) {
        expect(call.error).toBeInstanceOf(RetryableTransportError);
        expect(call.error).toMatchObject({
          message: "Remote session dropped before the request was sent",
          replaySafetyFromKey: false,
        });
        expect(mayHaveReachedHost(call.error)).toBe(false);
      }
    });

    it("keeps a terminal fatal's verdict on a call that never left, unmarked and not retryable", async () => {
      const fixture = await readyFixture(LIVE);
      const { host } = fixture;
      const { calls, release } = await strandBehindSeal(fixture, 3);

      await host.sendSessionFatal("HOST_REFUSED");
      await until(() => calls.every((call) => call.settled));
      release();

      const [sealing, queued] = calls;
      for (const call of [sealing, queued]) {
        expect(call?.error).toMatchObject({
          fatalDetails: { code: "HOST_REFUSED" },
        });
        expect(call?.error).not.toBeInstanceOf(RetryableTransportError);
      }
      expect(mayHaveReachedHost(sealing?.error)).toBe(true);
      expect(mayHaveReachedHost(queued?.error)).toBe(false);
    });

    it("reads a half-sent upload as sealed when its budget expires inside the hold: ambiguous, and it gets a CLOSE", async () => {
      const fixture = await readyFixture(LIVE);
      const { host, session } = fixture;
      const socket = host.live().socket;
      const before = socket.binarySends;
      // 1.5 MiB rides bulk frames; the pacer's 1 MiB burst seals the first
      // dozen or so of 24 and, with time frozen, holds the rest back.
      const upload = track(callPadded(session, 1.5 * 1024 * 1024));
      await until(() => socket.binarySends - before >= 10);
      await step(0);
      host.detach();
      await step(UNARY_RESPONSE_MS);
      await until(() => upload.settled);

      expect(upload.error).toBeInstanceOf(HostTransportFailureError);
      expect(upload.error).not.toBeInstanceOf(RetryableTransportError);
      expect(mayHaveReachedHost(upload.error)).toBe(true);

      const streamId =
        host.clientFrames.find((frame) => frame.type === MuxFrameType.REQUEST)
          ?.streamId ?? -1;
      host.attach();
      await until(() => host.resumes.length === 1);
      await untilContinued(fixture);
      await until(() => closesFor(host, streamId) > 0);

      expect(closesFor(host, streamId)).toBe(1);
      // The host never read the whole request.
      expect(host.requestMethods).toEqual([]);
    });

    it("reads a frame that is still being sealed as sealed when the budget expires", async () => {
      const fixture = await readyFixture(LIVE);
      const { session } = fixture;
      const seal = holdNextSeal();
      const call = track(callStatus(session));
      await until(() => seal.reached());

      await step(UNARY_RESPONSE_MS);
      await until(() => call.settled);
      seal.release();

      expect(call.error).toBeInstanceOf(HostTransportFailureError);
      expect(call.error).not.toBeInstanceOf(RetryableTransportError);
      expect(mayHaveReachedHost(call.error)).toBe(true);
    });
  });

  describe("failure rebuilds", () => {
    it("rebuilds when the host does not answer in 5 000 ms, not before", async () => {
      const fixture = await readyFixture(LIVE);
      const { host, session } = fixture;
      host.resumeReply = "silent";

      host.attach();
      await until(() => host.resumes.length === 1);
      await step(RESUME_ACK_MS - 1);
      expect(host.connections).toHaveLength(1);
      expect(session.isReady()).toBe(true);

      await step(1);
      expect(session.isReady()).toBe(false);
      await advanceUntil(() => host.connections.length === 2, 10_000);
      await advanceUntil(() => session.isReady(), 10_000);
      expect(host.handshakes).toBe(2);
      await until(() => host.subscribedStreams.length === 2);
      await host.settle();
      expect(host.subscribedStreams).toHaveLength(2);
      expect(host.resumes).toHaveLength(1);
    });

    it.each<{ readonly name: string; readonly reply: ResumeReply }>([
      { name: "a sealed FATAL on stream 0", reply: "fatal" },
      { name: "a host RESUME above what the client sent", reply: "overclaim" },
      { name: "a malformed RESUME", reply: "malformed" },
    ])("rebuilds on $name before the host's RESUME", async ({ reply }) => {
      const fixture = await readyFixture(LIVE);
      const { host, session } = fixture;
      host.resumeReply = reply;

      host.attach();
      await until(() => host.resumes.length === 1);
      await until(() => !session.isReady());
      await advanceUntil(() => host.connections.length === 2, 10_000);
      await advanceUntil(() => session.isReady(), 10_000);

      expect(host.handshakes).toBe(2);
      await until(() => host.subscribedStreams.length === 2);
      await host.settle();
      expect(host.subscribedStreams).toHaveLength(2);
      expect(host.resumes).toHaveLength(1);
      expect(host.connections[0]?.socket.closed).toBe(true);
    });
  });

  describe("restarts", () => {
    it("restarts the exchange on a second host_attached and ignores the first answer", async () => {
      const fixture = await readyFixture(LIVE);
      const { host, session } = fixture;
      const connection = host.live();
      host.resumeReply = "silent";

      host.detach();
      await host.tick(1);
      host.attach();
      await until(() => host.resumes.length === 1);
      const firstResume = host.resumes[0];
      if (firstResume === undefined) {
        throw new Error("no RESUME reached the host");
      }
      // The first answer is on the wire as the second host_attached lands.
      host.holdOutbound = true;
      await host.answerResume(connection, firstResume);
      host.holdOutbound = false;
      host.resumeReply = "answer";
      host.releaseHeldThen("host_attached");
      await until(() => host.resumes.length === 2);
      await until(() => fixture.ticks.length === 2);
      await host.tick(2);
      await until(() => fixture.ticks.length === 3);
      await host.settle();

      expect(fixture.ticks).toEqual(range(2));
      expect(session.isReady()).toBe(true);
      expect(host.connections).toHaveLength(1);
    });

    it("keeps every host frame dispatched once and the session live when two RESUMEs are in flight and the host answers both", async () => {
      const fixture = await readyFixture(LIVE);
      const { host, session } = fixture;
      const connection = host.live();
      host.resumeReply = "silent";

      host.detach();
      await host.tick(1);
      host.attach();
      await until(() => host.resumes.length === 1);
      host.control("host_attached");
      await until(() => host.resumes.length === 2);
      const [first, second] = host.resumes;
      if (first === undefined || second === undefined) {
        throw new Error("the client did not send two RESUMEs");
      }

      await host.answerResume(connection, first);
      await host.answerResume(connection, second);
      await host.settle();
      await host.tick(2);
      await until(() => fixture.ticks.length >= 3);
      await host.settle();

      expect(fixture.ticks).toEqual(range(2));
      expect(session.isReady()).toBe(true);
      expect(host.connections).toHaveLength(1);
    });

    it("returns to masked on a second host_detached during an exchange, with the original deadline", async () => {
      const fixture = await readyFixture(LIVE);
      const { host, session } = fixture;
      host.resumeReply = "silent";

      host.detach();
      await step(1_000);
      host.attach();
      await until(() => host.resumes.length === 1);
      await step(1_000);
      host.control("host_detached");
      expect(session.isReady()).toBe(true);

      await step(RESUME_MASK_MS - 2_000 - 2);
      expect(session.isReady()).toBe(true);
      await step(3);
      expect(session.isReady()).toBe(false);
      expect(fixture.readinessLost).toHaveBeenCalledTimes(1);

      // The cancelled exchange's ack timer is gone with it.
      await step(RESUME_ACK_MS);
      expect(host.connections).toHaveLength(1);
      expect(fixture.spies.sessionLost).toHaveBeenCalledTimes(1);
    });

    it("goes straight down on a second host_detached when the mask ended during the exchange", async () => {
      const fixture = await readyFixture(LIVE);
      const { host, session } = fixture;
      host.resumeReply = "silent";

      host.detach();
      await step(1_000);
      host.attach();
      await until(() => host.resumes.length === 1);
      // The mask's deadline passes while the exchange holds readiness.
      await step(RESUME_MASK_MS - 1_000 + 500);
      expect(session.isReady()).toBe(true);

      host.control("host_detached");
      expect(session.isReady()).toBe(false);
      expect(fixture.spies.sessionLost).toHaveBeenCalledTimes(1);
      await step(RESUME_ACK_MS);
      expect(host.connections).toHaveLength(1);
    });

    it("stays down on a second host_detached during an exchange begun from down", async () => {
      const fixture = await readyFixture(LIVE);
      const { host, session } = fixture;

      host.detach();
      await step(RESUME_MASK_MS + 1);
      expect(session.isReady()).toBe(false);
      host.resumeReply = "silent";
      await step(5_000);
      host.attach();
      await until(() => host.resumes.length === 1);
      expect(session.isReady()).toBe(false);

      host.control("host_detached");
      expect(session.isReady()).toBe(false);
      await step(RESUME_ACK_MS + 1_000);
      expect(session.isReady()).toBe(false);
      expect(fixture.readinessLost).toHaveBeenCalledTimes(1);
      expect(fixture.spies.sessionLost).toHaveBeenCalledTimes(1);
      expect(host.connections).toHaveLength(1);
    });
  });

  describe("gap resend", () => {
    it("resends the client's lost frames in ring order ahead of frames queued during the mask, paced and not as one burst", async () => {
      const fixture = await readyFixture(LIVE);
      const { host, session } = fixture;
      const lostCalls = LOST_CALLS;

      // Frames the relay lost in transit: sealed and in the client's ring.
      const calls = await loseCalls(fixture, lostCalls);
      host.control("host_detached");
      calls.push(track(callStatus(session)), track(callStatus(session)));
      await step(1_000);
      expect(host.requestMethods).toEqual([]);

      await attachIntoReplay(fixture);
      expect(host.requestStreamIds.length).toBeLessThan(lostCalls + 2);

      await advanceUntil(
        () => host.requestStreamIds.length === lostCalls + 2,
        5_000,
      );
      await until(() => calls.every((call) => call.settled));

      const ids = host.requestStreamIds;
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
      expect(new Set(ids).size).toBe(lostCalls + 2);
      expect(calls.every((call) => call.error === null)).toBe(true);
      expect(session.isReady()).toBe(true);
    });

    describe("the outage ends when the replay has gone out", () => {
      /** A detach during the replay stops it: no further frame is sealed. */
      async function detachAndExpectReplayStopped(
        fixture: Fixture,
      ): Promise<void> {
        const { host } = fixture;
        const socket = host.live().socket;
        // The replay is stalled on the pacer, so no write is in flight and
        // this count is final unless the replay goes on.
        const sealed = socket.binarySends;
        host.detach();
        await step(500);
        await realDelay(100);
        expect(socket.binarySends).toBe(sealed);
      }

      it("holds readiness, the resumed edge and every announcement until the last resent frame is out", async () => {
        const fixture = await readyFixture(LIVE);
        const { host, session, spies } = fixture;
        const calls = await loseCalls(fixture, LOST_CALLS);
        host.detach();
        await step(RESUME_MASK_MS);
        expect(fixture.statuses).toEqual([HELD]);

        await attachIntoReplay(fixture);
        expect(session.isReady()).toBe(false);
        expect(fixture.statuses).toEqual([HELD]);
        expect(spies.sessionEstablished).toHaveBeenCalledTimes(1);
        expect(fixture.recovered).not.toHaveBeenCalled();

        await advanceUntil(
          () => host.requestStreamIds.length === LOST_CALLS,
          5_000,
        );
        await until(() => session.isReady());
        await until(() => calls.every((call) => call.settled));

        expect(fixture.statuses).toEqual([HELD, CONTINUED]);
        expect(spies.sessionEstablished).toHaveBeenCalledTimes(2);
        expect(fixture.recovered).toHaveBeenCalledTimes(1);
        expect(new Set(host.requestStreamIds).size).toBe(LOST_CALLS);
      });

      it("stops the replay on a detach from down, stays down, and a later host_attached finishes it exactly once", async () => {
        const fixture = await readyFixture(LIVE);
        const { host, session, spies } = fixture;
        const calls = await loseCalls(fixture, LOST_CALLS);
        host.detach();
        await step(RESUME_MASK_MS);
        await attachIntoReplay(fixture);

        await detachAndExpectReplayStopped(fixture);
        expect(session.isReady()).toBe(false);
        expect(fixture.readinessLost).toHaveBeenCalledTimes(1);
        expect(spies.sessionLost).toHaveBeenCalledTimes(1);
        expect(fixture.statuses).toEqual([HELD]);
        expect(fixture.recovered).not.toHaveBeenCalled();

        await step(2_000);
        host.attach();
        await advanceUntil(
          () => host.requestStreamIds.length === LOST_CALLS,
          5_000,
        );
        await until(() => session.isReady());
        await until(() => calls.every((call) => call.settled));
        await host.settle();

        expect(host.requestStreamIds).toHaveLength(LOST_CALLS);
        expect(new Set(host.requestStreamIds).size).toBe(LOST_CALLS);
        expect(fixture.statuses).toEqual([HELD, CONTINUED]);
        expect(host.handshakes).toBe(1);
        expect(host.connections).toHaveLength(1);
      });

      it("measures the hold from the original detach when the replay is interrupted near its end", async () => {
        const fixture = await readyFixture(LIVE);
        const { host, session } = fixture;
        await loseCalls(fixture, LOST_CALLS);
        host.detach();
        await step(RESUME_HOLD_MS - 2_000);
        expect(fixture.statuses).toEqual([HELD]);
        await attachIntoReplay(fixture);

        await detachAndExpectReplayStopped(fixture);
        // 58 000 + the 500 ms spent proving the replay stopped.
        await step(RESUME_HOLD_MS - 58_500 - 1);
        expect(fixture.statuses).toEqual([HELD]);
        await step(1);
        expect(fixture.statuses).toEqual([HELD, REBUILDING]);
        expect(session.isReady()).toBe(false);

        host.attach();
        await advanceUntil(() => host.connections.length === 2, 10_000);
        await advanceUntil(() => session.isReady(), 10_000);

        expect(host.resumes).toHaveLength(1);
        expect(host.handshakes).toBe(2);
        await until(() => host.subscribedStreams.length === 2);
        await host.settle();
        expect(host.subscribedStreams).toHaveLength(2);
      });

      it("returns to masked with the original deadline on a detach during a replay begun inside the mask", async () => {
        const fixture = await readyFixture(LIVE);
        const { host, session, spies } = fixture;
        await loseCalls(fixture, LOST_CALLS);
        host.detach();
        await step(1_000);
        await attachIntoReplay(fixture);
        expect(session.isReady()).toBe(true);

        await detachAndExpectReplayStopped(fixture);
        expect(session.isReady()).toBe(true);
        await step(RESUME_MASK_MS - 1_000 - 500 - 1);
        expect(session.isReady()).toBe(true);
        expect(fixture.statuses).toEqual([]);
        expect(spies.sessionLost).not.toHaveBeenCalled();

        await step(1);
        expect(session.isReady()).toBe(false);
        expect(spies.sessionLost).toHaveBeenCalledTimes(1);
        expect(fixture.statuses).toEqual([HELD]);
        await step(1_000);
        expect(fixture.readinessLost).toHaveBeenCalledTimes(1);
      });
    });

    it("spends no bulk credit on a resent frame", async () => {
      const writes: Uint8Array[] = [];
      const scheduler = new PriorityScheduler({
        write: () => Promise.resolve(),
        onWriteError: () => undefined,
        initialBulkCredits: 7,
        now: undefined,
      });
      scheduler.pause();

      scheduler.resumeAfterResend(
        [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])],
        (frame) => {
          writes.push(frame);
          return Promise.resolve();
        },
        () => undefined,
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(writes).toHaveLength(3);
      expect(scheduler.availableCredits()).toBe(7);
    });
  });

  describe("silence", () => {
    const probe: SessionLivenessProbe = { method: STATUS_METHOD, params: {} };
    const SILENT: FixtureConfig = {
      advertiseResume: true,
      advertiseIdempotencyKey: false,
      autoTick: false,
      livenessProbe: probe,
    };

    it("probes an undisturbed silent subscription once the silence window passes", async () => {
      const fixture = await readyFixture(SILENT);

      await step(20_000 + 500);

      expect(fixture.host.requestMethods).toContain(STATUS_METHOD);
    });

    it("sends no liveness probe while masked or resuming", async () => {
      const fixture = await readyFixture(SILENT);
      const { host } = fixture;
      host.resumeReply = "silent";

      // The subscription's first-frame deadline falls inside the mask...
      await step(17_000);
      host.detach();
      await step(3_500);
      expect(host.requestMethods).toEqual([]);

      // ...and again, re-armed, inside a resume exchange from down.
      await step(12_500);
      host.attach();
      await until(() => host.resumes.length === 1);
      await step(4_500);
      expect(host.requestMethods).toEqual([]);
    });
  });

  describe("negotiation and dial", () => {
    it("rebuilds on host_attached as today when the host does not advertise resume", async () => {
      const fixture = await readyFixture({ ...LIVE, advertiseResume: false });
      const { host, session, spies } = fixture;

      host.detach();
      expect(session.isReady()).toBe(false);
      expect(spies.sessionLost).toHaveBeenCalledTimes(1);

      host.attach();
      await advanceUntil(() => host.connections.length === 2, 10_000);
      await advanceUntil(() => session.isReady(), 10_000);

      expect(host.resumes).toEqual([]);
      expect(host.handshakes).toBe(2);
      await until(() => host.subscribedStreams.length === 2);
      await host.settle();
      expect(host.subscribedStreams).toHaveLength(2);
    });

    it("carries the replaced leg's close as prev on the next dial, and none on the first", async () => {
      const fixture = await readyFixture(LIVE);
      const { host, session } = fixture;

      host.dropSocket(1006, "server-drop");
      await advanceUntil(() => host.urls.length === 2, 10_000);
      await advanceUntil(() => session.isReady(), 10_000);

      expect(new URL(host.urls[0] ?? "").searchParams.has("prev")).toBe(false);
      expect(new URL(host.urls[1] ?? "").searchParams.get("prev")).toBe(
        "1006:",
      );
    });
  });
});
