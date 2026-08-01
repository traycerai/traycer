import {
  checkCompatibility,
  isRpcErrorCode,
  type ConnectionManifest,
  type FatalErrorDetails,
  type MethodVersionRegistry,
  type SchemaVersion,
  type VersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import { canonicalForMethodVersionLine } from "@traycer/protocol/framework/compat-helpers";
import {
  buildStreamManifest,
  checkStreamMethodCompatibility,
} from "@traycer/protocol/framework/stream-compat";
import type { VersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { BearerSourceProvider } from "@traycer-clients/shared/auth/bearer-source";
import type {
  RevalidateOutcome,
  StreamAuthRevalidator,
} from "@traycer-clients/shared/auth/bearer-revalidator";
import type { IStreamWebSocketFactory } from "../ws-stream-factory";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "../i-stream-session";
import type { TimerHandle } from "../timer-handle";
import {
  HostRpcError,
  RetryableTransportError,
  type RequestOfMethod,
  type ResponseOfMethod,
} from "../host-messenger";
import {
  extractBearerForOpenFrame,
  prepareRequestPayload,
  decodeResponsePayload,
} from "../ws-rpc-client";
import {
  prepareStreamSubscribeRequest,
  type ParamsOf,
} from "../ws-stream-client";
import { backoffFor } from "../backoff";
import {
  CLIENT_REAUTH_INTERVAL_MS,
  CLIENT_REAUTH_JITTER_MS,
  HOST_STANDING_BOUND_MS,
  INITIAL_BULK_SEND_CREDITS,
  ATTACH_ACK_TIMEOUT_MS,
  NOISE_HANDSHAKE_TIMEOUT_MS,
  SESSION_OPEN_ACK_TIMEOUT_MS,
  UNARY_RESPONSE_TIMEOUT_MS,
  RECONNECT_INITIAL_BACKOFF_MS,
  RECONNECT_MAX_BACKOFF_MS,
} from "./config";
import {
  CURRENT_MUX_VERSION,
  MuxFrameType,
  QosClass,
  SESSION_CONTROL_STREAM_ID,
  SESSION_CAPABILITY_CREDENTIAL_UPDATE,
  creditPayloadSchema,
  decodeMuxFrame,
  encodeMuxFrame,
  fatalPayloadSchema,
  sessionOpenAckPayloadSchema,
  unaryResponsePayloadSchema,
  type EncodeMuxFrameInput,
  type QosClassValue,
  type SessionManifests,
  type SessionOpenPayload,
} from "@traycer/protocol/host-transport/mux";
import {
  ChunkReassembler,
  chunkOutboundMessage,
  type OutboundMessage,
  type ReassembledMessage,
} from "./chunker";
import { InboundCreditTracker, PriorityScheduler } from "./scheduler";
import { NoiseChannel } from "./noise-channel";
import { RelaySocket, type RelayKillReason } from "./relay-socket";
import type { AttachGrantProvider } from "./grant-client";
import { LogicalStream, type LogicalStreamPort } from "./logical-stream";

/**
 * The client's persistent, E2E, multiplexed remote session (Architecture §3).
 * ONE long-lived relay socket carries a Noise-NK channel over which unary RPC +
 * N subscribe streams are multiplexed. It is the single owner of everything the
 * transport-seam spike relocated off the per-socket local clients: connection
 * lifecycle, re-subscribe-on-reconnect, keepalive, credential rotation,
 * slow-client/credit flow control, and shared-fate resume.
 *
 * Connection lifecycle (each connect is a FULL attach — the v1 resume path,
 * R4-E3):
 *   mint fresh grant → dial relay(?grant) → attach_ack{sid}
 *     → Noise-NK handshake (msg0 → msg1)
 *     → open{bearer, manifest, authz:null, resume:null}  (re-presents bearer, A2)
 *     → openAck{manifest, capabilities}  → compat mirror
 *     → re-subscribe every live stream → ready
 *
 * Backoff resets ONLY at the ready boundary (transport open · E2E handshake ·
 * session open · subscriptions restored) — never on socket-open.
 *
 * Host blip (`host_detached`/`host_attached`) is NOT a resume: the same Noise
 * session persists; the scheduler pauses (holding frames, not losing them to a
 * host-less relay) and resumes. Only a socket drop or `peer_gone` triggers a
 * full attach.
 */

export interface RemoteSessionOptions<
  RpcRegistry extends VersionedRpcRegistry,
  StreamRegistry extends VersionedStreamRpcRegistry,
> {
  readonly hostId: string;
  /** Relay attach URL (e.g. `wss://relay.example/attach`). */
  readonly attachBaseUrl: string;
  /** Host static X25519 public key for the NK handshake (registry-published). */
  readonly hostStaticPublicKey: Uint8Array;
  /** Mints a fresh single-use `role:"client"` attach grant per attach + reauth. */
  readonly grantProvider: AttachGrantProvider;
  /** Reads the user bearer for the in-channel `open{bearer}` frame (A2). */
  readonly bearer: BearerSourceProvider;
  /**
   * Auth recovery hook invoked when the host FATALs the session with
   * `UNAUTHORIZED` - the in-channel `open{bearer}` was rejected (the
   * overnight-wake case: the bearer expired while the renderer slept). The
   * session revalidates the credential (single-flight, shared with the local
   * transports) and acts on the outcome - redial with the fresh bearer, stay
   * in backoff on a transient failure, or go terminal on a rejected
   * credential. `null` keeps an `UNAUTHORIZED` session fatal terminal,
   * mirroring `WsStreamClientOptions.auth` for short-lived/dev clients that
   * cannot recover an auth rejection by retrying the same bearer.
   */
  readonly auth: StreamAuthRevalidator | null;
  readonly rpcRegistry: RpcRegistry;
  readonly streamRegistry: StreamRegistry;
  readonly webSocketFactory: IStreamWebSocketFactory;
  readonly requestId: () => string;
}

/**
 * Public surface of `RemoteSession` (Architecture §4 / S1 session-collapse).
 * A plain interface (not the concrete class) so the session cache
 * (`active-remote-sessions.ts`) can hand each consumer its OWN wrapper object
 * over one shared `RemoteSession` - every method delegates straight through
 * except `close()`, which the cache intercepts to release that consumer's
 * reference instead of tearing down the shared connection outright.
 */
export interface IRemoteSession<
  RpcRegistry extends VersionedRpcRegistry,
  StreamRegistry extends VersionedStreamRpcRegistry,
> {
  start(): void;
  isClosed(): boolean;
  isReady(): boolean;
  sendUnary<Method extends keyof RpcRegistry & string>(
    method: Method,
    params: RequestOfMethod<RpcRegistry, Method>,
  ): Promise<ResponseOfMethod<RpcRegistry, Method>>;
  subscribe<Method extends keyof StreamRegistry & string>(
    method: Method,
    params: ParamsOf<StreamRegistry, Method>,
  ): IStreamSession;
  notifyBearerRotated(): void;
  /**
   * Subscribes to the session's terminal close - a caller `close()` (on the
   * shared session, once every consumer released) or a terminal session
   * fatal. Fires once, synchronously, after the session state is fully torn
   * down. NOT retro-fired for an already-closed session - late attachers must
   * check `isClosed()` first, exactly as with `WsStreamClient.onClosed` (the
   * provider-side liveness guard does both).
   */
  onClosed(listener: () => void): () => void;
  /**
   * Subscribes to positive evidence that the session just re-reached its
   * ready boundary after a drop (reconnecting → full re-attach + every live
   * stream restored). A clean FIRST open never fires - nothing recovered.
   * The remote analog of the recovery evidence `WsStreamClient` surfaces via
   * `subscribeAvailabilityRecovered`, consumed to un-strand errored
   * host-scoped queries.
   */
  subscribeAvailabilityRecovered(listener: () => void): () => void;
  close(): void;
}

type SessionPhase =
  | "idle"
  | "connecting"
  | "handshaking"
  | "opening"
  | "ready"
  | "reconnecting"
  | "closed";

interface OutboundFrame {
  readonly qos: QosClassValue;
  readonly frame: EncodeMuxFrameInput;
}

interface PendingUnary {
  readonly requestId: string;
  readonly method: string;
  readonly clientCanonical: SchemaVersion;
  readonly hostCanonical: SchemaVersion;
  readonly methodRegistry: MethodVersionRegistry;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: HostRpcError) => void;
  timer: TimerHandle | null;
}

interface ActiveConnection {
  readonly generation: number;
  readonly relaySocket: RelaySocket;
  readonly noise: NoiseChannel;
  readonly scheduler: PriorityScheduler<OutboundFrame>;
  readonly reassembler: ChunkReassembler;
  readonly inboundCredits: InboundCreditTracker;
  hostManifest: SessionManifests | null;
  credentialUpdateSupported: boolean;
  hostAttached: boolean;
}

export class RemoteSession<
  RpcRegistry extends VersionedRpcRegistry,
  StreamRegistry extends VersionedStreamRpcRegistry,
>
  implements LogicalStreamPort, IRemoteSession<RpcRegistry, StreamRegistry>
{
  private readonly options: RemoteSessionOptions<RpcRegistry, StreamRegistry>;
  private readonly clientManifests: SessionManifests;

  private phase: SessionPhase = "idle";
  private connectGeneration = 0;
  private reconnectAttempt = 0;
  private connection: ActiveConnection | null = null;

  private readonly subscriptions = new Map<number, LogicalStream>();
  private readonly pendingUnary = new Map<number, PendingUnary>();
  private readonly outboundSeq = new Map<number, number>();
  private readonly restoredStreamIds = new Set<number>();
  private readonly closedListeners = new Set<() => void>();
  private readonly availabilityRecoveredListeners = new Set<() => void>();
  private nextStreamId = 1;
  private readyBoundaryGeneration: number | null = null;
  /**
   * The bearer presented in the current connection's `open` frame, captured
   * at send time so the `UNAUTHORIZED` session-fatal recovery can tell
   * whether the NEXT attach would present a different token (progress) or
   * the very one the host just rejected (no progress).
   */
  private openFrameBearer: string | null = null;
  /**
   * Bounds the rare "valid-but-rejected" loop: authn keeps accepting the
   * bearer (revalidation returns "rotated") yet the host keeps FATAL-ing the
   * session `UNAUTHORIZED` because the token never actually changed (clock
   * skew / config mismatch). Incremented ONLY when a "rotated" revalidation
   * left the next-attach bearer identical to the just-rejected one; a real
   * rotation, a transient "network-error", or reaching `ready` all reset it.
   * At the cap the session goes terminal (mirrors the local stream
   * transport's no-progress bound).
   */
  private noProgressUnauthorizedReconnects = 0;
  /**
   * Set on every connection drop; consumed at the next ready boundary to
   * emit availability-recovered evidence. A boundary reached without a prior
   * drop is the clean first open - NOT recovery - so it stays silent.
   */
  private droppedSinceReady = false;

  private phaseTimer: TimerHandle | null = null;
  private backoffTimer: TimerHandle | null = null;
  private reauthTimer: TimerHandle | null = null;
  private standingTimer: TimerHandle | null = null;

  constructor(options: RemoteSessionOptions<RpcRegistry, StreamRegistry>) {
    this.options = options;
    this.clientManifests = {
      rpc: buildRpcManifest(options.rpcRegistry),
      stream: buildStreamManifest(options.streamRegistry),
    };
  }

  // ---- Public surface (consumed by the messenger + stream client) -------- //

  /** Kicks off the first connect if the session is idle. Idempotent. */
  start(): void {
    if (this.phase === "idle") {
      void this.beginConnect();
    }
  }

  isClosed(): boolean {
    return this.phase === "closed";
  }

  /**
   * True once the Noise handshake + in-channel `open`/`openAck` have both
   * completed and the mux is actively carrying traffic — the live, firsthand
   * evidence the "a client holding an open E2E session renders Online
   * regardless of the lease" status-honesty rule (Architecture §7, R4-B5)
   * reads. `false` while idle/connecting/handshaking/reconnecting, so a
   * session that is merely attempting to attach is never mistaken for proof
   * of liveness.
   */
  isReady(): boolean {
    return (
      this.phase === "ready" &&
      this.readyBoundaryGeneration === this.connectGeneration
    );
  }

  /**
   * Issues a single unary RPC over the session (single-flight, no post-send
   * auto-retry — local parity). Rejects with a `RetryableTransportError` only
   * when the session is not yet ready (provably pre-send, safe to retry); any
   * failure after the request frame is enqueued surfaces as a plain
   * `HostRpcError`, since the host may already have begun applying it.
   */
  sendUnary<Method extends keyof RpcRegistry & string>(
    method: Method,
    params: RequestOfMethod<RpcRegistry, Method>,
  ): Promise<ResponseOfMethod<RpcRegistry, Method>> {
    this.start();
    const requestId = this.options.requestId();
    const connection = this.connection;
    if (this.phase !== "ready" || connection === null) {
      return Promise.reject(
        new RetryableTransportError({
          code: "RPC_ERROR",
          message: "Remote session is not ready",
          requestId,
          method,
          fatalDetails: null,
        }),
      );
    }
    const hostManifest = connection.hostManifest;
    if (hostManifest === null) {
      return Promise.reject(
        new RetryableTransportError({
          code: "RPC_ERROR",
          message: "Remote session manifest is not negotiated",
          requestId,
          method,
          fatalDetails: null,
        }),
      );
    }

    const clientCanonical = this.clientManifests.rpc[method];
    const hostCanonical = hostManifest.rpc[method];
    if (clientCanonical === undefined || hostCanonical === undefined) {
      return Promise.reject(
        new HostRpcError({
          code: "RPC_ERROR",
          message: `Method '${method}' is not in both manifests`,
          requestId,
          method,
          fatalDetails: null,
        }),
      );
    }
    const methodRegistry = indexMethodRegistry(
      this.options.rpcRegistry,
      method,
    );

    let prepared: { onWireVersion: SchemaVersion; onWirePayload: unknown };
    try {
      prepared = prepareRequestPayload(
        methodRegistry,
        clientCanonical,
        hostCanonical,
        params,
        requestId,
        method,
      );
    } catch (cause) {
      return Promise.reject(asHostRpcError(cause, requestId, method));
    }

    const streamId = this.allocateStreamId();
    return new Promise<ResponseOfMethod<RpcRegistry, Method>>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          this.rejectUnary(streamId, unaryTimeoutError(requestId, method));
        }, UNARY_RESPONSE_TIMEOUT_MS);
        this.pendingUnary.set(streamId, {
          requestId,
          method,
          clientCanonical,
          hostCanonical,
          methodRegistry,
          resolve: (result) =>
            resolve(result as ResponseOfMethod<RpcRegistry, Method>),
          reject,
          timer,
        });
        try {
          this.enqueueMessage(connection, {
            type: MuxFrameType.REQUEST,
            streamId,
            qos: QosClass.INTERACTIVE,
            json: {
              requestId,
              method,
              schemaVersion: prepared.onWireVersion,
              params: prepared.onWirePayload,
              idempotencyKey: null,
            },
            binary: null,
          });
        } catch (cause) {
          this.clearPendingUnary(streamId);
          reject(asHostRpcError(cause, requestId, method));
        }
      },
    );
  }

  /** Opens a logical subscribe stream (interactive class; see §3 QoS note). */
  subscribe(method: string, params: unknown): IStreamSession {
    this.start();
    const streamId = this.allocateStreamId();
    const stream = new LogicalStream({
      streamId,
      method,
      params,
      // Recomputed against the host manifest at (re)subscribe; a provisional
      // client-canonical version is fine until then.
      schemaVersion: this.clientStreamCanonical(method),
      qos: QosClass.INTERACTIVE,
      port: this,
    });
    this.subscriptions.set(streamId, stream);
    if (this.phase === "ready" && this.connection !== null) {
      this.openSubscription(this.connection, stream);
    } else {
      stream.notifyStatus("connecting", null);
    }
    return stream;
  }

  /** Pushes a rotated bearer in place if the host advertised the capability. */
  notifyBearerRotated(): void {
    const connection = this.connection;
    if (
      this.phase !== "ready" ||
      connection === null ||
      !connection.credentialUpdateSupported
    ) {
      return;
    }
    const bearer = this.readBearerOrNull();
    if (bearer === null) {
      return;
    }
    this.enqueueMessage(connection, {
      type: MuxFrameType.CREDENTIAL_UPDATE,
      streamId: SESSION_CONTROL_STREAM_ID,
      qos: QosClass.INTERACTIVE,
      json: { bearer },
      binary: null,
    });
  }

  /** See {@link IRemoteSession.onClosed}. */
  onClosed(listener: () => void): () => void {
    if (this.phase === "closed") {
      return () => undefined;
    }
    this.closedListeners.add(listener);
    return () => {
      this.closedListeners.delete(listener);
    };
  }

  /** See {@link IRemoteSession.subscribeAvailabilityRecovered}. */
  subscribeAvailabilityRecovered(listener: () => void): () => void {
    if (this.phase === "closed") {
      return () => undefined;
    }
    this.availabilityRecoveredListeners.add(listener);
    return () => {
      this.availabilityRecoveredListeners.delete(listener);
    };
  }

  /** Tears the session down permanently: closes the socket, fails everything. */
  close(): void {
    if (this.phase === "closed") {
      return;
    }
    this.phase = "closed";
    this.restoredStreamIds.clear();
    this.clearAllTimers();
    this.teardownConnection("closed-by-caller");
    for (const stream of this.subscriptions.values()) {
      stream.notifyStatus("closed", { kind: "caller" });
    }
    this.subscriptions.clear();
    this.rejectAllPendingUnary(
      new HostRpcError({
        code: "RPC_ERROR",
        message: "Remote session closed",
        requestId: "session-close",
        method: "",
        fatalDetails: null,
      }),
    );
    this.emitClosed();
  }

  // ---- LogicalStreamPort ------------------------------------------------- //

  sendStreamFrame(
    streamId: number,
    envelope: StreamFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ): void {
    const connection = this.connection;
    const stream = this.subscriptions.get(streamId);
    if (this.phase !== "ready" || connection === null || stream === undefined) {
      return;
    }
    // Fixed-per-stream class (per-stream FIFO invariant); a large binary is
    // still chunked at 64 KiB but stays this stream's class.
    this.enqueueMessage(connection, {
      type: MuxFrameType.STREAM_FRAME,
      streamId,
      qos: stream.qos,
      json: { ...envelope },
      binary: binaryPayload,
    });
  }

  /**
   * `LogicalStreamPort.requestSessionReconnect`. Routes a caller-requested
   * reconnect (a post-sleep/wake liveness nudge) through the SAME
   * `handleConnectionLost` path a real transport drop takes, so the backoff
   * state machine, stream re-subscribe, and pending-unary rejection stay in
   * one place. No-op when idle or closed - there is no socket to replace, and
   * the existing `beginConnect`/backoff already owns getting one.
   */
  requestSessionReconnect(reason: string): void {
    if (this.phase === "closed" || this.phase === "idle") {
      return;
    }
    this.handleConnectionLost(this.connectGeneration, reason);
  }

  closeStream(streamId: number, reason: string): void {
    const connection = this.connection;
    this.subscriptions.delete(streamId);
    this.restoredStreamIds.delete(streamId);
    this.outboundSeq.delete(streamId);
    if (this.phase === "ready" && connection !== null) {
      this.enqueueMessage(connection, {
        type: MuxFrameType.CLOSE,
        streamId,
        qos: QosClass.INTERACTIVE,
        json: { reason },
        binary: null,
      });
    }
    this.maybeReachReadyBoundary();
  }

  // ---- Connect / attach / handshake / open ------------------------------- //

  private async beginConnect(): Promise<void> {
    if (this.phase === "closed") {
      return;
    }
    const generation = ++this.connectGeneration;
    this.phase = "connecting";
    this.clearPhaseTimer();

    const provision = await this.options.grantProvider();
    if (generation !== this.connectGeneration || this.isClosed()) {
      return;
    }
    if (provision.kind === "plan-restricted") {
      // Entitlement denial: the account's plan lacks remote connectivity.
      // Backoff cannot fix a plan — go terminal so the caller surfaces the
      // upsell instead of silently redialing forever. A later attempt (after
      // an upgrade) builds a fresh session; the closed one is evicted from
      // the session cache on the next acquire.
      this.goTerminalFatal(planRestrictedFatalDetails());
      return;
    }
    if (provision.kind === "unavailable") {
      // No grant (signed out / revoked / transient CS failure): stay in backoff.
      this.scheduleReconnect();
      return;
    }
    const grant = provision.grant;

    const scheduler = new PriorityScheduler<OutboundFrame>({
      write: (item) => this.writeFrame(generation, item),
      onWriteError: () => this.handleConnectionLost(generation, "write-failed"),
      initialBulkCredits: INITIAL_BULK_SEND_CREDITS,
    });
    const noise = await NoiseChannel.begin(this.options.hostStaticPublicKey);
    if (generation !== this.connectGeneration || this.isClosed()) {
      return;
    }

    const relaySocket = new RelaySocket({
      attachBaseUrl: this.options.attachBaseUrl,
      grantJws: grant.grant,
      webSocketFactory: this.options.webSocketFactory,
      handlers: {
        onAttachAck: () => this.onAttachAck(generation),
        onData: (bytes) => this.onData(generation, bytes),
        onHostDetached: () => this.onHostDetached(generation),
        onHostAttached: () => this.onHostAttached(generation),
        onReauthAck: () => undefined,
        onPeerGone: (reason) => this.onPeerGone(generation, reason),
        onError: () => undefined,
        onClose: () => this.handleConnectionLost(generation, "socket-closed"),
      },
    });

    this.connection = {
      generation,
      relaySocket,
      noise,
      scheduler,
      reassembler: new ChunkReassembler(),
      inboundCredits: new InboundCreditTracker(),
      hostManifest: null,
      credentialUpdateSupported: false,
      hostAttached: true,
    };
    this.armPhaseTimer(generation, ATTACH_ACK_TIMEOUT_MS, "attach-ack-timeout");
  }

  private onAttachAck(generation: number): void {
    if (!this.isCurrent(generation) || this.phase !== "connecting") {
      return;
    }
    const connection = this.connection;
    if (connection === null) {
      return;
    }
    this.phase = "handshaking";
    this.armPhaseTimer(
      generation,
      NOISE_HANDSHAKE_TIMEOUT_MS,
      "handshake-timeout",
    );
    void (async () => {
      const msg0 = await connection.noise.writeInitiatorMessage();
      if (!this.isCurrent(generation) || this.phase !== "handshaking") {
        return;
      }
      if (!connection.relaySocket.sendData(msg0)) {
        this.handleConnectionLost(generation, "handshake-send-failed");
      }
    })();
  }

  private onData(generation: number, bytes: Uint8Array): void {
    if (!this.isCurrent(generation)) {
      return;
    }
    const connection = this.connection;
    if (connection === null) {
      return;
    }
    if (this.phase === "handshaking") {
      this.armStandingTimer();
      void (async () => {
        await connection.noise.readResponderMessage(bytes);
        if (!this.isCurrent(generation) || this.phase !== "handshaking") {
          return;
        }
        this.sendOpenFrame(generation, connection);
      })().catch(() =>
        this.handleConnectionLost(generation, "handshake-read-failed"),
      );
      return;
    }
    // Established transport: decrypt → decode → reassemble → dispatch.
    this.armStandingTimer();
    void (async () => {
      const muxBytes = await connection.noise.decrypt(bytes);
      if (!this.isCurrent(generation)) {
        return;
      }
      const frame = decodeMuxFrame(muxBytes);
      const message = connection.reassembler.accept(frame);
      if (message === null) {
        return;
      }
      this.dispatchInbound(generation, connection, frame.qos, message);
    })().catch(() =>
      this.handleConnectionLost(generation, "inbound-decode-failed"),
    );
  }

  private sendOpenFrame(
    generation: number,
    connection: ActiveConnection,
  ): void {
    const bearer = this.readBearerOrNull();
    if (bearer === null) {
      // No bearer to present → cannot authenticate the session; stay in backoff.
      this.handleConnectionLost(generation, "missing-bearer");
      return;
    }
    this.phase = "opening";
    this.openFrameBearer = bearer;
    this.armPhaseTimer(
      generation,
      SESSION_OPEN_ACK_TIMEOUT_MS,
      "open-ack-timeout",
    );
    const open: SessionOpenPayload = {
      muxVersion: CURRENT_MUX_VERSION,
      bearer,
      manifest: this.clientManifests,
      authz: null,
      resume: null,
    };
    this.enqueueMessage(connection, {
      type: MuxFrameType.OPEN,
      streamId: SESSION_CONTROL_STREAM_ID,
      qos: QosClass.INTERACTIVE,
      json: { ...open },
      binary: null,
    });
  }

  private dispatchInbound(
    generation: number,
    connection: ActiveConnection,
    qos: QosClassValue,
    message: ReassembledMessage,
  ): void {
    if (qos === QosClass.BULK) {
      const grant = connection.inboundCredits.onBulkFrameConsumed();
      if (grant > 0) {
        this.enqueueMessage(connection, {
          type: MuxFrameType.CREDIT,
          streamId: SESSION_CONTROL_STREAM_ID,
          qos: QosClass.INTERACTIVE,
          json: { credits: grant },
          binary: null,
        });
      }
    }

    if (message.streamId === SESSION_CONTROL_STREAM_ID) {
      this.dispatchControl(generation, connection, message);
      return;
    }
    this.dispatchStreamScoped(connection, message);
  }

  private dispatchControl(
    generation: number,
    connection: ActiveConnection,
    message: ReassembledMessage,
  ): void {
    switch (message.type) {
      case MuxFrameType.OPEN_ACK:
        this.handleOpenAck(generation, connection, message.json);
        return;
      case MuxFrameType.CREDIT: {
        const parsed = creditPayloadSchema.safeParse(message.json);
        if (parsed.success) {
          connection.scheduler.grantCredits(parsed.data.credits);
        }
        return;
      }
      case MuxFrameType.REAUTH_NOTICE:
        // Host proved fresh standing (R4-D2); the watchdog reset already
        // happened on frame receipt. Nothing further to do.
        return;
      case MuxFrameType.FATAL: {
        const parsed = fatalPayloadSchema.safeParse(message.json);
        if (parsed.success) {
          this.handleSessionFatal(generation, parsed.data.details);
        } else {
          this.handleConnectionLost(generation, "malformed-session-fatal");
        }
        return;
      }
      default:
        return;
    }
  }

  private dispatchStreamScoped(
    connection: ActiveConnection,
    message: ReassembledMessage,
  ): void {
    if (message.type === MuxFrameType.RESPONSE) {
      this.handleUnaryResponse(message.json);
      return;
    }
    const stream = this.subscriptions.get(message.streamId);
    if (stream === undefined) {
      return;
    }
    if (message.type === MuxFrameType.STREAM_FRAME) {
      const envelope = message.json;
      if (envelope !== null && isStreamEnvelope(envelope)) {
        const delivered = stream.deliverServerFrame(envelope, message.binary);
        if (delivered) {
          this.markStreamRestored(message.streamId);
        }
      }
      return;
    }
    if (message.type === MuxFrameType.FATAL) {
      const parsed = fatalPayloadSchema.safeParse(message.json);
      if (parsed.success) {
        stream.goFatal(parsed.data.details);
        this.subscriptions.delete(message.streamId);
        this.restoredStreamIds.delete(message.streamId);
        this.maybeReachReadyBoundary();
      }
      return;
    }
    if (message.type === MuxFrameType.CLOSE) {
      stream.notifyStatus("closed", { kind: "caller" });
      this.subscriptions.delete(message.streamId);
      this.restoredStreamIds.delete(message.streamId);
      this.maybeReachReadyBoundary();
    }
    void connection;
  }

  private handleOpenAck(
    generation: number,
    connection: ActiveConnection,
    json: Record<string, unknown> | null,
  ): void {
    if (this.phase !== "opening") {
      return;
    }
    const parsed = sessionOpenAckPayloadSchema.safeParse(json);
    if (!parsed.success) {
      this.handleConnectionLost(generation, "malformed-openAck");
      return;
    }
    const compat = checkCompatibility(
      this.options.rpcRegistry,
      this.clientManifests.rpc,
      parsed.data.manifest.rpc,
      "client",
    );
    if (!compat.ok) {
      this.goTerminalFatal(compat.details);
      return;
    }
    connection.hostManifest = parsed.data.manifest;
    connection.credentialUpdateSupported = parsed.data.capabilities.includes(
      SESSION_CAPABILITY_CREDENTIAL_UPDATE,
    );
    this.clearPhaseTimer();
    this.phase = "ready";
    // The host accepted the `open{bearer}`: any prior UNAUTHORIZED episode is
    // over, so a later one starts its no-progress bound from a clean slate.
    this.noProgressUnauthorizedReconnects = 0;
    this.restoredStreamIds.clear();

    for (const stream of this.subscriptions.values()) {
      this.openSubscription(connection, stream);
    }
    this.startReauthLoop();
    this.armStandingTimer();
    this.maybeReachReadyBoundary();
  }

  private openSubscription(
    connection: ActiveConnection,
    stream: LogicalStream,
  ): void {
    const hostManifest = connection.hostManifest;
    if (hostManifest === null) {
      return;
    }
    const clientCanonical = this.clientManifests.stream[stream.method];
    const hostCanonical = hostManifest.stream[stream.method];
    const compat = checkStreamMethodCompatibility(
      this.options.streamRegistry,
      this.clientManifests.stream,
      hostManifest.stream,
      "client",
      stream.method,
    );
    if (
      !compat.ok ||
      clientCanonical === undefined ||
      hostCanonical === undefined
    ) {
      const details: FatalErrorDetails = compat.ok
        ? incompatibleStreamDetails(stream.method)
        : compat.details;
      stream.goFatal(details);
      this.subscriptions.delete(stream.streamId);
      return;
    }
    const prepared = prepareStreamSubscribeRequest(
      this.options.streamRegistry,
      stream.method,
      clientCanonical,
      hostCanonical,
      stream.params,
    );
    stream.updateSchemaVersion(prepared.onWireVersion);
    this.enqueueMessage(connection, {
      type: MuxFrameType.SUBSCRIBE,
      streamId: stream.streamId,
      qos: stream.qos,
      json: {
        method: stream.method,
        schemaVersion: prepared.onWireVersion,
        params: prepared.onWirePayload,
      },
      binary: null,
    });
  }

  private handleUnaryResponse(json: Record<string, unknown> | null): void {
    const parsed = unaryResponsePayloadSchema.safeParse(json);
    if (!parsed.success) {
      return;
    }
    const pending = this.findPendingByRequestId(parsed.data.requestId);
    if (pending === null) {
      return;
    }
    const { streamId, entry } = pending;
    this.clearPendingUnary(streamId);
    if (parsed.data.error !== null) {
      entry.reject(
        new HostRpcError({
          code: isRpcErrorCode(parsed.data.error.code)
            ? parsed.data.error.code
            : "RPC_ERROR",
          message: parsed.data.error.message,
          requestId: entry.requestId,
          method: entry.method,
          fatalDetails: null,
        }),
      );
      return;
    }
    try {
      const decoded = decodeResponsePayload(
        entry.methodRegistry,
        entry.clientCanonical,
        entry.hostCanonical,
        parsed.data.result,
        entry.requestId,
        entry.method,
      );
      entry.resolve(decoded);
    } catch (cause) {
      entry.reject(asHostRpcError(cause, entry.requestId, entry.method));
    }
  }

  // ---- Host blip / peer death / drop ------------------------------------- //

  private onHostDetached(generation: number): void {
    if (!this.isCurrent(generation)) {
      return;
    }
    const connection = this.connection;
    if (connection === null) {
      return;
    }
    connection.hostAttached = false;
    connection.scheduler.pause();
    this.markStreamsReconnecting();
  }

  private onHostAttached(generation: number): void {
    if (!this.isCurrent(generation)) {
      return;
    }
    const connection = this.connection;
    if (connection === null) {
      return;
    }
    this.armStandingTimer();
    if (!connection.hostAttached) {
      // The host discards ALL Noise state on any socket close
      // (`teardownAllSessions`, host-side), so a `host_attached` transition
      // out of "detached" ALWAYS means the host rebuilt a fresh Noise
      // responder for this attach - even though the CLIENT's own relay
      // socket never dropped. There is no "redundant re-handshake" case to
      // special-case: resuming the paused scheduler on the STALE Noise
      // channel (the old behavior) would silently desync the client against
      // a responder that no longer exists on the host side, recoverable
      // only by the 15-min standing watchdog - which a flapping host uplink
      // re-arms indefinitely (Architecture §4 fix #2 / S2). Route it through
      // the SAME full-attach path a genuine transport drop already uses -
      // fresh `NoiseChannel` + relay dial + `open{bearer}` - rather than a
      // second state machine or a new wire frame (`session_reset{sid}`
      // stays deferred/telemetry-gated; see the S2 ticket).
      this.handleConnectionLost(generation, "host-attached-stale-noise");
    }
  }

  private onPeerGone(generation: number, reason: RelayKillReason): void {
    if (!this.isCurrent(generation)) {
      return;
    }
    if (reason === "revoked" || reason === "policy_violation") {
      this.goTerminalFatal({
        code: "UNAUTHORIZED",
        reason:
          reason === "revoked"
            ? "Host access was revoked"
            : "Session closed by relay policy",
        incompatibleMethods: null,
        upgradeGuidance: null,
      });
      return;
    }
    this.handleConnectionLost(generation, `peer-gone:${reason}`);
  }

  /** Any transport loss → drop the connection and full-resume from backoff. */
  private handleConnectionLost(generation: number, cause: string): void {
    if (!this.isCurrent(generation) || this.phase === "closed") {
      return;
    }
    this.dropConnection(cause);
    this.scheduleReconnect();
  }

  /**
   * Shared drop bookkeeping for a lost connection: tear the transport down,
   * fail in-flight unary calls, flag streams reconnecting. The caller decides
   * what happens next - `handleConnectionLost` schedules the backoff redial
   * immediately; the `UNAUTHORIZED` session-fatal path first revalidates the
   * credential and only then reconnects (or goes terminal).
   */
  private dropConnection(cause: string): void {
    this.phase = "reconnecting";
    this.droppedSinceReady = true;
    this.restoredStreamIds.clear();
    this.teardownConnection(cause);
    // In-flight unary calls are post-send from the caller's view → not
    // retryable (the host may have applied them). Reject, never replay.
    this.rejectAllPendingUnary(
      new HostRpcError({
        code: "RPC_ERROR",
        message: "Remote session dropped before the response arrived",
        requestId: "session-drop",
        method: "",
        fatalDetails: null,
      }),
    );
    this.markStreamsReconnecting();
  }

  /**
   * A session-level FATAL control frame from the host. Not every fatal is
   * terminal (parity with the local stream transport's fatalError handling):
   *  - `retryable === true` marks a transient host-side rejection (e.g. the
   *    host's JWKS fetch timed out while verifying our bearer) - our
   *    credential is fine, so it is treated exactly like a transport drop and
   *    the reconnect backoff rides until the host recovers.
   *  - `UNAUTHORIZED` is recoverable when an auth revalidator is wired: the
   *    host rejected the in-channel `open{bearer}` (the overnight-wake case -
   *    the bearer expired while the renderer slept, or at a wake re-attach),
   *    and a single-flight revalidation may rotate a fresh one for the next
   *    attach to present.
   *  - every other fatal (e.g. `INCOMPATIBLE`), and the no-revalidator case,
   *    stays terminal exactly as before.
   */
  private handleSessionFatal(
    generation: number,
    details: FatalErrorDetails,
  ): void {
    if (details.retryable === true) {
      // A transient host blip must not count toward the credential give-up
      // bound - clear any streak left by a prior genuine UNAUTHORIZED episode.
      this.noProgressUnauthorizedReconnects = 0;
      this.handleConnectionLost(generation, "session-fatal-retryable");
      return;
    }
    const auth = this.revalidator();
    if (details.code === "UNAUTHORIZED" && auth !== null) {
      this.handleUnauthorizedSessionFatal(generation, details, auth);
      return;
    }
    this.goTerminalFatal(details);
  }

  /**
   * The wired revalidator, or `null` when there is none to call.
   *
   * `auth` is a REQUIRED option typed `StreamAuthRevalidator | null`, but this
   * transport is also driven from untyped entry points (the connect-path E2E
   * harness, ad-hoc probes) that can omit the property entirely. A bare
   * `!== null` check waves that `undefined` straight through into
   * `auth.revalidateForReconnect()`, and the resulting TypeError is thrown
   * inside a floating promise on the reconnect path - so a session that should
   * have failed cleanly with the host's own UNAUTHORIZED message instead dies
   * as an unhandled rejection with no diagnostic. Normalize once, here.
   */
  private revalidator(): StreamAuthRevalidator | null {
    return this.options.auth ?? null;
  }

  private handleUnauthorizedSessionFatal(
    generation: number,
    details: FatalErrorDetails,
    auth: StreamAuthRevalidator,
  ): void {
    if (!this.isCurrent(generation) || this.phase === "closed") {
      return;
    }
    // Capture the bearer the host just rejected BEFORE teardown clears it, so
    // after revalidation we can tell whether the next attach would present a
    // DIFFERENT token (progress) or the same rejected one (no progress).
    const rejectedBearer = this.openFrameBearer;
    this.dropConnection("session-fatal-unauthorized");
    void this.revalidateThenReconnect(auth, details, rejectedBearer);
  }

  /**
   * Recovers an `UNAUTHORIZED` session fatal by revalidating the credential
   * and acting on the normalized outcome (mirrors the local stream
   * transport's `revalidateThenReconnect`):
   *   - "rotated"       → redial from backoff; the next `open` frame carries
   *                       the fresh bearer.
   *   - "network-error" → stay in reconnect backoff (transient); the bearer
   *                       is untouched, so this never counts toward the
   *                       give-up bound.
   *   - "rejected"      → terminal (the revalidator has already signed out).
   * A no-progress streak (revalidation keeps returning a current credential
   * the host keeps rejecting) is bounded and goes terminal to stop looping.
   */
  private async revalidateThenReconnect(
    auth: StreamAuthRevalidator,
    details: FatalErrorDetails,
    rejectedBearer: string | null,
  ): Promise<void> {
    const outcome = await this.revalidateWithinBudget(auth);
    if (this.phase !== "reconnecting" || this.connection !== null) {
      // Closed - or a competing path already owns reconnection - while the
      // revalidation was in flight.
      return;
    }
    if (outcome === "rejected") {
      this.goTerminalFatal(details);
      return;
    }
    if (outcome === "network-error") {
      this.noProgressUnauthorizedReconnects = 0;
      this.scheduleReconnect();
      return;
    }
    // outcome === "rotated": authn accepts the credential. If the bearer the
    // next attach will present is still the one the host just rejected, no
    // progress was made (authn validates it but the host keeps rejecting -
    // clock skew / config mismatch). Bound that loop; otherwise reset and
    // redial with the fresh token.
    if (rejectedBearer !== null && this.readBearerOrNull() === rejectedBearer) {
      this.noProgressUnauthorizedReconnects += 1;
      if (
        this.noProgressUnauthorizedReconnects >=
        MAX_NO_PROGRESS_UNAUTHORIZED_RECONNECTS
      ) {
        this.goTerminalFatal(details);
        return;
      }
    } else {
      this.noProgressUnauthorizedReconnects = 0;
    }
    this.scheduleReconnect();
  }

  /**
   * Awaits the auth revalidation but never longer than
   * `UNAUTHORIZED_REVALIDATE_TIMEOUT_MS`, treating a timeout (or a thrown
   * revalidation) as a transient "network-error" so the normal reconnect
   * backoff retries - a hung authn refresh (a half-open socket after sleep)
   * must never strand the session in "reconnecting" forever.
   */
  private async revalidateWithinBudget(
    auth: StreamAuthRevalidator,
  ): Promise<RevalidateOutcome> {
    let timer: TimerHandle | null = null;
    const budget = new Promise<RevalidateOutcome>((resolve) => {
      timer = setTimeout(
        () => resolve("network-error"),
        UNAUTHORIZED_REVALIDATE_TIMEOUT_MS,
      );
    });
    // Invoke inside a promise chain, never bare: `revalidateForReconnect` is
    // typed to RETURN a promise, but an implementation may still throw
    // synchronously before it returns one — and a bare call would throw past
    // this `.catch`, past the `finally` that clears the budget timer, and out
    // of the `void`-discarded caller as an unhandled rejection, stranding the
    // session in "reconnecting" with nothing armed. Wrapping makes a sync throw
    // reach the same `.catch` an async rejection does.
    const revalidation = Promise.resolve()
      .then(() => auth.revalidateForReconnect())
      .catch((): RevalidateOutcome => "network-error");
    try {
      return await Promise.race([revalidation, budget]);
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
  }

  private goTerminalFatal(details: FatalErrorDetails): void {
    if (this.phase === "closed") {
      return;
    }
    this.phase = "closed";
    this.restoredStreamIds.clear();
    this.clearAllTimers();
    this.teardownConnection("session-fatal");
    for (const stream of this.subscriptions.values()) {
      stream.goFatal(details);
    }
    this.subscriptions.clear();
    this.rejectAllPendingUnary(
      new HostRpcError({
        code: isRpcErrorCode(details.code) ? details.code : "RPC_ERROR",
        message: details.reason,
        requestId: "session-fatal",
        method: "",
        fatalDetails: details,
      }),
    );
    this.emitClosed();
  }

  private scheduleReconnect(): void {
    if (this.phase === "closed") {
      return;
    }
    if (this.backoffTimer !== null) {
      clearTimeout(this.backoffTimer);
    }
    const delay = backoffFor(
      this.reconnectAttempt,
      RECONNECT_INITIAL_BACKOFF_MS,
      RECONNECT_MAX_BACKOFF_MS,
    );
    this.reconnectAttempt += 1;
    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = null;
      void this.beginConnect();
    }, delay);
  }

  // ---- Re-auth loop + host-standing watchdog (R4-D2) --------------------- //

  private startReauthLoop(): void {
    this.clearReauthTimer();
    const jitter = Math.round(
      CLIENT_REAUTH_JITTER_MS * 2 * this.pseudoJitter() -
        CLIENT_REAUTH_JITTER_MS,
    );
    const delay = Math.max(CLIENT_REAUTH_INTERVAL_MS + jitter, 60_000);
    this.reauthTimer = setTimeout(() => {
      this.reauthTimer = null;
      void this.runClientReauth();
    }, delay);
  }

  private async runClientReauth(): Promise<void> {
    const connection = this.connection;
    if (this.phase !== "ready" || connection === null) {
      return;
    }
    const provision = await this.options.grantProvider();
    if (this.phase !== "ready" || this.connection !== connection) {
      return;
    }
    if (provision.kind === "plan-restricted") {
      // Mid-session downgrade: end the session now rather than letting the
      // relay's client-leg deadline kill it opaquely later.
      this.goTerminalFatal(planRestrictedFatalDetails());
      return;
    }
    if (provision.kind === "ok") {
      connection.relaySocket.sendReauth(provision.grant.grant);
    }
    // Re-arm regardless: a failed mint retries at the next cadence, still under
    // the relay's 60-min client-leg deadline (we mint at ~45 min with slack).
    this.startReauthLoop();
  }

  /**
   * Resets the peer-enforced host-standing watchdog on any evidence the host is
   * alive + bridging (inbound frame / host_attached / reauth_notice). If the
   * host goes silent past the 15-min bound the client fails the session itself
   * (R4-D2) — a revoked host will not enforce its own death.
   */
  private armStandingTimer(): void {
    if (this.standingTimer !== null) {
      clearTimeout(this.standingTimer);
    }
    const generation = this.connectGeneration;
    this.standingTimer = setTimeout(() => {
      this.standingTimer = null;
      this.handleConnectionLost(generation, "host-standing-lapsed");
    }, HOST_STANDING_BOUND_MS);
  }

  // ---- Wire write + framing helpers -------------------------------------- //

  private enqueueMessage(
    connection: ActiveConnection,
    message: OutboundMessage,
  ): void {
    const frames = chunkOutboundMessage(message, () =>
      this.nextSeq(message.streamId),
    );
    for (const frame of frames) {
      connection.scheduler.enqueue({ qos: frame.qos, frame });
    }
  }

  private async writeFrame(
    generation: number,
    item: OutboundFrame,
  ): Promise<void> {
    if (!this.isCurrent(generation)) {
      return;
    }
    const connection = this.connection;
    if (connection === null) {
      return;
    }
    const plaintext = encodeMuxFrame(item.frame);
    const sealed = await connection.noise.encrypt(plaintext);
    if (!this.isCurrent(generation)) {
      return;
    }
    if (!connection.relaySocket.sendData(sealed)) {
      throw new Error("relay socket send failed");
    }
  }

  private nextSeq(streamId: number): number {
    const current = this.outboundSeq.get(streamId) ?? 0;
    this.outboundSeq.set(streamId, current + 1);
    return current;
  }

  private allocateStreamId(): number {
    const id = this.nextStreamId;
    this.nextStreamId += 1;
    return id;
  }

  // ---- Pending unary bookkeeping ----------------------------------------- //

  private findPendingByRequestId(
    requestId: string,
  ): { streamId: number; entry: PendingUnary } | null {
    for (const [streamId, entry] of this.pendingUnary) {
      if (entry.requestId === requestId) {
        return { streamId, entry };
      }
    }
    return null;
  }

  private clearPendingUnary(streamId: number): void {
    const entry = this.pendingUnary.get(streamId);
    if (entry === undefined) {
      return;
    }
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
    }
    this.pendingUnary.delete(streamId);
    this.outboundSeq.delete(streamId);
  }

  private rejectUnary(streamId: number, error: HostRpcError): void {
    const entry = this.pendingUnary.get(streamId);
    if (entry === undefined) {
      return;
    }
    this.clearPendingUnary(streamId);
    entry.reject(error);
  }

  private rejectAllPendingUnary(error: HostRpcError): void {
    for (const [streamId, entry] of Array.from(this.pendingUnary)) {
      if (entry.timer !== null) {
        clearTimeout(entry.timer);
      }
      this.pendingUnary.delete(streamId);
      this.outboundSeq.delete(streamId);
      entry.reject(error);
    }
  }

  // ---- Small helpers ----------------------------------------------------- //

  private markStreamsReconnecting(): void {
    for (const stream of this.subscriptions.values()) {
      stream.notifyStatus("reconnecting", null);
    }
  }

  private markStreamRestored(streamId: number): void {
    if (!this.subscriptions.has(streamId)) {
      return;
    }
    this.restoredStreamIds.add(streamId);
    this.maybeReachReadyBoundary();
  }

  private maybeReachReadyBoundary(): void {
    if (
      this.phase !== "ready" ||
      this.readyBoundaryGeneration === this.connectGeneration
    ) {
      return;
    }
    for (const streamId of this.subscriptions.keys()) {
      if (!this.restoredStreamIds.has(streamId)) {
        return;
      }
    }
    this.readyBoundaryGeneration = this.connectGeneration;
    this.reconnectAttempt = 0;
    if (this.droppedSinceReady) {
      // The session just fully recovered from a drop (re-attach + streams
      // restored) - the "endpoint recovered" evidence availability-recovered
      // consumers refetch on. A clean first open never sets the flag.
      this.droppedSinceReady = false;
      this.emitAvailabilityRecovered();
    }
  }

  private clientStreamCanonical(method: string): SchemaVersion {
    const canonical = this.clientManifests.stream[method];
    return canonical ?? { major: 1, minor: 0 };
  }

  private readBearerOrNull(): string | null {
    try {
      return extractBearerForOpenFrame(this.options.bearer());
    } catch {
      return null;
    }
  }

  private isCurrent(generation: number): boolean {
    return (
      generation === this.connectGeneration &&
      this.connection !== null &&
      this.connection.generation === generation &&
      this.phase !== "closed"
    );
  }

  private emitClosed(): void {
    const listeners = Array.from(this.closedListeners);
    this.closedListeners.clear();
    this.availabilityRecoveredListeners.clear();
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        console.error("[remote-session] closed listener threw", error);
      }
    }
  }

  private emitAvailabilityRecovered(): void {
    // Guarded per listener: the emission happens inside inbound frame
    // dispatch, so a throwing consumer must not break the session's message
    // processing or the other listeners (parity with `WsStreamClient`).
    for (const listener of Array.from(this.availabilityRecoveredListeners)) {
      try {
        listener();
      } catch (error) {
        console.error(
          "[remote-session] availability-recovered listener threw",
          error,
        );
      }
    }
  }

  private teardownConnection(reason: string): void {
    const connection = this.connection;
    this.connection = null;
    this.openFrameBearer = null;
    this.clearPhaseTimer();
    this.clearReauthTimer();
    this.clearStandingTimer();
    if (connection === null) {
      return;
    }
    connection.scheduler.stop();
    connection.reassembler.reset();
    connection.relaySocket.close(1000, reason);
    connection.noise.wipe();
  }

  private armPhaseTimer(
    generation: number,
    timeoutMs: number,
    cause: string,
  ): void {
    this.clearPhaseTimer();
    this.phaseTimer = setTimeout(() => {
      this.phaseTimer = null;
      this.handleConnectionLost(generation, cause);
    }, timeoutMs);
  }

  private clearPhaseTimer(): void {
    if (this.phaseTimer !== null) {
      clearTimeout(this.phaseTimer);
      this.phaseTimer = null;
    }
  }

  private clearReauthTimer(): void {
    if (this.reauthTimer !== null) {
      clearTimeout(this.reauthTimer);
      this.reauthTimer = null;
    }
  }

  private clearStandingTimer(): void {
    if (this.standingTimer !== null) {
      clearTimeout(this.standingTimer);
      this.standingTimer = null;
    }
  }

  private clearAllTimers(): void {
    this.clearPhaseTimer();
    this.clearReauthTimer();
    this.clearStandingTimer();
    if (this.backoffTimer !== null) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
  }

  /**
   * Deterministic per-arming jitter in [0,1). `Math.random` is banned in the
   * workflow sandbox but this is production client code (not a workflow), so
   * `Math.random` is used directly for re-auth spread.
   */
  private pseudoJitter(): number {
    return Math.random();
  }
}

