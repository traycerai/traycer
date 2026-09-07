import {
  CLIENT_CAPABILITY_EPIC_WRITE_PATH_V1,
  checkCompatibility,
  isRpcErrorCode,
  UNARY_CAPABILITY_IDEMPOTENCY_KEY,
  type ConnectionManifest,
  type FatalErrorDetails,
  type MethodVersionRegistry,
  type SchemaVersion,
  type VersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import {
  mergeConnectionManifests,
  selectConnectionManifestForPeer,
  splitConnectionManifest,
  SERVES_EVERY_INSTALLED_MAJOR,
} from "@traycer/protocol/framework/capability-manifest";
import { CLIENT_SERVED_STREAM_MAJORS } from "../served-stream-majors";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
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
import {
  clockSkewStreamReason,
  type ServerClockSkewSignal,
} from "@traycer-clients/shared/clock/server-time-offset-tracker";
import type { TransportEvidenceReporter } from "@traycer-clients/shared/host-selection/transport-evidence";
import type { IStreamWebSocketFactory } from "../ws-stream-factory";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "../i-stream-session";
import type { TimerHandle } from "../timer-handle";
import {
  HostRequestAbortedError,
  HostRpcError,
  HostTransportFailureError,
  RetryableTransportError,
  type RequestOfMethod,
  type ResponseOfMethod,
} from "../host-messenger";
import {
  extractBearerForOpenFrame,
  prepareRequestPayload,
  decodeResponsePayloadWithContext,
} from "../ws-rpc-client";
import {
  prepareStreamSubscribeRequest,
  type ParamsOf,
} from "../ws-stream-client";
import type { WakeProbeTuning } from "../host-stream-client";
import { jitteredBackoffFor } from "../backoff";
import {
  CLIENT_REAUTH_INTERVAL_MS,
  CLIENT_REAUTH_JITTER_MS,
  DIAL_FAILURE_RESTATE_MS,
  HOST_STANDING_BOUND_MS,
  INITIAL_BULK_SEND_CREDITS,
  MAX_TERMINAL_STREAM_IDS,
  ATTACH_ACK_TIMEOUT_MS,
  NOISE_HANDSHAKE_TIMEOUT_MS,
  PLAN_RESTRICTED_FATAL_CODE,
  SESSION_OPEN_ACK_TIMEOUT_MS,
  UNARY_RESPONSE_TIMEOUT_MS,
  RECONNECT_INITIAL_BACKOFF_MS,
  RECONNECT_MAX_BACKOFF_MS,
  RECONNECT_STABLE_RESET_MS,
  RELAY_WAKE_PROBE_TIMEOUT_MS,
  RESTORE_STALL_LOG_AFTER_MS,
  REASSEMBLY_PROGRESS_TIMEOUT_MS,
} from "./config";
import { DialFailureLog } from "./dial-failure-log";
import { recordNegotiatedHostManifest } from "../negotiated-manifest-registry";
import { resolveUnavailableMethodDegrade } from "../unavailable-method-degrade";
import {
  CURRENT_MUX_VERSION,
  FINE_INITIAL_BULK_SEND_CREDITS,
  MuxFrameDecodeError,
  MuxFrameType,
  MuxMessageSizeError,
  QosClass,
  SESSION_CONTROL_STREAM_ID,
  SESSION_CAPABILITY_BODY_COMPRESSION,
  SESSION_CAPABILITY_CREDENTIAL_UPDATE,
  SESSION_CAPABILITY_FINE_CREDITS,
  creditPayloadSchema,
  decodeMuxFrame,
  encodeMuxFrame,
  fatalPayloadSchema,
  sessionOpenAckPayloadSchema,
  unaryResponsePayloadSchema,
  type EncodeMuxFrameInput,
  type MuxFrame,
  type QosClassValue,
  type SessionManifests,
  type SessionOpenPayload,
} from "@traycer/protocol/host-transport/mux";
import {
  toClientHandshakeIdentity,
  type ClientHandshakeIdentity,
  type FirstPartyClientIdentity,
} from "@traycer/protocol/framework/client-identity";
import {
  ChunkReassembler,
  ChunkReassemblyError,
  OutboundChunkSource,
  type OutboundMessage,
  type ReassembledMessage,
} from "@traycer/protocol/host-transport/chunking";
import { InboundCreditTracker, PriorityScheduler } from "./scheduler";
import { NoiseChannel } from "./noise-channel";
import { RelaySocket, type RelayKillReason } from "./relay-socket";
import type { AttachGrantProvider } from "./grant-client";
import { LogicalStream, type LogicalStreamPort } from "./logical-stream";

/**
 * Streaming methods that ride the credit-gated `bulk` mux queue instead of the default `interactive` class.
 * Every other stream method stays interactive - keystrokes, terminal/chat output, and status polls must preempt bulk traffic.
 */
const BULK_QOS_STREAM_METHODS: ReadonlySet<string> = new Set([
  "workspace.streamAsset",
  "git.streamFileAsset",
]);

function qosForStreamMethod(method: string): QosClassValue {
  return BULK_QOS_STREAM_METHODS.has(method)
    ? QosClass.BULK
    : QosClass.INTERACTIVE;
}

/**
 * The client's persistent, E2E, multiplexed remote session (Architecture §3).
 * Never on socket-open, never on the boundary alone, and never on a wake - a connection that opens and dies repeatedly must escalate, not present itself as a first failure forever.
 */

/**
 * Whether a connection loss is evidence about the host, or only about us.
 * `not-host-evidence` means we tore the connection down ourselves, had no bearer, or the relay killed only its client leg.
 */
type ConnectionLossProvenance = "host-transport-plane" | "not-host-evidence";

/**
 * Where the wall-clock of one connect attempt went, stamped at each phase transition.
 * Every field after `startedAt` is `null` until its phase is reached.
 */
interface ReattachMarks {
  /**
   * When the link was lost, not when the redial began - `0` when this connect follows no loss (the first-ever connect).
   */
  lostAt: number;
  startedAt: number;
  attachAckAt: number | null;
  handshakeAt: number | null;
  openAckAt: number | null;
}

function emptyReattachMarks(): ReattachMarks {
  return {
    lostAt: 0,
    startedAt: 0,
    attachAckAt: null,
    handshakeAt: null,
    openAckAt: null,
  };
}

/**
 * Whether a host-sent session fatal is evidence about the host's transport plane, or about the credential plane standing between us and it.
 */
function sessionFatalProvenance(
  details: FatalErrorDetails,
): ConnectionLossProvenance {
  return details.code === "UNAUTHORIZED"
    ? "not-host-evidence"
    : "host-transport-plane";
}

/**
 * Relay `policy_violation` is commonly a client-leg congestion decision, not a statement from the host.
 * Unknown relay kill reasons must fail the same way: new relays can emit them before this client learns their semantics.
 */
function relayKillProvenance(
  reason: RelayKillReason,
): ConnectionLossProvenance {
  return reason === "reauth_timeout" || reason === "host_gone"
    ? "host-transport-plane"
    : "not-host-evidence";
}

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
   * Auth recovery hook invoked when the host FATALs the session with `unauthorized` - the in-channel `open{bearer}` was rejected (the overnight-wake case: the bearer expired while the renderer slept).
   * `null` keeps an `unauthorized` session fatal terminal, mirroring `WsStreamClientOptions.auth` for short-lived/dev clients that cannot recover an auth rejection by retrying the same bearer.
   */
  readonly auth: StreamAuthRevalidator | null;
  /**
   * Verdict on whether this machine's wall clock is trustworthy, from the shared server-time offset tracker.
   * Read at exactly one site here (the no-progress `unauthorized` bound), because unlike the local transport this session has no pre-dial expiry gate to read it at.
   */
  readonly clock: ServerClockSkewSignal | null;
  readonly rpcRegistry: RpcRegistry;
  readonly streamRegistry: StreamRegistry;
  readonly webSocketFactory: IStreamWebSocketFactory;
  readonly requestId: () => string;
  /** Shells with no authority to feed pass `NO_TRANSPORT_EVIDENCE`. */
  readonly evidence: TransportEvidenceReporter;
  /**
   * Who this client IS, sent on the session `open` frame and re-sent on every redial (each attach re-authenticates, so each is re-gated).
   * `remote-session.test.ts > RemoteSession client identity` pins that the value reaches the wire on every dial and redial; it does not - and from inside one process cannot - observe the cache key.
   */
  readonly clientIdentity: FirstPartyClientIdentity;
}

export interface IRemoteSession<
  RpcRegistry extends VersionedRpcRegistry,
  StreamRegistry extends VersionedStreamRpcRegistry,
> {
  start(): void;
  isClosed(): boolean;
  isReady(): boolean;
  /**
   * `abortSignal` is the caller's request authority (a cancelled TanStack read, a disposed host binding).
   */
  sendUnary<Method extends keyof RpcRegistry & string>(
    method: Method,
    params: RequestOfMethod<RpcRegistry, Method>,
    idempotencyKey: string | null,
    abortSignal: AbortSignal | null,
    /**
     * Per-request response budget, overriding `UNARY_RESPONSE_TIMEOUT_MS`.
     * `undefined` keeps the shared default, so only a caller that has a reason to wait longer changes anything - the extension is scoped to that call rather than re-scoring every unary this session carries.
     */
    responseTimeoutMs: number | undefined,
    /**
     * This send is a replay whose predecessor was only retryable because the key was negotiated (`HostRequestOptions.replayMustBeKeyed` in `host-messenger.ts`, which documents the full rule).
     * The key-stripping this session does for a host that predates the capability is a legitimate downgrade on a first send and a double-execution on this one, so a stripped key here refuses instead of dispatching.
     */
    replayMustBeKeyed: boolean,
  ): Promise<ResponseOfMethod<RpcRegistry, Method>>;
  subscribe<Method extends keyof StreamRegistry & string>(
    method: Method,
    params: ParamsOf<StreamRegistry, Method>,
  ): IStreamSession;
  subscribeAtVersion<Method extends keyof StreamRegistry & string>(
    method: Method,
    schemaVersion: SchemaVersion,
    params: ParamsOf<StreamRegistry, Method>,
  ): IStreamSession;
  subscribeWithParamsProvider<Method extends keyof StreamRegistry & string>(
    method: Method,
    paramsProvider: () => ParamsOf<StreamRegistry, Method>,
  ): IStreamSession;
  notifyBearerRotated(): void;
  /**
   * Tells the session that something outside it has evidence its connection should be re-established sooner than the backoff schedule intends.
   * Note what is not a caller: a request merely arriving at a session that is not ready.
   */
  wake(reason: string, probe: WakeProbeTuning | null): void;
  /**
   * Drops the current socket - alive or not - and redials with no backoff delay.
   * An attach already in flight is left alone - its own phase timers bound it, and a timer frozen through an OS suspend fires immediately on unfreeze, so a stale dial already fails fast on resume.
   */
  forceReconnect(reason: string): void;
  /**
   * Subscribes to the session's terminal close - a caller `close()` (on the shared session, once every consumer released) or a terminal session fatal.
   * Fires once, synchronously, after the session state is fully torn down.
   */
  onClosed(listener: () => void): () => void;
  /**
   * The terminal fatal that closed this session, or `null` while it is alive OR when it was closed by a caller (`close()` at refcount zero is a lifecycle event, not a verdict).
   */
  terminalFatal(): FatalErrorDetails | null;
  /**
   * The remote analog of the recovery evidence `WsStreamClient` surfaces via `subscribeAvailabilityRecovered`, consumed to un-strand errored host-scoped queries.
   * For a local transport "first open" happens once per app run before anything could have errored, so never-on-first-open costs nothing there; for the remote session it is precisely the gap.
   */
  subscribeAvailabilityRecovered(listener: () => void): () => void;
  /**
   * The down edge: this session was ready and no longer is.
   * Fires on the transition only, never on a re-assertion of the same state, and never for a terminal close (`onClosed` owns that edge - a session that died is not a session that became unready).
   */
  subscribeReadinessLost(listener: () => void): () => void;
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

interface PendingUnary {
  readonly requestId: string;
  readonly method: string;
  readonly clientCanonical: SchemaVersion;
  readonly hostCanonical: SchemaVersion;
  readonly methodRegistry: MethodVersionRegistry;
  readonly onWireRequest: unknown;
  /** This connection promised replay-by-key, so an unheard result may retry. */
  readonly replaySafe: boolean;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: HostRpcError) => void;
  timer: TimerHandle | null;
}

