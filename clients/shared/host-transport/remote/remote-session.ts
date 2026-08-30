import {
  checkCompatibility,
  isRpcErrorCode,
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
 * Streaming methods that ride the credit-gated `BULK` mux queue instead of
 * the default `INTERACTIVE` class. Every other stream method stays
 * interactive - keystrokes, terminal/chat output, and status polls must
 * preempt bulk traffic. Today this is only the two asset-fetch streams: a
 * 20 MiB image must not starve interactive traffic sharing the same
 * connection. A simple per-method lookup rather than a negotiated QoS
 * scheme, matching the tech plan's "minimal method-to-QoS policy" - grow
 * this set, don't build a config system, if a third bulk method shows up.
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
 * Backoff resets ONLY after a connection SURVIVES: the ready boundary
 * (transport open · E2E handshake · session open · subscriptions restored) must
 * be reached AND held for `RECONNECT_STABLE_RESET_MS`. Never on socket-open,
 * never on the boundary alone, and never on a wake — a connection that opens
 * and dies repeatedly must escalate, not present itself as a first failure
 * forever.
 *
 * Host blip (`host_detached`/`host_attached`) is NOT a resume: the same Noise
 * session persists; the scheduler pauses (holding frames, not losing them to a
 * host-less relay) and resumes. Only a socket drop or `peer_gone` triggers a
 * full attach.
 */

/**
 * Whether a connection loss is evidence ABOUT THE HOST, or only about us.
 *
 * The one funnel (`handleConnectionLost`) is shared by both, deliberately -
 * backoff, stream re-subscribe and pending-unary rejection belong in one
 * place. What is NOT shared is the verdict that leaves it:
 *
 *  - `host-transport-plane` - the relay socket closed, a Noise/handshake step
 *    was rejected, a known host-leg peer loss arrived, or a phase deadline
 *    elapsed with the host silent. The host's own transport plane answered (or
 *    failed to), so this is `confirmed-refusal` evidence.
 *  - `not-host-evidence` - we tore the connection down ourselves (a caller's
 *    reconnect nudge), could not present a credential (no bearer), or the
 *    relay killed only its client leg for a policy/future reason. The host
 *    refused nothing; it may be perfectly healthy. Reported `indeterminate`.
 *
 * This is the durable classification rule applied one layer down from where
 * it was written: `confirmed-refusal` requires evidence from the HOST's
 * transport plane, and a client's own teardown request is self-evidence.
 */
type ConnectionLossProvenance = "host-transport-plane" | "not-host-evidence";

/**
 * Whether a host-sent session FATAL is evidence about the HOST's transport
 * plane, or about the credential plane standing between us and it.
 *
 * The durable classification rule decides this, not the frame's severity or
 * its `retryable` flag: `confirmed-refusal` requires evidence from the HOST's
 * transport plane, and an authn/credential rejection says nothing about
 * whether the host is alive - it is alive enough to have rejected us.
 *
 * `UNAUTHORIZED` is the credential plane's code on this wire, and it is
 * checked by CODE rather than by any recovery flag because the two are
 * orthogonal: the same code arrives both retryable (the host's JWKS lookup
 * timed out) and terminal (our bearer is genuinely bad), and neither is host
 * evidence.
 *
 * Deliberately narrow rather than a guessed "credential family": every other
 * fatal on this path - a relay policy close, a malformed frame, a phase
 * deadline, and `HOST_RESTARTING` - IS the host's own plane answering, and
 * widening this predicate on suspicion would silently stop counting real
 * deaths. A new credential-plane code gets added here explicitly, with the
 * same reasoning written down.
 */
/**
 * Where the wall-clock of one connect attempt went, stamped at each phase
 * transition. Every field after `startedAt` is `null` until its phase is
 * reached, so a breakdown emitted for a partial attempt is honest about which
 * legs never happened rather than reporting them as zero-cost.
 */
interface ReattachMarks {
  /**
   * When the link was LOST, not when the redial began - `0` when this connect
   * follows no loss (the first-ever connect). The two differ by the whole
   * backoff wait, which is the client's own contribution to the outage and the
   * single largest term in it at the upper rungs.
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

function sessionFatalProvenance(
  details: FatalErrorDetails,
): ConnectionLossProvenance {
  return details.code === "UNAUTHORIZED"
    ? "not-host-evidence"
    : "host-transport-plane";
}

/**
 * Relay `policy_violation` is commonly a client-leg congestion decision, not
 * a statement from the host. Unknown relay kill reasons must fail the same
 * way: new relays can emit them before this client learns their semantics.
 * Only the two established host-leg losses are evidence about host liveness.
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
  /**
   * Verdict on whether this machine's WALL CLOCK is trustworthy, from the
   * shared server-time offset tracker. The twin of
   * `WsStreamClientOptions.clock`, and it is here for the reason a remote
   * session most needs it: the clock is a property of the MACHINE, so a user
   * whose clock is hours off wedges identically whether their host is local or
   * across a relay - and a remote user is the one least able to guess why.
   *
   * Read at exactly one site here (the no-progress `UNAUTHORIZED` bound),
   * because unlike the local transport this session has no pre-dial expiry
   * gate to read it at. `null` restores the pre-existing behaviour exactly.
   */
  readonly clock: ServerClockSkewSignal | null;
  readonly rpcRegistry: RpcRegistry;
  readonly streamRegistry: StreamRegistry;
  readonly webSocketFactory: IStreamWebSocketFactory;
  readonly requestId: () => string;
  /**
   * Where this session's dial outcomes and liveness go (redesign P1.3). The
   * selection authority's confirmed-death counter is fed from HERE and from
   * the local WS transport - never from the directory's cloud DTO, and never
   * from `isConfirmedTransportRefusal`, which is a pre-dial gate that folds
   * DTO verdicts in (invariant 5). Shells with no authority to feed pass
   * `NO_TRANSPORT_EVIDENCE`.
   */
  readonly evidence: TransportEvidenceReporter;
  /**
   * WHO THIS CLIENT IS, sent on the session `open` frame and re-sent on every
   * redial (each attach re-authenticates, so each is re-gated).
   *
   * Required for the same reason the two local transports' is: an absent
   * identity reads to the host as legacy epoch 1, and a defaulted value here
   * would let a composition root ship a build a floored host terminally
   * refuses, with nothing at compile time to catch it.
   *
   * IT IS DELIBERATELY NOT PART OF THE SESSION CACHE KEY
   * (`active-remote-sessions.ts`). Kind, epoch and build version are process
   * constants - updating the application restarts the process - so two
   * consumers in one process can never want different identities on one host,
   * and keying on it would only fragment the cache.
   *
   * NOTHING TESTS THAT EXCLUSION, and it is worth knowing which way the gap
   * runs. `remote-session.test.ts > RemoteSession client identity` pins that
   * the value reaches the wire on every dial and redial; it does not - and
   * from inside one process cannot - observe the cache key. So a future field
   * here that is NOT a process constant (a window id, a per-consumer label)
   * would be silently inherited by every cache hit from whichever consumer
   * built the session first. Keep this type to process constants, or key the
   * cache on it.
   */
  readonly clientIdentity: FirstPartyClientIdentity;
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
  /**
   * `abortSignal` is the CALLER's request authority (a cancelled TanStack
   * read, a disposed host binding). It matters because `sendUnary` can now
   * park waiting for the session to become ready: without it a cancelled read
   * would still be dispatched at the ready boundary and would keep occupying
   * the request coordinator's active slot for the whole dial. `null` for
   * callers that own no authority.
   */
  sendUnary<Method extends keyof RpcRegistry & string>(
    method: Method,
    params: RequestOfMethod<RpcRegistry, Method>,
    abortSignal: AbortSignal | null,
    /**
     * Per-request response budget, overriding `UNARY_RESPONSE_TIMEOUT_MS`.
     * `undefined` keeps the shared default, so only a caller that has a reason
     * to wait longer changes anything - the extension is scoped to that call
     * rather than re-scoring every unary this session carries.
     */
    responseTimeoutMs: number | undefined,
  ): Promise<ResponseOfMethod<RpcRegistry, Method>>;
  subscribe<Method extends keyof StreamRegistry & string>(
    method: Method,
    params: ParamsOf<StreamRegistry, Method>,
  ): IStreamSession;
  subscribeWithParamsProvider<Method extends keyof StreamRegistry & string>(
    method: Method,
    paramsProvider: () => ParamsOf<StreamRegistry, Method>,
  ): IStreamSession;
  notifyBearerRotated(): void;
  /**
   * Tells the session that something outside it has evidence its connection
   * should be re-established sooner than the backoff schedule intends.
   *
   * Two callers, one meaning - "this session was demonstrably needed and did
   * not deliver":
   *  - the runtime resume signal, swept in through `wakeHeldRemoteSessions`
   *    (`IHostStreamClient.reconnectAll` ← `subscribeWakeSignals`). A runtime
   *    that was frozen - laptop sleep, a mobile WebView suspended on every app
   *    switch - comes back with a socket that may already be dead and a backoff
   *    timer armed for a failure that is now minutes old;
   *  - a `sendUnary` caller whose parked request has just failed PRE-SEND,
   *    which is what the user's Retry looks like from down here.
   *
   * Note what is NOT a caller: a request merely arriving at a session that is
   * not ready. Waking on the way in lets ambient polling reads collapse the
   * long tiers continuously, which turns an unavailable host into a dial loop.
   * The wake is earned by a proven failure, not by demand.
   *
   * The session decides what that evidence is worth. A pending redial is pulled
   * forward once - to a jittered sub-second delay, never instantly, and never
   * more than once per armed timer - and a connection that still reads open is
   * probed on a short deadline rather than trusted, because the drop that made
   * it dead may never have been delivered. It never lengthens a pending redial,
   * never disturbs a healthy session, never cancels an attach already in
   * flight, and never forgives the escalation (that needs a connection to
   * SURVIVE; see the class contract). So repeated wakes cannot become a dial
   * loop, and a fleet woken by one shared event does not redial in a herd.
   *
   * `probe` sizes the probe that verdict rides on; `null` is the default
   * desktop-calibrated deadline. A caller that measured a brief mobile
   * background passes a shorter one, and may additionally ask for the redial
   * after a FAILED probe to skip its backoff rung (see
   * {@link WakeProbeTuning}) - the user is watching that recovery happen.
   */
  wake(reason: string, probe: WakeProbeTuning | null): void;
  /**
   * Drops the current socket - alive or not - and redials with no backoff
   * delay. The forced flavour of {@link wake}, for a caller whose evidence
   * says the socket is not worth probing: a user tapping Retry, a network
   * path change under a socket that cannot have survived it, a mobile resume
   * after a background long enough that iOS has torn the socket down.
   *
   * Same skip-not-pardon stance as `wake`: the redial is pulled to now, but
   * the escalation counter is untouched, so a host that is genuinely gone
   * keeps climbing the ladder between forced attempts instead of being pinned
   * at the fastest tier. An attach already in flight is left alone - its own
   * phase timers bound it, and a timer frozen through an OS suspend fires
   * immediately on unfreeze, so a stale dial already fails fast on resume.
   */
  forceReconnect(reason: string): void;
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
   * The terminal fatal that closed this session, or `null` while it is alive
   * OR when it was closed by a caller (`close()` at refcount zero is a
   * lifecycle event, not a verdict). This is how a consumer reacting to
   * `onClosed` distinguishes "the host rejected this session for a reason
   * that will repeat" (incompatible protocol, plan restriction, revoked
   * credential) from "the cache retired an idle session" - the former is
   * worth surfacing and NOT worth immediately redialing, the latter is
   * routine.
   */
  terminalFatal(): FatalErrorDetails | null;
  /**
   * Subscribes to positive evidence that the session just reached its ready
   * boundary (full attach + accepted restore evidence for every live
   * stream; completed delivery stays each stream's own status) - EVERY boundary,
   * including the clean first open. The remote analog of the recovery
   * evidence `WsStreamClient` surfaces via `subscribeAvailabilityRecovered`,
   * consumed to un-strand errored host-scoped queries.
   *
   * The clean first open fires deliberately, unlike the local transport:
   * a remote session is built on demand and torn down at refcount zero
   * (after the cache's keep-warm linger), so its FIRST dial races the very
   * queries that created it. Those queries
   * error pre-send ("Remote session is not ready"), exhaust their retry, and
   * then have no automatic signal left - in production that stranded the
   * Providers panel on an error card for 15-20s (until the query layer's own
   * doubling backoff happened to re-fire) when the session had been ready
   * since second two. For a local transport "first open" happens once per
   * app run before anything could have errored, so never-on-first-open costs
   * nothing there; for the remote session it is precisely the gap. Consumers
   * already cooldown-coalesce (`wireAvailabilityRecovery`), so the extra
   * emission is at most one host-scope invalidation per session build.
   */
  subscribeAvailabilityRecovered(listener: () => void): () => void;
  /**
   * The DOWN edge: this session was ready and no longer is.
   *
   * The counterpart to `subscribeAvailabilityRecovered`, and it exists because
   * `hasReadyRemoteSession` used to be read by two 1-second polls. A poll has
   * no direction - it answered "did this stop being ready" by simply asking
   * again. Replacing it with change events kept only the transitions someone
   * enumerated, and both of those point UP (`subscribeAvailabilityRecovered`,
   * `onClosed`), so a relay `host_detached` or a drop into `reconnecting` left
   * every subscriber holding a stale `true` for the whole outage - and if the
   * reconnect succeeded they never observed the loss at all.
   *
   * Fires on the transition only, never on a re-assertion of the same state,
   * and never for a terminal close (`onClosed` owns that edge - a session that
   * died is not a session that became unready).
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
   * Version selection and dispatch read THIS (an optional method must
   * dispatch like any other); only the session-level compatibility check
   * reads the raw floor.
   */
  hostRpcMerged: ConnectionManifest | null;
  credentialUpdateSupported: boolean;
  /**
   * Whether the HOST advertised that it can inflate compressed frames, i.e.
   * whether frames this client sends may set `MuxFlags.COMPRESSED`. Starts
   * `false` and is only ever raised at `openAck`, so the `open` frame itself —
   * the one frame that must be readable by a host of any vintage — can never
   * go out compressed.
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
   * Armed at the ready boundary, fires after RECONNECT_STABLE_RESET_MS of
   * uninterrupted health and only then clears the ladder. Cancelled on every
   * connection loss so a flapping host never collects partial credit.
   */
  private stableResetTimer: TimerHandle | null = null;
  /**
   * Armed when an attach completes with the ready boundary still unreached,
   * cleared by the boundary or by connection loss. If it fires, some stream's
   * restore has produced no evidence at all for the whole window - no
   * delivered frame and no in-flight chunk - and the session is sitting
   * not-ready on a live mux. That state is otherwise invisible: the surfaces
   * above can only say "still can't connect", which misattributes it. One
   * line naming the unrestored methods is what lets a field report of a stuck
   * banner be attributed to the stream that caused it.
   */
  private restoreStallTimer: TimerHandle | null = null;
  /**
   * Per-stream progress deadlines for in-flight chunk reassembly on the
   * current connection - the replacement for the stall bound that message
   * COMPLETION used to provide implicitly, before the ready boundary started
   * accepting the first chunk as restore evidence. Armed/reset by every
   * accepted chunk of a subscription stream's message, retired when that
   * message completes (or the stream/connection ends). Expiry is the verdict
   * "this transfer stopped": the stream is reopened on a fresh id through the
   * per-stream reopen backoff. See {@link REASSEMBLY_PROGRESS_TIMEOUT_MS} for
   * why no other deadline can observe this state. The token makes a retired
   * arm's callback provably inert - a cleared or superseded watchdog must
   * never reopen a stream that completed or re-armed after it.
   */
  private readonly reassemblyWatchdogs = new Map<
    number,
    { readonly timer: TimerHandle; readonly token: number }
  >();
  /** Monotonic identity for reassembly-watchdog arms (see the map doc). */
  private reassemblyWatchdogToken = 0;
  /**
   * Streams whose CURRENT id exists because a reassembly-stall verdict
   * re-keyed them. Membership is the license for the FIRST-evidence deadline
   * on a subscribe send: a stall verdict only ever follows accepted chunks,
   * so these resolvers PROVABLY emit, and a replacement subscribe answered
   * with nothing is the same stall one hop later. An event-only stream (one
   * with no initial server frame) can never enter this set - it reaches the
   * reopen regime only through a retryable FATAL - so it is never churned
   * through zero-evidence CLOSE/resubscribe cycles; the restore-stall
   * diagnostic remains its observer. Membership moves with each stall
   * re-key and ends on any delivered frame, a host verdict on the id, or a
   * caller close - a host that ANSWERS, even negatively, has disproven the
   * silent-stall premise. Deliberately kept across connection drops: a
   * session reconnect mid-loop replays the member through the same send
   * path, and the loop must not reset with it.
   */
  private readonly stallReopenedStreamIds = new Set<number>();
  /**
   * Whether this session has EVER reached its ready boundary.
   *
   * Separates "recovering" from "still trying for the first time", which two
   * behaviours below must not conflate. A session that has never connected has
   * no established health to recover TO: its failures are the ordinary
   * can't-reach-the-host case, its retries feed the host-liveness evidence
   * machinery, and its ladder must stay exactly what it has always been.
   */
  private hasReachedReadyOnce = false;
  /**
   * Phase-transition stamps for the CURRENT connect attempt, emitted as one
   * breakdown line at the ready boundary.
   *
   * A single "reconnected in 3.2s" number is unactionable - it cannot say
   * whether the time went to backoff we imposed on ourselves, a grant mint, a
   * Noise round trip, or resubscribing N streams, and those have completely
   * different fixes. The rc.1 diagnosis cost two logs and a code read for
   * exactly this class of missing breakdown. Reset per attempt, so a retry
   * never reports its predecessor's timings.
   */
  private reattachMarks: ReattachMarks = emptyReattachMarks();
  /**
   * When the CURRENT outage began, or `0` while a session is healthy.
   *
   * Deliberately outside {@link reattachMarks}, which every `beginConnect`
   * resets: an outage that costs three failed dials is ONE outage to the user,
   * and re-stamping it per attempt would report only the last attempt's share
   * of it. Set on the first loss edge, cleared once a reattach has been
   * reported.
   */
  private connectionLostAt = 0;
  private connection: ActiveConnection | null = null;

  /**
   * This session instance's namespace for the selection authority's evidence
   * ids (redesign P1.3).
   *
   * `connectGeneration` alone is NOT a usable attemptId: the authority
   * deduplicates attempts by (incarnation, attemptId) with no host in the key,
   * so two sessions for two different hosts would both report generation 1 and
   * the second host's first dial would be silently swallowed as a duplicate.
   * The same applies to session ids, which are unique only WITHIN a reporting
   * incarnation. Prefixing with a per-instance label makes both unique across
   * the window without depending on host ids being delimiter-free.
   */
  private readonly evidenceScope = `remote-${(nextRemoteEvidenceScope += 1)}`;
  /**
   * The session id currently announced to the authority as live, or null.
   * Minted at the ready boundary (the ONLY minting site) and retracted at the
   * teardown funnel, so the reporter can never emit `lost` for an id it never
   * announced - nor leave one announced, which would suppress death evidence
   * for this host forever.
   */
  private announcedSessionId: string | null = null;
  /** Distinguishes a mid-session re-auth verdict from its generation's dial. */
  private reauthEvidenceSeq = 0;

  private readonly subscriptions = new Map<number, LogicalStream>();
  private readonly pendingUnary = new Map<number, PendingUnary>();
  private readonly outboundSeq = new Map<number, number>();
  private readonly restoredStreamIds = new Set<number>();
  /**
   * Terminal-stream tombstones, insertion-ordered (mirror of the host's R-2 /
   * `r2-host-stream-tombstone` frontier): every path that ends a stream —
   * local close, received FATAL/CLOSE, inbound reassembly failure, outbound
   * encode failure, unary rejection — records the streamId here, and inbound
   * frames for a tombstoned stream are dropped BEFORE `reassembler.accept`.
   * Without this, a relay-delayed genuine `CHUNK_FIRST` for a dead stream
   * would seed a fresh accumulator nothing ever completes or collects.
   * Bounded by `MAX_TERMINAL_STREAM_IDS` (streamIds are monotonic and never
   * reused within a session, so evicting the oldest is safe).
   */
  private readonly terminalStreamIds = new Set<number>();
  private readonly closedListeners = new Set<() => void>();
  private readonly availabilityRecoveredListeners = new Set<() => void>();
  private readonly readinessLostListeners = new Set<() => void>();
  /**
   * Last readiness this session PUBLISHED, not last readiness it had.
   *
   * The edge detector for {@link subscribeReadinessLost}. Kept as a latch
   * rather than deriving the edge at each call site because readiness is a
   * conjunction of four terms (phase, generation, connection, host attach) and
   * enumerating every mutation that can flip it is precisely the mistake this
   * event exists to correct. Comparing against `isReady()` makes the emitter
   * self-correcting: a transition through a path nobody listed is still
   * reported the next time any site syncs.
   */
  private lastPublishedReadiness = false;
  /**
   * Callers parked inside `sendUnary` waiting for this session to become
   * usable. Settled from exactly three places, which together are every exit
   * a pre-ready session has: `handleOpenAck` (ready), `dropConnection` (this
   * attach attempt is over), and `goTerminalFatal` / `close()` (never
   * coming). A waiter that outlived all three would be a permanently parked
   * query, so every phase transition out of pre-ready must keep settling
   * this set.
   */
  private readonly readyWaiters = new Set<{
    readonly requestId: string;
    readonly method: string;
    readonly resolve: () => void;
    readonly reject: (error: HostRpcError) => void;
    /** Detaches this waiter's abort listener. Called on EVERY settle path. */
    readonly dispose: () => void;
  }>();
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
   * Live subscription to the clock tracker's `skewed → ok` edge while this
   * session is PARKED, or `null` when it is not. Doubles as the parked flag.
   *
   * It is also the only thing that can wake a parked session, and that is
   * load-bearing here in a way it is not in the local transport: parking means
   * no armed backoff, and every other resume path in this file is gated on one
   * (`collapseBackoff` and `pullRedialToNow` both return early on a null
   * `backoffTimer`, and `handleConnectionLost` on a null `connection`). Losing
   * this handle strands the session for the life of the page.
   */
  private clockParkUnsubscribe: (() => void) | null = null;

  private phaseTimer: TimerHandle | null = null;
  private backoffTimer: TimerHandle | null = null;
  /**
   * When the pending `backoffTimer` was armed, and for how long - together, the
   * deadline it will actually fire on. Read by {@link collapseBackoff}, which
   * may only move that deadline EARLIER.
   */
  private backoffArmedAt = 0;
  private backoffDelayMs = 0;
  /**
   * Whether the pending `backoffTimer` has already spent its one wake-driven
   * collapse. Cleared when `scheduleReconnect` arms a fresh timer, so each
   * failure earns exactly one accelerated redial no matter how many wakes
   * arrive during it.
   */
  private backoffCollapsed = false;
  /**
   * The connect generation a {@link forceReconnect} arrived DURING, when that
   * generation's dial was already in flight and could be neither dropped
   * (nothing attached yet) nor hurried (its own phase timers bound it). The
   * intent is scoped to exactly that generation: if generation G fails into
   * the loss funnel, the funnel arms its normal backoff (accounting and
   * evidence preserved) and then spends this intent by pulling that one wait
   * to zero; if G reaches ready, the force is satisfied and the intent is
   * consumed unspent. A newer generation never inherits it - `beginConnect`
   * clears any stale value when it allocates - and terminal close clears it,
   * so callback ordering around an iOS unfreeze (resume task vs overdue
   * phase timer) cannot strand the session on its old rung either way.
   */
  private pendingForceGeneration: number | null = null;
  private reauthTimer: TimerHandle | null = null;
  private standingTimer: TimerHandle | null = null;
  /**
   * Pending per-stream re-opens after a RETRYABLE per-stream fatal, keyed by
   * stream id, with the escalating attempt count that paces them. Separate
   * from `backoffTimer` (which re-dials the whole socket): one resolver
   * failing its init says nothing about the session, and dropping every other
   * stream to recover it would be the shared-fate outcome this avoids.
   *
   * `streamReopenAttempts` outlives its timer deliberately - it is cleared
   * when the stream ends or delivers a frame, so a stream that flaps every few
   * minutes does not inherit the backoff rung of an hour-old episode.
   */
  private readonly streamReopenTimers = new Map<number, TimerHandle>();
  private readonly streamReopenAttempts = new Map<number, number>();

  /**
   * Throttled connect-loop failure logging (see `dial-failure-log.ts`). The
   * loop otherwise fails in TOTAL silence — a relay hostname that does not
   * resolve in DNS produced months of "Remote session is not ready" with not
   * one diagnostic line anywhere on the client.
   */
  private readonly dialFailures: DialFailureLog;

  /** See {@link IRemoteSession.terminalFatal}. Set once, by `goTerminalFatal`. */
  private terminalFatalDetails: FatalErrorDetails | null = null;

  constructor(options: RemoteSessionOptions<RpcRegistry, StreamRegistry>) {
    this.options = options;
    // The same floor/optional split the local `WsRpcClient` advertises, from
    // the same released-floor list - the remote handshake's compatibility
    // check runs over the floor ONLY, so a peer that lacks an optional
    // method degrades instead of fataling the session.
    const rpcSplit = splitConnectionManifest(
      options.rpcRegistry,
      RELEASED_FLOOR_METHOD_NAMES,
      // Unary methods have no client-side implementation to be missing: the
      // client sends a request and reads a response, so every installed major
      // is serveable. Only the STREAM half needs narrowing.
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
      // Console on purpose: this is shared OSS transport code with no logger
      // seam (parity with `WsStreamClient`), and the desktop shell forwards
      // renderer console output into `traycer-desktop.log`.
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
   * True once the Noise handshake + in-channel `open`/`openAck` have both
   * completed and the mux is actively carrying traffic — the live, firsthand
   * evidence the "a client holding an open E2E session renders Online
   * regardless of the lease" status-honesty rule (Architecture §7, R4-B5)
   * reads. `false` while idle/connecting/handshaking/reconnecting, so a
   * session that is merely attempting to attach is never mistaken for proof
   * of liveness.
   *
   * `hostAttached` is part of that evidence: after a relay `host_detached`
   * the session keeps its socket and `phase === "ready"` while it waits for
   * the host to come back, but the mux is carrying nothing — the scheduler is
   * paused and every stream is reconnecting. Answering "ready" there is the
   * standing lie R4-B5 exists to kill (Settings would render Online, off this
   * session, for a host that is OFF — for up to the 15-min standing bound).
   *
   * "Restored" means ACCEPTED restore evidence — a delivered frame, or the
   * first accepted chunk of one still reassembling — not completed delivery.
   * This verdict is connection/host liveness for session-level surfaces; a
   * consumer that needs a specific stream's DATA reads that stream's own
   * status, which stays `reconnecting` until its completed frame lands. The
   * gap between the two (an in-flight transfer that stops) is bounded by the
   * per-stream reassembly watchdog, not by this read.
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
   * Streams with a partially-accumulated inbound chunk sequence on the
   * current connection. Mirror of the host session's accessor: the terminal
   * tombstone regressions pin that a dead stream's delayed chunks can't
   * park an accumulator here forever.
   */
  get pendingReassemblyCount(): number {
    return this.connection?.reassembler.pendingStreamCount ?? 0;
  }

  /**
   * Issues a single unary RPC over the session (single-flight, no post-send
   * auto-retry — local parity).
   *
   * **A session that is still on its way to ready is AWAITED, not rejected.**
   * That is the contract change `createRetryingMessenger` and every
   * pre-send-rejection reader (the Providers panel's recovery reasoning, the
   * compat probe's failure classification) must be read against. Rejecting
   * pre-send looked safe - the class carried the no-dispatch guarantee, so the
   * caller could retry - but the caller's retry budget is a handful of
   * attempts over a few seconds, while a FULL attach is bounded by its phases
   * individually (dial 10s, attach-ack 10s, Noise 15s per round trip, openAck
   * 15s — see `remote/config.ts`) and legitimately exceeds 50s on a slow link.
   * So every consumer that raced a fresh session's first dial - which is every
   * consumer, since the session is built on demand BY those consumers -
   * exhausted its retries against "Remote session is not ready" and then had
   * no automatic signal left. A remote host switch landed on a full-screen
   * "Traycer Host is not responding" for a host that was seconds from ready.
   *
   * The wait is bounded by the session's OWN phase machine, deliberately
   * without a second fixed cap: a disconnected ~20s ceiling would re-introduce
   * exactly the mid-dial strand it was meant to prevent. It ends when the
   * session reaches ready (send), when the attempt it is riding fails (reject
   * `RetryableTransportError` — still provably pre-send, so the caller's
   * retry license is intact and its budget now buys a whole fresh attach), or
   * when the session goes terminal (reject `HostTransportFailureError`).
   *
   * A CLOSED session is not-ready too, but it is never going to become ready:
   * `close()` is terminal (a rejected credential, a plan restriction, an
   * incompatible handshake, or the reconnect cap), and `start()` above only
   * re-dials from `idle`. Waiting on one would park forever, and calling it
   * "retryable" would make `createRetryingMessenger` burn its whole budget on
   * a session that cannot answer. So a terminal session rejects immediately
   * with the non-retryable `HostTransportFailureError`, exactly as
   * `HostRequestAbortedError` does for a disposed request authority: still a
   * transport fault, no longer a promise that waiting will help.
   *
   * Any failure AFTER the request frame is enqueued still surfaces as a plain
   * `HostRpcError` — the host may already have begun applying it.
   *
   * The RESPONSE TIMEOUT is the one carve-out, and it is not an exception to
   * that reasoning but an expression of it: the request provably reached the
   * wire and we merely stopped waiting, which is exactly what
   * `HostTransportFailureError` means. It stays non-retryable (only
   * `RetryableTransportError` asks for another attempt), so "may already have
   * been applied" still holds — the class says dispatched-but-unheard, not
   * safe-to-resend. `WsRpcClient` has always drawn the line here
   * (`transientFailure` picks the transport failure once `requestSent`), so
   * this is the two transports agreeing rather than a new semantic. A caller
   * that can recover from an unheard read — `host.getRateLimitUsage` collects
   * the host's gauge cache shortly after — can only do so if it can TELL, and
   * a plain `HostRpcError` reads as a delivered answer.
   */
  async sendUnary<Method extends keyof RpcRegistry & string>(
    method: Method,
    params: RequestOfMethod<RpcRegistry, Method>,
    abortSignal: AbortSignal | null,
    responseTimeoutMs: number | undefined,
  ): Promise<ResponseOfMethod<RpcRegistry, Method>> {
    this.start();
    const requestId = this.options.requestId();
    if (abortSignal !== null && abortSignal.aborted) {
      throw abortedRequestError(requestId, method);
    }
    if (this.phase !== "ready" || this.connection === null) {
      // Throws on a terminal session, a failed attach, or the caller's
      // authority being aborted while parked; returns once this session is
      // ready to carry the frame.
      try {
        await this.awaitReadyBoundary(requestId, method, abortSignal);
      } catch (cause) {
        if (cause instanceof RetryableTransportError) {
          // The attach this caller was riding has now PROVABLY failed, before
          // anything was sent. That is the moment a wake is earned: someone
          // was demonstrably waiting on this session and got nothing, and
          // their retry budget (`createRetryingMessenger`) is about to be
          // spent against the same cached session - so the next attempt
          // should ride an accelerated timer rather than the tier this
          // failure just escalated to.
          //
          // Only here. Waking on the way IN - before knowing whether the
          // in-progress attach would have succeeded - lets ambient polling
          // reads collapse the 16s and 30s tiers continuously, which turns a
          // genuinely unavailable host into a dial loop and a relay herd.
          // Aborts, terminal closures, post-send ambiguity and host-originated
          // failures never reach this branch: they are not
          // `RetryableTransportError`.
          this.wake("pre-send-failure", null);
        }
        throw cause;
      }
      // LOAD-BEARING, not belt-and-braces. The abort listener above cannot
      // cover every ordering: an abort queued as a MICROTASK before
      // `settleReadyWaiters` resolves this waiter runs before the
      // continuation here, so the waiter is already settled "ready" by the
      // time the signal flips and the listener has been disposed. Nothing
      // else stands between that cancelled read and the wire - the enqueue is
      // a few statements down.
      if (abortSignal !== null && abortSignal.aborted) {
        throw abortedRequestError(requestId, method);
      }
    }
    const connection = this.connection;
    if (this.phase !== "ready" || connection === null) {
      // The wait resolved on a ready boundary that has already been lost
      // again (a drop landing in the same tick). Nothing was sent, so this
      // keeps the pre-send retry license rather than pretending to be a
      // host-originated failure.
      throw this.notReadyRejection(requestId, method);
    }
    if (!connection.hostAttached) {
      // Relay said `host_detached`: the scheduler is paused and nothing will
      // drain it (host re-attach forces a full re-dial — see
      // `onHostAttached`). Enqueueing here would park the frame until the
      // 30s unary timeout kills it as a NON-retryable `HostRpcError`.
      // Pre-send and provably undeliverable ⇒ retryable, same as any other
      // not-ready-yet state.
      return Promise.reject(
        new RetryableTransportError({
          code: "RPC_ERROR",
          message: "Remote host is detached from the relay",
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

    const clientCanonical = this.clientRpcMerged[method];
    const hostCanonical = connection.hostRpcMerged?.[method];
    const methodRegistry = indexMethodRegistry(
      this.options.rpcRegistry,
      method,
    );
    if (clientCanonical === undefined || hostCanonical === undefined) {
      // Now that optional methods no longer fatal the handshake, "this host
      // doesn't have that method" is a NORMAL runtime outcome here, and it
      // must honor the registry's declared degrade exactly as `WsRpcClient`
      // does - callers key off the resulting `E_HOST_UNSUPPORTED` (e.g. the
      // run-settings write queue suppresses only that code to fall back to
      // legacy persist-on-next-send). A generic `RPC_ERROR` would surface as
      // a real failure instead.
      return this.executeUnavailableMethodDegrade(
        connection,
        method,
        methodRegistry,
        clientCanonical,
        connection.hostRpcMerged ?? {},
        params,
        requestId,
        responseTimeoutMs,
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
    ) as Promise<ResponseOfMethod<RpcRegistry, Method>>;
  }

  /**
   * Parks until this session can carry a frame, or until it provably cannot.
   *
   * Resolves at the ready boundary; rejects `RetryableTransportError` when the
   * attach attempt this call is riding fails (pre-send, so the caller may
   * retry into a fresh attempt) and `HostTransportFailureError` when the
   * session goes terminal. There is deliberately NO timer here - the phases
   * are individually bounded and a failed phase lands in `dropConnection`,
   * which settles this waiter; adding a second, shorter ceiling on top would
   * re-create the mid-dial strand this exists to remove.
   */
  private awaitReadyBoundary(
    requestId: string,
    method: string,
    abortSignal: AbortSignal | null,
  ): Promise<void> {
    if (this.isClosed()) {
      return Promise.reject(this.notReadyRejection(requestId, method));
    }
    // A parked waiter carries NO timer of its own, so it is settled only by a
    // later transition reaching `settleReadyWaiters` - `handleOpenAck`,
    // `dropConnection`, `goTerminalFatal` or `close`. `sendUnary` calls
    // `start()` before parking, so an attempt always owns the loop.
    //
    // The one path worth naming: `handleUnauthorizedSessionFatal` calls
    // `dropConnection` and then `revalidateThenReconnect`, which can return
    // without calling `scheduleReconnect` when `phase !== "reconnecting"` or
    // `connection !== null`. Both conditions mean another attempt already owns
    // the loop, so a waiter created in that window is still settled by that
    // attempt - safety that lives in a guard in a different method, exactly
    // like the incidental case documented on `beginConnectGuarded`. An edit
    // that relaxes either condition has to re-check this.
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
      // Named rather than inline so `dispose` can remove exactly this
      // listener. A waiter that settles normally must not leave a listener on
      // a signal that can outlive it (a request context's signal lives as
      // long as the sign-in session), which is a leak per parked call.
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

  /**
   * Settles every parked `sendUnary` caller.
   *
   * The failure path re-derives its class per waiter at settle time, so one
   * call site covers both endings correctly: a drop leaves the session able to
   * reach ready again (`RetryableTransportError`), while a terminal fatal or
   * `close()` has already set `phase = "closed"` and therefore yields the
   * non-retryable `HostTransportFailureError` carrying the verdict.
   */
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

  /**
   * The pre-send failure for a session that is not carrying frames. Retryable
   * while the session can still reach ready; a terminal one carries its
   * verdict so the surface showing the failure can say WHY (plan restriction
   * vs incompatible protocol vs revoked credential), not just "closed".
   */
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
      : new RetryableTransportError(notReady);
  }

  /**
   * Sends an ALREADY-negotiated method at EXPLICIT versions.
   *
   * The versions are parameters rather than re-derived from the manifests
   * because a degrade fallback targets the version its declaration names
   * (`degrade.to`), which is not necessarily the target method's canonical
   * version - re-deriving would validate the already-adapted request, and
   * transform the response, against the wrong contract.
   */
  private dispatchNegotiatedUnary(
    connection: ActiveConnection,
    method: string,
    methodRegistry: MethodVersionRegistry,
    clientCanonical: SchemaVersion,
    hostCanonical: SchemaVersion,
    params: unknown,
    requestId: string,
    responseTimeoutMs: number | undefined,
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

    const streamId = this.allocateStreamId();
    return new Promise<unknown>((resolve, reject) => {
      {
        const timer = setTimeout(() => {
          this.rejectUnary(streamId, unaryTimeoutError(requestId, method));
        }, responseTimeoutMs ?? UNARY_RESPONSE_TIMEOUT_MS);
        this.pendingUnary.set(streamId, {
          requestId,
          method,
          clientCanonical,
          hostCanonical,
          methodRegistry,
          onWireRequest: prepared.onWirePayload,
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
              idempotencyKey: null,
            },
            binary: null,
          });
        } catch (cause) {
          this.clearPendingUnary(streamId);
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
    return this.subscribeWithParamsProvider(method, () => params);
  }

  /**
   * Opens a logical stream whose params are re-read for every full attach.
   * The mux reconnect path re-opens every live LogicalStream, so keeping the
   * provider on that stream makes resume cursors current at the exact wire
   * subscribe boundary rather than frozen at session creation.
   */
  subscribeWithParamsProvider<Method extends keyof StreamRegistry & string>(
    method: Method,
    paramsProvider: () => ParamsOf<StreamRegistry, Method>,
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
      // A ready session is the only one that can be sitting on a socket the
      // runtime never saw die: its liveness rests on an INTERVAL, which was
      // frozen along with the runtime, so an overdue tick is all that stands
      // between a dead socket and work being parked on it. A dial caught
      // mid-flight is bounded by its own one-shot phase timer instead, which
      // comes back overdue and fires on its own, so it needs nothing here.
      //
      // Order matters. The poke can land in `handleConnectionLost` (when the
      // socket is ALREADY provably stale), which arms a fresh backoff - so the
      // collapse below has to run afterwards to pull that redial forward too.
      // A socket that merely looks alive is left connected and answers the
      // poke's probe on its own deadline.
      //
      // Deadline and failure policy travel INTO the socket together: the arm
      // merges concurrent pokes monotonically (earlier deadline wins, the
      // immediate-redial policy can be raised but never lowered), so mixed
      // wake bursts - a measured mobile resume beside a generic online edge,
      // in either order - always keep the stronger evidence.
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
      // A client-initiated teardown says nothing about the host - the durable
      // rule is that `confirmed-refusal` requires evidence from the HOST's
      // transport plane, and this loss is our own decision (see the provenance
      // note on `handleConnectionLost`).
      this.handleConnectionLost(
        connection.generation,
        `forced-reconnect:${reason}`,
        "not-host-evidence",
      );
      this.pullRedialToNow(reason);
      return;
    }
    if (this.backoffTimer !== null) {
      // An armed backoff timer is the truth REGARDLESS of phase: the
      // pre-dial landers (a failed grant mint, a thrown connect path) arm it
      // while the phase still reads `connecting`, and a force landing just
      // after one of them has no future failure lander left to spend a
      // recorded intent - the pending wait itself is what must move.
      this.pullRedialToNow(reason);
      return;
    }
    // A dial/handshake/revalidation is genuinely in flight with no timer
    // armed: it is not interrupted (one dial owner at a time), but the
    // demand is NOT dropped either - record it against this exact
    // generation, so if this attempt fails its loss redials immediately
    // instead of arming the rung the caller was trying to skip. Success
    // consumes the intent - a fresh attach is everything a force could have
    // bought.
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
    // A parked session's tracker subscription is the one handle that is NOT a
    // timer, so `clearAllTimers` cannot reach it. Left attached it would redial
    // a closed session the next time somebody's clock came right.
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
      // Fixed-per-stream class (per-stream FIFO invariant); a large binary is
      // still chunked at 64 KiB but stays this stream's class (the chunk
      // source overrides >1 MiB bodies to BULK).
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
      // Deterministic encode failure: this one frame can never be sent, and
      // stream frames have no per-call reply channel — fail the stream so
      // the surface shows a typed error instead of hanging on a frame the
      // transport silently owed it.
      connection.scheduler.dropStreamOutbound(streamId);
      connection.reassembler.forget(streamId);
      this.markStreamTerminal(streamId);
      this.subscriptions.delete(streamId);
      this.restoredStreamIds.delete(streamId);
      this.outboundSeq.delete(streamId);
      // Terminal end: same retry-state cleanup as the FATAL/CLOSE branches.
      this.clearStreamReopen(streamId);
      stream.goFatal({
        code: "STREAM_MESSAGE_TOO_LARGE",
        reason: error.message,
        incompatibleMethods: null,
        upgradeGuidance: null,
      });
      this.enqueueMessage(connection, {
        type: MuxFrameType.CLOSE,
        streamId,
        qos: QosClass.INTERACTIVE,
        json: { reason: "outbound frame exceeded the message cap" },
        binary: null,
      });
      this.maybeReachReadyBoundary();
    }
  }

  /**
   * `LogicalStreamPort.requestSessionReconnect`. Routes a caller-requested
   * reconnect (a post-sleep/wake liveness nudge, a store discarding a socket
   * whose frames it could not parse) through the SAME `handleConnectionLost`
   * path a real transport drop takes, so the backoff state machine, stream
   * re-subscribe, and pending-unary rejection stay in one place. No-op when
   * idle or closed - there is no socket to replace, and the existing
   * `beginConnect`/backoff already owns getting one.
   *
   * `not-host-evidence`: WE asked for this teardown. The host refused
   * nothing - it may be answering perfectly, which is exactly the case a
   * caller nudging for liveness is in. Sharing the funnel is right; sharing
   * its VERDICT is not.
   */
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
    this.outboundSeq.delete(streamId);
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
      // Drop the stream's queued/mid-transfer outbound first, or per-stream
      // FIFO would park this CLOSE behind a transfer nobody wants anymore
      // (the peer's reassembler accepts a CLOSE mid-sequence as an abort).
      connection.scheduler.dropStreamOutbound(streamId);
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
    // A dial is happening, so nothing is parked any more - whether we got here
    // from the recovery edge or from any path that armed a backoff straight
    // through a park. Idempotent.
    this.clearClockPark();
    const generation = ++this.connectGeneration;
    // Any intent recorded against an earlier generation is stale by
    // construction: that dial ended (its failure spent the intent, or a path
    // that never consults it retired the attempt), and this fresh dial must
    // not inherit a demand nobody made of it.
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
      // Backoff cannot fix a plan — go terminal so the caller surfaces the
      // upsell instead of silently redialing forever. A later attempt (after
      // an upgrade) builds a fresh session; the closed one is evicted from
      // the session cache on the next acquire.
      this.goTerminalFatal(planRestrictedFatalDetails());
      // The SOLE provenance of `dead("plan-restricted")` (grant-client's
      // `plan-restricted` arm). Reported AFTER the terminal teardown so the
      // funnel has already retracted any announced session — a live session
      // would otherwise suppress this refusal and the lease would settle
      // `offline`, routing the ∅ modal to "retry" for a user whose only fix
      // is an upgrade. Unlike every other mint failure this is a stable
      // per-host entitlement verdict, not a fleet-correlated outage, which is
      // why it counts as host evidence at all.
      this.reportEvidenceOutcome(
        this.dialAttemptId(generation),
        "plan-restricted",
      );
      return;
    }
    if (provision.kind === "unavailable") {
      // No grant (signed out / revoked / transient CS failure): stay in backoff.
      // This attach attempt is over before it dialed, so parked `sendUnary`
      // callers settle here rather than riding an unbounded number of further
      // mint attempts inside one call.
      this.settleReadyWaiters(false);
      // INDETERMINATE, never a refusal. Every arm folded into `unavailable` -
      // signed out, a rejected bearer, a revoked host, an authn 5xx, a
      // malformed body - is a CREDENTIAL/AUTHN-plane failure: the host was
      // never dialed, so nothing here is evidence about whether it is alive.
      // Counting it would let one authn outage reach the confirmed-death
      // streak on every remote host simultaneously and fail the whole fleet
      // over to local, which is the false-Offline class invariant 5 exists to
      // prevent. A host that really is down still produces its refusal at the
      // `handleConnectionLost` funnel, which observes the host's own plane.
      this.reportEvidenceOutcome(
        this.dialAttemptId(generation),
        "indeterminate",
      );
      const retryInMs = this.scheduleReconnectForFailedGeneration(generation);
      this.dialFailures.recordFailure({
        cause: `could not mint an attach grant: ${provision.detail}`,
        // The per-attempt text goes in the CONTEXT, never the cause: a server
        // body routinely carries a request id or timestamp, and a socket-level
        // throw carries the address THIS attempt resolved, so a cause built
        // from either would differ on every attempt and defeat this log's
        // throttle entirely. It arrives already attributed to its source — see
        // `AttachGrantFailure` — so it is passed through, not re-worded.
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
          // The socket's own verdict on the current wake-probe arm, read at
          // the one moment it matters: this close IS the arm's negative
          // ending, whatever delivered it - the arm's own deadline, an
          // OS-delivered error close, missed pongs. An answered arm reads
          // false here forever, so a loss after proven liveness stays an
          // ordinary loss. Each connection owns its socket object, so this
          // cannot leak across dials.
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
    //
    // ORDERING INVARIANT (load-bearing once every large message is a long
    // chunk sequence): `noise.decrypt` is entered SYNCHRONOUSLY here and its
    // receive mutex admits waiters in call order, so per-frame continuations
    // resume in arrival order — and nothing below may `await` between decrypt
    // and `reassembler.accept`, or concurrent inbound delivery could splice
    // chunk sequences. Pinned by the arrival-order conformance test.
    this.armStandingTimer();
    void (async () => {
      const muxBytes = await connection.noise.decrypt(bytes);
      if (!this.isCurrent(generation)) {
        return;
      }
      const frame = decodeMuxFrame(muxBytes);
      // Bulk credit accounting is PER FRAME at receipt, symmetric with the
      // host's spend-per-frame-sent — counting per completed message would
      // deadlock any transfer longer than the initial credit window at
      // exactly `INITIAL_BULK_SEND_CREDITS` frames (critique C1).
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
        // Client mirror of the host's R-2 tombstone check: every terminal
        // path forgets the reassembler entry for its stream, but a relay can
        // still deliver a withheld genuine frame for that streamId afterward
        // — and since `accept()` starts a FRESH accumulator for any
        // unrecognized stream, letting it through would resurrect an
        // uncollectable accumulator that lingers to connection teardown.
        // Runs AFTER credit accounting (the frame was still delivered, so
        // the grant stays symmetric with the host's per-frame spend).
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
        // A chunk was accepted for a message still in flight. For a stream
        // subscription that is all the proof "restored" asks for: the host
        // accepted the subscribe and its data is arriving on the mux, so the
        // SESSION-level ready boundary must not stay hostage to the transfer
        // finishing. A large snapshot (tens of MB through the relay) can take
        // minutes on a slow link, during which every connection-plane surface
        // - the connectivity banner, availability recovery, the backoff
        // stable-reset - would otherwise report an outage on a link that is
        // demonstrably carrying frames, inviting the exact retry/redial that
        // restarts the transfer from zero. The stream's own consumer still
        // waits for the completed message; only the session verdict moves
        // early. Per-stream reopen escalation is deliberately NOT reset here
        // - a delivered frame remains its only proof (see the dispatch path).
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
   * Per-stream routing for deterministic inbound reassembly failures
   * (Decision 6 of the whole-body-chunking plan): a chunk-sequence fault, an
   * over-cap message, or an undecodable body on stream N proves nothing about
   * the session — the Noise decrypt already succeeded — so it fails that ONE
   * stream (a live subscription gets its fatal, a pending unary rejects)
   * instead of the blanket connection drop, which at 100 MB snapshot scale
   * would loop: reconnect → identical snapshot → identical failure. Returns
   * false for anything that IS session-level (control-stream faults, unknown
   * errors), which the caller re-throws into the connection-lost path.
   *
   * `MuxFrameDecodeError` belongs in that set even though the class is also
   * thrown for FRAME-level faults, and the placement of the caller's `try` is
   * what makes the distinction sound: `decodeMuxFrame` runs OUTSIDE it, so a
   * malformed header — which names no stream and therefore has nothing to
   * blame — still reaches `handleConnectionLost` unchanged. What reaches HERE
   * is only what `ChunkReassembler.accept` throws for an already-attributed
   * frame: a body whose framing or json will not decode, or a compressed
   * payload `inflateFramePayload` rejects. Both are per-stream by
   * construction. `inflateFramePayload` in particular is a pure function over
   * one frame — raw deflate into a fresh buffer, no context carried between
   * frames or streams — so a corrupt payload cannot have poisoned anything a
   * sibling stream depends on, and failing the session closed would buy no
   * safety while guaranteeing the reconnect loop above for any peer that
   * mis-encodes deterministically.
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
      // Its own code rather than folding into the reassembly one: a corrupt
      // compressed payload and a chunk-sequence fault send a reader to
      // different places, and a fatal that misnames its own cause is the
      // misdirection this epic keeps removing.
      code: streamInboundFailureCode(error),
      reason: error.message,
      incompatibleMethods: null,
      upgradeGuidance: null,
    };
    const pending = this.pendingUnary.get(frame.streamId);
    if (pending !== undefined) {
      // `rejectUnary` is the full terminal transition: drops queued outbound,
      // forgets the accumulator, tombstones the id, and CLOSEs the stream so
      // the host stops producing for it.
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
    // Not local-only (S2 of the cold review): without the outbound drop the
    // stream's own queued frames keep sending, and without the CLOSE the
    // host keeps its resolver and server-push producer alive — serializing,
    // pacing, encrypting, and credit-spending for a stream this side already
    // deleted. Drop the dead transfer FIRST or per-stream FIFO would park
    // the CLOSE behind it.
    const connection = this.connection;
    if (connection !== null) {
      connection.scheduler.dropStreamOutbound(frame.streamId);
      connection.reassembler.forget(frame.streamId);
    }
    this.markStreamTerminal(frame.streamId);
    if (this.phase === "ready" && connection !== null) {
      this.enqueueMessage(connection, {
        type: MuxFrameType.CLOSE,
        streamId: frame.streamId,
        qos: QosClass.INTERACTIVE,
        json: { reason: `inbound stream failed: ${details.code}` },
        binary: null,
      });
    }
    const stream = this.subscriptions.get(frame.streamId);
    if (stream !== undefined) {
      stream.goFatal(details);
      this.subscriptions.delete(frame.streamId);
      this.restoredStreamIds.delete(frame.streamId);
      this.outboundSeq.delete(frame.streamId);
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
      // No bearer to present → cannot authenticate the session; stay in
      // backoff. `not-host-evidence` for the same reason a failed grant mint
      // is indeterminate: this is the CREDENTIAL plane refusing us, one step
      // before the host was ever asked anything. Counting it would let a
      // signed-out moment march every remote host toward confirmed death at
      // once.
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
      // Advertised UNCONDITIONALLY: both entries describe what this client can
      // COPE with, never what it demands, so a host that has never heard of
      // either simply strips the key (zod objects are non-strict) and keeps
      // behaving exactly as it does today. There is deliberately no version
      // branch here — a capability the peer ignores must be indistinguishable
      // from one it never received.
      capabilities: [
        SESSION_CAPABILITY_BODY_COMPRESSION,
        SESSION_CAPABILITY_FINE_CREDITS,
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
      // A received terminal verdict ends the stream in BOTH directions:
      // whatever this side still had queued for it (say, a partial upload)
      // is undeliverable by verdict, and the id is tombstoned so a
      // relay-delayed chunk can't reseed an accumulator.
      connection.scheduler.dropStreamOutbound(message.streamId);
      connection.reassembler.forget(message.streamId);
      this.markStreamTerminal(message.streamId);
      const pending = this.pendingUnary.get(message.streamId);
      if (pending !== undefined) {
        // Unary requests live in `pendingUnary`, not `subscriptions` — a
        // host-side per-stream FATAL for a failed request (e.g. the upload
        // exceeded the host's message cap mid-reassembly) must reject the
        // caller NOW, not after the 30s unary timeout (S3 of the cold
        // review).
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
      // A RETRYABLE per-stream fatal is the resolver saying "this open failed,
      // ask again" - not a verdict on the subscription. Disposing it here made
      // `retryable` mean something different on this transport than on the
      // local socket, where the session's own reconnect re-subscribes: the
      // stream went permanently dead while every consumer, reading the same
      // flag, believed a recovery was in flight. Re-open it on the shared
      // backoff instead and keep it in `subscriptions`, so a later session
      // reconnect replays it like any other live stream.
      if (parsed.data.details.retryable === true && this.phase !== "closed") {
        this.restoredStreamIds.delete(message.streamId);
        this.outboundSeq.delete(message.streamId);
        // The verdict just tombstoned this id on BOTH peers: the host marks a
        // stream terminal whenever it sends a FATAL, and its R-2 ingest check
        // then drops every later frame for that id - a SUBSCRIBE included -
        // so a re-open under the same id can never be answered on this
        // connection. It would sit `reconnecting` forever against a host that
        // is deliberately ignoring it (only the test fake, which now enforces
        // the same invariant, ever accepted one). The re-open therefore rides
        // a FRESH id, exactly as if the consumer had subscribed anew; the
        // attempt count moves with the stream so the backoff keeps climbing
        // across re-keys, and the old id stays tombstoned so relay-delayed
        // frames from before the verdict remain dead.
        this.subscriptions.delete(message.streamId);
        const reopenAttempts = this.streamReopenAttempts.get(message.streamId);
        this.streamReopenAttempts.delete(message.streamId);
        const freshStreamId = this.allocateStreamId();
        // The verdict answers THIS attempt; it says nothing about the next
        // one. A stall license the stream already held is the stronger prior
        // fact - its resolver provably emitted and then stopped - and a
        // retryable refusal of one re-subscribe does not disprove it, so the
        // license MOVES with the re-key exactly as the attempt count does. A
        // stream that entered the reopen regime through this verdict alone
        // never held one, so an event-only method still re-subscribes
        // unarmed.
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
      // A host CLOSE ends the stream as terminally as a caller close does, so
      // it clears the same retry state: the pending re-open timer (a closed
      // stream must not re-subscribe) AND the attempt count. The count is
      // only otherwise cleared by a delivered frame, so a reopened stream the
      // host closes BEFORE its first frame - a normal end for a short-lived
      // stream - leaked its entry in this long-lived session forever.
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
          // A frame is the only proof the re-open actually worked, so the
          // escalation resets here rather than at subscribe time - a stream
          // that fails init repeatedly must keep climbing the backoff. The
          // stall provenance ends with it: the resolver answered, so a later
          // silence is a fresh episode that must earn its own verdict.
          this.streamReopenAttempts.delete(message.streamId);
          this.stallReopenedStreamIds.delete(message.streamId);
        }
      }
    }
  }

  /**
   * A method this host never advertised. Applies the registry's DECLARED
   * degrade through the shared policy (see `unavailable-method-degrade.ts`) -
   * `E_HOST_UNSUPPORTED` for an `unsupported` declaration, or the declared
   * floor fallback dispatched back through this same session.
   */
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
      // Dispatched at the versions the DECLARATION names, not the target's
      // canonical pair: `degrade.to` may anchor an older version, and the
      // request handed over here is already adapted to it. Re-entering
      // `sendUnary` would re-derive canonical versions and validate the
      // adapted payload - and transform the response - against the wrong
      // contract. Same anchoring the local transport's fallback tests pin.
      execute: (input) =>
        this.dispatchNegotiatedUnary(
          connection,
          input.method,
          input.methodRegistry,
          input.clientCanonical,
          input.hostCanonical,
          input.params,
          requestId,
          // The degraded retry is the SAME caller request on an older
          // contract, so it keeps that caller's budget rather than silently
          // reverting to the shared default.
          responseTimeoutMs,
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
    // Publish what this host advertised so UI layers can gate an optional
    // (non-floor) affordance without calling the method - the exact mirror of
    // `WsRpcClient`'s publish on the local path, and recorded BEFORE the
    // compatibility check for the same reason: an incompatible pairing still
    // tells us truthfully which methods the host has. A long-lived session
    // refreshes this on every re-attach, which is when a host upgraded
    // underneath us re-handshakes.
    recordNegotiatedHostManifest(this.options.hostId, hostRpcMerged);
    // Floor vs floor ONLY - optional methods are deliberately outside the
    // session-fatal surface (see `SessionManifests`); a peer lacking one
    // degrades per-call/per-gate instead.
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
    connection.bodyCompressionSupported = parsed.data.capabilities.includes(
      SESSION_CAPABILITY_BODY_COMPRESSION,
    );
    if (
      parsed.data.capabilities.includes(SESSION_CAPABILITY_FINE_CREDITS) &&
      FINE_INITIAL_BULK_SEND_CREDITS < INITIAL_BULK_SEND_CREDITS
    ) {
      // Shrinking the un-granted send window is the ONE half of the credit
      // change that can deadlock, so it happens here and only here: after a
      // host has said, in this session, that it grants finely. A host that
      // said nothing keeps the legacy 32 MiB window, which is wasteful but
      // never wedged.
      connection.scheduler.adoptNegotiatedCreditWindow(
        FINE_INITIAL_BULK_SEND_CREDITS,
      );
    }
    this.clearPhaseTimer();
    this.phase = "ready";
    this.reattachMarks.openAckAt = Date.now();
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
    this.armRestoreStallTimer(generation);
    // The session can carry frames from here: release every `sendUnary`
    // caller parked through this attach.
    this.settleReadyWaiters(true);
  }

  /**
   * Arms the restore-stall diagnostic for this attach: a no-op when the
   * boundary was already reached above, one line if any stream is still
   * producing zero restore evidence a full window after the attach completed.
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
   * (Re-)arms the progress deadline for one subscription stream's in-flight
   * reassembly. Non-subscription streams are excluded: a chunked unary
   * response is already bounded by its own response timeout.
   *
   * The fired verdict defers while the host leg is detached at the relay -
   * silence there is the HOST's, not this stream's (the same attribution rule
   * the restore-stall diagnostic follows), and the detach recovery path owns
   * that episode. The watchdog re-arms so the verdict resumes if the leg
   * returns without a reconnect.
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

  /**
   * The watchdog's expiry verdict: the transfer stopped, so the stream's
   * restore failed. Routed through the same fresh-id reopen shape as a
   * retryable per-stream FATAL - abandon the partial body, tombstone the old
   * id on this side (a relay-delayed late chunk must not reseed an
   * accumulator), tell the host to stop paying for the dead transfer, and
   * re-subscribe under a fresh id on the per-stream reopen backoff. The
   * verdict is stream-local on purpose: the rest of the mux is provably
   * carrying traffic, so the session-level boundary and every surface reading
   * it stay put, exactly as they do for a resolver stuck in its reopen loop.
   */
  private reopenStalledStream(
    streamId: number,
    stream: LogicalStream,
    connection: ActiveConnection,
  ): void {
    connection.reassembler.forget(streamId);
    this.markStreamTerminal(streamId);
    this.restoredStreamIds.delete(streamId);
    this.outboundSeq.delete(streamId);
    this.subscriptions.delete(streamId);
    // Drop queued outbound first so per-stream FIFO cannot park the CLOSE
    // behind a transfer nobody wants anymore (mirrors `closeStream`).
    connection.scheduler.dropStreamOutbound(streamId);
    this.enqueueMessage(connection, {
      type: MuxFrameType.CLOSE,
      streamId,
      qos: QosClass.INTERACTIVE,
      json: { reason: "reassembly-stalled" },
      binary: null,
    });
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
    const clientCanonical = selectedClientManifest[stream.method];
    const hostCanonical = hostManifest.stream[stream.method];
    const compat = checkStreamMethodCompatibility(
      this.options.streamRegistry,
      selectedClientManifest,
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
      this.stallReopenedStreamIds.delete(stream.streamId);
      return;
    }
    // No tombstone to lift here - deliberately. A tombstoned id is dead on
    // BOTH peers: the host's R-2 ingest drop covers a SUBSCRIBE too, so
    // re-subscribing one could never be answered, and an earlier draft that
    // lifted the client's own tombstone here merely made the client accept
    // frames the host would never send. Instead the retryable-FATAL branch
    // re-keys its stream to a FRESH id at the verdict, which is what keeps
    // every id this method subscribes un-tombstoned by construction - every
    // other terminal path removes its stream from `subscriptions` outright.
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
      // A stall-reopened stream's resolver provably emits (the stall verdict
      // only ever follows accepted chunks), so its replacement subscribe
      // cannot be trusted to produce evidence on its own: its FIRST evidence
      // is bounded exactly as inter-chunk progress is, from the moment the
      // subscribe is sent. This is what makes the stall recovery a
      // self-sustaining loop - an expiry with zero frames re-keys and
      // re-subscribes again on the climbing per-stream backoff - and it
      // covers the reconnect-mid-loop case too, since the openAck replay of
      // a loop member passes through here as well. Every OTHER subscribe
      // stays unarmed - including a retryable-FATAL reopen, whose method may
      // legitimately emit nothing on subscribe (an event-only stream) and
      // must not be churned through zero-evidence CLOSE/resubscribe cycles;
      // the attach fan-out's silent streams have the stall diagnostic naming
      // them. The arm retires through the same evidence/verdict/close/drop
      // set as any other.
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

  /**
   * A relay `host_detached`: the host leg went away, the client leg did not.
   *
   * Two different things are announced from this connection, and they part
   * ways here:
   *
   *  - The SOCKET stays. `host_detached` is transient; `onHostAttached` gates
   *    on `!connection.hostAttached` precisely to restore through it, and
   *    tearing the connection down would turn a recoverable blip into a full
   *    redial. `isReady()` includes `hostAttached`, so `hasReadyRemoteSession`
   *    stops counting this host the moment the flag clears; the
   *    `syncReadinessLatch()` at the end is what tells its subscribers.
   *  - The AUTHORITY SESSION goes. `announceSession` at the ready boundary told
   *    the selection authority this host has a live session, and an announced
   *    session suppresses ALL death evidence for its host and pins its lease
   *    `ready` (see `teardownConnection`). A previous version of this method
   *    kept it announced through the detach, reasoning from `isReady()` - a
   *    different consumer. The result was the silent outage: a remote host
   *    whose box lost power read `ready` in every window, refusals against it
   *    were dropped, no corpse ceiling was armed (that arms on `sessionLost`),
   *    and failover was impossible until the 15-minute standing bound - which
   *    is re-armed on every attach, so it measured from the LAST attach, not
   *    from the detach. Retracting here is what lets the authority see the
   *    host as it is; the next ready boundary re-announces under the new
   *    connect generation, exactly as it does after any redial.
   */
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
    // A detach is a DOWN edge even though the socket survives, so the two
    // things every other loss edge does through `handleConnectionLost` have to
    // happen here too - this path does not reach that funnel.
    //
    // The probation timer especially: it is a claim about SUSTAINED HEALTH,
    // and a host that is absent is not healthy. Left armed it would fire mid
    // detach, reset the ladder to rung 0, and hand the full reconnect that
    // `onHostAttached` triggers the immediate rung - so a host whose uplink
    // flaps on a period longer than the probation window gets redialled
    // immediately every time, which is the exact behaviour the window exists
    // to prevent.
    this.clearStableResetTimer();
    // The stall diagnostic reads "no restore evidence" as a fact about the
    // stream; with the host absent that silence is the HOST's, so the line
    // would misattribute. The reattach path arms a fresh window.
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
      // A relay policy kill can be congestion (for example, the relay's
      // client-leg buffer limit), not an authorization verdict. Future relay
      // kill reasons are conservatively treated the same way: retry them, but
      // never redial an unknown overloaded session at the ordinary 1s rung.
      // The two known non-congestion losses retain their regular schedule.
      // Keep this in the existing reconnect state machine; only its entry rung
      // differs.
      this.raiseReconnectBackoffToMax();
    }
    this.handleConnectionLost(generation, `peer-gone:${reason}`, provenance);
  }

  /**
   * Any transport loss → drop the connection and full-resume from backoff.
   *
   * `provenance` is REQUIRED, and is the whole reason this parameter exists:
   * the funnel is shared by losses that are host evidence and losses that are
   * not, and before it was threaded here every caller was laundered into a
   * confirmed refusal on the way past. A required argument makes the census
   * mechanical - a new caller cannot reach this funnel without stating which
   * kind of loss it is.
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
    // THE host-plane funnel: every relay-socket close, Noise/handshake
    // rejection, `peer_gone`, and phase timeout arrives here. This is the one
    // site in the remote loop that observes the HOST rather than the cloud, so
    // it is the one that produces confirmed refusals. `dropConnection` above
    // has already retracted the announced session, so the refusal is not
    // suppressed by liveness that no longer exists.
    //
    // ...but only for losses that ARE host evidence. A caller-requested
    // reconnect and a missing local bearer both arrive here too, and neither
    // is a statement about the host: the durable rule is that
    // `confirmed-refusal` requires evidence from the HOST's transport plane,
    // and a client's own teardown request is self-evidence. Reporting those as
    // refusals let three app-driven reconnects reach the confirmed-death
    // streak on a host that never stopped answering - the false-Offline class
    // invariant 5 exists to prevent, reintroduced from inside the client.
    //
    // Its own attempt id, NOT the generation's: a generation that reached
    // ready already reported success under `#<generation>`, and the authority
    // deduplicates by attempt id - so reusing it would swallow the very first
    // refusal after a live session died, the most common death there is. This
    // funnel runs at most once per generation (`isCurrent` fails the moment
    // `dropConnection` nulls the connection), so the suffixed id stays a
    // faithful one-attempt-one-outcome report.
    this.reportEvidenceOutcome(
      `${this.evidenceScope}#${generation}-lost`,
      provenance === "host-transport-plane" ? "refusal" : "indeterminate",
    );
  }

  /**
   * Shared drop bookkeeping for a lost connection: tear the transport down,
   * fail in-flight unary calls, flag streams reconnecting. The caller decides
   * what happens next - `handleConnectionLost` schedules the backoff redial
   * immediately; the `UNAUTHORIZED` session-fatal path first revalidates the
   * credential and only then reconnects (or goes terminal).
   *
   * "Shared" is now literal. The two lines below used to sit in
   * `handleConnectionLost`, which reads as the funnel but is only ONE of three
   * callers - and the other two are exactly the ones that keep the session
   * disconnected for an unbounded time. `handleUnauthorizedSessionFatal` awaits
   * an auth-plane round trip before it redials, and the connect-path-threw
   * lander is a pre-dial failure; neither cleared the ladder-reset probation
   * timer, so an ABSENT host went on being counted as sustained health and a
   * timer that expired mid-outage handed the eventual redial the immediate
   * rung. Both facts are properties of the DROP - the ladder reset was not
   * earned, and this is when the outage clock starts - so they belong with the
   * drop rather than with one caller's choice of what to do next.
   */
  private dropConnection(cause: string): void {
    // Before anything else: a connection that is being lost never earned its
    // ladder reset, however close it came.
    this.clearStableResetTimer();
    // The stall diagnostic speaks for ONE attach's restores; the drop ends
    // that attach, and the next one arms its own. Same for the reassembly
    // watchdogs: every partial they were pacing died with the connection.
    this.clearRestoreStallTimer();
    this.clearAllReassemblyWatchdogs();
    // Guarded internally to once per outage, so a failed redial arriving here
    // again does not restart the clock.
    this.noteConnectionLost();
    this.phase = "reconnecting";
    this.restoredStreamIds.clear();
    this.teardownConnection(cause);
    // A pending per-stream reopen's job transfers to the next handshake: the
    // openAck replay re-subscribes every stream in `subscriptions`, so a timer
    // that survived the drop would only issue a DUPLICATE subscribe for a
    // stream the replay already recovered. The attempts map deliberately
    // stays - a resolver that keeps failing its init must keep climbing the
    // backoff across session drops, not restart it.
    this.clearAllStreamReopens();
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
    // Callers parked awaiting THIS attach are still pre-send, so they keep
    // their retry license - but they must be released rather than left to
    // ride an unbounded number of further attempts inside one call.
    this.settleReadyWaiters(false);
    this.markStreamsReconnecting();
    // The DOWN edge, from the funnel every drop passes through. `isReady()`
    // is false the moment `connection` is nulled above; publishing that here
    // means no caller can forget. `handleUnauthorizedSessionFatal` had - the
    // one drop from a READY session that ran without this - so
    // `subscribeReadinessLost` never fired and `hasReadyRemoteSession` held a
    // stale `true` for the whole revalidate-and-backoff window: exactly the
    // stale-true class that subscription was added to close.
    this.syncReadinessLatch();
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
    // The restart tombstone (P1.4 / D5 / M1), reported BEFORE the teardown it
    // announces. This is the ingress by which a restart issued from ANY
    // client - a GUI on the user's other machine, a CLI on the box, an update
    // install - reaches this window's selection authority, which otherwise
    // sees only a socket dying and cannot tell deliberate from dead.
    //
    // It does not replace the loss report below, and must not: the session
    // really is going away, and the authority's derivation order is what puts
    // the expected-outage HOLD above the death streak the loss feeds. Two
    // honest reports beat one that tries to mean both.
    this.reportRestartIntentIfPresent(details);
    // Classified BEFORE the retryable arm, and that order is the whole point.
    // `retryable` says how to RECOVER; it says nothing about what the failure
    // is evidence OF, and the two are independent. A host whose own JWKS fetch
    // times out while verifying our bearer answers `UNAUTHORIZED` WITH
    // `retryable: true` - it is alive and talking, and the failure is on the
    // credential plane. Reading the retryable flag first and calling every
    // such drop host evidence let a healthy host bank a confirmed refusal per
    // reconnect attempt, and three of them reach the death streak and fail the
    // window away from a host that never stopped answering. That is the
    // false-Offline class invariant 5 exists to prevent, reintroduced through
    // the very arm whose own comment says "a prior genuine UNAUTHORIZED
    // episode" flows through here.
    const provenance = sessionFatalProvenance(details);
    if (details.retryable === true) {
      // A transient host blip must not count toward the credential give-up
      // bound - clear any streak left by a prior genuine UNAUTHORIZED episode.
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
    void this.revalidateThenReconnect(
      generation,
      auth,
      details,
      rejectedBearer,
    );
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
    generation: number,
    auth: StreamAuthRevalidator,
    details: FatalErrorDetails,
    rejectedBearer: string | null,
  ): Promise<void> {
    const outcome = await this.revalidateWithinBudget(auth);
    if (generation !== this.connectGeneration) {
      // A stale completion: the generation this revalidation was recovering
      // has been superseded while it was in flight. It owns nothing now - it
      // must neither schedule a redial for the new owner nor spend an intent
      // recorded against a different generation.
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
      // Credential-plane, so INDETERMINATE: the host is answering (it rejected
      // a bearer, which a dead host cannot do) and what failed is our own
      // revalidation. Neither half is evidence that the host is gone.
      this.reportEvidenceOutcome(this.credentialAttemptId(), "indeterminate");
      return;
    }
    // outcome === "rotated": authn accepts the credential. If the bearer the
    // next attach will present is still the one the host just rejected, no
    // progress was made (authn validates it but the host keeps rejecting -
    // clock skew / config mismatch). Bound that loop; otherwise reset and
    // redial with the fresh token.
    if (rejectedBearer !== null && this.readBearerOrNull() === rejectedBearer) {
      // The clock, not the credential. The revalidation that just resolved is
      // itself an authn round trip, so its `Date` header has already reached
      // the tracker - if our clock is running FAST, this streak is measuring a
      // wrong wall clock and must not walk the session to `goTerminalFatal`.
      // Parked BEFORE the counter moves, so skew can never contribute to the
      // bound.
      //
      // Keyed on the CLOCK and never on the rejection shape: a host config
      // mismatch produces an identical no-progress streak from an identical
      // frame, and that one SHOULD still reach the bound. And keyed on the
      // direction that can cause this, not on `skewed`: a SLOW clock leaves
      // this rejection just as unexplained as no skew at all.
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
    // Same reasoning as the network-error arm: an UNAUTHORIZED redial is a
    // credential rotation, not a statement about host liveness.
    this.reportEvidenceOutcome(this.credentialAttemptId(), "indeterminate");
  }

  /**
   * Parks this session if - and only if - the shared tracker reads the local
   * clock as wrong IN THE DIRECTION THAT CAN CAUSE THIS FAILURE: running
   * AHEAD, where a valid bearer reads as expired locally. Returns whether it
   * parked, so the call site reads as a guard.
   *
   * Not merely `skewed`. A clock running BEHIND is equally wrong and equally
   * banner-worthy, but it cannot make a bearer look expired and cannot make
   * the relay reject one - it validates against its own clock - so an
   * UNAUTHORIZED alongside it has some other cause, and parking would strand a
   * session the bound would have diagnosed honestly. See
   * `clockCanMakeValidBearersLookExpired`.
   *
   * The caller has already dropped the connection and left the phase at
   * `reconnecting`, so parking is mostly a matter of NOT arming the backoff
   * that every other arm of `revalidateThenReconnect` arms. A parked session
   * therefore holds no connection and no timer, and comes back only on the
   * tracker's `skewed → ok` edge. It is not terminal:
   * `goTerminalFatal`'s "the loop is OVER" contract stays reserved for
   * genuinely broken sessions, and a wrong clock is a condition the user fixes
   * in seconds.
   *
   * Two deliberate omissions relative to the sibling arms:
   *
   *  - No `dialFailures.recordFailure`. Its `retryInMs` is a promise to the
   *    reader that the loop will try again at a time, and there is no such
   *    time here; the park's own line below is the honest replacement. The
   *    consecutive-failure streak is deliberately left INTACT so that when the
   *    clock is fixed, `recordSuccess` still prints the true
   *    "recovered after N failures over M seconds".
   *  - The evidence outcome IS still reported, as `indeterminate`, exactly
   *    like both sibling arms: the host is answering (it rejected a bearer,
   *    which a dead host cannot do) and what failed is our own clock. Anything
   *    else would let a wrong clock feed the authority's death streak and fail
   *    the window away from a perfectly healthy host.
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
    // Defensive: a competing path is not supposed to have armed one while the
    // revalidation was in flight (the caller re-checked `phase`/`connection`
    // after its await), but "a parked session runs no retry timer" has to be
    // literally true or the park silently becomes a slow retry loop.
    if (this.backoffTimer !== null) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
    // SUBSCRIBE BEFORE THE EXTERNAL CALLBACK, and re-check after it. The twin
    // of the local transport's status-emit hazard: `reportEvidenceOutcome`
    // hands control to the selection authority synchronously, and that is a
    // component whose whole job is to react to transport evidence - a verdict
    // that retires this host can close this very session before the call
    // returns. Assigning the handle first means a re-entrant `close()` finds
    // something to release instead of nulling nothing and leaving the tracker
    // holding a dead session for the life of the page.
    this.clockParkUnsubscribe = clock.subscribeToRecovery(() => {
      this.resumeFromClockPark();
    });
    this.reportEvidenceOutcome(this.credentialAttemptId(), "indeterminate");
    // Through `isClosed()`, not a bare `this.phase === "closed"`. The early
    // return at the top of this method narrows `phase` to exclude `"closed"`,
    // and the checker does not know the call above can re-enter and change it -
    // so the direct comparison type-errors as impossible. That narrowing IS the
    // hazard this check exists for; reading the phase through the accessor is
    // what keeps the check honest.
    if (this.isClosed()) {
      this.clearClockPark();
    }
    return true;
  }

  /**
   * The `skewed → ok` edge: the clock was corrected, so redial now.
   *
   * `scheduleReconnect` then `pullRedialToNow` is the file's existing forced-
   * resume idiom (it is what `consumePendingForce` does), and it is right here
   * for the same reason: the rung is armed so attempt accounting stays honest,
   * then that one wait is pulled to zero. `reconnectAttempt` is deliberately
   * NOT reset - a host that is genuinely gone must keep climbing the ladder
   * once the clock stops being the explanation.
   *
   * The no-progress streak IS reset, because it was counting a condition that
   * no longer exists; carrying it forward would let a couple of pre-fix cycles
   * push the first honest post-fix attempt into the terminal bound.
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
    // One-shot, not throttled: terminal means the loop is OVER, so the
    // absence of further retry lines must not read as recovery.
    console.warn(
      `[remote-session] remote session (host ${this.options.hostId}) closed terminally: ${details.code}: ${details.reason}`,
    );
    this.terminalFatalDetails = details;
    this.phase = "closed";
    // Terminal means every recorded demand dies with the loop - the field's
    // contract says terminal close clears it, and BOTH terminal transitions
    // (caller `close()` and this fatal) must honor that, not just one.
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

  /**
   * Arms the ladder reset. Deliberately a TIMER rather than an assignment at
   * the ready boundary: reaching ready proves a session was established, not
   * that it is healthy, and rewarding establishment alone is what let a
   * flapping host be re-dialled at the fastest rung indefinitely.
   */
  private armStableResetTimer(): void {
    this.clearStableResetTimer();
    this.stableResetTimer = setTimeout(() => {
      this.stableResetTimer = null;
      this.reconnectAttempt = 0;
      // The dial-failure log's recovery line waits for the same proof: a
      // flapping connection that never survives the dwell never logs
      // "recovered", so the log cannot claim a recovery the ladder does not
      // believe in.
      this.dialFailures.recordSuccess();
    }, RECONNECT_STABLE_RESET_MS);
  }

  /**
   * Emits the one line that makes the reattach budget falsifiable: total, and
   * where the time went. Without the split, a regression in any single leg -
   * a slower grant mint, an extra Noise round trip, a resubscribe fan-out that
   * grew with the epic - is invisible inside one aggregate number, and the
   * budget becomes a claim nobody can check against a field log.
   *
   * `info`, not `warn`: a successful reattach is not a problem, and the
   * scenario harness asserts zero ERROR-level lines per blip.
   */
  private logReattachBreakdown(): void {
    const marks = this.reattachMarks;
    if (marks.startedAt === 0) {
      return;
    }
    if (!this.hasReachedReadyOnce) {
      // A first-ever connect is not a reattach, and calling it one would put
      // "reattached in Nms" in a field log for a session that had never been
      // attached. The first connect's cost is already covered by the dial
      // failure/recovery log; this line exists to explain RECOVERIES.
      this.reattachMarks = emptyReattachMarks();
      this.connectionLostAt = 0;
      return;
    }
    const now = Date.now();
    const leg = (from: number | null, to: number | null): string =>
      from === null || to === null ? "n/a" : `${to - from}ms`;
    // Measured from the LOSS, not from the dial. The backoff wait is time the
    // user spends disconnected exactly like a slow handshake is, and it is the
    // one leg the client chooses - excluding it let a 30s wait plus a 1s dial
    // report "reattached in 1s", which made the budget unfalsifiable in the
    // only direction that mattered. `wait` breaks it out so a long total can
    // still be read as "we waited" rather than "the network was slow".
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

  /**
   * Stamps the start of an outage, once per outage.
   *
   * Guarded rather than unconditional: `handleConnectionLost` runs again for
   * every FAILED redial, and re-stamping there would restart the clock on each
   * attempt, so a recovery that took three dials would report only the last
   * one - which is the same understatement this stamp exists to remove.
   */
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
   * Arms the backoff redial and returns the armed delay, so failure paths can
   * report the SAME value they actually scheduled (never a second jitter/
   * growth roll purely for the log line).
   *
   * The delay carries equal jitter. Every client that shares a cause - a relay
   * deploy, a `window 'online'` event crossing a fleet at once - would
   * otherwise walk the identical 1/2/4/8/16/30 ladder in lockstep and arrive
   * back at the relay in a herd, at each rung, indefinitely. Jitter is what
   * makes the tiers a spread rather than a schedule.
   */
  private scheduleReconnect(): number {
    if (this.phase === "closed") {
      return 0;
    }
    if (this.backoffTimer !== null) {
      clearTimeout(this.backoffTimer);
    }
    // Rung 0 is IMMEDIATE. On a link that blips for a second, the dominant
    // cost of recovery used to be a backoff we imposed on ourselves before
    // even trying - a full second of a ~2 s budget spent waiting to find out
    // whether anything was wrong. A blip is far more likely than a sick host,
    // so the first attempt after a stable session pays nothing and the ladder
    // starts from the SECOND consecutive failure: 0, 1s, 2s, 4s ... 30s. The
    // counter only returns to rung 0 after RECONNECT_STABLE_RESET_MS of
    // sustained health, so this cannot become a hot loop against a host that
    // is genuinely refusing.
    // The immediate rung is for RECOVERY only - a session that was healthy and
    // lost its link, where a blip is far likelier than a sick host. A session
    // that has never connected keeps the original ladder untouched: its
    // retries are evidence about host liveness, and doubling their rate would
    // both hammer a host that is legitimately down and accelerate the
    // death-streak machinery that reads those attempts.
    // Every non-immediate rung carries equal jitter: clients that share a
    // cause (a relay deploy, an `online` event crossing a fleet) would
    // otherwise walk the identical ladder in lockstep and arrive back at the
    // relay in a herd, at each rung, indefinitely.
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
   * How far `reconnectAttempt` runs AHEAD of the backoff rung it will be
   * spent on.
   *
   * A session that has reached ready spends its first attempt on the immediate
   * recovery redial, so the exponential ladder starts one attempt later and
   * every rung it reaches is `attempt - 1`. A session that has never connected
   * has no such freebie and its rung IS its attempt.
   *
   * Anything that reasons about rungs has to apply this - `scheduleReconnect`
   * picking a delay forwards, and `raiseReconnectBackoffToMax` solving
   * backwards for the attempt that yields a given rung. They disagreed before
   * this existed, and the disagreement was invisible: it produced a working
   * reconnect at the wrong interval rather than a failure.
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
   * Arms the redial for the deadline `armedAt + delayMs`, recording both so
   * {@link wake} can reason about how long this session has ALREADY been
   * waiting rather than restarting the clock.
   *
   * The delay is expressed against `armedAt`, not against now, so re-arming an
   * EXISTING deadline stays a deadline: the timer is set to whatever is left of
   * it. Passing `Date.now()` as `armedAt` - what a fresh backoff does - makes
   * the two the same thing.
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
   * Pulls a pending redial forward, ONCE per armed timer, to a jittered
   * sub-second delay measured from now.
   *
   * Two properties do all the work, and they are why {@link wake} can be wired
   * to signals that fire freely (every app switch, every proven pre-send
   * failure):
   *
   *  - **One collapse per armed timer.** The draw happens on the first wake
   *    against a given timer and is then recorded as spent. Later wakes do not
   *    redraw and do not shorten again, so a burst buys exactly ONE redial
   *    rather than N increasingly early ones - and the timer that eventually
   *    fires re-arms a fresh, un-collapsed one.
   *  - **Jittered, never fixed.** A shared `online` event or a relay deploy
   *    wakes a whole fleet on the same edge; a fixed sub-second collapse would
   *    turn every one of those wakes into a synchronized redial. The draw is
   *    equal jitter across `[RECONNECT_INITIAL_BACKOFF_MS / 2,
   *    RECONNECT_INITIAL_BACKOFF_MS)`, which still reads as immediate to the
   *    person who just tapped Retry.
   *
   * It can only ever SHORTEN: a draw landing later than the deadline already
   * armed is discarded (though it still spends this timer's one collapse, so a
   * wake never becomes a delay and never becomes a retry lottery). And
   * `reconnectAttempt` is deliberately untouched - the schedule resets only
   * after the connection has SURVIVED (see {@link maybeReachReadyBoundary}), so
   * a host that is genuinely gone keeps escalating between wakes instead of
   * being pinned at the fastest tier.
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
    // Worth a line of its own: the failure log reported the delay this session
    // ORIGINALLY armed, so without this the log claims a 30s wait that a wake
    // then cut to one - and the difference between those two is the whole
    // difference between a session that recovers and one that looks dead.
    console.info(
      `[remote-session] remote session (host ${this.options.hostId}) redialing early (${reason}) in ${wokenDelayMs}ms - ${Math.round(armedRemainingMs)}ms of backoff left`,
    );
    this.armBackoffTimer(now, wokenDelayMs);
  }

  /**
   * Spends a force recorded against `generation`, pulling the backoff that
   * generation's failure just armed to zero. Called after EVERY path that
   * arms a reconnect for a failed attempt - the connection-loss funnel and
   * the direct schedulers (grant-provision failure, a thrown connect path,
   * UNAUTHORIZED revalidation) alike - so whether the demand is honored does
   * not depend on which lander a failure happens to take. The rung is always
   * armed first: attempt accounting and the failure log see the ordinary
   * schedule, and only then is the one wait pulled to zero.
   * Generation-scoped on both sides: a newer dial's loss can never spend an
   * older intent.
   */
  private consumePendingForce(generation: number): void {
    if (this.pendingForceGeneration !== generation) {
      return;
    }
    this.pendingForceGeneration = null;
    this.pullRedialToNow("pending-forced-redial");
  }

  /**
   * THE reconnect scheduler for a failed attempt: arms the ordinary rung
   * (attempt accounting, jitter, and the failure log all see the ordinary
   * delay, which is returned for that log) and then spends a force recorded
   * against exactly `generation` by pulling that newly armed wait to zero.
   * Every retryable failure lander must come through here - the loss funnel,
   * the grant-provision failure, the thrown connect path, and both
   * UNAUTHORIZED revalidation arms - so whether a recorded demand is honored
   * cannot depend on which lander a failure happens to take.
   */
  private scheduleReconnectForFailedGeneration(generation: number): number {
    const retryInMs = this.scheduleReconnect();
    this.consumePendingForce(generation);
    return retryInMs;
  }

  /**
   * Clears a pending backoff wait and dials NOW. Distinct from
   * {@link collapseBackoff} on both axes that make collapse safe to wire to
   * free-firing signals: no jitter (the callers are single-device,
   * user-scoped edges - a Retry tap, a forced resume, a probe this session
   * just watched fail - not fleet-synchronized events), and not
   * once-per-timer (a forced caller's evidence does not expire because an
   * earlier wake already spent the collapse). `reconnectAttempt` stays
   * untouched: this skips ONE wait, it does not forgive the escalation, so a
   * host that is genuinely gone keeps climbing the ladder between forced
   * redials.
   */
  private pullRedialToNow(reason: string): void {
    // Keyed on the ARMED TIMER, not on a phase: the pre-dial landers (a
    // failed grant mint, a thrown connect path) arm their backoff while the
    // phase still reads `connecting`, and a pull that insisted on
    // `reconnecting` silently no-opped for exactly the failures the pending
    // force exists to hurry. A pending wait is a pending wait; `closed` is
    // the only state whose timer must never be revived.
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

  /**
   * `beginConnect` with its pre-connection failure modes routed back into the
   * state machine.
   *
   * Everything it awaits before a `RelaySocket` exists - the grant provider,
   * `NoiseChannel.begin` - can reject, and a bare `void beginConnect()` sent
   * that rejection nowhere: the phase stayed `connecting`, no backoff was
   * armed, and the session simply never dialed again for the life of the
   * page. That was survivable while every `sendUnary` failed fast; it is not
   * survivable now that callers PARK on the phase machine (see
   * `awaitReadyBoundary`), because a phase that never transitions again is a
   * query that never settles. `dropConnection` is the right landing: it
   * settles the parked callers as retryable (nothing was sent) and hands the
   * loop back to the normal backoff.
   */
  private beginConnectGuarded(): void {
    // `beginConnect` allocates its generation SYNCHRONOUSLY, before its first
    // await, so reading the counter immediately after the call names the
    // generation this attempt owns - not the one it superseded.
    //
    // With ONE exception: the `phase === "closed"` early return never reaches
    // the increment, so this captures the PREVIOUS generation. That is inert
    // today because the same early return resolves rather than rejects, so
    // the `catch` below never runs for it - a stale value nothing reads. If
    // `beginConnect` ever learns to reject before incrementing, this capture
    // stops naming this attempt and the guard silently compares against
    // someone else's generation.
    const attempt = this.beginConnect();
    const generation = this.connectGeneration;
    void attempt.catch((cause: unknown) => {
      // The same generation guard every other callback here takes, and it is
      // deliberately NOT load-bearing today: a rejection can only arrive while
      // this attempt is still pre-connection, `dropConnection` nulls
      // `this.connection`, and `isCurrent` requires a non-null one - so
      // `requestSessionReconnect` and every `handleConnectionLost` caller are
      // no-ops for exactly as long as an attempt is parked, and no newer
      // generation can exist to be dropped. That safety is incidental to
      // another method's null check, one refactor deep (a force-redial that
      // does not tear down first, or an `isCurrent` that stops requiring a
      // connection, reintroduces it). Stated here so a superseded attempt
      // owning nothing is a property of THIS code rather than a coincidence.
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
      // Threw BEFORE dialing (a key decode, a factory, an await that rejected)
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
      // The second provenance of `dead("plan-restricted")`, for a host that
      // was already CONNECTED when the plan changed. Without it the lease
      // settles `connecting` and the ∅ modal offers "retry" to a user whose
      // only fix is an upgrade. Reported after the terminal teardown, which
      // has already retracted this session's announcement - otherwise its own
      // liveness would suppress the verdict. Its own attempt id: this
      // generation's dial already reported success.
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
      this.handleConnectionLost(
        generation,
        "host-standing-lapsed",
        "host-transport-plane",
      );
    }, HOST_STANDING_BOUND_MS);
  }

  // ---- Wire write + framing helpers -------------------------------------- //

  /**
   * Encodes one logical message into a pull-based chunk source and queues it
   * (ONE queue slot regardless of body size; frames materialize, drawing
   * their per-stream `seq`, as the scheduler pulls). The two deterministic
   * encode failures — `MuxMessageSizeError` (body over the message cap) and
   * `RangeError` (`JSON.stringify` past V8's string ceiling) — THROW to the
   * caller, which owns routing them (a unary rejects its promise, a stream
   * frame fails its stream).
   */
  private enqueueMessage(
    connection: ActiveConnection,
    message: OutboundMessage,
  ): void {
    const source = new OutboundChunkSource(
      message,
      () => this.nextSeq(message.streamId),
      connection.bodyCompressionSupported,
    );
    connection.scheduler.enqueue(source);
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
    this.outboundSeq.delete(streamId);
  }

  private rejectUnary(streamId: number, error: HostRpcError): void {
    const entry = this.pendingUnary.get(streamId);
    if (entry === undefined) {
      return;
    }
    this.clearPendingUnary(streamId);
    // A rejected unary's stream is terminal. Drop any still-queued request
    // upload, clear any partial response accumulator, tombstone the id so a
    // late response chunk (e.g. one landing after the 30s timeout) can't
    // seed a fresh accumulator, and CLOSE the stream so the host drops its
    // own queued response instead of finishing a transfer nobody awaits.
    const connection = this.connection;
    if (connection !== null) {
      connection.scheduler.dropStreamOutbound(streamId);
      connection.reassembler.forget(streamId);
    }
    this.markStreamTerminal(streamId);
    if (this.phase === "ready" && connection !== null) {
      this.enqueueMessage(connection, {
        type: MuxFrameType.CLOSE,
        streamId,
        qos: QosClass.INTERACTIVE,
        json: { reason: "unary request rejected" },
        binary: null,
      });
    }
    entry.reject(error);
  }

  /**
   * Records `streamId` as terminal (client mirror of the host's R-2 /
   * `r2-host-stream-tombstone` invariant) so a later relay-delayed frame for
   * it is dropped before `reassembler.accept` instead of resurrecting a
   * fresh accumulator. Bounded: streamIds are monotonic and never reused
   * within a session, so evicting the oldest tombstone (insertion order,
   * which tracks the terminal frontier) once the cap is hit never re-admits
   * a still-active stream.
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
      // A stream in its private retryable-FATAL loop (an attempt entry exists
      // from its first verdict until a frame finally lands) must not hold the
      // SESSION's boundary hostage: its id can never enter `restoredStreamIds`
      // while the loop runs, so waiting on it meant one broken resolver kept
      // `isReady()` false forever - the session was never announced,
      // availability recovery never fired, and the reconnect backoff never
      // reset, making the whole remote host look unavailable while every
      // other stream exchanged frames on a healthy mux. The stream keeps its
      // own reopen backoff either way; only the session-level verdict stops
      // depending on it.
      if (this.streamReopenAttempts.has(streamId)) {
        continue;
      }
      if (!this.restoredStreamIds.has(streamId)) {
        return;
      }
    }
    this.readyBoundaryGeneration = this.connectGeneration;
    this.clearRestoreStallTimer();
    // A force recorded against this generation is satisfied by reaching
    // ready: a fresh attach is everything it could have bought. Consumed
    // unspent, so it cannot leak onto a later, unrelated loss.
    this.pendingForceGeneration = null;
    this.armStableResetTimer();
    // Order matters: the breakdown reads `hasReachedReadyOnce` to decide
    // whether this was a REATTACH at all, so the flag is raised after it.
    this.logReattachBreakdown();
    this.hasReachedReadyOnce = true;
    // The ready boundary is the ONLY site that mints a session id, and it runs
    // once per connect generation (the guard above). Order matters: the dial
    // success clears the host's death streak, and the announcement then makes
    // every later failure for this host inert until the session is retracted.
    this.reportEvidenceOutcome(
      this.dialAttemptId(this.connectGeneration),
      "success",
    );
    this.announceSession(`${this.evidenceScope}:s${this.connectGeneration}`);
    // Recovery is NOT held behind the dwell either: every ready boundary is
    // availability evidence, the clean first open included - queries that
    // raced this session's first dial have already errored pre-send and
    // exhausted their retry, and this emission is the only automatic signal
    // that can un-strand them (see the `subscribeAvailabilityRecovered`
    // contract). Delaying forgiveness must never mean delaying the data
    // coming back.
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
   * A credential-plane event, which is never tied to a dial: revalidation can
   * run several times inside one generation, and each needs its own id or the
   * authority's dedup would keep only the first.
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

  /**
   * The ONE place a dial outcome leaves this session. Written as a closed set
   * of outcomes rather than an error-classifying helper: the classification
   * decision belongs at the call site, where the attempt's own error is in
   * hand, and there is deliberately no path here that could consult a
   * directory verdict (invariant 5).
   */
  /**
   * Forwards a host-published restart tombstone to the selection authority.
   *
   * Every observation is forwarded, including duplicates across reconnects:
   * the authority keys episodes by (hostId, tombstoneId) and a repeat receipt
   * is inert by contract, so suppressing here would only add a second,
   * weaker copy of a rule that already exists in the one place that can
   * enforce it across every window in the app.
   */
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
    // A generation cannot reach its ready boundary twice, so an announcement
    // while one is outstanding would mean the retraction funnel was bypassed.
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

  /**
   * Reconciles the published-readiness latch with reality and emits the DOWN
   * edge if one just happened. Safe to call from any state mutation; calling
   * it too often costs a boolean compare, calling it too rarely is the bug.
   */
  private syncReadinessLatch(): void {
    const ready = this.isReady();
    if (ready === this.lastPublishedReadiness) {
      return;
    }
    this.lastPublishedReadiness = ready;
    if (ready) {
      // The UP edge belongs to `subscribeAvailabilityRecovered`, which fires
      // at the ready boundary with more precise timing than this latch has.
      // Recording it here only keeps the next DOWN edge detectable.
      return;
    }
    // Guarded per listener, same reason as the recovered emitter: this runs
    // inside inbound frame dispatch and a throwing consumer must not break
    // message processing or the other listeners.
    for (const listener of Array.from(this.readinessLostListeners)) {
      try {
        listener();
      } catch (error) {
        console.error("[remote-session] readiness-lost listener threw", error);
      }
    }
  }

  private emitAvailabilityRecovered(): void {
    // Keep the loss latch in step on the way up, or the next DOWN edge is
    // invisible: an un-synced latch still reads `false` and the transition
    // compares equal.
    this.syncReadinessLatch();
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
    // THE retraction funnel. All three teardown paths pass through here -
    // `dropConnection` (a transport loss), `goTerminalFatal` (a revoked
    // credential, a mid-session plan downgrade, an incompatible handshake) and
    // the caller's `close()`. Anchoring the retraction at `dropConnection`
    // instead would leave a session announced forever on the two terminal
    // paths, and an announced session suppresses ALL death evidence for its
    // host and pins the lease `ready` - so the host could never be declared
    // dead again. A consumer `close()` reaching here is correct too: the
    // session really has ended, and the authority's transitions are
    // idempotent, so a redundant retraction costs nothing while a missing one
    // is the defect.
    this.retractSession();
    const connection = this.connection;
    this.connection = null;
    this.openFrameBearer = null;
    this.clearPhaseTimer();
    this.clearReauthTimer();
    this.clearStandingTimer();
    // The connection did not survive its dwell, so the streak is not forgiven.
    // This is the single choke point for losing a connection - every drop,
    // fatal and caller close routes through here - which is what keeps the
    // survival test honest without a clear() at each call site.
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
   * Re-opens ONE logical stream after a retryable per-stream fatal, on a
   * per-stream backoff so a resolver that keeps failing its init cannot spin.
   *
   * The status goes to `reconnecting` rather than `closed`: that is the same
   * projection the local transport gives a stream whose session is re-dialling,
   * and it is what makes a consumer's "retryable, so something is recovering"
   * reading true here. The stream stays in `subscriptions` throughout, so a
   * session-level reconnect landing first simply replays it and the pending
   * timer is dropped as redundant.
   */
  private scheduleStreamReopen(stream: LogicalStream): void {
    const streamId = stream.streamId;
    const attempt = this.streamReopenAttempts.get(streamId) ?? 0;
    this.streamReopenAttempts.set(streamId, attempt + 1);
    // `null`, like the session-wide reconnect projection at `notifyStatus`
    // above: `StreamCloseReason` describes a CLOSE, and this stream is not
    // closed. The reason travels in the log line instead.
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
      // Not ready: the session is between sockets and will replay every
      // subscription itself once the next `open` is accepted. The stream
      // already carries its fresh, never-tombstoned id (re-keyed at the
      // FATAL), so returning here cannot strand it.
      if (connection === null || this.phase !== "ready") {
        return;
      }
      this.openSubscription(connection, stream);
    }, delay);
    this.streamReopenTimers.set(streamId, timer);
  }

  /**
   * Test seam: the per-stream retry state still held. The attempts map is the
   * one that can leak - it deliberately outlives its timer (see the field doc)
   * and is otherwise invisible from the outside, so the "every terminal path
   * clears it" invariant is only checkable here.
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

function indexMethodRegistry(
  registry: VersionedRpcRegistry,
  method: string,
): MethodVersionRegistry {
  const entry = registry[method];
  return entry as MethodVersionRegistry;
}

/**
 * A `DialFailureLog` cause for a relay-socket close. The browser WebSocket
 * strips the discriminating fault: a DNS failure (the outage this logging was
 * written for was a relay hostname with NO DNS record), a refused/blocked
 * connection, and a relay-rejected upgrade (bad grant, wrong relay) ALL
 * surface as `code=1006` with an empty reason. When the close happened before
 * `attach_ack` (phase "connecting") the line says so explicitly, because that
 * is the one client-side observable that narrows the fault to the dial
 * itself. Stable per fault (code + reason + phase bucket), so it dedups.
 */
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
 * The caller's own authority was aborted (a cancelled query, a replaced host
 * binding). Never retryable: the request was not dispatched, and the context
 * that would have owned the answer is gone. Mirrors what the local transport
 * raises for a disposed authority, so `isTransientHostRpcFailure` and the
 * retry wrapper classify both transports identically.
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

/** The stream-fatal code for one of the three per-stream inbound failures {@link RemoteSession.failStreamOnInboundError} routes. */
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