// -----------------------------------------------------------------------------
// Module helpers
// -----------------------------------------------------------------------------

/**
 * Cap on consecutive `UNAUTHORIZED` session-fatal recoveries where the
 * revalidation keeps returning a current credential the host keeps rejecting
 * (no token rotation making progress). After this many no-progress cycles the
 * session goes terminal instead of looping forever - mirrors the local stream
 * transport's identically-named bound.
 */
const MAX_NO_PROGRESS_UNAUTHORIZED_RECONNECTS = 3;

/**
 * Upper bound on how long an `UNAUTHORIZED` revalidation may run before the
 * session gives up waiting and treats it as a transient "network-error". Caps
 * the "reconnecting" window so a hung authn refresh can never strand the
 * session - the normal reconnect backoff then retries. Mirrors the local
 * stream transport's `REVALIDATE_TIMEOUT_MS`.
 */
const UNAUTHORIZED_REVALIDATE_TIMEOUT_MS = 10_000;

function buildRpcManifest(registry: VersionedRpcRegistry): ConnectionManifest {
  const manifest: Record<string, SchemaVersion> = {};
  for (const method of Object.keys(registry)) {
    manifest[method] = canonicalForMethodVersionLine(registry[method], method);
  }
  return manifest;
}

function indexMethodRegistry(
  registry: VersionedRpcRegistry,
  method: string,
): MethodVersionRegistry {
  const entry = registry[method];
  return entry as MethodVersionRegistry;
}

