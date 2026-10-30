import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
  type MockInstance,
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
  ChunkReassembler,
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
  type ResumePayload,
} from "../../mux";
import {
  encodeResumeFrame,
  parseResumeFrame,
  ResumeLedger,
} from "../../resume-ledger";
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
import type {
  RemoteSessionAuth,
  RemoteSessionAuthRecoveryOutcome,
} from "../auth";
import {
  ATTACH_ACK_TIMEOUT_MS,
  CLIENT_REAUTH_INTERVAL_MS,
  CLIENT_REAUTH_JITTER_MS,
  RELAY_DIAL_TIMEOUT_MS,
  RESUME_HOLD_MS,
  RESUME_MASK_MS,
} from "../config";
import type { AttachGrantProvider, AttachGrantProvision } from "../grant";
import { NoiseChannel } from "../noise-channel";
import type { RelaySocketHandlers, RelaySocketOptions } from "../relay-socket";
import { HostTransportFailureError } from "../rpc-types";
import { RemoteSession, type RemoteSessionEvidence } from "../session";

/**
 * Own-leg loss on a session that negotiated resume: the client keeps its Noise
 * session, re-dials with a claim (`resume=<sid>:<key>`) and either resumes on
 * the same relay session id or, when the relay no longer holds the row, takes
 * the fresh leg into a rebuild.
 *
 * The relay model below owns the client legs; the host model owns the Noise
 * session, ring and stream state, bound to a relay session id that outlives a
 * leg. A leg the client closes with anything but a parkable code ends its
 * session for good, as the real relay does; frames sent to a session while no
 * leg is bound are lost (they still count in the host's ledger).
 */

const HOST_ID = "host-relink";
const ATTACH_URL = "wss://relay.test/attach";
const EMPTY_AD = new Uint8Array(0);
const STATUS_METHOD = "host.status";
const STREAM_METHOD = "cursor.subscribe";
const RELINK_CLOSE_CODE = 4007;

/** Captured before fake timers: the real event loop lets Noise's async work finish. */
const realSetTimeout = globalThis.setTimeout;
function realDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    realSetTimeout(resolve, ms);
  });
}

/** The handlers the session gave each relay socket, in dial order. */
const capturedLegs = vi.hoisted(() => ({
  handlers: [] as RelaySocketHandlers[],
}));

vi.mock("../relay-socket", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../relay-socket")>();
  class RecordingRelaySocket extends actual.RelaySocket {
    constructor(options: RelaySocketOptions) {
      super(options);
      capturedLegs.handlers.push(options.handlers);
    }
  }
  return { ...actual, RelaySocket: RecordingRelaySocket };
});

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

function encodeHostResume(
  clientResume: ResumePayload,
  hostReceived: number,
): Uint8Array {
  return encodeResumeFrame(hostReceived, clientResume.attempt);
}

// ---- Fake relay + host ------------------------------------------------------ //

type RelayControl = "host_detached" | "host_attached";

/** What the relay does with one dial, consumed in order from the plan. */
type DialBehavior = "ack" | "swallow" | "never-open" | "refuse";

class Leg implements StreamWebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: StreamWebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;
  readonly params: URLSearchParams;
  /** Every close the client asked for, in order. */
  readonly closes: { readonly code: number; readonly reason: string }[] = [];
  closed = false;
  /** Text frames the client sent on this leg, keepalive pings excluded. */
  readonly textSends: string[] = [];
  /** Binary frames the client put on this leg. */
  binarySends = 0;
  failSends = false;
  session: HostSession | null = null;

  constructor(
    readonly index: number,
    readonly url: string,
    private readonly relay: FakeRelay,
  ) {
    this.params = new URL(url).searchParams;
  }

  get claim(): string | null {
    return this.params.get("resume");
  }

  send(data: string | Uint8Array): void {
    if (typeof data === "string" && data !== "relay-ping") {
      this.textSends.push(data);
    }
    if (typeof data !== "string") {
      if (this.failSends) {
        throw new Error("send failed");
      }
      this.binarySends += 1;
    }
    this.relay.onClientSend(this, data);
  }

  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
    this.closed = true;
    this.relay.onLegClosed(this, code);
  }

  deliverControl(type: RelayControl): void {
    this.onmessage?.({ type: "text", data: JSON.stringify({ type }) });
  }
}

interface HostSession {
  readonly sid: number;
  readonly key: string;
  noise: NoiseSession | null;
  /** The host's own ring and receive count. */
  readonly ledger: ResumeLedger;
  readonly reassembler: ChunkReassembler;
  readonly seqByStream: Map<number, number>;
  readonly streamIds: number[];
  leg: Leg | null;
  expired: boolean;
  queue: Promise<void>;
  /** The host leg is away: frames both ways are lost. */
  hostAway: boolean;
}

interface ClientFrameRecord {
  readonly leg: number;
  readonly type: number;
}

interface PendingRequest {
  readonly session: HostSession;
  readonly streamId: number;
  readonly requestId: string;
}

class FakeRelay {
  private readonly keys: NoiseKeyPair = generateStaticKeyPair();
  readonly legs: Leg[] = [];
  readonly sessions: HostSession[] = [];
  readonly dialTimes: number[] = [];
  readonly clientFrames: ClientFrameRecord[] = [];
  readonly resumes: ResumePayload[] = [];
  readonly requestStreamIds: number[] = [];
  readonly pendingRequests: PendingRequest[] = [];
  readonly subscribedStreams: number[] = [];
  private nextSid = 1;
  handshakes = 0;
  /** Behaviour of upcoming dials; an empty plan means `ack`. */
  plan: DialBehavior[] = [];
  /** Every dial opens and is then never acknowledged. */
  swallowAcks = false;
  /** An older relay: the ack carries no `resumeKey`. */
  issueKeys = true;
  /** Claims find no row: the relay answers with a fresh session id. */
  expireRows = false;
  answerPings = true;
  holdUnary = false;
  autoTick = true;
  /** Runs in the tick right after a fresh (non-claim) ack. */
  onFreshAck: ((leg: Leg) => void) | null = null;

  get publicKey(): Uint8Array {
    return this.keys.publicKey;
  }

  readonly factory: IStreamWebSocketFactory = {
    create: (url: string): StreamWebSocketLike => {
      const leg = new Leg(this.legs.length, url, this);
      this.legs.push(leg);
      this.dialTimes.push(Date.now());
      const behavior = this.plan.shift() ?? "ack";
      queueMicrotask(() => this.openLeg(leg, behavior));
      return leg;
    },
  };

  /** The session the newest leg is bound to. */
  host(): HostSession {
    const session = [...this.sessions]
      .reverse()
      .find((entry) => !entry.expired);
    if (session === undefined) {
      throw new Error("no live host session");
    }
    return session;
  }

  currentLeg(): Leg {
    const leg = this.host().leg;
    if (leg === null) {
      throw new Error("the session has no leg");
    }
    return leg;
  }

  // -- Relay behaviour ----------------------------------------------------- //

  /** The relay drops the session's current leg from its side. */
  dropLeg(code: number, reason: string): void {
    const leg = this.currentLeg();
    leg.closed = true;
    this.onLegClosed(leg, code);
    leg.onclose?.({ code, reason, wasClean: false });
  }

  /** The host leg goes away; the relay says so. */
  hostDetach(): void {
    this.host().hostAway = true;
    this.currentLeg().deliverControl("host_detached");
  }

  hostAttach(): void {
    this.host().hostAway = false;
    this.currentLeg().deliverControl("host_attached");
  }

  onLegClosed(leg: Leg, code: number): void {
    const session = leg.session;
    if (session === null || session.leg !== leg) {
      return;
    }
    session.leg = null;
    // Only a parkable close keeps the row; 1000 ends the session.
    if (code === 1000 || leg.params.get("park") !== "1") {
      session.expired = true;
    }
  }

