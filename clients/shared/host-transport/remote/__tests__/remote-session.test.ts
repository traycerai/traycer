import {
  NO_TRANSPORT_EVIDENCE,
  type TransportEvidenceReporter,
} from "@traycer-clients/shared/host-selection/transport-evidence";
import type {
  SelectionIncompatibility,
  SelectionTransportKind,
} from "@traycer-clients/shared/host-selection/selection-authority-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { RemoteSession, type RemoteSessionOptions } from "../remote-session";
import { RemoteStreamClient } from "../remote-stream-client";
import { INBOUND_CREDIT_GRANT_BATCH } from "../config";
import type {
  StreamCloseReason,
  StreamFrameEnvelope,
} from "../../i-stream-session";

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
  /** Params carried by every logical subscribe, including reconnect replay. */
  readonly subscribeParams: unknown[] = [];
  /** streamId of every logical subscribe, index-aligned with `subscribeParams`. */
  readonly subscribeStreamIds: number[] = [];
  /** Every `credits` value from a CREDIT control frame the client sent. */
  readonly creditGrants: number[] = [];
  /** Fired synchronously the instant a CREDIT frame is recorded - lets a test
   * capture ordering evidence (e.g. "was the stream frame already delivered
   * to the consumer?") at the exact tick the grant landed, not on a later poll. */
  onCreditGrant: (() => void) | null = null;
  streamManifest = buildStreamManifest(emptyStreamRegistry);
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
   * When true, a REQUEST is recorded in `unaryRequests` but NOT auto-answered
   * with a RESPONSE - lets a test inject its own terminal frame (e.g. a
   * stream-scoped FATAL) for that request's streamId instead of racing the
   * harness's own reply.
   */
  skipUnaryAutoRespond = false;
  /** streamId of every CLOSE frame the CLIENT sent, in arrival order. */
  readonly closesSent: number[] = [];
  /** Unexpected harness-side failures; asserted empty by the tests. */
  readonly errors: unknown[] = [];
  decideOpen: (bearer: string, openIndex: number) => OpenDecision = () => ({
    kind: "ack",
  });

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
   * long enough to cross `INBOUND_CREDIT_GRANT_BATCH` mid-flight.
   */
  async sendStreamFrame(
    streamId: number,
    envelope: Record<string, unknown>,
    binary: Uint8Array | null,
    qos: QosClassValue,
  ): Promise<void> {
    await this.sendMux(this.liveConnection(), {
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
    await this.sendMux(this.liveConnection(), {
      type: MuxFrameType.FATAL,
      streamId,
      qos: QosClass.INTERACTIVE,
      json: { details: { ...details } },
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
        connection.socket.onmessage?.({ type: "text", data: "relay-pong" });
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
          result: this.unaryResult,
          error: null,
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
          capabilities: [],
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
    const source = new OutboundChunkSource(message, () => {
      const current = connection.seqByStream.get(message.streamId) ?? 0;
      connection.seqByStream.set(message.streamId, current + 1);
      return current;
    });
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
  };
}

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
          .sendUnary("host.status", {}, null)
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
    "re-reads the current params before a reconnect re-subscribes",
    async () => {
      const relay = new FakeRelayHost();
      relay.streamManifest = buildStreamManifest(cursorStreamRegistry);
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
    "logs the recovery line when a previously-failing session reaches ready",
    async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      const relay = new FakeRelayHost();
      const lease = new MutableBearerLease("token", "user-1");
      let mintCalls = 0;
      const options = buildSessionOptions(relay, lease, null);
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
      try {
        session.start();
        await vi.waitFor(() => expect(session.isReady()).toBe(true), WAIT);
        const recoveries = infoSpy.mock.calls
          .map((call) => String(call[0]))
          .filter((line) => line.startsWith("[remote-session]"));
        expect(recoveries).toHaveLength(1);
        expect(recoveries[0]).toContain(
          "recovered after 2 consecutive failures",
        );
        expect(relay.errors).toEqual([]);
      } finally {
        session.close();
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
      .sendUnary("host.status", {}, null)
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

        const resultPromise = session.sendUnary("host.status", {}, null);
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
          .sendUnary("host.status", {}, null)
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
          .sendUnary("host.status", {}, null)
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
        const pending = session.sendUnary("host.status", {}, controller.signal);
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
          .sendUnary("host.status", {}, controller.signal)
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
          .sendUnary("host.syntheticUnsupported", {}, null)
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
    "grants credits after INBOUND_CREDIT_GRANT_BATCH FRAMES - mid-transfer, before the logical STREAM_FRAME finishes reassembling",
    async () => {
      // The deadlock this pins: the old code counted consumed BULK frames
      // per completed logical MESSAGE, so a single message spanning more
      // than `INBOUND_CREDIT_GRANT_BATCH` chunk frames would never itself
      // trigger a grant - the peer's send credits would run out and the
      // transfer would stall forever. Accounting per FRAME (remote-session's
      // `onData`, right after decrypt) grants mid-transfer instead.
      const relay = new FakeRelayHost();
      relay.streamManifest = buildStreamManifest(cursorStreamRegistry);
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

        // Comfortably over INBOUND_CREDIT_GRANT_BATCH frames at the real
        // BULK_CHUNK_SIZE_BYTES chunk cap - a transfer the old per-MESSAGE
        // accounting would never have granted credits for mid-flight.
        const frameCount = INBOUND_CREDIT_GRANT_BATCH + 5;
        const binary = new Uint8Array(BULK_CHUNK_SIZE_BYTES * frameCount);
        await relay.sendStreamFrame(
          streamId,
          { kind: "snapshot", hasBinaryPayload: true },
          binary,
          QosClass.BULK,
        );

        await vi.waitFor(() => expect(messageDelivered).toBe(true), WAIT);
        // Exactly one grant, of exactly the batch size: `frameCount` crossed
        // the batch boundary once (at frame 256) and the remaining 5 frames
        // were not enough to cross it again.
        expect(relay.creditGrants).toEqual([INBOUND_CREDIT_GRANT_BATCH]);
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
      relay.streamManifest = buildStreamManifest(cursorStreamRegistry);
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
      relay.streamManifest = buildStreamManifest(cursorStreamRegistry);
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

        const pending = session.sendUnary("host.status", {}, null);
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
        // tombstoned.
        await vi.waitFor(
          () => expect(relay.closesSent).toContain(streamId),
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
      relay.streamManifest = buildStreamManifest(cursorStreamRegistry);
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