function unaryTimeoutError(requestId: string, method: string): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message: `Remote unary '${method}' timed out awaiting a response`,
    requestId,
    method,
    fatalDetails: null,
  });
}

function asHostRpcError(
  cause: unknown,
  requestId: string,
  method: string,
): HostRpcError {
  if (cause instanceof HostRpcError) {
    return cause;
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return new HostRpcError({
    code: "RPC_ERROR",
    message,
    requestId,
    method,
    fatalDetails: null,
  });
}

/**
 * Fatal code for the attach-grant entitlement denial. UI layers key the
 * paid-plan upsell on this instead of a generic session failure. Free-string
 * `FatalErrorDetails.code` space, so no protocol change is involved.
 */
export const PLAN_RESTRICTED_FATAL_CODE = "PLAN_RESTRICTED";

function planRestrictedFatalDetails(): FatalErrorDetails {
  return {
    code: PLAN_RESTRICTED_FATAL_CODE,
    reason: "Remote host connectivity requires a paid plan",
    incompatibleMethods: null,
    upgradeGuidance: null,
  };
}

function incompatibleStreamDetails(method: string): FatalErrorDetails {
  return {
    code: "INCOMPATIBLE",
    reason: `Stream method '${method}' is not compatible with the host`,
    incompatibleMethods: null,
    upgradeGuidance: null,
  };
}

function isStreamEnvelope(
  value: Record<string, unknown>,
): value is StreamFrameEnvelope {
  return (
    typeof value.kind === "string" &&
    typeof value.hasBinaryPayload === "boolean"
  );
}

/** Re-exported for tests / callers that need the connection status union. */
export type { StreamConnectionStatus, StreamCloseReason };