interface ActiveConnection {
  readonly generation: number;
  readonly relaySocket: RelaySocket;
  readonly noise: NoiseChannel;
  readonly scheduler: PriorityScheduler;
  readonly reassembler: ChunkReassembler;
  readonly inboundCredits: InboundCreditTracker;
  hostManifest: SessionManifests | null;
  /**
   * `hostManifest.rpc` + `hostManifest.optionalRpc`, merged once at ack.
   * Version selection and dispatch read this (an optional method must dispatch like any other); only the session-level compatibility check reads the raw floor.
   */
  hostRpcMerged: ConnectionManifest | null;
  credentialUpdateSupported: boolean;
  idempotencyKeySupported: boolean;
  /**
   * Whether the host advertised that it can inflate compressed frames, i.e. whether frames this client sends may set `MuxFlags.compressed`.
   * Starts `false` and is only ever raised at `openAck`, so the `open` frame itself - the one frame that must be readable by a host of any vintage - can never go out compressed.
   */
  bodyCompressionSupported: boolean;
  hostAttached: boolean;
}

/**
 * Instance counter behind {@link RemoteSession.evidenceScope}. Process-local
 * and never persisted or sent anywhere - it only has to be distinct.
 */
let nextRemoteEvidenceScope = 0;

export class RemoteSession<
  RpcRegistry extends VersionedRpcRegistry,
  StreamRegistry extends VersionedStreamRpcRegistry,
