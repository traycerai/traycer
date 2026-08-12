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
  splitConnectionManifest,
} from "@traycer/protocol/framework/capability-manifest";
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
  DIAL_FAILURE_RESTATE_MS,
  HOST_STANDING_BOUND_MS,
  INITIAL_BULK_SEND_CREDITS,
  ATTACH_ACK_TIMEOUT_MS,
  NOISE_HANDSHAKE_TIMEOUT_MS,
  SESSION_OPEN_ACK_TIMEOUT_MS,
  UNARY_RESPONSE_TIMEOUT_MS,
  RECONNECT_INITIAL_BACKOFF_MS,
  RECONNECT_MAX_BACKOFF_MS,
} from "./config";
import { DialFailureLog } from "./dial-failure-log";
import { recordNegotiatedHostMethods } from "../negotiated-manifest-registry";
import { resolveUnavailableMethodDegrade } from "../unavailable-method-degrade";
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
   * boundary (full attach + every live stream restored) - EVERY boundary,
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
  /**
   * `hostManifest.rpc` + `hostManifest.optionalRpc`, merged once at ack.
   * Version selection and dispatch read THIS (an optional method must
   * dispatch like any other); only the session-level compatibility check
   * reads the raw floor.
   */
  hostRpcMerged: ConnectionManifest | null;
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
  /** `clientManifests.rpc` + `.optionalRpc` merged - the dispatch view. */
  private readonly clientRpcMerged: ConnectionManifest;

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

  private phaseTimer: TimerHandle | null = null;
  private backoffTimer: TimerHandle | null = null;
  private reauthTimer: TimerHandle | null = null;
  private standingTimer: TimerHandle | null = null;

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
    );
    this.clientManifests = {
      rpc: rpcSplit.manifest,
      optionalRpc: rpcSplit.optionalManifest,
      stream: buildStreamManifest(options.streamRegistry),
    };
    this.clientRpcMerged = mergeConnectionManifests(
      rpcSplit.manifest,
      rpcSplit.optionalManifest,
    );
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
   */
  async sendUnary<Method extends keyof RpcRegistry & string>(
    method: Method,
    params: RequestOfMethod<RpcRegistry, Method>,
    abortSignal: AbortSignal | null,
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
      await this.awaitReadyBoundary(requestId, method, abortSignal);
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
        }, UNARY_RESPONSE_TIMEOUT_MS);
        this.pendingUnary.set(streamId, {
          requestId,
          method,
          clientCanonical,
          hostCanonical,
          methodRegistry,
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

  /** Opens a logical subscribe stream (interactive class; see §3 QoS note). */
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
    this.dialFailures.recordAbandoned();
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
      // This attach attempt is over before it dialed, so parked `sendUnary`
      // callers settle here rather than riding an unbounded number of further
      // mint attempts inside one call.
      this.settleReadyWaiters(false);
      const retryInMs = this.scheduleReconnect();
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
        onClose: (info) =>
          this.handleConnectionLost(
            generation,
            describeSocketClose(this.phase, info),
          ),
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
      hostRpcMerged: null,
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
      this.handleConnectionLost(generation, "malformed-openAck");
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
    recordNegotiatedHostMethods(
      this.options.hostId,
      Object.keys(hostRpcMerged),
    );
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
    // The session can carry frames from here: release every `sendUnary`
    // caller parked through this attach.
    this.settleReadyWaiters(true);
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
    const retryInMs = this.scheduleReconnect();
    this.dialFailures.recordFailure({ cause, context: "", retryInMs });
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
    // Callers parked awaiting THIS attach are still pre-send, so they keep
    // their retry license - but they must be released rather than left to
    // ride an unbounded number of further attempts inside one call.
    this.settleReadyWaiters(false);
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
      const retryInMs = this.scheduleReconnect();
      this.dialFailures.recordFailure({
        cause:
          "the host rejected the session bearer (UNAUTHORIZED) and revalidating the credential hit a network error",
        context: "",
        retryInMs,
      });
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
    const retryInMs = this.scheduleReconnect();
    this.dialFailures.recordFailure({
      cause:
        "the host rejected the session bearer (UNAUTHORIZED); redialing after credential revalidation",
      context: "",
      retryInMs,
    });
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
    // Phase is already "closed", so parked callers settle as NON-retryable
    // and carry this verdict - waiting cannot help a terminal session.
    this.settleReadyWaiters(false);
    this.emitClosed();
  }

  /**
   * Arms the backoff redial and returns the armed delay, so failure paths can
   * report the SAME value they actually scheduled (never a second jitter/
   * growth roll purely for the log line).
   */
  private scheduleReconnect(): number {
    if (this.phase === "closed") {
      return 0;
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
      this.beginConnectGuarded();
    }, delay);
    return delay;
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
      const retryInMs = this.scheduleReconnect();
      this.dialFailures.recordFailure({
        cause: `the connect path threw before dialing: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        context: "",
        retryInMs,
      });
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
    this.dialFailures.recordSuccess();
    // EVERY ready boundary is availability evidence, the clean first open
    // included: queries that raced this session's first dial have already
    // errored pre-send and exhausted their retry, and this emission is the
    // only automatic signal that can un-strand them (see the
    // `subscribeAvailabilityRecovered` contract).
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