  onClientSend(leg: Leg, data: string | Uint8Array): void {
    if (typeof data === "string") {
      if (data === "relay-ping" && this.answerPings) {
        queueMicrotask(() => {
          leg.onmessage?.({ type: "text", data: "relay-pong" });
        });
      }
      return;
    }
    const session = leg.session;
    if (session === null || session.leg !== leg || session.hostAway) {
      return;
    }
    session.queue = session.queue
      .then(() => this.handleClientData(leg, session, data))
      .catch((error: unknown) => {
        throw error instanceof Error ? error : new Error(String(error));
      });
  }

  // -- Host behaviour ------------------------------------------------------ //

  async tick(n: number): Promise<void> {
    const session = this.host();
    const streamId = session.streamIds[0];
    if (streamId === undefined) {
      throw new Error("no subscription on this session");
    }
    await this.sendMux(session, {
      type: MuxFrameType.STREAM_FRAME,
      streamId,
      qos: QosClass.INTERACTIVE,
      json: { kind: "tick", n, hasBinaryPayload: false },
      binary: null,
    });
  }

  async respondTo(request: PendingRequest): Promise<void> {
    await this.sendMux(request.session, {
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

  /** A host-sent session FATAL on stream 0, sealed in order like any host frame. */
  async sendSessionFatal(code: string, retryable: boolean): Promise<void> {
    await this.sendMux(this.host(), {
      type: MuxFrameType.FATAL,
      streamId: SESSION_CONTROL_STREAM_ID,
      qos: QosClass.INTERACTIVE,
      json: {
        details: {
          code,
          reason: "the host said so",
          incompatibleMethods: null,
          upgradeGuidance: null,
          retryable,
        },
      },
      binary: null,
    });
  }

  /** A frame that passes the AEAD check and that the mux decoder refuses. */
  async sendUndecodable(): Promise<void> {
    await this.sealAndDeliver(this.host(), new Uint8Array([0xff]));
  }

  /** The host's RESUME for `resume`, then the client's gap, resealed. */
  async answerResume(
    session: HostSession,
    resume: ResumePayload,
  ): Promise<void> {
    await this.sealAndDeliver(
      session,
      encodeHostResume(resume, session.ledger.received),
    );
    const gap = session.ledger.gapFrom(resume.received);
    if (gap.kind !== "gap") {
      throw new Error("the fake host cannot recover the client's count");
    }
    for (const plaintext of gap.frames) {
      await this.sealAndDeliver(session, plaintext);
    }
  }

  // -- Plumbing ------------------------------------------------------------ //

  private openLeg(leg: Leg, behavior: DialBehavior): void {
    if (behavior === "never-open" || leg.closed) {
      return;
    }
    if (behavior === "refuse") {
      leg.closed = true;
      leg.onclose?.({ code: 1006, reason: "refused", wasClean: false });
      return;
    }
    leg.onopen?.({ type: "open" });
    const claim = leg.claim;
    let session: HostSession | undefined;
    if (claim !== null && !this.expireRows) {
      session = this.sessions.find(
        (entry) => !entry.expired && `${entry.sid}:${entry.key}` === claim,
      );
    }
    const claimed = session !== undefined;
    if (session === undefined) {
      const sid = this.nextSid;
      this.nextSid += 1;
      session = {
        sid,
        key: `secret-key-${sid}-xyzzy`,
        noise: null,
        ledger: new ResumeLedger(() => undefined),
        reassembler: new ChunkReassembler(undefined),
        seqByStream: new Map(),
        streamIds: [],
        leg: null,
        expired: false,
        queue: Promise.resolve(),
        hostAway: false,
      };
      this.sessions.push(session);
    }
    session.leg = leg;
    leg.session = session;
    if (behavior === "swallow" || this.swallowAcks) {
      return;
    }
    leg.onmessage?.({
      type: "text",
      data: JSON.stringify({
        type: "attach_ack",
        role: "client",
        sid: session.sid,
        ...(this.issueKeys ? { resumeKey: session.key } : {}),
      }),
    });
    if (!claimed) {
      this.onFreshAck?.(leg);
    }
  }

  private async handleClientData(
    leg: Leg,
    session: HostSession,
    data: Uint8Array,
  ): Promise<void> {
    if (session.noise === null) {
      const handshake = await createResponderHandshake(
        this.keys,
        NOISE_PROLOGUE,
      );
      await handshake.readMessage(data);
      const msg1 = await handshake.writeMessage(new Uint8Array(0));
      session.noise = NoiseSession.fromHandshake(
        handshake,
        DEFAULT_REPLAY_WINDOW_SIZE,
      );
      this.handshakes += 1;
      if (session.leg === leg) {
        leg.onmessage?.({ type: "binary", data: msg1 });
      }
      return;
    }
    const plaintext = await session.noise.decrypt(data, EMPTY_AD);
    const frame = decodeMuxFrame(plaintext);
    this.clientFrames.push({ leg: leg.index, type: frame.type });
    session.ledger.receive(plaintext);
    if (frame.type === MuxFrameType.RESUME) {
      const resume = parseResumeFrame(frame);
      if (resume === null) {
        throw new Error("the client sent a malformed RESUME");
      }
      this.resumes.push(resume);
      await this.answerResume(session, resume);
      return;
    }
    const message = session.reassembler.accept(frame);
    if (message !== null) {
      await this.handleMessage(session, message);
    }
  }

  private async handleMessage(
    session: HostSession,
    message: ReassembledMessage,
  ): Promise<void> {
    const json = message.json ?? {};
    if (
      message.streamId === SESSION_CONTROL_STREAM_ID &&
      message.type === MuxFrameType.OPEN
    ) {
      await this.sendMux(session, {
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
          capabilities: [SESSION_CAPABILITY_RESUME],
        },
        binary: null,
      });
      return;
    }
    if (message.type === MuxFrameType.SUBSCRIBE) {
      session.streamIds.push(message.streamId);
      this.subscribedStreams.push(message.streamId);
      if (this.autoTick) {
        await this.tick(0);
      }
      return;
    }
    if (message.type === MuxFrameType.REQUEST) {
      this.requestStreamIds.push(message.streamId);
      const request: PendingRequest = {
        session,
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
    session: HostSession,
    message: OutboundMessage,
  ): Promise<void> {
    const source = new OutboundChunkSource(
      message,
      () => {
        const current = session.seqByStream.get(message.streamId) ?? 0;
        session.seqByStream.set(message.streamId, current + 1);
        return current;
      },
      false,
    );
    while (!source.done) {
      const plaintext = encodeMuxFrame(source.nextFrame());
      session.ledger.append(plaintext);
      await this.sealAndDeliver(session, plaintext);
    }
  }

  private async sealAndDeliver(
    session: HostSession,
    plaintext: Uint8Array,
  ): Promise<void> {
    if (session.noise === null) {
      throw new Error("no established noise session");
    }
    const bytes = await session.noise.encrypt(plaintext, EMPTY_AD);
    const leg = session.leg;
    if (session.hostAway || leg === null || leg.closed) {
      return;
    }
    leg.onmessage?.({ type: "binary", data: bytes });
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
  readonly reportDialRefusal: Mock<RemoteSessionEvidence["reportDialRefusal"]>;
  readonly reportDialIndeterminate: Mock<
    RemoteSessionEvidence["reportDialIndeterminate"]
  >;
  /** `relay.legs.length` when each refusal was reported. */
  readonly legsAtRefusal: number[];
}

function buildEvidence(relay: FakeRelay): EvidenceSpies {
  const legsAtRefusal: number[] = [];
  const sessionEstablished =
    vi.fn<RemoteSessionEvidence["sessionEstablished"]>();
  const sessionLost = vi.fn<RemoteSessionEvidence["sessionLost"]>();
  const reportDialSuccess = vi.fn<RemoteSessionEvidence["reportDialSuccess"]>();
  const reportDialRefusal = vi.fn<RemoteSessionEvidence["reportDialRefusal"]>(
    () => {
      legsAtRefusal.push(relay.legs.length);
    },
  );
  const reportDialIndeterminate =
    vi.fn<RemoteSessionEvidence["reportDialIndeterminate"]>();
  return {
    evidence: {
      sessionEstablished,
      sessionLost,
      reportDialSuccess,
      reportDialRefusal,
      reportDialIndeterminate,
      reportRestartIntent:
        vi.fn<RemoteSessionEvidence["reportRestartIntent"]>(),
    },
    sessionEstablished,
    sessionLost,
    reportDialSuccess,
    reportDialRefusal,
    reportDialIndeterminate,
    legsAtRefusal,
  };
}

function hostAuth(revalidate: FixtureConfig["revalidate"]): RemoteSessionAuth {
  return {
    missingOpenAuthCause: "missing-host-credential",
    readOpenAuth: () => ({
      bearer: "relink-bearer",
      authz: null,
      fingerprint: "relink-bearer",
    }),
    readCredentialUpdateBearer: () => "relink-bearer",
    currentFingerprint: () => "relink-bearer",
    revalidateForReconnect: revalidate,
  };
}

type Session = RemoteSession<VersionedRpcRegistry, VersionedStreamRpcRegistry>;

interface StatusEvent {
  readonly status: StreamConnectionStatus;
  readonly continuity: StreamContinuity;
}

const HELD: StatusEvent = { status: "reconnecting", continuity: "held" };
const CONTINUED: StatusEvent = { status: "open", continuity: "continued" };
const REBUILDING: StatusEvent = { status: "reconnecting", continuity: null };
const OPENED: StatusEvent = { status: "open", continuity: null };

interface Fixture {
  readonly relay: FakeRelay;
  readonly session: Session;
  readonly spies: EvidenceSpies;
  readonly grants: Mock<AttachGrantProvider>;
  readonly stream: IStreamSession;
  /** `n` of every tick the subscription received, in delivery order. */
  readonly ticks: number[];
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

interface FixtureConfig {
  readonly issueKeys: boolean;
  /** The credential revalidation an UNAUTHORIZED session fatal runs, or none. */
  readonly revalidate: (() => Promise<RemoteSessionAuthRecoveryOutcome>) | null;
}

async function readyFixture(config: FixtureConfig): Promise<Fixture> {
  const relay = new FakeRelay();
  relay.issueKeys = config.issueKeys;
  const spies = buildEvidence(relay);
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
    hostStaticPublicKey: relay.publicKey,
    grantProvider: grants,
    auth: hostAuth(config.revalidate),
    clock: null,
    rpcRegistry,
    streamRegistry,
    webSocketFactory: relay.factory,
    requestId: () => `relink-req-${(nextRequestId += 1)}`,
    evidence: spies.evidence,
    onNegotiatedMethods: null,
    servedStreamMajors: {},
    unaryResponseMs: 30_000,
    clientIdentity: {
      kind: "desktop",
      compatibilityEpoch: CURRENT_CLIENT_COMPATIBILITY_EPOCH,
      appVersion: "0.0.0-test",
    },
    livenessProbe: null,
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
  await until(() => ticks.length === 1);
  stream.onStatusChange((status, _reason, _retryCause, continuity) => {
    statuses.push({ status, continuity });
  });
  const readinessLost = vi.fn<() => void>();
  const recovered = vi.fn<() => void>();
  session.subscribeReadinessLost(readinessLost);
  session.subscribeAvailabilityRecovered(recovered);
  return {
    relay,
    session,
    spies,
    grants,
    stream,
    ticks,
    statuses,
    readinessLost,
    recovered,
  };
}

const LIVE: FixtureConfig = { issueKeys: true, revalidate: null };

function callStatus(session: Session): Promise<unknown> {
  return session.sendUnary(
    STATUS_METHOD,
    {},
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

/** `sid:key` of the session a fixture's host currently holds. */
function claimOf(session: HostSession): string {
  return `${session.sid}:${session.key}`;
}

/** The resumed session is back: same relay session, one RESUME answered. */
async function untilResumed(fixture: Fixture, resumes: number): Promise<void> {
  await advanceUntil(() => fixture.relay.resumes.length === resumes, 30_000);
  await until(() => fixture.session.isReady());
  await fixture.relay.host().queue;
  await realDelay(20);
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

/** Moves the fake clock in five-minute strokes; host traffic keeps the standing watchdog fed. */
async function advanceFeedingHost(
  relay: FakeRelay,
  totalMs: number,
): Promise<void> {
  const stroke = 5 * 60_000;
  for (let elapsed = 0; elapsed < totalMs; elapsed += stroke) {
    await vi.advanceTimersByTimeAsync(Math.min(stroke, totalMs - elapsed));
    await relay.tick(1_000 + elapsed);
    await realDelay(20);
  }
}

/** Runs the standing re-auth loop to its mint and holds that mint outstanding. */
async function holdReauthMint(
  fixture: Fixture,
): Promise<Deferred<AttachGrantProvision>> {
  const { relay, grants } = fixture;
  const mint = deferred<AttachGrantProvision>();
  grants.mockImplementationOnce(() => mint.promise);
  await advanceFeedingHost(
    relay,
    CLIENT_REAUTH_INTERVAL_MS + CLIENT_REAUTH_JITTER_MS,
  );
  expect(grants).toHaveBeenCalledTimes(2);
  return mint;
}

interface HeldDecrypt {
  readonly spy: MockInstance<NoiseChannel["decrypt"]>;
  /** The held frame decodes as it would have. */
  release(): void;
  /** The held frame fails to decode. */
  fail(error: Error): void;
}

/** Holds the client's next inbound decrypt until the test lets it go. */
function holdNextDecrypt(): HeldDecrypt {
  const gate = deferred<void>();
  const spy = vi
    .spyOn(NoiseChannel.prototype, "decrypt")
    .mockImplementationOnce(async function (
      this: NoiseChannel,
      frame: Uint8Array,
    ) {
      await gate.promise;
      return this.decrypt(frame);
    });
  return {
    spy,
    release: () => gate.resolve(undefined),
    fail: (error) => gate.reject(error),
  };
}

const OK_GRANT: AttachGrantProvision = {
  kind: "ok",
  grant: { grant: "late-grant-jws", expiresInSeconds: 300 },
};

describe("RemoteSession relink on an own-leg loss", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    capturedLegs.handlers.length = 0;
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

  describe("entry paths keep the session and claim it back", () => {
    interface EntryPath {
      readonly name: string;
      readonly trigger: (fixture: Fixture) => Promise<void>;
      /** The code the client closed the old leg with, or null if it did not. */
      readonly closedWith: number | null;
      readonly prev: string;
    }

    const paths: EntryPath[] = [
      {
        name: "a socket close",
        trigger: (fixture) => {
          fixture.relay.dropLeg(1006, "net");
          return Promise.resolve();
        },
        closedWith: null,
        prev: "1006:net",
      },
      {
        name: "a relay close whose reason is outside the old mirror",
        trigger: (fixture) => {
          fixture.relay.dropLeg(1012, "Session Superseded!");
          return Promise.resolve();
        },
        closedWith: null,
        prev: "1012:session-superseded",
      },
      {
        name: "a socket error",
        trigger: (fixture) => {
          fixture.relay.currentLeg().onerror?.({ message: "boom" });
          return Promise.resolve();
        },
        closedWith: 4005,
        prev: "4005:relay-socket-error",
      },
      {
        name: "the relay socket failing on missed pongs",
        trigger: async (fixture) => {
          fixture.relay.answerPings = false;
          await advanceUntil(() => fixture.relay.legs.length >= 2, 180_000);
        },
        closedWith: 4004,
        prev: "4004:relay-missed-pongs",
      },
      {
        name: "forceReconnect",
        trigger: (fixture) => {
          fixture.session.forceReconnect("test");
          return Promise.resolve();
        },
        closedWith: RELINK_CLOSE_CODE,
        prev: "4007:relay-relink",
      },
      {
        name: "requestSessionReconnect",
        trigger: (fixture) => {
          fixture.session.requestSessionReconnect("test");
          return Promise.resolve();
        },
        closedWith: RELINK_CLOSE_CODE,
        prev: "4007:relay-relink",
      },
      {
        name: "a failed send",
        trigger: async (fixture) => {
          fixture.relay.currentLeg().failSends = true;
          void callStatus(fixture.session).catch(() => undefined);
          await vi.advanceTimersByTimeAsync(0);
        },
        closedWith: RELINK_CLOSE_CODE,
        prev: "4007:relay-relink",
      },
    ];

    it.each(paths)(
      "$name",
      async ({ trigger, closedWith, prev }) => {
        const fixture = await readyFixture(LIVE);
        const { relay, session } = fixture;
        const first = relay.legs[0];
        const held = relay.host();
        expect(first?.params.get("park")).toBe("1");
        expect(first?.params.has("resume")).toBe(false);
        expect(first?.params.has("prev")).toBe(false);

        await trigger(fixture);
        await advanceUntil(() => relay.legs.length === 2, 30_000);
        await untilResumed(fixture, 1);

        const claim = relay.legs[1];
        expect(claim?.claim).toBe(claimOf(held));
        expect(claim?.params.get("park")).toBe("1");
        expect(claim?.params.get("prev")).toBe(prev);
        const codes = first?.closes.map((close) => close.code) ?? [];
        expect(codes).not.toContain(1000);
        if (closedWith === null) {
          expect(codes).toEqual([]);
        } else {
          expect(codes).toContain(closedWith);
        }
        expect(relay.handshakes).toBe(1);
        expect(relay.sessions).toHaveLength(1);
        expect(relay.subscribedStreams).toHaveLength(1);
        await relay.tick(1);
        await until(() => fixture.ticks.length >= 2);
        expect(fixture.ticks.slice(0, 2)).toEqual([0, 1]);
        expect(session.isReady()).toBe(true);
      },
      240_000,
    );
  });

  describe("the claim is answered with the same session id", () => {
    it("resolves an in-flight unary and keeps a held-open stream's frame order, numbering attempts per session across legs", async () => {
      const fixture = await readyFixture(LIVE);
      const { relay, session } = fixture;
      // A host-leg exchange first: attempt 1.
      relay.hostDetach();
      await step(500);
      relay.hostAttach();
      await untilResumed(fixture, 1);

      relay.holdUnary = true;
      const call = track(callStatus(session));
      await until(() => relay.pendingRequests.length === 1);
      relay.dropLeg(1006, "net");
      await relay.tick(1);
      const [request] = relay.pendingRequests;
      if (request === undefined) {
        throw new Error("the unary never reached the host");
      }
      await relay.respondTo(request);

      await advanceUntil(() => relay.legs.length === 2, 30_000);
      await untilResumed(fixture, 2);
      await until(() => call.settled && fixture.ticks.length === 2);
      await relay.tick(2);
      await until(() => fixture.ticks.length === 3);

      expect(call.value).toEqual({ ready: true });
      expect(fixture.ticks).toEqual([0, 1, 2]);
      expect(relay.resumes.map((resume) => resume.attempt)).toEqual([1, 2]);
      expect(relay.handshakes).toBe(1);
      expect(relay.subscribedStreams).toHaveLength(1);
      expect(fixture.statuses).toEqual([]);
      expect(session.isReady()).toBe(true);
    });
  });

  describe("the claim is answered with a different session id", () => {
    it("rebuilds on the leg it just opened: one extra socket, one extra grant, a handshake there, never closed", async () => {
      const fixture = await readyFixture(LIVE);
      const { relay, session, grants } = fixture;
      relay.holdUnary = true;
      const call = track(callStatus(session));
      await until(() => relay.pendingRequests.length === 1);
      expect(grants).toHaveBeenCalledTimes(1);

      relay.expireRows = true;
      relay.dropLeg(1006, "net");
      await advanceUntil(() => relay.handshakes === 2, 30_000);
      await until(() => fixture.ticks.length === 2);
      await until(() => session.isReady());

      expect(relay.legs).toHaveLength(2);
      expect(grants).toHaveBeenCalledTimes(2);
      expect(relay.sessions).toHaveLength(2);
      expect(relay.legs[1]?.session).toBe(relay.host());
      expect(relay.legs[1]?.closes).toEqual([]);
      expect(call.settled).toBe(true);
      expect(call.error).toBeInstanceOf(HostTransportFailureError);
      expect(fixture.statuses).toEqual([REBUILDING, OPENED]);
      expect(relay.subscribedStreams).toHaveLength(2);
      expect(relay.resumes).toEqual([]);
    });

    it("takes control frames that arrive while the Noise channel is begun after the ack, in order", async () => {
      const fixture = await readyFixture(LIVE);
      const { relay, spies } = fixture;
      relay.expireRows = true;
      relay.onFreshAck = (leg) => {
        leg.deliverControl("host_detached");
        leg.closed = true;
        relay.onLegClosed(leg, 1006);
        leg.onclose?.({ code: 1006, reason: "gone", wasClean: false });
      };

      relay.dropLeg(1006, "net");
      await advanceUntil(() => relay.legs.length >= 3, 30_000);

      // The detach took effect (a no-host refusal) before the close redialled.
      const refusalIds = spies.reportDialRefusal.mock.calls.map(
        ([, attemptId]) => attemptId,
      );
      const noHost = refusalIds.findIndex((id) => /-no-host-\d+$/.test(id));
      expect(noHost).toBeGreaterThanOrEqual(0);
      expect(spies.legsAtRefusal[noHost]).toBe(2);
      // The close took effect too: a full attach, not a claim.
      expect(relay.legs[2]?.params.has("resume")).toBe(false);
      expect(relay.legs[2]?.params.get("park")).toBe("1");
    });

    it("closes the adopted socket and runs nothing when the session is closed while the Noise channel is begun", async () => {
      const fixture = await readyFixture(LIVE);
      const { relay, session } = fixture;
      relay.expireRows = true;
      relay.onFreshAck = () => {
        session.close();
      };

      relay.dropLeg(1006, "net");
      await advanceUntil(() => relay.legs.length >= 2, 30_000);
      await until(() => relay.legs[1]?.closed === true);
      await step(60_000);

      expect(relay.legs).toHaveLength(2);
      expect(relay.handshakes).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("a claim that is never answered", () => {
    it("claims again with the same key after a lost ack, closing the abandoned leg 4007, and ignores host data on it", async () => {
      const fixture = await readyFixture(LIVE);
      const { relay } = fixture;
      const held = relay.host();
      relay.plan = ["swallow"];

      relay.dropLeg(1006, "net");
      await advanceUntil(() => relay.legs.length === 2, 5_000);
      // The relay bound the claim leg: host data flows to it before any ack.
      await relay.tick(99);
      await step(500);
      expect(fixture.ticks).toEqual([0]);

      await advanceUntil(
        () => relay.legs.length === 3,
        ATTACH_ACK_TIMEOUT_MS + 5_000,
      );
      await untilResumed(fixture, 1);
      await until(() => fixture.ticks.length === 2);

      expect(relay.legs[1]?.closes.map((close) => close.code)).toEqual([
        RELINK_CLOSE_CODE,
      ]);
      expect(relay.legs[1]?.claim).toBe(claimOf(held));
      expect(relay.legs[2]?.claim).toBe(claimOf(held));
      expect(fixture.ticks).toEqual([0, 99]);
      expect(relay.handshakes).toBe(1);
    });

    it("claims again with the same key after a dial that never opens", async () => {
      const fixture = await readyFixture(LIVE);
      const { relay } = fixture;
      const held = relay.host();
      relay.plan = ["never-open"];

      relay.dropLeg(1006, "net");
      await advanceUntil(() => relay.legs.length === 2, 5_000);
      await advanceUntil(
        () => relay.legs.length === 3,
        RELAY_DIAL_TIMEOUT_MS + 5_000,
      );
      await untilResumed(fixture, 1);

      expect(relay.legs[1]?.closes.map((close) => close.code)).toEqual([4000]);
      expect(relay.legs[2]?.claim).toBe(claimOf(held));
      expect(relay.handshakes).toBe(1);
    });

    it("walks the ladder on failed dials: the first redial at once, the next on the first rung, claiming each time", async () => {
      const fixture = await readyFixture(LIVE);
      const { relay } = fixture;
      const held = relay.host();
      relay.plan = ["refuse", "refuse"];

      const lostAt = Date.now();
      relay.dropLeg(1006, "net");
      await step(0);
      expect(relay.legs).toHaveLength(2);
      expect(relay.dialTimes[1]).toBe(lostAt);

      await step(300);
      expect(relay.legs).toHaveLength(2);
      await advanceUntil(() => relay.legs.length === 3, 3_000);
      const firstRung = (relay.dialTimes[2] ?? 0) - lostAt;
      expect(firstRung).toBeGreaterThanOrEqual(400);
      expect(firstRung).toBeLessThanOrEqual(1_100);
      await advanceUntil(() => relay.legs.length === 4, 5_000);
      const secondGap = (relay.dialTimes[3] ?? 0) - (relay.dialTimes[2] ?? 0);
      expect(secondGap).toBeGreaterThan(firstRung - 500);
      expect(secondGap).toBeLessThanOrEqual(2_100);

      await untilResumed(fixture, 1);
      for (const leg of relay.legs.slice(1)) {
        expect(leg.claim).toBe(claimOf(held));
      }
    });
  });

  describe("readiness and streams across the outage", () => {
    it("takes the resumed edge from down: held, then continued, with fresh ids", async () => {
      const fixture = await readyFixture(LIVE);
      const { relay, session, spies } = fixture;
      const [firstSession] = spies.sessionEstablished.mock.calls;
      const [firstAttempt] = spies.reportDialSuccess.mock.calls;
      relay.plan = ["swallow"];

      relay.dropLeg(1006, "net");
      await step(RESUME_MASK_MS);
      expect(session.isReady()).toBe(false);
      expect(spies.sessionLost).toHaveBeenCalledTimes(1);
      expect(fixture.statuses).toEqual([HELD]);

      await untilResumed(fixture, 1);

      expect(fixture.statuses).toEqual([HELD, CONTINUED]);
      expect(spies.sessionEstablished).toHaveBeenCalledTimes(2);
      expect(spies.sessionEstablished.mock.calls[1]?.[1]).not.toBe(
        firstSession?.[1],
      );
      expect(spies.reportDialSuccess).toHaveBeenCalledTimes(2);
      expect(spies.reportDialSuccess.mock.calls[1]?.[1]).not.toBe(
        firstAttempt?.[1],
      );
      expect(fixture.recovered).toHaveBeenCalledTimes(1);
      expect(relay.handshakes).toBe(1);
    });

    it("keeps the original mask deadline when the own leg goes during the mask", async () => {
      const fixture = await readyFixture(LIVE);
      const { relay, session, spies } = fixture;

      relay.hostDetach();
      await step(2_000);
      relay.plan = ["swallow"];
      relay.dropLeg(1006, "net");
      await step(RESUME_MASK_MS - 2_000 - 1);
      expect(session.isReady()).toBe(true);
      expect(spies.sessionLost).not.toHaveBeenCalled();
      expect(fixture.statuses).toEqual([]);

      await step(1);
      expect(session.isReady()).toBe(false);
      expect(spies.sessionLost).toHaveBeenCalledTimes(1);
      expect(fixture.statuses).toEqual([HELD]);
    });

    it("keeps streams held past the hold while a claim is outstanding, and continues them on a same-session ack", async () => {
      const fixture = await readyFixture(LIVE);
      const { relay } = fixture;
      // The host-leg hold runs from this detach, and the own leg then drops.
      relay.hostDetach();
      await step(1_000);
      relay.swallowAcks = true;

      relay.dropLeg(1006, "net");
      for (
        let elapsed = 0;
        elapsed <= RESUME_HOLD_MS + 1_000;
        elapsed += 1_000
      ) {
        await step(1_000);
      }
      expect(fixture.statuses).toEqual([HELD]);

      // The host came back without this client hearing of it.
      relay.host().hostAway = false;
      relay.swallowAcks = false;
      await untilResumed(fixture, 1);

      expect(fixture.statuses).toEqual([HELD, CONTINUED]);
      expect(relay.handshakes).toBe(1);
    });

    it("turns streams reconnecting past the hold only from the rebuild when the claim is answered with a fresh session", async () => {
      const fixture = await readyFixture(LIVE);
      const { relay } = fixture;
      // The host-leg hold runs from this detach, and the own leg then drops.
      relay.hostDetach();
      await step(1_000);
      relay.swallowAcks = true;

      relay.dropLeg(1006, "net");
      for (
        let elapsed = 0;
        elapsed <= RESUME_HOLD_MS + 1_000;
        elapsed += 1_000
      ) {
        await step(1_000);
      }
      expect(fixture.statuses).toEqual([HELD]);

      // The host came back without this client hearing of it.
      relay.host().hostAway = false;
      relay.swallowAcks = false;
      relay.expireRows = true;
      await advanceUntil(() => relay.handshakes === 2, 60_000);
      await until(() => fixture.ticks.length === 2);

      expect(fixture.statuses).toEqual([HELD, REBUILDING, OPENED]);
    });

    it("claims an own-leg loss that comes after the host-leg hold has passed", async () => {
      const fixture = await readyFixture(LIVE);
      const { relay } = fixture;
      const held = relay.host();

      relay.hostDetach();
      await step(RESUME_HOLD_MS + 1_000);
      expect(fixture.statuses).toEqual([HELD, REBUILDING]);
      // The host is back on the relay without this client hearing of it, then
      // its own leg drops: a claim, whatever the hold says.
      relay.host().hostAway = false;
      relay.dropLeg(1006, "net");
      await advanceUntil(() => relay.legs.length === 2, 30_000);
      await untilResumed(fixture, 1);

      expect(relay.legs[1]?.claim).toBe(claimOf(held));
      expect(relay.handshakes).toBe(1);
      await relay.tick(1);
      await until(() => fixture.ticks.length === 2);
      expect(fixture.statuses.at(-1)).toEqual(OPENED);
    });

    it("still retracts at the mask expiry for a relay that never answers, and keeps reporting distinct refusals", async () => {
      const fixture = await readyFixture(LIVE);
      const { relay, session, spies } = fixture;
      relay.swallowAcks = true;

      relay.dropLeg(1006, "net");
      await step(RESUME_MASK_MS - 1);
      expect(spies.sessionLost).not.toHaveBeenCalled();
      expect(session.isReady()).toBe(true);
      await step(1);
      expect(spies.sessionLost).toHaveBeenCalledTimes(1);
      expect(session.isReady()).toBe(false);

      for (let elapsed = 0; elapsed < 120_000; elapsed += 1_000) {
        await step(1_000);
      }
      const attempts = spies.reportDialRefusal.mock.calls.map(
        ([, attemptId]) => attemptId,
      );
      expect(attempts.length).toBeGreaterThanOrEqual(3);
      expect(new Set(attempts).size).toBe(attempts.length);
      expect(spies.sessionLost).toHaveBeenCalledTimes(1);
    });
  });

  describe("the wake path", () => {
    it("rebuilds as in the different-session case when a long background finds the row expired (asserted through forceReconnect: wakeHeldRemoteSessions is not reachable from protocol/)", async () => {
      const fixture = await readyFixture(LIVE);
      const { relay, session } = fixture;
      relay.expireRows = true;

      session.forceReconnect("wake:long-background");
      await advanceUntil(() => relay.handshakes === 2, 30_000);
      await until(() => fixture.ticks.length === 2);

      expect(relay.legs).toHaveLength(2);
      expect(relay.legs[1]?.claim).not.toBeNull();
      expect(fixture.statuses).toEqual([REBUILDING, OPENED]);
      expect(relay.resumes).toEqual([]);
    });
  });

  describe("an older relay that issues no key", () => {
    it("rebuilds as today on an own-leg loss: a full attach, 1000 on the client-closed leg, no claim", async () => {
      const fixture = await readyFixture({ ...LIVE, issueKeys: false });
      const { relay, session } = fixture;
      expect(relay.legs[0]?.params.get("park")).toBe("1");
      expect(relay.legs[0]?.params.has("resume")).toBe(false);

      session.forceReconnect("test");
      await advanceUntil(() => relay.handshakes === 2, 30_000);
      await until(() => fixture.ticks.length === 2);

      expect(relay.legs[0]?.closes.map((close) => close.code)).toContain(1000);
      expect(relay.legs[1]?.params.has("resume")).toBe(false);
      expect(relay.legs[1]?.params.get("park")).toBe("1");
      expect(relay.resumes).toEqual([]);
    });
  });

  describe("leg identity", () => {
    it("ignores every late event from a superseded leg", async () => {
      const fixture = await readyFixture(LIVE);
      const { relay, session } = fixture;
      relay.dropLeg(1006, "net");
      await advanceUntil(() => relay.legs.length === 2, 30_000);
      await untilResumed(fixture, 1);
      const old = capturedLegs.handlers[0];
      if (old === undefined) {
        throw new Error("the first leg's handlers were not captured");
      }

      old.onClose({ code: 1006, reason: "late" });
      old.onData(new Uint8Array([1, 2, 3, 4]));
      old.onHostDetached();
      old.onPeerGone("killed");
      old.onAttachAck(relay.host().sid, "late-key");
      await step(RESUME_MASK_MS + 1_000);

      expect(relay.legs).toHaveLength(2);
      expect(session.isReady()).toBe(true);
      expect(fixture.statuses).toEqual([]);
      expect(fixture.readinessLost).not.toHaveBeenCalled();
      // The late bytes were not counted: the next exchange states the real count.
      relay.hostAttach();
      await untilResumed(fixture, 2);
      expect(relay.resumes[1]?.received).toBe(relay.host().ledger.sent);
    });
  });

  describe("a frame still sealing when the leg goes", () => {
    it("is not sent by the sealing path on either leg and reaches the host once through the gap", async () => {
      const fixture = await readyFixture(LIVE);
      const { relay, session } = fixture;

      const call = track(callStatus(session));
      relay.dropLeg(1006, "net");
      await advanceUntil(() => relay.legs.length === 2, 30_000);
      await untilResumed(fixture, 1);
      await until(() => call.settled);

      expect(call.value).toEqual({ ready: true });
      expect(relay.requestStreamIds).toHaveLength(1);
      expect(
        relay.clientFrames
          .filter((frame) => frame.leg === 1)
          .map((frame) => frame.type),
      ).toEqual([MuxFrameType.RESUME, MuxFrameType.REQUEST]);
      expect(relay.handshakes).toBe(1);
    });
  });

  describe("a claim dial's late completions", () => {
    /**
     * Claim mint #1 is outstanding after `forceReconnect` when an old inbound
     * frame, a retryable host FATAL whose decrypt was held, goes through. That
     * is a failure of the session itself: it ends the relink and rebuilds, and
     * the dial goes with the connection it was made for. (No leg-plane loss can
     * reach a dial whose mint is outstanding: the old leg is closed and its
     * handlers detached, and no claim socket exists until the mint is done.)
     * Returns the controls and the legs dialled by then.
     */
    async function rebuildDuringFirstClaimMint(fixture: Fixture): Promise<{
      readonly mint1: Deferred<AttachGrantProvision>;
      readonly legsAtRebuild: number;
    }> {
      const { relay, session, grants } = fixture;
      const held = holdNextDecrypt();
      await relay.sendSessionFatal("INTERNAL_ERROR", true);
      await until(() => held.spy.mock.calls.length === 1);
      const mint1 = deferred<AttachGrantProvision>();
      grants.mockImplementationOnce(() => mint1.promise);

      session.forceReconnect("test");
      await step(0);
      expect(grants).toHaveBeenCalledTimes(2);

      held.release();
      await step(0);
      expect(relay.resumes).toEqual([]);
      return { mint1, legsAtRebuild: relay.legs.length };
    }

    /** The rebuild finishes: a second handshake, and no leg ever claims again. */
    async function untilRebuilt(fixture: Fixture): Promise<void> {
      const { relay, session } = fixture;
      await advanceUntil(() => relay.handshakes === 2, 30_000);
      await until(() => session.isReady());
      for (const leg of relay.legs.slice(1)) {
        expect(leg.claim).toBeNull();
      }
      expect(relay.sessions).toHaveLength(2);
    }

    it("ignores a retired mint that completes ok before the rebuild dials: no claim leg, and the session rebuilds", async () => {
      const fixture = await readyFixture(LIVE);
      const { relay } = fixture;
      const { mint1, legsAtRebuild } =
        await rebuildDuringFirstClaimMint(fixture);

      mint1.resolve(OK_GRANT);
      await step(0);
      expect(relay.legs).toHaveLength(legsAtRebuild);

      await untilRebuilt(fixture);
      expect(relay.legs).toHaveLength(2);
    });

    it("ignores a retired mint that completes ok after the rebuild: no extra socket", async () => {
      const fixture = await readyFixture(LIVE);
      const { relay } = fixture;
      const { mint1 } = await rebuildDuringFirstClaimMint(fixture);
      await untilRebuilt(fixture);

      mint1.resolve(OK_GRANT);
      await step(30_000);

      expect(relay.legs).toHaveLength(2);
      expect(fixture.session.isReady()).toBe(true);
    });

    it("ignores a retired mint that completes unavailable: no new backoff, no evidence", async () => {
      const fixture = await readyFixture(LIVE);
      const { relay, spies } = fixture;
      const { mint1 } = await rebuildDuringFirstClaimMint(fixture);
      await untilRebuilt(fixture);
      const indeterminate = spies.reportDialIndeterminate.mock.calls.length;

      mint1.resolve({
        kind: "unavailable",
        detail: "authn down",
        context: "x",
      });
      await step(60_000);

      expect(relay.legs).toHaveLength(2);
      expect(relay.handshakes).toBe(2);
      expect(fixture.session.isReady()).toBe(true);
      expect(spies.reportDialIndeterminate.mock.calls).toHaveLength(
        indeterminate,
      );
    });

    it("ignores a retired mint that rejects: the rebuilt session and its leg are untouched", async () => {
      const fixture = await readyFixture(LIVE);
      const { relay } = fixture;
      const { mint1 } = await rebuildDuringFirstClaimMint(fixture);
      await untilRebuilt(fixture);

      mint1.reject(new Error("the mint failed late"));
      await step(60_000);

      expect(relay.legs).toHaveLength(2);
      expect(relay.legs[1]?.closes).toEqual([]);
      expect(relay.handshakes).toBe(2);
      expect(fixture.session.isReady()).toBe(true);
    });

    it("ignores a retired mint that is refused: the session does not go terminal", async () => {
      const fixture = await readyFixture(LIVE);
      const { relay, session } = fixture;
      const { mint1 } = await rebuildDuringFirstClaimMint(fixture);
      await untilRebuilt(fixture);

      mint1.resolve({
        kind: "refused",
        detail: "frozen",
        context: "x",
        fatal: {
          code: "UNAUTHORIZED",
          reason: "late verdict",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      });
      await step(1_000);

      expect(session.isClosed()).toBe(false);
      expect(session.terminalFatal()).toBeNull();
      expect(session.isReady()).toBe(true);
      expect(relay.legs).toHaveLength(2);
    });

    it("walks the ladder and claims again with the same key when the live claim mint rejects", async () => {
      const fixture = await readyFixture(LIVE);
      const { relay, grants, session } = fixture;
      const held = relay.host();
      const mint = deferred<AttachGrantProvision>();
      grants.mockImplementationOnce(() => mint.promise);

      session.forceReconnect("test");
      await step(0);
      expect(grants).toHaveBeenCalledTimes(2);
      mint.reject(new Error("authn unreachable"));
      await step(0);
      await advanceUntil(() => grants.mock.calls.length === 3, 5_000);
      await untilResumed(fixture, 1);

      expect(relay.legs).toHaveLength(2);
      expect(relay.legs[1]?.claim).toBe(claimOf(held));
      expect(relay.handshakes).toBe(1);
      expect(relay.sessions).toHaveLength(1);
    });
  });

  describe("completions that land after their leg went", () => {
    it("does not let a frame that finishes sealing after the leg went disturb the claim under way", async () => {
      const fixture = await readyFixture(LIVE);
      const { relay, session, grants, stream } = fixture;
      const sealed = deferred<Uint8Array>();
      const encryptSpy = vi
        .spyOn(NoiseChannel.prototype, "encrypt")
        .mockImplementationOnce(() => sealed.promise);
      const mint1 = deferred<AttachGrantProvision>();
      grants.mockImplementationOnce(() => mint1.promise);
      stream.sendClientFrame({ kind: "noop", hasBinaryPayload: false }, null);
      await step(0);
      expect(encryptSpy).toHaveBeenCalledTimes(1);

      session.forceReconnect("test");
      await step(0);
      expect(grants).toHaveBeenCalledTimes(2);
      sealed.resolve(new Uint8Array([1, 2, 3]));
      await step(5_000);

      // Mint #1 is still the only claim dial: nothing restarted it.
      expect(grants).toHaveBeenCalledTimes(2);
      expect(relay.legs).toHaveLength(1);
      mint1.resolve(OK_GRANT);
      await untilResumed(fixture, 1);
      expect(relay.legs).toHaveLength(2);
    });

    it("does not let a write that fails after the leg went disturb the claim under way", async () => {
      const fixture = await readyFixture(LIVE);
      const { relay, session, grants, stream } = fixture;
      const sealed = deferred<Uint8Array>();
      vi.spyOn(NoiseChannel.prototype, "encrypt").mockImplementationOnce(
        () => sealed.promise,
      );
      const mint1 = deferred<AttachGrantProvision>();
      grants.mockImplementationOnce(() => mint1.promise);
      stream.sendClientFrame({ kind: "noop", hasBinaryPayload: false }, null);
      await step(0);

      session.forceReconnect("test");
      await step(0);
      expect(grants).toHaveBeenCalledTimes(2);
      sealed.reject(new Error("the seal failed"));
      await step(5_000);

      expect(grants).toHaveBeenCalledTimes(2);
      expect(relay.legs).toHaveLength(1);
      mint1.resolve(OK_GRANT);
      await untilResumed(fixture, 1);
      expect(session.isReady()).toBe(true);
    });

    it("does not let a RESUME that fails to seal after its exchange was cancelled rebuild the session", async () => {
      const fixture = await readyFixture(LIVE);
      const { relay, session } = fixture;
      const sealed = deferred<Uint8Array>();
      const encryptSpy = vi
        .spyOn(NoiseChannel.prototype, "encrypt")
        .mockImplementationOnce(() => sealed.promise);

      relay.hostAttach();
      await until(() => encryptSpy.mock.calls.length === 1);
      relay.hostDetach();
      sealed.reject(new Error("the seal failed"));
      await step(RESUME_MASK_MS - 1_000);

      expect(relay.legs).toHaveLength(1);
      expect(relay.handshakes).toBe(1);
      expect(session.isReady()).toBe(true);
    });

    it("does not let a Noise begin that fails after the session closed restart anything", async () => {
      const fixture = await readyFixture(LIVE);
      const { relay, session } = fixture;
      const begin = deferred<NoiseChannel>();
      vi.spyOn(NoiseChannel, "begin").mockImplementationOnce(
        () => begin.promise,
      );
      relay.expireRows = true;

      relay.dropLeg(1006, "net");
      await advanceUntil(() => relay.legs.length === 2, 30_000);
      await until(() => relay.legs[1]?.session !== null);
      await step(0);
      session.close();
      begin.reject(new Error("the key could not be imported"));
      await step(60_000);

      expect(relay.legs).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("does not re-present a grant on a leg whose ack is still outstanding when a re-auth mint completes", async () => {
      const fixture = await readyFixture(LIVE);
      const { relay, session } = fixture;
      const reauthMint = await holdReauthMint(fixture);

      relay.swallowAcks = true;
      session.forceReconnect("test");
      await advanceUntil(() => relay.legs.length === 2, 5_000);
      reauthMint.resolve(OK_GRANT);
      await step(1_000);

      expect(relay.legs[1]?.textSends).toEqual([]);
    });
  });

  describe("completions that land after the new leg's same-session ack", () => {
    it("lets a write on the old leg fail without rebuilding: the frame goes through the gap, once", async () => {
      const fixture = await readyFixture(LIVE);
      const { relay, session, stream } = fixture;
      relay.holdUnary = true;
      const call = track(callStatus(session));
      await until(() => relay.pendingRequests.length === 1);
      const sealed = deferred<Uint8Array>();
      const encryptSpy = vi
        .spyOn(NoiseChannel.prototype, "encrypt")
        .mockImplementationOnce(() => sealed.promise);
      stream.sendClientFrame({ kind: "noop", hasBinaryPayload: false }, null);
      await step(0);
      expect(encryptSpy).toHaveBeenCalledTimes(1);
      const framesBefore = relay.clientFrames.length;

      session.forceReconnect("test");
      await advanceUntil(() => relay.legs.length === 2, 5_000);
      // The ack is in; the exchange waits for the old leg's write to settle.
      await step(0);
      expect(relay.resumes).toHaveLength(0);
      sealed.reject(new Error("the old leg's seal failed"));
      await untilResumed(fixture, 1);

      expect(relay.legs).toHaveLength(2);
      expect(relay.legs[1]?.closes).toEqual([]);
      expect(relay.handshakes).toBe(1);
      expect(relay.sessions).toHaveLength(1);
      expect(session.isReady()).toBe(true);
      expect(
        relay.clientFrames
          .slice(framesBefore)
          .filter((frame) => frame.type === MuxFrameType.STREAM_FRAME),
      ).toEqual([{ leg: 1, type: MuxFrameType.STREAM_FRAME }]);
      const pending = relay.pendingRequests[0];
      if (pending === undefined) {
        throw new Error("the host never saw the call");
      }
      expect(call.settled).toBe(false);
      await relay.respondTo(pending);
      await until(() => call.settled);
      expect(call.value).toEqual({ ready: true });
    });

    it.each<{
      readonly name: string;
      readonly provision: AttachGrantProvision;
      readonly sentOnLate: number;
    }>([
      { name: "ok", provision: OK_GRANT, sentOnLate: 0 },
      {
        name: "unavailable",
        provision: { kind: "unavailable", detail: "authn down", context: "x" },
        sentOnLate: 0,
      },
    ])(
      "leaves the loop the ack installed alone when the old leg's re-auth mint completes $name",
      async ({ provision, sentOnLate }) => {
        const fixture = await readyFixture(LIVE);
        const { relay, session, grants } = fixture;
        const reauthMint = await holdReauthMint(fixture);

        session.forceReconnect("test");
        await untilResumed(fixture, 1);
        const resumedAt = Date.now();
        const claimLeg = relay.legs[1];
        expect(claimLeg?.textSends).toEqual([]);

        // The ack's loop is 45 minutes out (plus or minus five); this
        // completion lands twenty minutes into it.
        await advanceFeedingHost(relay, 20 * 60_000);
        const timers = vi.getTimerCount();
        const mints = grants.mock.calls.length;
        reauthMint.resolve(provision);
        await step(0);

        expect(claimLeg?.textSends).toHaveLength(sentOnLate);
        expect(vi.getTimerCount()).toBe(timers);
        expect(grants).toHaveBeenCalledTimes(mints);

        // The loop fires once, on the schedule the ack gave it.
        await advanceFeedingHost(
          relay,
          resumedAt +
            CLIENT_REAUTH_INTERVAL_MS +
            CLIENT_REAUTH_JITTER_MS +
            60_000 -
            Date.now(),
        );
        expect(grants).toHaveBeenCalledTimes(mints + 1);
        expect(claimLeg?.textSends).toHaveLength(1);
        expect(relay.legs).toHaveLength(2);
      },
    );
  });

  describe("a failure of the session itself ends a relink", () => {
    /** Two ticks reach the client and wait in its decrypt: frames n and n+1. */
    async function holdTwoFrames(
      relay: FakeRelay,
    ): Promise<{ readonly n: HeldDecrypt; readonly next: HeldDecrypt }> {
      const n = holdNextDecrypt();
      const next = holdNextDecrypt();
      await relay.tick(5);
      await relay.tick(6);
      await until(() => n.spy.mock.calls.length === 2);
      return { n, next };
    }

    async function untilRebuilt(fixture: Fixture): Promise<void> {
      const { relay, session } = fixture;
      await advanceUntil(() => relay.handshakes === 2, 30_000);
      await until(() => session.isReady());
      await until(() => fixture.ticks.length === 2);
    }

    it("rebuilds when frame n fails to decrypt while relinking: no RESUME, and the frame behind it is never dispatched", async () => {
      const fixture = await readyFixture(LIVE);
      const { relay, session } = fixture;
      const { n, next } = await holdTwoFrames(relay);
      session.forceReconnect("test");
      await step(0);

      n.fail(new Error("frame n did not decode"));
      next.release();
      await untilRebuilt(fixture);

      // The one claim dial forceReconnect made, and then the rebuild's attach.
      expect(relay.resumes).toEqual([]);
      expect(fixture.ticks).toEqual([0, 0]);
      expect(relay.legs).toHaveLength(3);
      expect(relay.legs[2]?.claim).toBeNull();
      expect(relay.sessions).toHaveLength(2);
    });

    it("rebuilds when frame n fails to decrypt after a same-session ack: no frame behind it is dispatched", async () => {
      const fixture = await readyFixture(LIVE);
      const { relay, session } = fixture;
      const { n, next } = await holdTwoFrames(relay);
      session.forceReconnect("test");
      await advanceUntil(() => relay.legs.length === 2, 5_000);
      await step(0);

      n.fail(new Error("frame n did not decode"));
      next.release();
      await untilRebuilt(fixture);

      expect(relay.legs[1]?.closes.map((close) => close.code)).toEqual([1000]);
      expect(fixture.ticks).toEqual([0, 0]);
      expect(relay.legs[2]?.claim).toBeNull();
      expect(relay.sessions).toHaveLength(2);
    });

    it("rebuilds, not claims again, when a counted frame fails to decode while relinking", async () => {
      const fixture = await readyFixture(LIVE);
      const { relay, session } = fixture;
      const held = holdNextDecrypt();
      await relay.sendUndecodable();
      await until(() => held.spy.mock.calls.length === 1);
      session.forceReconnect("test");
      await step(0);

      held.release();
      await untilRebuilt(fixture);

      expect(relay.resumes).toEqual([]);
      expect(relay.legs).toHaveLength(3);
      expect(relay.legs[2]?.claim).toBeNull();
      expect(relay.sessions).toHaveLength(2);
    });

    it("rebuilds on a retryable FATAL while relinking: no claim dial follows", async () => {
      const fixture = await readyFixture(LIVE);
      const { relay, session, grants } = fixture;
      const held = holdNextDecrypt();
      await relay.sendSessionFatal("INTERNAL_ERROR", true);
      await until(() => held.spy.mock.calls.length === 1);
      const mint1 = deferred<AttachGrantProvision>();
      grants.mockImplementationOnce(() => mint1.promise);
      session.forceReconnect("test");
      await step(0);
      const legsBefore = relay.legs.length;

      held.release();
      await untilRebuilt(fixture);

      expect(relay.legs.length).toBeGreaterThan(legsBefore);
      for (const leg of relay.legs.slice(1)) {
        expect(leg.claim).toBeNull();
        expect(leg.url).not.toContain("resume=");
      }
      expect(relay.resumes).toEqual([]);
    });

    it("lets an UNAUTHORIZED FATAL while relinking cancel the claim dial waiting on its rung: the next dial follows the revalidation", async () => {
      const revalidation = deferred<RemoteSessionAuthRecoveryOutcome>();
      const revalidate = vi.fn(() => revalidation.promise);
      const fixture = await readyFixture({ ...LIVE, revalidate });
      const { relay, session, grants } = fixture;
      const held = holdNextDecrypt();
      await relay.sendSessionFatal("UNAUTHORIZED", false);
      await until(() => held.spy.mock.calls.length === 1);
      const mint1 = deferred<AttachGrantProvision>();
      grants.mockImplementationOnce(() => mint1.promise);
      session.forceReconnect("test");
      await step(0);
      mint1.reject(new Error("authn unreachable"));
      await step(0);
      // Dial #2 waits on its rung.
      expect(grants).toHaveBeenCalledTimes(2);

      held.release();
      await until(() => revalidate.mock.calls.length === 1);
      await step(3_000);

      // The rung passed and nothing dialled: the revalidation is still out.
      expect(grants).toHaveBeenCalledTimes(2);
      expect(relay.legs).toHaveLength(1);
      revalidation.resolve("rotated");
      await advanceUntil(() => relay.handshakes === 2, 30_000);
      await until(() => session.isReady());

      expect(relay.legs).toHaveLength(2);
      expect(relay.legs[1]?.claim).toBeNull();
      expect(relay.sessions).toHaveLength(2);
    });
  });

  describe("a real failure on the current leg", () => {
    it.each<{
      readonly name: string;
      readonly reason: string;
      readonly fail: (fixture: Fixture) => Promise<void>;
    }>([
      {
        name: "a write on it fails",
        reason: "write-failed",
        fail: async ({ relay, stream }) => {
          const sealed = deferred<Uint8Array>();
          vi.spyOn(NoiseChannel.prototype, "encrypt").mockImplementationOnce(
            () => sealed.promise,
          );
          stream.sendClientFrame(
            { kind: "noop", hasBinaryPayload: false },
            null,
          );
          await step(0);
          expect(relay.legs).toHaveLength(1);
          sealed.reject(new Error("the channel failed under the write"));
        },
      },
      {
        name: "an inbound decrypt on it rejects",
        reason: "inbound-decode-failed",
        fail: async ({ relay }) => {
          const held = holdNextDecrypt();
          await relay.tick(5);
          await until(() => held.spy.mock.calls.length === 1);
          held.fail(new Error("the frame did not decode"));
        },
      },
    ])("rebuilds the session when $name", async ({ fail, reason }) => {
      const fixture = await readyFixture(LIVE);
      const { relay, session } = fixture;

      await fail(fixture);
      await advanceUntil(() => relay.handshakes === 2, 30_000);
      await until(() => session.isReady());

      expect(relay.legs[0]?.closes).toEqual([{ code: 1000, reason }]);
      expect(relay.legs).toHaveLength(2);
      expect(relay.legs[1]?.claim).toBeNull();
      expect(relay.sessions).toHaveLength(2);
    });
  });

  describe("secrets", () => {
    it("never logs a resume key through a relink and a rebuild", async () => {
      const logged: string[] = [];
      for (const method of ["log", "info", "warn", "error", "debug"] as const) {
        vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          logged.push(args.map((arg) => String(arg)).join(" "));
        });
      }
      const fixture = await readyFixture(LIVE);
      const { relay } = fixture;
      const firstKey = relay.host().key;

      relay.dropLeg(1006, "net");
      await advanceUntil(() => relay.legs.length === 2, 30_000);
      await untilResumed(fixture, 1);
      relay.expireRows = true;
      relay.dropLeg(1006, "net");
      await advanceUntil(() => relay.handshakes === 2, 30_000);
      await until(() => fixture.ticks.length === 2);
      const secondKey = relay.host().key;

      expect(firstKey).not.toBe(secondKey);
      expect(logged.length).toBeGreaterThan(0);
      for (const line of logged) {
        expect(line).not.toContain(firstKey);
        expect(line).not.toContain(secondKey);
      }
    });
  });
});