>
  implements LogicalStreamPort, IRemoteSession<RpcRegistry, StreamRegistry>
{
  private readonly options: RemoteSessionOptions<RpcRegistry, StreamRegistry>;
  private readonly clientManifests: SessionManifests;
  /** `clientManifests.rpc` + `.optionalRpc` merged - the dispatch view. */
  private readonly clientRpcMerged: ConnectionManifest;
  /**
   * Serialized once: every member is a process constant, and this frame is
   * rebuilt on every redial.
   */
  private readonly clientIdentity: ClientHandshakeIdentity;

  private phase: SessionPhase = "idle";
  private connectGeneration = 0;
  private reconnectAttempt = 0;
  /**
   * Armed at the ready boundary, fires after RECONNECT_STABLE_RESET_MS of uninterrupted health and only then clears the ladder.
   * Cancelled on every connection loss so a flapping host never collects partial credit.
   */
  private stableResetTimer: TimerHandle | null = null;
  /**
   * Armed when an attach completes with the ready boundary still unreached, cleared by the boundary or by connection loss.
   * That state is otherwise invisible: the surfaces above can only say "still can't connect", which misattributes it.
   */
  private restoreStallTimer: TimerHandle | null = null;
  /**
   * Armed/reset by every accepted chunk of a subscription stream's message, retired when that message completes (or the stream/connection ends).
   * The token makes a retired arm's callback provably inert - a cleared or superseded watchdog must never reopen a stream that completed or re-armed after it.
   */
  private readonly reassemblyWatchdogs = new Map<
    number,
    { readonly timer: TimerHandle; readonly token: number }
  >();
  /** Monotonic identity for reassembly-watchdog arms (see the map doc). */
  private reassemblyWatchdogToken = 0;
  /**
   * Streams whose current id exists because a reassembly-stall verdict re-keyed them.
   * Deliberately kept across connection drops: a session reconnect mid-loop replays the member through the same send path, and the loop must not reset with it.
   */
  private readonly stallReopenedStreamIds = new Set<number>();
  /**
   * Whether this session has ever reached its ready boundary.
   * Separates "recovering" from "still trying for the first time", which two behaviours below must not conflate.
   */
  private hasReachedReadyOnce = false;
  /**
   * Phase-transition stamps for the current connect attempt, emitted as one breakdown line at the ready boundary.
   * Reset per attempt, so a retry never reports its predecessor's timings.
   */
  private reattachMarks: ReattachMarks = emptyReattachMarks();
  /** When the current outage began, or `0` while a session is healthy. */
  private connectionLostAt = 0;
  private connection: ActiveConnection | null = null;

  /**
   * The same applies to session ids, which are unique only within a reporting incarnation.
   * Prefixing with a per-instance label makes both unique across the window without depending on host ids being delimiter-free.
   */
  private readonly evidenceScope = `remote-${(nextRemoteEvidenceScope += 1)}`;
  /** The session id currently announced to the authority as live, or null. */
  private announcedSessionId: string | null = null;
  /** Distinguishes a mid-session re-auth verdict from its generation's dial. */
  private reauthEvidenceSeq = 0;

  private readonly subscriptions = new Map<number, LogicalStream>();
  private readonly pendingUnary = new Map<number, PendingUnary>();
  /**
   * Next outbound `seq` per stream.
   * A bare `delete` before the enqueue sends the close at seq 0.
   */
  private readonly outboundSeq = new Map<number, number>();
  private readonly restoredStreamIds = new Set<number>();
  /**
   * Without this, a relay-delayed genuine `CHUNK_FIRST` for a dead stream would seed a fresh accumulator nothing ever completes or collects.
   * Bounded by `MAX_TERMINAL_STREAM_IDS` (streamIds are monotonic and never reused within a session, so evicting the oldest is safe).
   */
  private readonly terminalStreamIds = new Set<number>();
  private readonly closedListeners = new Set<() => void>();
  private readonly availabilityRecoveredListeners = new Set<() => void>();
  private readonly readinessLostListeners = new Set<() => void>();
  /** Last readiness this session published, not last readiness it had. */
  private lastPublishedReadiness = false;
  /**
   * Callers parked inside `sendUnary` waiting for this session to become usable.
   * Settled from exactly three places, which together are every exit a pre-ready session has: `handleOpenAck` (ready), `dropConnection` (this attach attempt is over), and `goTerminalFatal` / `close()` (never coming).
   */
  private readonly readyWaiters = new Set<{
    readonly requestId: string;
    readonly method: string;
    readonly resolve: () => void;
    readonly reject: (error: HostRpcError) => void;
    /** Detaches this waiter's abort listener. Called on every settle path. */
    readonly dispose: () => void;
  }>();
  private nextStreamId = 1;
  private readyBoundaryGeneration: number | null = null;
  private openFrameBearer: string | null = null;
  /**
   * Incremented only when a "rotated" revalidation left the next-attach bearer identical to the just-rejected one; a real rotation, a transient "network-error", or reaching `ready` all reset it.
   * At the cap the session goes terminal (mirrors the local stream transport's no-progress bound).
   */
  private noProgressUnauthorizedReconnects = 0;
  /**
   * Live subscription to the clock tracker's `skewed → ok` edge while this session is parked, or `null` when it is not.
   */
  private clockParkUnsubscribe: (() => void) | null = null;

  private phaseTimer: TimerHandle | null = null;
  private backoffTimer: TimerHandle | null = null;
  /**
   * When the pending `backoffTimer` was armed, and for how long - together, the deadline it will actually fire on.
   * Read by {@link collapseBackoff}, which may only move that deadline earlier.
   */
  private backoffArmedAt = 0;
  private backoffDelayMs = 0;
  /** Whether the pending `backoffTimer` has already spent its one wake-driven collapse. */
  private backoffCollapsed = false;
  /**
   * The connect generation a {@link forceReconnect} arrived during, when that generation's dial was already in flight and could be neither dropped (nothing attached yet) nor hurried (its own phase timers bound it).
   */
  private pendingForceGeneration: number | null = null;
  private reauthTimer: TimerHandle | null = null;
  private standingTimer: TimerHandle | null = null;
  /**
   * Pending per-stream re-opens after a retryable per-stream fatal, keyed by stream id, with the escalating attempt count that paces them.
   */
  private readonly streamReopenTimers = new Map<number, TimerHandle>();
  private readonly streamReopenAttempts = new Map<number, number>();

  /** Throttled connect-loop failure logging (see `dial-failure-log.ts`). */
  private readonly dialFailures: DialFailureLog;

  /** See {@link IRemoteSession.terminalFatal}. Set once, by `goTerminalFatal`. */
  private terminalFatalDetails: FatalErrorDetails | null = null;

  constructor(options: RemoteSessionOptions<RpcRegistry, StreamRegistry>) {
    this.options = options;
    const rpcSplit = splitConnectionManifest(
      options.rpcRegistry,
      RELEASED_FLOOR_METHOD_NAMES,
      // Unary methods have no client-side implementation to be missing: the client sends a request and reads a response, so every installed major is serveable.
      // Only the stream half needs narrowing.
      SERVES_EVERY_INSTALLED_MAJOR,
    );
    this.clientManifests = {
      rpc: rpcSplit.manifest,
      optionalRpc: rpcSplit.optionalManifest,
      stream: buildStreamManifest(
        options.streamRegistry,
        CLIENT_SERVED_STREAM_MAJORS,
      ),
    };
    this.clientRpcMerged = mergeConnectionManifests(
      rpcSplit.manifest,
      rpcSplit.optionalManifest,
    );
    this.clientIdentity = toClientHandshakeIdentity(options.clientIdentity);
    this.dialFailures = new DialFailureLog({
      label: `remote session (host ${options.hostId})`,
      now: () => Date.now(),
      repeatIntervalMs: DIAL_FAILURE_RESTATE_MS,
      // Console on purpose: this is shared oss transport code with no logger seam (parity with `WsStreamClient`), and the desktop shell forwards renderer console output into `traycer-desktop.log`.
      warn: (message) => console.warn(message),
      info: (message) => console.info(message),
    });
  }

  // ---- Public surface (consumed by the messenger + stream client) -------- //

  /** Kicks off the first connect if the session is idle. Idempotent. */
  start(): void {
    if (this.phase === "idle") {
      this.beginConnectGuarded();
    }
  }

  isClosed(): boolean {
    return this.phase === "closed";
  }

  /** See {@link IRemoteSession.terminalFatal}. */
  terminalFatal(): FatalErrorDetails | null {
    return this.terminalFatalDetails;
  }

  /**
   * `false` while idle/connecting/handshaking/reconnecting, so a session that is merely attempting to attach is never mistaken for proof of liveness.
   * Answering "ready" there is the standing lie R4-B5 exists to kill (Settings would render Online, off this session, for a host that is off - for up to the 15-min standing bound).
   */
  isReady(): boolean {
    return (
      this.phase === "ready" &&
      this.readyBoundaryGeneration === this.connectGeneration &&
      this.connection !== null &&
      this.connection.hostAttached
    );
  }

  /**
   * Streams with a partially-accumulated inbound chunk sequence on the current connection.
   * Mirror of the host session's accessor: the terminal tombstone regressions pin that a dead stream's delayed chunks can't park an accumulator here forever.
   */
  get pendingReassemblyCount(): number {
    return this.connection?.reassembler.pendingStreamCount ?? 0;
  }

  /**
   * Issues a single unary RPC over the session (single-flight, no post-send auto-retry - local parity).
   * The wait is bounded by the session's own phase machine, deliberately without a second fixed cap: a disconnected ~20s ceiling would re-introduce exactly the mid-dial strand it was meant to prevent.
   */
  async sendUnary<Method extends keyof RpcRegistry & string>(
    method: Method,
    params: RequestOfMethod<RpcRegistry, Method>,
    idempotencyKey: string | null,
    abortSignal: AbortSignal | null,
    responseTimeoutMs: number | undefined,
    replayMustBeKeyed: boolean,
  ): Promise<ResponseOfMethod<RpcRegistry, Method>> {
    this.start();
    const requestId = this.options.requestId();
    if (abortSignal !== null && abortSignal.aborted) {
      throw abortedRequestError(requestId, method);
    }
    if (this.phase !== "ready" || this.connection === null) {
      // Throws on a terminal session, a failed attach, or the caller's authority being aborted while parked; returns once this session is ready to carry the frame.
      try {
        await this.awaitReadyBoundary(requestId, method, abortSignal);
      } catch (cause) {
        if (cause instanceof RetryableTransportError) {
          // The attach this caller was riding has now provably failed, before anything was sent.
          // Only here.
          this.wake("pre-send-failure", null);
        }
        throw cause;
      }
      // Load-bearing, not belt-and-braces.
      if (abortSignal !== null && abortSignal.aborted) {
        throw abortedRequestError(requestId, method);
      }
    }
    const connection = this.connection;
    if (this.phase !== "ready" || connection === null) {
      // The wait resolved on a ready boundary that has already been lost again (a drop landing in the same tick).
      // Nothing was sent, so this keeps the pre-send retry license rather than pretending to be a host-originated failure.
      throw this.notReadyRejection(requestId, method);
    }
    if (!connection.hostAttached) {
      // Relay said `host_detached`: the scheduler is paused and nothing will drain it (host re-attach forces a full re-dial - see `onHostAttached`).
      return Promise.reject(
        new RetryableTransportError({
          code: "RPC_ERROR",
          message: "Remote host is detached from the relay",
          requestId,
          method,
          fatalDetails: null,
          // Pre-send: the frame was never enqueued, so the next attempt is a
          // first send however it is keyed.
          replaySafetyFromKey: false,
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
          // Pre-send, same as the detached case above.
          replaySafetyFromKey: false,
        }),
      );
    }

    const clientCanonical = this.clientRpcMerged[method];
    const hostCanonical = connection.hostRpcMerged?.[method];
    const methodRegistry = indexMethodRegistry(
      this.options.rpcRegistry,
      method,
    );
    if (clientCanonical === undefined || hostCanonical === undefined) {
      // A generic `RPC_ERROR` would surface as a real failure instead.
      return this.executeUnavailableMethodDegrade(
        connection,
        method,
        methodRegistry,
        clientCanonical,
        connection.hostRpcMerged ?? {},
        params,
        requestId,
        responseTimeoutMs,
        idempotencyKey,
        replayMustBeKeyed,
      );
    }

    return this.dispatchNegotiatedUnary(
      connection,
      method,
      methodRegistry,
      clientCanonical,
      hostCanonical,
      params,
      requestId,
      responseTimeoutMs,
      idempotencyKey,
      replayMustBeKeyed,
    ) as Promise<ResponseOfMethod<RpcRegistry, Method>>;
  }

  /** Parks until this session can carry a frame, or until it provably cannot. */
  private awaitReadyBoundary(
    requestId: string,
    method: string,
    abortSignal: AbortSignal | null,
  ): Promise<void> {
    if (this.isClosed()) {
      return Promise.reject(this.notReadyRejection(requestId, method));
    }
    // A parked waiter carries NO timer of its own, so it is settled only by a later transition reaching `settleReadyWaiters` - `handleOpenAck`, `dropConnection`, `goTerminalFatal` or `close`.
    // `sendUnary` calls `start()` before parking, so an attempt always owns the loop.
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        requestId,
        method,
        resolve,
        reject,
        dispose: (): void => {
          if (abortSignal === null) return;
          abortSignal.removeEventListener("abort", onAbort);
        },
      };
      // Named rather than inline so `dispose` can remove exactly this listener.
      // A waiter that settles normally must not leave a listener on a signal that can outlive it (a request context's signal lives as long as the sign-in session), which is a leak per parked call.
      const onAbort = (): void => {
        if (!this.readyWaiters.delete(waiter)) return;
        waiter.dispose();
        reject(abortedRequestError(requestId, method));
      };
      if (abortSignal !== null) {
        abortSignal.addEventListener("abort", onAbort);
      }
      this.readyWaiters.add(waiter);
    });
  }

  /** Settles every parked `sendUnary` caller. */
  private settleReadyWaiters(ready: boolean): void {
    if (this.readyWaiters.size === 0) {
      return;
    }
    const waiters = Array.from(this.readyWaiters);
    this.readyWaiters.clear();
    for (const waiter of waiters) {
      waiter.dispose();
      if (ready) {
        waiter.resolve();
        continue;
      }
      waiter.reject(this.notReadyRejection(waiter.requestId, waiter.method));
    }
  }

  /** The pre-send failure for a session that is not carrying frames. */
  private notReadyRejection(
    requestId: string,
    method: string,
  ): HostTransportFailureError {
    const notReady = {
      code: "RPC_ERROR" as const,
      message: this.isClosed()
        ? "Remote session is closed"
        : "Remote session is not ready",
      requestId,
      method,
      fatalDetails: this.isClosed() ? this.terminalFatalDetails : null,
    };
    return this.isClosed()
      ? new HostTransportFailureError(notReady)
      : new RetryableTransportError({
          ...notReady,
          // "Not ready" is decided before anything is enqueued, so this
          // retryability is the no-dispatch guarantee, not a key.
          replaySafetyFromKey: false,
        });
  }

  /** Sends an already-negotiated method at explicit versions. */
  private dispatchNegotiatedUnary(
    connection: ActiveConnection,
    method: string,
    methodRegistry: MethodVersionRegistry,
    clientCanonical: SchemaVersion,
    hostCanonical: SchemaVersion,
    params: unknown,
    requestId: string,
    responseTimeoutMs: number | undefined,
    idempotencyKey: string | null,
    replayMustBeKeyed: boolean,
  ): Promise<unknown> {
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

    const wireIdempotencyKey = connection.idempotencyKeySupported
      ? idempotencyKey
      : null;
    if (replayMustBeKeyed && wireIdempotencyKey === null) {
      // Decided before `allocateStreamId` so a refusal costs no stream id: it reads `connection.idempotencyKeySupported` and nothing else, so hoisting it above the allocation changes no other ordering.
      // An earlier attempt of this call went out keyed and its outcome is unknown; the only reason it was replayable at all is that that connection deduplicates the key.
      return Promise.reject(
        new HostTransportFailureError({
          code: "RPC_ERROR",
          message: `Remote session cannot honour the idempotency key a replay of '${method}' requires`,
          requestId,
          method,
          fatalDetails: null,
        }),
      );
    }
    const streamId = this.allocateStreamId();
    const replaySafe = wireIdempotencyKey !== null;
    return new Promise<unknown>((resolve, reject) => {
      {
        const timer = setTimeout(() => {
          this.rejectUnary(
            streamId,
            replaySafe
              ? retryableUnaryFailure(
                  requestId,
                  method,
                  `Remote unary '${method}' timed out awaiting a response`,
                )
              : unaryTimeoutError(requestId, method),
          );
        }, responseTimeoutMs ?? UNARY_RESPONSE_TIMEOUT_MS);
        this.pendingUnary.set(streamId, {
          requestId,
          method,
          clientCanonical,
          hostCanonical,
          methodRegistry,
          onWireRequest: prepared.onWirePayload,
          replaySafe,
          resolve,
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
              idempotencyKey: wireIdempotencyKey,
            },
            binary: null,
          });
        } catch (cause) {
          this.clearPendingUnary(streamId);
          // Nothing was enqueued, so nothing follows on this stream.
          this.retireOutboundSeq(streamId);
          reject(asHostRpcError(cause, requestId, method));
        }
      }
    });
  }

  /**
   * Opens a logical subscribe stream (interactive class by default, bulk
   * for the methods in `qosForStreamMethod`; see §3 QoS note).
   */
  subscribe<Method extends keyof StreamRegistry & string>(
    method: Method,
    params: ParamsOf<StreamRegistry, Method>,
  ): IStreamSession {
    return this.subscribeWithParamsProviderInternal(method, () => params, null);
  }

  subscribeAtVersion<Method extends keyof StreamRegistry & string>(
    method: Method,
    schemaVersion: SchemaVersion,
    params: ParamsOf<StreamRegistry, Method>,
  ): IStreamSession {
    return this.subscribeWithParamsProviderInternal(
      method,
      () => params,
      schemaVersion,
    );
  }

  /**
   * Opens a logical stream whose params are re-read for every full attach.
   * The mux reconnect path re-opens every live LogicalStream, so keeping the provider on that stream makes resume cursors current at the exact wire subscribe boundary rather than frozen at session creation.
   */
  subscribeWithParamsProvider<Method extends keyof StreamRegistry & string>(
    method: Method,
    paramsProvider: () => ParamsOf<StreamRegistry, Method>,
  ): IStreamSession {
    return this.subscribeWithParamsProviderInternal(
      method,
      paramsProvider,
      null,
    );
  }

  private subscribeWithParamsProviderInternal<
    Method extends keyof StreamRegistry & string,
  >(
    method: Method,
    paramsProvider: () => ParamsOf<StreamRegistry, Method>,
    requiredSchemaVersion: SchemaVersion | null,
  ): IStreamSession {
    this.start();
    const streamId = this.allocateStreamId();
    const stream = new LogicalStream({
      streamId,
      method,
      paramsProvider,
      // Recomputed against the host manifest at (re)subscribe; a provisional
      // client-canonical version is fine until then.
      schemaVersion: this.clientStreamCanonical(method),
      requiredSchemaVersion,
      qos: qosForStreamMethod(method),
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

  /** See {@link IRemoteSession.wake}. */
  wake(reason: string, probe: WakeProbeTuning | null): void {
    if (this.phase === "closed" || this.phase === "idle") {
      // Closed is terminal, and idle has never dialed - `start()` owns that,
      // and every caller that wants a session calls it first.
      return;
    }
    if (this.phase === "ready" && this.connection !== null) {
      // A dial caught mid-flight is bounded by its own one-shot phase timer instead, which comes back overdue and fires on its own, so it needs nothing here.
      this.connection.relaySocket.pokeKeepalive(
        probe === null ? RELAY_WAKE_PROBE_TIMEOUT_MS : probe.timeoutMs,
        probe !== null && probe.immediateRedialOnFailure,
      );
    }
    this.collapseBackoff(reason);
  }

  /** See {@link IRemoteSession.forceReconnect}. */
  forceReconnect(reason: string): void {
    if (this.phase === "closed" || this.phase === "idle") {
      return;
    }
    const connection = this.connection;
    if (this.phase === "ready" && connection !== null) {
      this.handleConnectionLost(
        connection.generation,
        `forced-reconnect:${reason}`,
        "not-host-evidence",
      );
      this.pullRedialToNow(reason);
      return;
    }
    if (this.backoffTimer !== null) {
      this.pullRedialToNow(reason);
      return;
    }
    // Success consumes the intent - a fresh attach is everything a force could have bought.
    this.pendingForceGeneration = this.connectGeneration;
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

  /** See {@link IRemoteSession.subscribeReadinessLost}. */
  subscribeReadinessLost(listener: () => void): () => void {
    if (this.phase === "closed") {
      return () => undefined;
    }
    this.readinessLostListeners.add(listener);
    return () => {
      this.readinessLostListeners.delete(listener);
    };
  }

  /** Tears the session down permanently: closes the socket, fails everything. */
  close(): void {
    if (this.phase === "closed") {
      return;
    }
    this.dialFailures.recordAbandoned();
    this.phase = "closed";
    this.pendingForceGeneration = null;
    this.restoredStreamIds.clear();
    this.stallReopenedStreamIds.clear();
    // A parked session's tracker subscription is the one handle that is not a timer, so `clearAllTimers` cannot reach it.
    this.clearClockPark();
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
    this.settleReadyWaiters(false);
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
    try {
      // Fixed-per-stream class (per-stream FIFO invariant); a large binary is still chunked at 64 KiB but stays this stream's class (the chunk source overrides >1 MiB bodies to bulk).
      this.enqueueMessage(connection, {
        type: MuxFrameType.STREAM_FRAME,
        streamId,
        qos: stream.qos,
        json: { ...envelope },
        binary: binaryPayload,
      });
    } catch (error) {
      if (
        !(error instanceof MuxMessageSizeError) &&
        !(error instanceof RangeError)
      ) {
        throw error;
      }
      connection.scheduler.dropStreamOutbound(streamId);
      connection.reassembler.forget(streamId);
      this.markStreamTerminal(streamId);
      this.subscriptions.delete(streamId);
      this.restoredStreamIds.delete(streamId);
      const nextSeq = this.retireOutboundSeq(streamId);
      // Terminal end: same retry-state cleanup as the fatal/close branches.
      this.clearStreamReopen(streamId);
      stream.goFatal({
        code: "STREAM_MESSAGE_TOO_LARGE",
        reason: error.message,
        incompatibleMethods: null,
        upgradeGuidance: null,
      });
      this.enqueueMessageWithSeq(
        connection,
        {
          type: MuxFrameType.CLOSE,
          streamId,
          qos: QosClass.INTERACTIVE,
          json: { reason: "outbound frame exceeded the message cap" },
          binary: null,
        },
        nextSeq,
      );
      this.maybeReachReadyBoundary();
    }
  }

  /** `LogicalStreamPort.requestSessionReconnect`. */
  requestSessionReconnect(reason: string): void {
    if (this.phase === "closed" || this.phase === "idle") {
      return;
    }
    this.handleConnectionLost(
      this.connectGeneration,
      reason,
      "not-host-evidence",
    );
  }

  closeStream(streamId: number, reason: string): void {
    const connection = this.connection;
    this.subscriptions.delete(streamId);
    this.restoredStreamIds.delete(streamId);
    const nextSeq = this.retireOutboundSeq(streamId);
    // A caller close outranks a pending retryable re-open: without this the
    // timer would re-subscribe a stream the consumer has already abandoned.
    this.clearStreamReopen(streamId);
    this.clearReassemblyWatchdog(streamId);
    this.stallReopenedStreamIds.delete(streamId);
    // Locally-closed is terminal: clear any partial inbound accumulator and
    // tombstone the id so an in-flight/delayed server frame can't reseed one.
    connection?.reassembler.forget(streamId);
    this.markStreamTerminal(streamId);
    if (this.phase === "ready" && connection !== null) {
      // Drop the stream's queued/mid-transfer outbound first, or per-stream FIFO would park this close behind a transfer nobody wants anymore (the peer's reassembler accepts a close mid-sequence as an abort).
      connection.scheduler.dropStreamOutbound(streamId);
      this.enqueueMessageWithSeq(
        connection,
        {
          type: MuxFrameType.CLOSE,
          streamId,
          qos: QosClass.INTERACTIVE,
          json: { reason },
          binary: null,
        },
        nextSeq,
      );
    }
    this.maybeReachReadyBoundary();
  }

  // ---- Connect / attach / handshake / open ------------------------------- //

  private async beginConnect(): Promise<void> {
    if (this.phase === "closed") {
      return;
    }
    // A dial is happening, so nothing is parked any more - whether we got here from the recovery edge or from any path that armed a backoff straight through a park.
    // Idempotent.
    this.clearClockPark();
    const generation = ++this.connectGeneration;
    this.pendingForceGeneration = null;
    this.phase = "connecting";
    this.clearPhaseTimer();
    this.reattachMarks = {
      ...emptyReattachMarks(),
      lostAt: this.connectionLostAt,
      startedAt: Date.now(),
    };

    const provision = await this.options.grantProvider();
    if (generation !== this.connectGeneration || this.isClosed()) {
      return;
    }
    if (provision.kind === "plan-restricted") {
      // Entitlement denial: the account's plan lacks remote connectivity.
      // Backoff cannot fix a plan - go terminal so the caller surfaces the upsell instead of silently redialing forever.
      this.goTerminalFatal(planRestrictedFatalDetails());
      // The sole provenance of `dead("plan-restricted")` (grant-client's `plan-restricted` arm).
      // Unlike every other mint failure this is a stable per-host entitlement verdict, not a fleet-correlated outage, which is why it counts as host evidence at all.
      this.reportEvidenceOutcome(
        this.dialAttemptId(generation),
        "plan-restricted",
      );
      return;
    }
    if (provision.kind === "unavailable") {
      // No grant (signed out / revoked / transient CS failure): stay in backoff.
      // This attach attempt is over before it dialed, so parked `sendUnary` callers settle here rather than riding an unbounded number of further mint attempts inside one call.
      this.settleReadyWaiters(false);
      // Indeterminate, never a refusal.
      // Counting it would let one authn outage reach the confirmed-death streak on every remote host simultaneously and fail the whole fleet over to local, which is the false-Offline class invariant 5 exists to prevent.
      this.reportEvidenceOutcome(
        this.dialAttemptId(generation),
        "indeterminate",
      );
      const retryInMs = this.scheduleReconnectForFailedGeneration(generation);
      this.dialFailures.recordFailure({
        cause: `could not mint an attach grant: ${provision.detail}`,
        // It arrives already attributed to its source - see `AttachGrantFailure` - so it is passed through, not re-worded.
        context: provision.context,
        retryInMs,
      });
      return;
    }
    const grant = provision.grant;

    const scheduler = new PriorityScheduler({
      write: (frame) => this.writeFrame(generation, frame),
      onWriteError: () =>
        this.handleConnectionLost(
          generation,
          "write-failed",
          "host-transport-plane",
        ),
      initialBulkCredits: INITIAL_BULK_SEND_CREDITS,
      now: undefined,
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
        onClose: (info) => {
          // An answered arm reads false here forever, so a loss after proven liveness stays an ordinary loss.
          // Each connection owns its socket object, so this cannot leak across dials.
          const immediateRedialEarned =
            relaySocket.hasUnansweredImmediateRedialProbe();
          this.handleConnectionLost(
            generation,
            describeSocketClose(this.phase, info),
            "host-transport-plane",
          );
          if (immediateRedialEarned) {
            // A user is watching this recovery happen; sleeping out the
            // backoff rung the funnel armed would be pure added outage.
            this.pullRedialToNow("wake-probe-failed");
          }
        },
      },
    });

    this.connection = {
      generation,
      relaySocket,
      noise,
      scheduler,
      reassembler: new ChunkReassembler(undefined),
      inboundCredits: new InboundCreditTracker(),
      hostManifest: null,
      hostRpcMerged: null,
      credentialUpdateSupported: false,
      idempotencyKeySupported: false,
      bodyCompressionSupported: false,
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
    this.reattachMarks.attachAckAt = Date.now();
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
        this.handleConnectionLost(
          generation,
          "handshake-send-failed",
          "host-transport-plane",
        );
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
        this.handleConnectionLost(
          generation,
          "handshake-read-failed",
          "host-transport-plane",
        ),
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
      if (frame.qos === QosClass.BULK) {
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
      if (this.terminalStreamIds.has(frame.streamId)) {
        // Runs after credit accounting (the frame was still delivered, so the grant stays symmetric with the host's per-frame spend).
        return;
      }
      let message: ReassembledMessage | null;
      try {
        message = connection.reassembler.accept(frame);
      } catch (error) {
        if (this.failStreamOnInboundError(generation, frame, error)) {
          // The reassembly this watchdog was pacing just ended in a verdict.
          this.clearReassemblyWatchdog(frame.streamId);
          return;
        }
        throw error;
      }
      if (message === null) {
        // A chunk was accepted for a message still in flight.
        // The stream's own consumer still waits for the completed message; only the session verdict moves early.
        if (frame.type === MuxFrameType.STREAM_FRAME) {
          this.markStreamRestored(frame.streamId);
          // Early evidence needs its own progress bound: completion used to
          // be the implicit one. Reset on every accepted chunk.
          this.armReassemblyWatchdog(generation, frame.streamId);
        }
        return;
      }
      // A completed message closes its stream's in-flight sequence; the
      // watchdog pacing it is retired (no-op for streams with none armed).
      this.clearReassemblyWatchdog(message.streamId);
      this.dispatchInbound(generation, connection, message);
    })().catch(() =>
      this.handleConnectionLost(
        generation,
        "inbound-decode-failed",
        "host-transport-plane",
      ),
    );
  }

  /**
   * Returns false for anything that IS session-level (control-stream faults, unknown errors), which the caller re-throws into the connection-lost path.
   * What reaches here is only what `ChunkReassembler.accept` throws for an already-attributed frame: a body whose framing or json will not decode, or a compressed payload `inflateFramePayload` rejects.
   */
  private failStreamOnInboundError(
    generation: number,
    frame: MuxFrame,
    error: unknown,
  ): boolean {
    if (
      !(error instanceof ChunkReassemblyError) &&
      !(error instanceof MuxMessageSizeError) &&
      !(error instanceof MuxFrameDecodeError)
    ) {
      return false;
    }
    if (frame.streamId === SESSION_CONTROL_STREAM_ID) {
      return false;
    }
    if (!this.isCurrent(generation)) {
      return true;
    }
    const details: FatalErrorDetails = {
      code: streamInboundFailureCode(error),
      reason: error.message,
      incompatibleMethods: null,
      upgradeGuidance: null,
    };
    const pending = this.pendingUnary.get(frame.streamId);
    if (pending !== undefined) {
      // `rejectUnary` is the full terminal transition: drops queued outbound, forgets the accumulator, tombstones the id, and CLOSEs the stream so the host stops producing for it.
      this.rejectUnary(
        frame.streamId,
        new HostRpcError({
          code: "RPC_ERROR",
          message: details.reason,
          requestId: pending.requestId,
          method: pending.method,
          fatalDetails: details,
        }),
      );
      return true;
    }
    // Drop the dead transfer first or per-stream FIFO would park the close behind it.
    const connection = this.connection;
    if (connection !== null) {
      connection.scheduler.dropStreamOutbound(frame.streamId);
      connection.reassembler.forget(frame.streamId);
    }
    this.markStreamTerminal(frame.streamId);
    const nextSeq = this.retireOutboundSeq(frame.streamId);
    if (this.phase === "ready" && connection !== null) {
      this.enqueueMessageWithSeq(
        connection,
        {
          type: MuxFrameType.CLOSE,
          streamId: frame.streamId,
          qos: QosClass.INTERACTIVE,
          json: { reason: `inbound stream failed: ${details.code}` },
          binary: null,
        },
        nextSeq,
      );
    }
    const stream = this.subscriptions.get(frame.streamId);
    if (stream !== undefined) {
      stream.goFatal(details);
      this.subscriptions.delete(frame.streamId);
      this.restoredStreamIds.delete(frame.streamId);
      this.stallReopenedStreamIds.delete(frame.streamId);
      this.maybeReachReadyBoundary();
    }
    return true;
  }

  private sendOpenFrame(
    generation: number,
    connection: ActiveConnection,
  ): void {
    const bearer = this.readBearerOrNull();
    if (bearer === null) {
      // No bearer to present → cannot authenticate the session; stay in backoff.
      // `not-host-evidence` for the same reason a failed grant mint is indeterminate: this is the credential plane refusing us, one step before the host was ever asked anything.
      this.handleConnectionLost(
        generation,
        "missing-bearer",
        "not-host-evidence",
      );
      return;
    }
    this.phase = "opening";
    this.reattachMarks.handshakeAt = Date.now();
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
      // There is deliberately no version branch here - a capability the peer ignores must be indistinguishable from one it never received.
      capabilities: [
        SESSION_CAPABILITY_BODY_COMPRESSION,
        SESSION_CAPABILITY_FINE_CREDITS,
        CLIENT_CAPABILITY_EPIC_WRITE_PATH_V1,
      ],
      clientIdentity: this.clientIdentity,
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
    message: ReassembledMessage,
  ): void {
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
          this.handleConnectionLost(
            generation,
            "malformed-session-fatal",
            "host-transport-plane",
          );
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
    if (message.type === MuxFrameType.FATAL) {
      const parsed = fatalPayloadSchema.safeParse(message.json);
      if (!parsed.success) {
        return;
      }
      connection.scheduler.dropStreamOutbound(message.streamId);
      connection.reassembler.forget(message.streamId);
      this.markStreamTerminal(message.streamId);
      const pending = this.pendingUnary.get(message.streamId);
      if (pending !== undefined) {
        this.rejectUnary(
          message.streamId,
          new HostRpcError({
            code: "RPC_ERROR",
            message: parsed.data.details.reason,
            requestId: pending.requestId,
            method: pending.method,
            fatalDetails: parsed.data.details,
          }),
        );
        return;
      }
      const stream = this.subscriptions.get(message.streamId);
      if (stream === undefined) {
        return;
      }
      // A retryable per-stream fatal is the resolver saying "this open failed, ask again" - not a verdict on the subscription.
      if (parsed.data.details.retryable === true && this.phase !== "closed") {
        this.restoredStreamIds.delete(message.streamId);
        this.outboundSeq.delete(message.streamId);
        // It would sit `reconnecting` forever against a host that is deliberately ignoring it (only the test fake, which now enforces the same invariant, ever accepted one).
        this.subscriptions.delete(message.streamId);
        const reopenAttempts = this.streamReopenAttempts.get(message.streamId);
        this.streamReopenAttempts.delete(message.streamId);
        const freshStreamId = this.allocateStreamId();
        // The verdict answers this attempt; it says nothing about the next one.
        // A stream that entered the reopen regime through this verdict alone never held one, so an event-only method still re-subscribes unarmed.
        if (this.stallReopenedStreamIds.delete(message.streamId)) {
          this.stallReopenedStreamIds.add(freshStreamId);
        }
        stream.adoptStreamIdForReopen(freshStreamId);
        this.subscriptions.set(freshStreamId, stream);
        if (reopenAttempts !== undefined) {
          this.streamReopenAttempts.set(freshStreamId, reopenAttempts);
        }
        this.scheduleStreamReopen(stream);
        this.maybeReachReadyBoundary();
        return;
      }
      stream.goFatal(parsed.data.details);
      this.subscriptions.delete(message.streamId);
      this.restoredStreamIds.delete(message.streamId);
      this.outboundSeq.delete(message.streamId);
      this.clearStreamReopen(message.streamId);
      this.stallReopenedStreamIds.delete(message.streamId);
      this.maybeReachReadyBoundary();
      return;
    }
    if (message.type === MuxFrameType.CLOSE) {
      connection.scheduler.dropStreamOutbound(message.streamId);
      connection.reassembler.forget(message.streamId);
      this.markStreamTerminal(message.streamId);
      const stream = this.subscriptions.get(message.streamId);
      if (stream === undefined) {
        return;
      }
      stream.notifyStatus("closed", { kind: "caller" });
      this.subscriptions.delete(message.streamId);
      this.restoredStreamIds.delete(message.streamId);
      this.outboundSeq.delete(message.streamId);
      // A host close ends the stream as terminally as a caller close does, so it clears the same retry state: the pending re-open timer (a closed stream must not re-subscribe) and the attempt count.
      // The count is only otherwise cleared by a delivered frame, so a reopened stream the host closes before its first frame - a normal end for a short-lived stream - leaked its entry in this long-lived session forever.
      this.clearStreamReopen(message.streamId);
      this.stallReopenedStreamIds.delete(message.streamId);
      this.maybeReachReadyBoundary();
      return;
    }
    if (message.type === MuxFrameType.STREAM_FRAME) {
      const stream = this.subscriptions.get(message.streamId);
      if (stream === undefined) {
        return;
      }
      const envelope = message.json;
      if (envelope !== null && isStreamEnvelope(envelope)) {
        const delivered = stream.deliverServerFrame(envelope, message.binary);
        if (delivered) {
          this.markStreamRestored(message.streamId);
          // A frame is the only proof the re-open actually worked, so the escalation resets here rather than at subscribe time - a stream that fails init repeatedly must keep climbing the backoff.
          // The stall provenance ends with it: the resolver answered, so a later silence is a fresh episode that must earn its own verdict.
          this.streamReopenAttempts.delete(message.streamId);
          this.stallReopenedStreamIds.delete(message.streamId);
        }
      }
    }
  }

  /** A method this host never advertised. */
  private executeUnavailableMethodDegrade<
    Method extends keyof RpcRegistry & string,
  >(
    connection: ActiveConnection,
    method: Method,
    methodRegistry: MethodVersionRegistry,
    clientCanonical: SchemaVersion | undefined,
    hostRpcMerged: ConnectionManifest,
    params: RequestOfMethod<RpcRegistry, Method>,
    requestId: string,
    responseTimeoutMs: number | undefined,
    idempotencyKey: string | null,
    replayMustBeKeyed: boolean,
  ): Promise<ResponseOfMethod<RpcRegistry, Method>> {
    return resolveUnavailableMethodDegrade({
      registry: this.options.rpcRegistry,
      method,
      methodRegistry,
      clientCanonical,
      clientManifest: this.clientRpcMerged,
      hostManifest: hostRpcMerged,
      params,
      requestId,
      // Dispatched at the versions the declaration names, not the target's canonical pair: `degrade.to` may anchor an older version, and the request handed over here is already adapted to it.
      execute: (input) =>
        this.dispatchNegotiatedUnary(
          connection,
          input.method,
          input.methodRegistry,
          input.clientCanonical,
          input.hostCanonical,
          input.params,
          requestId,
          // The degraded retry is the same caller request on an older contract, so it keeps that caller's budget rather than silently reverting to the shared default.
          responseTimeoutMs,
          idempotencyKey,
          // Same caller request on an older contract, so it is the same replay: a degrade must not become the unkeyed dispatch the direct path just refused.
          replayMustBeKeyed,
        ),
    }) as Promise<ResponseOfMethod<RpcRegistry, Method>>;
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
      this.handleConnectionLost(
        generation,
        "malformed-openAck",
        "host-transport-plane",
      );
      return;
    }
    const hostRpcMerged = mergeConnectionManifests(
      parsed.data.manifest.rpc,
      parsed.data.manifest.optionalRpc,
    );
    // A long-lived session refreshes this on every re-attach, which is when a host upgraded underneath us re-handshakes.
    recordNegotiatedHostManifest(this.options.hostId, hostRpcMerged);
    // Floor vs floor only - optional methods are deliberately outside the session-fatal surface (see `SessionManifests`); a peer lacking one degrades per-call/per-gate instead.
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
    connection.hostRpcMerged = hostRpcMerged;
    connection.credentialUpdateSupported = parsed.data.capabilities.includes(
      SESSION_CAPABILITY_CREDENTIAL_UPDATE,
    );
    connection.idempotencyKeySupported = parsed.data.capabilities.includes(
      UNARY_CAPABILITY_IDEMPOTENCY_KEY,
    );
    connection.bodyCompressionSupported = parsed.data.capabilities.includes(
      SESSION_CAPABILITY_BODY_COMPRESSION,
    );
    if (
      parsed.data.capabilities.includes(SESSION_CAPABILITY_FINE_CREDITS) &&
      FINE_INITIAL_BULK_SEND_CREDITS < INITIAL_BULK_SEND_CREDITS
    ) {
      // Shrinking the un-granted send window is the one half of the credit change that can deadlock, so it happens here and only here: after a host has said, in this session, that it grants finely.
      // A host that said nothing keeps the legacy 32 MiB window, which is wasteful but never wedged.
      connection.scheduler.adoptNegotiatedCreditWindow(
        FINE_INITIAL_BULK_SEND_CREDITS,
      );
    }
    this.clearPhaseTimer();
    this.phase = "ready";
    this.reattachMarks.openAckAt = Date.now();
    // The host accepted the `open{bearer}`: any prior unauthorized episode is
    // over, so a later one starts its no-progress bound from a clean slate.
    this.noProgressUnauthorizedReconnects = 0;
    this.restoredStreamIds.clear();

    for (const stream of this.subscriptions.values()) {
      this.openSubscription(connection, stream);
    }
    this.startReauthLoop();
    this.armStandingTimer();
    this.maybeReachReadyBoundary();
    this.armRestoreStallTimer(generation);
    // The session can carry frames from here: release every `sendUnary`
    // caller parked through this attach.
    this.settleReadyWaiters(true);
  }

  /**
   * Arms the restore-stall diagnostic for this attach: a no-op when the boundary was already reached above, one line if any stream is still producing zero restore evidence a full window after the attach completed.
   * See the field doc for why that state must be named rather than inferred.
   */
  private armRestoreStallTimer(generation: number): void {
    this.clearRestoreStallTimer();
    if (this.readyBoundaryGeneration === this.connectGeneration) {
      return;
    }
    this.restoreStallTimer = setTimeout(() => {
      this.restoreStallTimer = null;
      if (
        !this.isCurrent(generation) ||
        this.phase !== "ready" ||
        this.readyBoundaryGeneration === this.connectGeneration
      ) {
        return;
      }
      const unrestored: string[] = [];
      for (const [streamId, stream] of this.subscriptions) {
        if (
          !this.restoredStreamIds.has(streamId) &&
          !this.streamReopenAttempts.has(streamId)
        ) {
          unrestored.push(`${stream.method}#${streamId}`);
        }
      }
      if (unrestored.length === 0) {
        return;
      }
      console.warn(
        `[remote-session] remote session (host ${this.options.hostId}) not ready ${RESTORE_STALL_LOG_AFTER_MS}ms after attach: ` +
          `unrestored streams with no inbound evidence [${unrestored.join(", ")}], ` +
          `reassembling=${this.pendingReassemblyCount}`,
      );
    }, RESTORE_STALL_LOG_AFTER_MS);
  }

  private clearRestoreStallTimer(): void {
    if (this.restoreStallTimer !== null) {
      clearTimeout(this.restoreStallTimer);
      this.restoreStallTimer = null;
    }
  }

  /**
   * (Re-)arms the progress deadline for one subscription stream's in-flight reassembly.
   * The watchdog re-arms so the verdict resumes if the leg returns without a reconnect.
   */
  private armReassemblyWatchdog(generation: number, streamId: number): void {
    if (!this.subscriptions.has(streamId)) {
      return;
    }
    const existing = this.reassemblyWatchdogs.get(streamId);
    if (existing !== undefined) {
      clearTimeout(existing.timer);
    }
    this.reassemblyWatchdogToken += 1;
    const token = this.reassemblyWatchdogToken;
    const timer = setTimeout(() => {
      const armed = this.reassemblyWatchdogs.get(streamId);
      if (armed === undefined || armed.token !== token) {
        // Retired or superseded arm: the message completed, a newer chunk
        // re-armed, or the connection dropped. Nothing to judge.
        return;
      }
      this.reassemblyWatchdogs.delete(streamId);
      if (!this.isCurrent(generation) || this.phase !== "ready") {
        return;
      }
      const stream = this.subscriptions.get(streamId);
      if (stream === undefined) {
        return;
      }
      const connection = this.connection;
      if (connection === null || !connection.hostAttached) {
        this.armReassemblyWatchdog(generation, streamId);
        return;
      }
      console.warn(
        `[remote-session] remote session (host ${this.options.hostId}) stream ${stream.method}#${streamId} ` +
          `made no reassembly progress for ${REASSEMBLY_PROGRESS_TIMEOUT_MS}ms - reopening on a fresh stream id`,
      );
      this.reopenStalledStream(streamId, stream, connection);
    }, REASSEMBLY_PROGRESS_TIMEOUT_MS);
    this.reassemblyWatchdogs.set(streamId, { timer, token });
  }

  /** The watchdog's expiry verdict: the transfer stopped, so the stream's restore failed. */
  private reopenStalledStream(
    streamId: number,
    stream: LogicalStream,
    connection: ActiveConnection,
  ): void {
    connection.reassembler.forget(streamId);
    this.markStreamTerminal(streamId);
    this.restoredStreamIds.delete(streamId);
    const nextSeq = this.retireOutboundSeq(streamId);
    this.subscriptions.delete(streamId);
    // Drop queued outbound first so per-stream FIFO cannot park the close
    // behind a transfer nobody wants anymore (mirrors `closeStream`).
    connection.scheduler.dropStreamOutbound(streamId);
    this.enqueueMessageWithSeq(
      connection,
      {
        type: MuxFrameType.CLOSE,
        streamId,
        qos: QosClass.INTERACTIVE,
        json: { reason: "reassembly-stalled" },
        binary: null,
      },
      nextSeq,
    );
    const reopenAttempts = this.streamReopenAttempts.get(streamId);
    this.streamReopenAttempts.delete(streamId);
    const freshStreamId = this.allocateStreamId();
    stream.adoptStreamIdForReopen(freshStreamId);
    this.subscriptions.set(freshStreamId, stream);
    if (reopenAttempts !== undefined) {
      this.streamReopenAttempts.set(freshStreamId, reopenAttempts);
    }
    // The stall provenance moves with the re-key: this is the ONE transition
    // that grants (and carries) the first-evidence deadline license.
    this.stallReopenedStreamIds.delete(streamId);
    this.stallReopenedStreamIds.add(freshStreamId);
    this.scheduleStreamReopen(stream);
    this.maybeReachReadyBoundary();
  }

  private clearReassemblyWatchdog(streamId: number): void {
    const armed = this.reassemblyWatchdogs.get(streamId);
    if (armed !== undefined) {
      clearTimeout(armed.timer);
      this.reassemblyWatchdogs.delete(streamId);
    }
  }

  /** Connection teardown: every in-flight reassembly died with its socket. */
  private clearAllReassemblyWatchdogs(): void {
    for (const armed of this.reassemblyWatchdogs.values()) {
      clearTimeout(armed.timer);
    }
    this.reassemblyWatchdogs.clear();
  }

  private openSubscription(
    connection: ActiveConnection,
    stream: LogicalStream,
  ): void {
    const hostManifest = connection.hostManifest;
    if (hostManifest === null) {
      return;
    }
    const selectedClientManifest = selectConnectionManifestForPeer(
      this.options.streamRegistry,
      this.clientManifests.stream,
      hostManifest.stream,
    );
    const requiredVersion = stream.requiredSchemaVersion;
    const clientCanonical = selectedClientManifest[stream.method];
    const hostCanonical = hostManifest.stream[stream.method];
    const pinnedVersionSupported =
      requiredVersion === null ||
      (hostCanonical !== undefined &&
        hostCanonical.major === requiredVersion.major &&
        hostCanonical.minor >= requiredVersion.minor);
    const compat = pinnedVersionSupported
      ? checkStreamMethodCompatibility(
          this.options.streamRegistry,
          selectedClientManifest,
          hostManifest.stream,
          "client",
          stream.method,
        )
      : {
          ok: false as const,
          details: incompatibleStreamDetails(
            stream.method,
            clientCanonical,
            hostCanonical,
          ),
        };
    if (
      !compat.ok ||
      clientCanonical === undefined ||
      hostCanonical === undefined
    ) {
      const details: FatalErrorDetails = compat.ok
        ? incompatibleStreamDetails(
            stream.method,
            clientCanonical,
            hostCanonical,
          )
        : compat.details;
      stream.goFatal(details);
      this.subscriptions.delete(stream.streamId);
      this.stallReopenedStreamIds.delete(stream.streamId);
      return;
    }
    // No tombstone to lift here - deliberately.
    const prepared = prepareStreamSubscribeRequest(
      this.options.streamRegistry,
      stream.method,
      clientCanonical,
      hostCanonical,
      stream.readParams(),
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
    if (this.stallReopenedStreamIds.has(stream.streamId)) {
      // The arm retires through the same evidence/verdict/close/drop set as any other.
      this.armReassemblyWatchdog(this.connectGeneration, stream.streamId);
    }
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
    // The response ends the exchange; the client sends nothing further here.
    this.retireOutboundSeq(streamId);
    if (parsed.data.error !== null) {
      entry.reject(
        HostRpcError.fromWireEnvelope(
          parsed.data.error,
          entry.requestId,
          entry.method,
        ),
      );
      return;
    }
    try {
      const decoded = decodeResponsePayloadWithContext(
        entry.methodRegistry,
        entry.clientCanonical,
        entry.hostCanonical,
        parsed.data.result,
        entry.requestId,
        entry.method,
        entry.onWireRequest,
        this.options.hostId,
      );
      entry.resolve(decoded);
    } catch (cause) {
      entry.reject(asHostRpcError(cause, entry.requestId, entry.method));
    }
  }

  // ---- Host blip / peer death / drop ------------------------------------- //

  /** A relay `host_detached`: the host leg went away, the client leg did not. */
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
    this.retractSession();
    // A detach is a down edge even though the socket survives, so the two things every other loss edge does through `handleConnectionLost` have to happen here too - this path does not reach that funnel.
    // The probation timer especially: it is a claim about sustained health, and a host that is absent is not healthy.
    this.clearStableResetTimer();
    // The stall diagnostic reads "no restore evidence" as a fact about the stream; with the host absent that silence is the host's, so the line would misattribute.
    this.clearRestoreStallTimer();
    this.noteConnectionLost();
    // `isReady()` includes `hostAttached`, so it is already false here - this
    // is what tells anyone.
    this.syncReadinessLatch();
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
      this.handleConnectionLost(
        generation,
        "host-attached-stale-noise",
        "host-transport-plane",
      );
    }
  }

  private onPeerGone(generation: number, reason: RelayKillReason): void {
    if (!this.isCurrent(generation)) {
      return;
    }
    if (reason === "revoked") {
      this.goTerminalFatal({
        code: "UNAUTHORIZED",
        reason: "Host access was revoked",
        incompatibleMethods: null,
        upgradeGuidance: null,
      });
      return;
    }
    const provenance = relayKillProvenance(reason);
    if (provenance === "not-host-evidence") {
      // A relay policy kill can be congestion (for example, the relay's client-leg buffer limit), not an authorization verdict.
      // Future relay kill reasons are conservatively treated the same way: retry them, but never redial an unknown overloaded session at the ordinary 1s rung.
      this.raiseReconnectBackoffToMax();
    }
    this.handleConnectionLost(generation, `peer-gone:${reason}`, provenance);
  }

  /**
   * Any transport loss → drop the connection and full-resume from backoff.
   * A required argument makes the census mechanical - a new caller cannot reach this funnel without stating which kind of loss it is.
   */
  private handleConnectionLost(
    generation: number,
    cause: string,
    provenance: ConnectionLossProvenance,
  ): void {
    if (!this.isCurrent(generation) || this.phase === "closed") {
      return;
    }
    this.dropConnection(cause);
    this.syncReadinessLatch();
    const retryInMs = this.scheduleReconnectForFailedGeneration(generation);
    this.dialFailures.recordFailure({ cause, context: "", retryInMs });
    // The host-plane funnel: every relay-socket close, Noise/handshake rejection, `peer_gone`, and phase timeout arrives here.
    // This is the one site in the remote loop that observes the host rather than the cloud, so it is the one that produces confirmed refusals.
    this.reportEvidenceOutcome(
      `${this.evidenceScope}#${generation}-lost`,
      provenance === "host-transport-plane" ? "refusal" : "indeterminate",
    );
  }

  /**
   * Shared drop bookkeeping for a lost connection: tear the transport down, fail in-flight unary calls, flag streams reconnecting.
   * The caller decides what happens next - `handleConnectionLost` schedules the backoff redial immediately; the `unauthorized` session-fatal path first revalidates the credential and only then reconnects (or goes terminal).
   */
  private dropConnection(cause: string): void {
    // Before anything else: a connection that is being lost never earned its
    // ladder reset, however close it came.
    this.clearStableResetTimer();
    // The stall diagnostic speaks for one attach's restores; the drop ends that attach, and the next one arms its own.
    this.clearRestoreStallTimer();
    this.clearAllReassemblyWatchdogs();
    // Guarded internally to once per outage, so a failed redial arriving here
    // again does not restart the clock.
    this.noteConnectionLost();
    this.phase = "reconnecting";
    this.restoredStreamIds.clear();
    this.teardownConnection(cause);
    // The attempts map deliberately stays - a resolver that keeps failing its init must keep climbing the backoff across session drops, not restart it.
    this.clearAllStreamReopens();
    // Only requests carrying a key this connection negotiated are replayable.
    // Unkeyed calls retain the old ambiguous-outcome failure on first drop.
    this.rejectPendingOnConnectionDrop();
    // Callers parked awaiting this attach are still pre-send, so they keep their retry license - but they must be released rather than left to ride an unbounded number of further attempts inside one call.
    this.settleReadyWaiters(false);
    this.markStreamsReconnecting();
    // The down edge, from the funnel every drop passes through.
    this.syncReadinessLatch();
  }

  /** A session-level fatal control frame from the host. */
  private handleSessionFatal(
    generation: number,
    details: FatalErrorDetails,
  ): void {
    // It does not replace the loss report below, and must not: the session really is going away, and the authority's derivation order is what puts the expected-outage hold above the death streak the loss feeds.
    this.reportRestartIntentIfPresent(details);
    // Classified before the retryable arm, and that order is the whole point.
    // That is the false-Offline class invariant 5 exists to prevent, reintroduced through the very arm whose own comment says "a prior genuine unauthorized episode" flows through here.
    const provenance = sessionFatalProvenance(details);
    if (details.retryable === true) {
    // A transient host blip must not count toward the credential give-up
      // bound - clear any streak left by a prior genuine unauthorized episode.
      this.noProgressUnauthorizedReconnects = 0;
      this.handleConnectionLost(
        generation,
        "session-fatal-retryable",
        provenance,
      );
      return;
    }
    const auth = this.revalidator();
    if (details.code === "UNAUTHORIZED" && auth !== null) {
      this.handleUnauthorizedSessionFatal(generation, details, auth);
      return;
    }
    this.goTerminalFatal(details);
  }

  /** The wired revalidator, or `null` when there is none to call. */
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
    // Capture the bearer the host just rejected before teardown clears it, so after revalidation we can tell whether the next attach would present a different token (progress) or the same rejected one (no progress).
    const rejectedBearer = this.openFrameBearer;
    this.dropConnection("session-fatal-unauthorized");
    void this.revalidateThenReconnect(
      generation,
      auth,
      details,
      rejectedBearer,
    );
  }

  /**
   * - "network-error" → stay in reconnect backoff (transient); the bearer is untouched, so this never counts toward the give-up bound.
   */
  private async revalidateThenReconnect(
    generation: number,
    auth: StreamAuthRevalidator,
    details: FatalErrorDetails,
    rejectedBearer: string | null,
  ): Promise<void> {
    const outcome = await this.revalidateWithinBudget(auth);
    if (generation !== this.connectGeneration) {
      // A stale completion: the generation this revalidation was recovering has been superseded while it was in flight.
      // It owns nothing now - it must neither schedule a redial for the new owner nor spend an intent recorded against a different generation.
      return;
    }
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
      const retryInMs = this.scheduleReconnectForFailedGeneration(generation);
      this.dialFailures.recordFailure({
        cause:
          "the host rejected the session bearer (UNAUTHORIZED) and revalidating the credential hit a network error",
        context: "",
        retryInMs,
      });
      // Credential-plane, so indeterminate: the host is answering (it rejected a bearer, which a dead host cannot do) and what failed is our own revalidation.
      this.reportEvidenceOutcome(this.credentialAttemptId(), "indeterminate");
      return;
    }
    // outcome === "rotated": authn accepts the credential.
    // Bound that loop; otherwise reset and redial with the fresh token.
    if (rejectedBearer !== null && this.readBearerOrNull() === rejectedBearer) {
      // The clock, not the credential.
      // Parked before the counter moves, so skew can never contribute to the bound.
      if (this.parkIfClockSkewed()) {
        return;
      }
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
    const retryInMs = this.scheduleReconnectForFailedGeneration(generation);
    this.dialFailures.recordFailure({
      cause:
        "the host rejected the session bearer (UNAUTHORIZED); redialing after credential revalidation",
      context: "",
      retryInMs,
    });
    // Same reasoning as the network-error arm: an unauthorized redial is a
    // credential rotation, not a statement about host liveness.
    this.reportEvidenceOutcome(this.credentialAttemptId(), "indeterminate");
  }

  /**
   * Parks this session if - and only if - the shared tracker reads the local clock as wrong IN the direction that can cause this failure: running ahead, where a valid bearer reads as expired locally.
   * A parked session therefore holds no connection and no timer, and comes back only on the tracker's `skewed → ok` edge.
   */
  private parkIfClockSkewed(): boolean {
    if (this.phase === "closed") {
      return false;
    }
    const clock = this.options.clock ?? null;
    if (clock === null || !clock.canMakeValidBearersLookExpired()) {
      return false;
    }
    if (this.clockParkUnsubscribe !== null) {
      return true;
    }
    console.warn(
      `[remote-session] remote session (host ${this.options.hostId}) parked on ` +
        `system-clock skew: ${clockSkewStreamReason(clock.currentState())} - ` +
        `it will reconnect on its own once the clock is corrected`,
    );
    if (this.backoffTimer !== null) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
    // Subscribe before the external callback, and re-check after it.
    // Assigning the handle first means a re-entrant `close()` finds something to release instead of nulling nothing and leaving the tracker holding a dead session for the life of the page.
    this.clockParkUnsubscribe = clock.subscribeToRecovery(() => {
      this.resumeFromClockPark();
    });
    this.reportEvidenceOutcome(this.credentialAttemptId(), "indeterminate");
    // Through `isClosed()`, not a bare `this.phase === "closed"`.
    if (this.isClosed()) {
      this.clearClockPark();
    }
    return true;
  }

  /**
   * The `skewed → ok` edge: the clock was corrected, so redial now.
   * `reconnectAttempt` is deliberately not reset - a host that is genuinely gone must keep climbing the ladder once the clock stops being the explanation.
   */
  private resumeFromClockPark(): void {
    if (this.clockParkUnsubscribe === null) {
      return;
    }
    this.clearClockPark();
    if (this.phase === "closed") {
      return;
    }
    console.info(
      `[remote-session] remote session (host ${this.options.hostId}) resuming: ` +
        `the system clock was corrected`,
    );
    this.noProgressUnauthorizedReconnects = 0;
    this.scheduleReconnect();
    this.pullRedialToNow("system-clock-corrected");
  }

  private clearClockPark(): void {
    const unsubscribe = this.clockParkUnsubscribe;
    if (unsubscribe === null) {
      return;
    }
    this.clockParkUnsubscribe = null;
    unsubscribe();
  }

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
    // Wrapping makes a sync throw reach the same `.catch` an async rejection does.
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
    // One-shot, not throttled: terminal means the loop is over, so the
    // absence of further retry lines must not read as recovery.
    console.warn(
      `[remote-session] remote session (host ${this.options.hostId}) closed terminally: ${details.code}: ${details.reason}`,
    );
    this.terminalFatalDetails = details;
    this.phase = "closed";
    // Terminal means every recorded demand dies with the loop - the field's contract says terminal close clears it, and both terminal transitions (caller `close()` and this fatal) must honor that, not just one.
    this.pendingForceGeneration = null;
    this.restoredStreamIds.clear();
    // See `close()`: not a timer, so not reachable by `clearAllTimers`.
    this.clearClockPark();
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
    // Phase is already "closed", so parked callers settle as NON-retryable
    // and carry this verdict - waiting cannot help a terminal session.
    this.settleReadyWaiters(false);
    this.emitClosed();
  }

  /** Arms the ladder reset. */
  private armStableResetTimer(): void {
    this.clearStableResetTimer();
    this.stableResetTimer = setTimeout(() => {
      this.stableResetTimer = null;
      this.reconnectAttempt = 0;
      // The dial-failure log's recovery line waits for the same proof: a flapping connection that never survives the dwell never logs "recovered", so the log cannot claim a recovery the ladder does not believe in.
      this.dialFailures.recordSuccess();
    }, RECONNECT_STABLE_RESET_MS);
  }

  /**
   * Emits the one line that makes the reattach budget falsifiable: total, and where the time went.
   * `info`, not `warn`: a successful reattach is not a problem, and the scenario harness asserts zero error-level lines per blip.
   */
  private logReattachBreakdown(): void {
    const marks = this.reattachMarks;
    if (marks.startedAt === 0) {
      return;
    }
    if (!this.hasReachedReadyOnce) {
      // A first-ever connect is not a reattach, and calling it one would put "reattached in Nms" in a field log for a session that had never been attached.
      this.reattachMarks = emptyReattachMarks();
      this.connectionLostAt = 0;
      return;
    }
    const now = Date.now();
    const leg = (from: number | null, to: number | null): string =>
      from === null || to === null ? "n/a" : `${to - from}ms`;
    // Measured from the loss, not from the dial.
    // `wait` breaks it out so a long total can still be read as "we waited" rather than "the network was slow".
    const lostAt = marks.lostAt === 0 ? null : marks.lostAt;
    const outageStartedAt = lostAt ?? marks.startedAt;
    console.info(
      `[remote-session] host=${this.options.hostId} reattached in ${now - outageStartedAt}ms ` +
        `(wait=${leg(lostAt, marks.startedAt)} ` +
        `grant+dial=${leg(marks.startedAt, marks.attachAckAt)} ` +
        `noise=${leg(marks.attachAckAt, marks.handshakeAt)} ` +
        `open=${leg(marks.handshakeAt, marks.openAckAt)} ` +
        `resubscribe=${leg(marks.openAckAt, now)} ` +
        `streams=${this.subscriptions.size})`,
    );
    this.reattachMarks = emptyReattachMarks();
    this.connectionLostAt = 0;
  }

  /** Stamps the start of an outage, once per outage. */
  private noteConnectionLost(): void {
    if (this.connectionLostAt !== 0) {
      return;
    }
    this.connectionLostAt = Date.now();
  }

  private clearStableResetTimer(): void {
    if (this.stableResetTimer !== null) {
      clearTimeout(this.stableResetTimer);
      this.stableResetTimer = null;
    }
  }

  /**
   * Arms the backoff redial and returns the armed delay, so failure paths can report the same value they actually scheduled (never a second jitter/ growth roll purely for the log line).
   * Jitter is what makes the tiers a spread rather than a schedule.
   */
  private scheduleReconnect(): number {
    if (this.phase === "closed") {
      return 0;
    }
    if (this.backoffTimer !== null) {
      clearTimeout(this.backoffTimer);
    }
    // Rung 0 is immediate.
    // On a link that blips for a second, the dominant cost of recovery used to be a backoff we imposed on ourselves before even trying - a full second of a ~2 s budget spent waiting to find out whether anything was wrong.
    const immediate = this.reconnectAttempt === 0 && this.hasReachedReadyOnce;
    const rung = this.reconnectAttempt - this.recoveryRungOffset;
    const delay = immediate
      ? 0
      : jitteredBackoffFor(
          Math.max(0, rung),
          RECONNECT_INITIAL_BACKOFF_MS,
          RECONNECT_MAX_BACKOFF_MS,
          () => this.pseudoJitter(),
        );
    this.reconnectAttempt += 1;
    // A newly armed timer has not been collapsed, so the next wake gets its
    // one draw against it.
    this.backoffCollapsed = false;
    this.armBackoffTimer(Date.now(), delay);
    return delay;
  }

  /**
   * How far `reconnectAttempt` runs ahead of the backoff rung it will be spent on.
   * A session that has never connected has no such freebie and its rung IS its attempt.
   */
  private get recoveryRungOffset(): number {
    return this.hasReachedReadyOnce ? 1 : 0;
  }

  /**
   * Starts a congestion-triggered reconnect at the capped backoff rung while
   * preserving the ordinary scheduler and its sustained-ready reset.
   */
  private raiseReconnectBackoffToMax(): void {
    const rungAtMaxBackoff = Math.ceil(
      Math.log2(RECONNECT_MAX_BACKOFF_MS / RECONNECT_INITIAL_BACKOFF_MS),
    );
    this.reconnectAttempt = Math.max(
      this.reconnectAttempt,
      rungAtMaxBackoff + this.recoveryRungOffset,
    );
  }

  /**
   * Arms the redial for the deadline `armedAt + delayMs`, recording both so {@link wake} can reason about how long this session has already been waiting rather than restarting the clock.
   */
  private armBackoffTimer(armedAt: number, delayMs: number): void {
    this.backoffArmedAt = armedAt;
    this.backoffDelayMs = delayMs;
    this.backoffTimer = setTimeout(
      () => {
        this.backoffTimer = null;
        this.beginConnectGuarded();
      },
      Math.max(0, armedAt + delayMs - Date.now()),
    );
  }

  /**
   * Pulls a pending redial forward, once per armed timer, to a jittered sub-second delay measured from now.
   * Later wakes do not redraw and do not shorten again, so a burst buys exactly one redial rather than N increasingly early ones - and the timer that eventually fires re-arms a fresh, un-collapsed one.
   */
  private collapseBackoff(reason: string): void {
    if (this.backoffTimer === null || this.backoffCollapsed) {
      return;
    }
    // Spent whether or not the draw wins below: this timer has had its wake.
    this.backoffCollapsed = true;
    const now = Date.now();
    const wokenDelayMs = jitteredBackoffFor(
      0,
      RECONNECT_INITIAL_BACKOFF_MS,
      RECONNECT_INITIAL_BACKOFF_MS,
      () => this.pseudoJitter(),
    );
    const armedRemainingMs = this.backoffArmedAt + this.backoffDelayMs - now;
    if (wokenDelayMs >= armedRemainingMs) {
      return;
    }
    clearTimeout(this.backoffTimer);
    this.backoffTimer = null;
    console.info(
      `[remote-session] remote session (host ${this.options.hostId}) redialing early (${reason}) in ${wokenDelayMs}ms - ${Math.round(armedRemainingMs)}ms of backoff left`,
    );
    this.armBackoffTimer(now, wokenDelayMs);
  }

  /**
   * Spends a force recorded against `generation`, pulling the backoff that generation's failure just armed to zero.
   * The rung is always armed first: attempt accounting and the failure log see the ordinary schedule, and only then is the one wait pulled to zero.
   */
  private consumePendingForce(generation: number): void {
    if (this.pendingForceGeneration !== generation) {
      return;
    }
    this.pendingForceGeneration = null;
    this.pullRedialToNow("pending-forced-redial");
  }

  private scheduleReconnectForFailedGeneration(generation: number): number {
    const retryInMs = this.scheduleReconnect();
    this.consumePendingForce(generation);
    return retryInMs;
  }

  /** Clears a pending backoff wait and dials now. */
  private pullRedialToNow(reason: string): void {
    // A pending wait is a pending wait; `closed` is the only state whose timer must never be revived.
    if (this.phase === "closed" || this.backoffTimer === null) {
      return;
    }
    clearTimeout(this.backoffTimer);
    this.backoffTimer = null;
    // Spend the timer's wake-collapse as well: the wait it guarded no longer
    // exists, so a wake racing in behind this must find nothing to shorten.
    this.backoffCollapsed = true;
    console.info(
      `[remote-session] remote session (host ${this.options.hostId}) redialing now (${reason})`,
    );
    this.armBackoffTimer(Date.now(), 0);
  }

  /** `beginConnect` with its pre-connection failure modes routed back into the state machine. */
  private beginConnectGuarded(): void {
    // `beginConnect` allocates its generation synchronously, before its first await, so reading the counter immediately after the call names the generation this attempt owns - not the one it superseded.
    // With one exception: the `phase === "closed"` early return never reaches the increment, so this captures the previous generation.
    const attempt = this.beginConnect();
    const generation = this.connectGeneration;
    void attempt.catch((cause: unknown) => {
      // That safety is incidental to another method's null check, one refactor deep (a force-redial that does not tear down first, or an `isCurrent` that stops requiring a connection, reintroduces it).
      // Stated here so a superseded attempt owning nothing is a property of this code rather than a coincidence.
      if (this.phase === "closed" || generation !== this.connectGeneration) {
        return;
      }
      this.dropConnection("connect-path-threw");
      const retryInMs = this.scheduleReconnectForFailedGeneration(generation);
      this.dialFailures.recordFailure({
        cause: `the connect path threw before dialing: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        context: "",
        retryInMs,
      });
      // Threw before dialing (a key decode, a factory, an await that rejected)
      // - our own connect path failed, so the host was never asked anything.
      this.reportEvidenceOutcome(
        this.dialAttemptId(generation),
        "indeterminate",
      );
    });
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
      // The second provenance of `dead("plan-restricted")`, for a host that was already connected when the plan changed.
      // Without it the lease settles `connecting` and the ∅ modal offers "retry" to a user whose only fix is an upgrade.
      this.reportEvidenceOutcome(this.reauthAttemptId(), "plan-restricted");
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
   * Resets the peer-enforced host-standing watchdog on any evidence the host is alive + bridging (inbound frame / host_attached / reauth_notice).
   * If the host goes silent past the 15-min bound the client fails the session itself (R4-D2) - a revoked host will not enforce its own death.
   */
  private armStandingTimer(): void {
    if (this.standingTimer !== null) {
      clearTimeout(this.standingTimer);
    }
    const generation = this.connectGeneration;
    this.standingTimer = setTimeout(() => {
      this.standingTimer = null;
      this.handleConnectionLost(
        generation,
        "host-standing-lapsed",
        "host-transport-plane",
      );
    }, HOST_STANDING_BOUND_MS);
  }

  // ---- Wire write + framing helpers -------------------------------------- //

  /**
   * Encodes one logical message into a pull-based chunk source and queues it (one queue slot regardless of body size; frames materialize, drawing their per-stream `seq`, as the scheduler pulls).
   */
  private enqueueMessage(
    connection: ActiveConnection,
    message: OutboundMessage,
  ): void {
    this.enqueueMessageWithSeq(connection, message, () =>
      this.nextSeq(message.streamId),
    );
  }

  /**
   * {@link enqueueMessage} with the `seq` source supplied by the caller - for the close that ends a stream whose counter {@link retireOutboundSeq} has already taken out of {@link outboundSeq}.
   */
  private enqueueMessageWithSeq(
    connection: ActiveConnection,
    message: OutboundMessage,
    nextSeq: () => number,
  ): void {
    const source = new OutboundChunkSource(
      message,
      nextSeq,
      connection.bodyCompressionSupported,
    );
    connection.scheduler.enqueue(source);
  }

  /**
   * Takes a stream's counter out of {@link outboundSeq} and returns a source that continues its progression.
   */
  private retireOutboundSeq(streamId: number): () => number {
    let next = this.outboundSeq.get(streamId) ?? 0;
    this.outboundSeq.delete(streamId);
    return () => {
      const seq = next;
      next += 1;
      return seq;
    };
  }

  private async writeFrame(
    generation: number,
    frame: EncodeMuxFrameInput,
  ): Promise<void> {
    if (!this.isCurrent(generation)) {
      return;
    }
    const connection = this.connection;
    if (connection === null) {
      return;
    }
    const plaintext = encodeMuxFrame(frame);
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
    // The stream's `outboundSeq` entry is NOT cleared here: `rejectUnary`
  // still has a close to send on it. Each caller retires the counter itself.
  }

  private rejectUnary(streamId: number, error: HostRpcError): void {
    const entry = this.pendingUnary.get(streamId);
    if (entry === undefined) {
      return;
    }
    this.clearPendingUnary(streamId);
    const nextSeq = this.retireOutboundSeq(streamId);
    // A rejected unary's stream is terminal.
    const connection = this.connection;
    if (connection !== null) {
      connection.scheduler.dropStreamOutbound(streamId);
      connection.reassembler.forget(streamId);
    }
    this.markStreamTerminal(streamId);
    if (this.phase === "ready" && connection !== null) {
      this.enqueueMessageWithSeq(
        connection,
        {
          type: MuxFrameType.CLOSE,
          streamId,
          qos: QosClass.INTERACTIVE,
          json: { reason: "unary request rejected" },
          binary: null,
        },
        nextSeq,
      );
    }
    entry.reject(error);
  }

  /**
   * Bounded: streamIds are monotonic and never reused within a session, so evicting the oldest tombstone (insertion order, which tracks the terminal frontier) once the cap is hit never re-admits a still-active stream.
   */
  private markStreamTerminal(streamId: number): void {
    if (this.terminalStreamIds.has(streamId)) {
      return;
    }
    this.terminalStreamIds.add(streamId);
    if (this.terminalStreamIds.size > MAX_TERMINAL_STREAM_IDS) {
      const oldest = this.terminalStreamIds.values().next().value;
      if (oldest !== undefined) {
        this.terminalStreamIds.delete(oldest);
      }
    }
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

  private rejectPendingOnConnectionDrop(): void {
    for (const [streamId, entry] of Array.from(this.pendingUnary)) {
      if (entry.timer !== null) {
        clearTimeout(entry.timer);
      }
      this.pendingUnary.delete(streamId);
      this.outboundSeq.delete(streamId);
      entry.reject(
        entry.replaySafe
          ? retryableUnaryFailure(
              entry.requestId,
              entry.method,
              "Remote session dropped before the response arrived",
            )
          : new HostTransportFailureError({
              code: "RPC_ERROR",
              message: "Remote session dropped before the response arrived",
              requestId: entry.requestId,
              method: entry.method,
              fatalDetails: null,
            }),
      );
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
      // The stream keeps its own reopen backoff either way; only the session-level verdict stops depending on it.
      if (this.streamReopenAttempts.has(streamId)) {
        continue;
      }
      if (!this.restoredStreamIds.has(streamId)) {
        return;
      }
    }
    this.readyBoundaryGeneration = this.connectGeneration;
    this.clearRestoreStallTimer();
    // A force recorded against this generation is satisfied by reaching ready: a fresh attach is everything it could have bought.
    // Consumed unspent, so it cannot leak onto a later, unrelated loss.
    this.pendingForceGeneration = null;
    this.armStableResetTimer();
    // Order matters: the breakdown reads `hasReachedReadyOnce` to decide
    // whether this was a reattach at all, so the flag is raised after it.
    this.logReattachBreakdown();
    this.hasReachedReadyOnce = true;
    // The ready boundary is the only site that mints a session id, and it runs once per connect generation (the guard above).
    this.reportEvidenceOutcome(
      this.dialAttemptId(this.connectGeneration),
      "success",
    );
    this.announceSession(`${this.evidenceScope}:s${this.connectGeneration}`);
    // Delaying forgiveness must never mean delaying the data coming back.
    this.emitAvailabilityRecovered();
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

  // ---- Selection-authority evidence (redesign P1.3) ---------------------- //

  /** One dial attempt per connect generation (the contract's attempt identity). */
  private dialAttemptId(generation: number): string {
    return `${this.evidenceScope}#${generation}`;
  }

  /**
   * A credential-plane event, which is never tied to a dial: revalidation can run several times inside one generation, and each needs its own id or the authority's dedup would keep only the first.
   */
  private credentialAttemptId(): string {
    this.reauthEvidenceSeq += 1;
    return `${this.evidenceScope}#auth-${this.reauthEvidenceSeq}`;
  }

  /** A mid-session re-auth verdict, distinct from its generation's dial. */
  private reauthAttemptId(): string {
    this.reauthEvidenceSeq += 1;
    return `${this.evidenceScope}#reauth-${this.reauthEvidenceSeq}`;
  }

  /** The one place a dial outcome leaves this session. */
  /** Forwards a host-published restart tombstone to the selection authority. */
  private reportRestartIntentIfPresent(details: FatalErrorDetails): void {
    const restartIntent = details.restartIntent;
    if (restartIntent === undefined) {
      return;
    }
    this.options.evidence.reportRestartIntent(
      this.options.hostId,
      restartIntent.tombstoneId,
      restartIntent.expiresAt,
    );
  }

  private reportEvidenceOutcome(
    attemptId: string,
    outcome: "success" | "refusal" | "plan-restricted" | "indeterminate",
  ): void {
    const hostId = this.options.hostId;
    const evidence = this.options.evidence;
    if (outcome === "success") {
      evidence.reportDialSuccess(hostId, attemptId, "remote-relay");
      return;
    }
    if (outcome === "indeterminate") {
      evidence.reportDialIndeterminate(hostId, attemptId, "remote-relay");
      return;
    }
    evidence.reportDialRefusal(
      hostId,
      attemptId,
      "remote-relay",
      outcome === "plan-restricted" ? "plan-restricted" : null,
    );
  }

  private announceSession(sessionId: string): void {
    // A generation cannot reach its ready boundary twice, so an announcement while one is outstanding would mean the retraction funnel was bypassed.
    // Retract first rather than leaking the previous id.
    this.retractSession();
    this.announcedSessionId = sessionId;
    this.options.evidence.sessionEstablished(
      this.options.hostId,
      sessionId,
      "remote-relay",
    );
  }

  private retractSession(): void {
    const sessionId = this.announcedSessionId;
    if (sessionId === null) return;
    this.announcedSessionId = null;
    this.options.evidence.sessionLost(
      this.options.hostId,
      sessionId,
      "remote-relay",
    );
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
    this.readinessLostListeners.clear();
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        console.error("[remote-session] closed listener threw", error);
      }
    }
  }

  /** Reconciles the published-readiness latch with reality and emits the down edge if one just happened. */
  private syncReadinessLatch(): void {
    const ready = this.isReady();
    if (ready === this.lastPublishedReadiness) {
      return;
    }
    this.lastPublishedReadiness = ready;
    if (ready) {
      // The UP edge belongs to `subscribeAvailabilityRecovered`, which fires at the ready boundary with more precise timing than this latch has.
      // Recording it here only keeps the next down edge detectable.
      return;
    }
    // Guarded per listener, same reason as the recovered emitter: this runs inside inbound frame dispatch and a throwing consumer must not break message processing or the other listeners.
    for (const listener of Array.from(this.readinessLostListeners)) {
      try {
        listener();
      } catch (error) {
        console.error("[remote-session] readiness-lost listener threw", error);
      }
    }
  }

  private emitAvailabilityRecovered(): void {
    // Keep the loss latch in step on the way up, or the next down edge is invisible: an un-synced latch still reads `false` and the transition compares equal.
    this.syncReadinessLatch();
    // Guarded per listener: the emission happens inside inbound frame dispatch, so a throwing consumer must not break the session's message processing or the other listeners (parity with `WsStreamClient`).
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
    // The retraction funnel.
    // A consumer `close()` reaching here is correct too: the session really has ended, and the authority's transitions are idempotent, so a redundant retraction costs nothing while a missing one is the defect.
    this.retractSession();
    const connection = this.connection;
    this.connection = null;
    this.openFrameBearer = null;
    this.clearPhaseTimer();
    this.clearReauthTimer();
    this.clearStandingTimer();
    // The connection did not survive its dwell, so the streak is not forgiven.
    // This is the single choke point for losing a connection - every drop, fatal and caller close routes through here - which is what keeps the survival test honest without a clear() at each call site.
    this.clearStableResetTimer();
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
      this.handleConnectionLost(generation, cause, "host-transport-plane");
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

  /**
   * Re-opens one logical stream after a retryable per-stream fatal, on a per-stream backoff so a resolver that keeps failing its init cannot spin.
   */
  private scheduleStreamReopen(stream: LogicalStream): void {
    const streamId = stream.streamId;
    const attempt = this.streamReopenAttempts.get(streamId) ?? 0;
    this.streamReopenAttempts.set(streamId, attempt + 1);
    // `null`, like the session-wide reconnect projection at `notifyStatus` above: `StreamCloseReason` describes a close, and this stream is not closed.
    stream.notifyStatus("reconnecting", null);
    const existing = this.streamReopenTimers.get(streamId);
    if (existing !== null && existing !== undefined) {
      clearTimeout(existing);
    }
    const delay = jitteredBackoffFor(
      attempt,
      RECONNECT_INITIAL_BACKOFF_MS,
      RECONNECT_MAX_BACKOFF_MS,
      () => this.pseudoJitter(),
    );
    const timer = setTimeout(() => {
      this.streamReopenTimers.delete(streamId);
      // Anything that closed the stream or the session in the meantime wins:
      // `subscriptions` no longer holding it is exactly that signal.
      if (this.phase === "closed") {
        return;
      }
      if (this.subscriptions.get(streamId) !== stream) {
        return;
      }
      const connection = this.connection;
      // Not ready: the session is between sockets and will replay every subscription itself once the next `open` is accepted.
      // The stream already carries its fresh, never-tombstoned id (re-keyed at the fatal), so returning here cannot strand it.
      if (connection === null || this.phase !== "ready") {
        return;
      }
      this.openSubscription(connection, stream);
    }, delay);
    this.streamReopenTimers.set(streamId, timer);
  }

  /**
   * Test seam: the per-stream retry state still held.
   * The attempts map is the one that can leak - it deliberately outlives its timer (see the field doc) and is otherwise invisible from the outside, so the "every terminal path clears it" invariant is only checkable here.
   */
  streamReopenStateForTests(): { timers: number; attempts: number } {
    return {
      timers: this.streamReopenTimers.size,
      attempts: this.streamReopenAttempts.size,
    };
  }

  /** Drops any pending re-open for a stream that has terminally ended. */
  private clearStreamReopen(streamId: number): void {
    const timer = this.streamReopenTimers.get(streamId);
    if (timer !== null && timer !== undefined) {
      clearTimeout(timer);
    }
    this.streamReopenTimers.delete(streamId);
    this.streamReopenAttempts.delete(streamId);
  }

  /** Clears every pending per-stream re-open (session teardown / re-dial). */
  private clearAllStreamReopens(): void {
    for (const timer of this.streamReopenTimers.values()) {
      clearTimeout(timer);
    }
    this.streamReopenTimers.clear();
  }

  private clearAllTimers(): void {
    this.clearPhaseTimer();
    this.clearReauthTimer();
    this.clearStandingTimer();
    this.clearStableResetTimer();
    this.clearRestoreStallTimer();
    this.clearAllReassemblyWatchdogs();
    this.clearAllStreamReopens();
    if (this.backoffTimer !== null) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
  }

  /**
   * Deterministic per-arming jitter in [0,1).
   * `Math.random` is banned in the workflow sandbox but this is production client code (not a workflow), so `Math.random` is used directly for re-auth spread.
   */
  private pseudoJitter(): number {
    return Math.random();
  }
}

 // ----------------------------------------------------------------------------- Module helpers -----------------------------------------------------------------------------

/**
 * Cap on consecutive `unauthorized` session-fatal recoveries where the revalidation keeps returning a current credential the host keeps rejecting (no token rotation making progress).
 * After this many no-progress cycles the session goes terminal instead of looping forever - mirrors the local stream transport's identically-named bound.
 */
const MAX_NO_PROGRESS_UNAUTHORIZED_RECONNECTS = 3;

/**
 * Upper bound on how long an `unauthorized` revalidation may run before the session gives up waiting and treats it as a transient "network-error".
 * Caps the "reconnecting" window so a hung authn refresh can never strand the session - the normal reconnect backoff then retries.
 */
const UNAUTHORIZED_REVALIDATE_TIMEOUT_MS = 10_000;

function indexMethodRegistry(
  registry: VersionedRpcRegistry,
  method: string,
): MethodVersionRegistry {
  const entry = registry[method];
  return entry as MethodVersionRegistry;
}

function describeSocketClose(
  phase: SessionPhase,
  info: { readonly code: number; readonly reason: string },
): string {
  const reason = info.reason === "" ? "" : ` reason=${info.reason}`;
  const base = `the relay socket closed (code=${info.code}${reason})`;
  if (phase === "connecting") {
    return `${base} before attach_ack - a DNS failure, a refused/blocked connection, and a relay-rejected upgrade (bad or wrong-environment grant) all look exactly like this`;
  }
  return base;
}

/**
 * The caller's own authority was aborted (a cancelled query, a replaced host binding).
 * Never retryable: the request was not dispatched, and the context that would have owned the answer is gone.
 */
function abortedRequestError(
  requestId: string,
  method: string,
): HostRequestAbortedError {
  return new HostRequestAbortedError({
    message: "Remote unary was aborted before it was sent",
    requestId,
    method,
  });
}

function streamInboundFailureCode(
  error: ChunkReassemblyError | MuxMessageSizeError | MuxFrameDecodeError,
):
  | "STREAM_MESSAGE_TOO_LARGE"
  | "STREAM_BODY_DECODE_FAILED"
  | "STREAM_CHUNK_REASSEMBLY_FAILED" {
  if (error instanceof MuxMessageSizeError) {
    return "STREAM_MESSAGE_TOO_LARGE";
  }
  if (error instanceof MuxFrameDecodeError) {
    return "STREAM_BODY_DECODE_FAILED";
  }
  return "STREAM_CHUNK_REASSEMBLY_FAILED";
}

function unaryTimeoutError(
  requestId: string,
  method: string,
): HostTransportFailureError {
  return new HostTransportFailureError({
    code: "RPC_ERROR",
    message: `Remote unary '${method}' timed out awaiting a response`,
    requestId,
    method,
    fatalDetails: null,
  });
}

/**
 * The post-send retryable failure: a timeout or a connection drop for a request whose frame is already on the wire.
 */
function retryableUnaryFailure(
  requestId: string,
  method: string,
  message: string,
): RetryableTransportError {
  return new RetryableTransportError({
    code: "RPC_ERROR",
    message,
    requestId,
    method,
    fatalDetails: null,
    replaySafetyFromKey: true,
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
 * Fatal code for the attach-grant entitlement denial.
 * UI layers key the paid-plan upsell on this instead of a generic session failure.
 */
export { PLAN_RESTRICTED_FATAL_CODE } from "./config";

function planRestrictedFatalDetails(): FatalErrorDetails {
  return {
    code: PLAN_RESTRICTED_FATAL_CODE,
    reason: "Remote host connectivity requires a paid plan",
    incompatibleMethods: null,
    upgradeGuidance: null,
  };
}

function incompatibleStreamDetails(
  method: string,
  clientCanonical: SchemaVersion | undefined,
  hostCanonical: SchemaVersion | undefined,
): FatalErrorDetails {
  return {
    code: "INCOMPATIBLE",
    reason: `Stream method '${method}' is not compatible with the host`,
    incompatibleMethods: [
      {
        method,
        clientCanonical: clientCanonical ?? null,
        hostCanonical: hostCanonical ?? null,
        blocking:
          clientCanonical === undefined
            ? "client-missing-method"
            : hostCanonical === undefined
              ? "host-missing-method"
              : "no-bridge",
      },
    ],
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

export type { StreamConnectionStatus, StreamCloseReason };
