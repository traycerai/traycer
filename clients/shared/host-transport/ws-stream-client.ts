import type {
  SchemaVersion,
  StreamMethodVersionRegistry,
  VersionedStreamRpcRegistry,
} from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  buildStreamManifest,
  checkStreamMethodCompatibility,
} from "@traycer/protocol/framework/stream-compat";
import { selectConnectionManifestForPeer } from "@traycer/protocol/framework/capability-manifest";
import {
  extractBearerForOpenFrame,
  MissingBearerTokenForOpenFrameError,
  type HostEndpointProvider,
} from "./ws-rpc-client";
import type { BearerSourceProvider } from "@traycer-clients/shared/auth/bearer-source";
import { readAccessTokenExpiryMs } from "@traycer-clients/shared/auth/jwt-exp";
import type {
  RevalidateOutcome,
  StreamAuthRevalidator,
} from "@traycer-clients/shared/auth/bearer-revalidator";
import type {
  ConnectionManifest,
  FatalErrorDetails,
} from "@traycer/protocol/framework/ws-protocol";
import {
  toClientHandshakeIdentity,
  type ClientHandshakeIdentity,
  type FirstPartyClientIdentity,
} from "@traycer/protocol/framework/client-identity";
import {
  hostStreamOpenAckFrameSchema,
  hostStreamFatalErrorFrameSchema,
  streamMethodFrameEnvelopeSchema,
  STREAM_CAPABILITY_CREDENTIAL_UPDATE,
  STREAM_CAPABILITY_HOST_CREDENTIAL_PROVISION,
  STREAM_SUBSCRIBE_TIMEOUT_FATAL_CODE,
  type ClientStreamOpenFrame,
  type ClientStreamSubscribeFrame,
  type ClientStreamFatalErrorFrame,
  type ClientStreamCredentialUpdateFrame,
  type ClientStreamHostCredentialProvisionFrame,
  type HostCredentialState,
} from "@traycer/protocol/framework/stream-ws-protocol";
import type {
  HostCredentialMintFlow,
  HostCredentialMintOutcome,
} from "./host-credential-mint-flow";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "./i-stream-session";
import type { TransportEvidenceReporter } from "@traycer-clients/shared/host-selection/transport-evidence";
import type { IStreamClient } from "./i-stream-client";
import type {
  IStreamWebSocketFactory,
  StreamWebSocketLike,
  StreamWebSocketMessageEvent,
} from "./ws-stream-factory";
import type { WebSocketCloseEvent, WebSocketErrorEvent } from "./ws-factory";
import type { IntervalHandle, TimerHandle } from "./timer-handle";
import type { ReconnectAllOptions } from "./host-stream-client";
import { backoffFor } from "./backoff";

/**
 * Options for constructing the shared `/stream` transport.
 *
 * The timing knobs are explicit - no defaults on the constructor - so every
 * caller (production renderer, dev mock, test harness) is forced to think
 * about the values it wants. The ping loop is gated to ~25s per the tech
 * plan's decision #14; `pongTimeoutMs` is the "N missed pongs" cutoff.
 */
export interface WsStreamClientOptions<
  Registry extends VersionedStreamRpcRegistry,
> {
  readonly registry: Registry;
  readonly endpoint: HostEndpointProvider;
  readonly bearer: BearerSourceProvider;
  /**
   * Auth recovery hook invoked when the host rejects an open frame with
   * `UNAUTHORIZED` (the overnight-wake case: the bearer expired during sleep).
   * The session revalidates the credential (single-flight, shared with unary
   * RPC) and acts on the outcome — re-dial on a fresh bearer, stay in backoff
   * on a transient failure, or go terminal on a rejected credential. `null`
   * keeps the legacy behaviour (an `UNAUTHORIZED` fatalError is terminal),
   * which is correct for short-lived/dev clients that have no revalidator and
   * cannot recover an auth rejection by retrying the same bearer.
   */
  readonly auth: StreamAuthRevalidator | null;
  /**
   * Mints a device credential when a connected host reports it has none, so the
   * host can act on the user's behalf after the client disconnects. `null` opts
   * the client out entirely - correct for dev mocks and tests. An opted-out
   * client never sends the provision frame; the host stays on this connection's
   * credential lease, exactly as before the capability existed.
   *
   * See `HostCredentialMintFlow` for the obligation the implementor owns:
   * app-wide single-flight per hostId, so concurrent mints cannot supersede one
   * another and leave the host with nothing.
   */
  readonly hostCredentialMint: HostCredentialMintFlow | null;
  /**
   * Observation tap for the `openAck.hostCredentialState` a connected host
   * reports. Fired on every ack that carries a state (the host must advertise
   * the provision capability), BEFORE the client acts on it - so an observer
   * sees `"active"` acks the mint machinery ignores. This is the only
   * client-visible signal for "did the host adopt the credential": the
   * provision frame has no receipt by design, and adoption is reported by the
   * NEXT connection's ack (see `stream-ws-protocol.ts`). `null` for callers
   * that don't verify provisioning - which is every long-lived surface; a
   * short-lived provisioning probe (CLI `host install`) is who needs it.
   */
  readonly onHostCredentialState:
    ((hostId: string, state: HostCredentialState) => void) | null;
  /**
   * Where this transport's observations reach the selection authority.
   *
   * `/stream` is the LOCAL host's long-lived connection - a remote host's
   * streams ride the relay mux instead - so this is the leg that hears a
   * restart tombstone from a local host somebody else restarted: a
   * `traycer host restart` on the box, an update install, a second app
   * window. The desktop's own mutation lane covers restarts IT issued and is
   * structurally blind to those.
   *
   * Required, not defaulted, for the same reason the unary transport's is:
   * a new construction site has to say whether it feeds an authority or
   * `NO_TRANSPORT_EVIDENCE`.
   */
  readonly evidence: TransportEvidenceReporter;
  readonly webSocketFactory: IStreamWebSocketFactory;
  readonly dialTimeoutMs: number;
  readonly openAckTimeoutMs: number;
  readonly pingIntervalMs: number;
  readonly pongTimeoutMs: number;
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
  /**
   * WHO THIS CLIENT IS, sent on every `open` frame this transport writes -
   * including every reconnect, since each redial re-authenticates and is
   * therefore re-gated by the host.
   *
   * Required, not defaulted, for the same reason `evidence` is: a new
   * construction site has to answer the question rather than inherit a silent
   * answer. An absent identity reads to the host as legacy epoch 1, which a
   * floored host terminally refuses - so a defaulted value here would let a
   * composition root ship a build that cannot connect, with nothing at
   * compile time to say so.
   */
  readonly clientIdentity: FirstPartyClientIdentity;
}

/**
 * Shared-state transport for `/stream`. Constructed once; each call to
 * `subscribe(...)` returns an independent `IStreamSession` that owns its
 * own socket lifetime.
 *
 * Per-session lifecycle (mirrors the tech plan's decision #3 handshake):
 *   dial → send `open { token, manifest }` → await `openAck { manifest }`
 *        → run client-side subscribed-method compatibility mirror
 *        → send `subscribe { method, schemaVersion, params }`
 *        → enter the bidirectional frame loop
 *        → ping/pong heartbeat every `pingIntervalMs`
 *        → on drop: exponential-backoff reconnect, re-declare the same
 *          method with its current params; never closed until `close()` is
 *          called or a fatal error frame arrives
 *
 * Frame pairing: a binary WS frame is the payload of the immediately
 * preceding text envelope whose `hasBinaryPayload` flag is `true`. WS
 * in-order delivery is the correlation; no sequence id is added.
 */

/**
 * Builds the inert `IStreamSession` returned when `subscribe()` is called on a
 * closed client. "No live transport": it drops outbound frames and its
 * `close()` only suppresses the pending status emission - so a stale late
 * subscribe degrades without throwing. Unlike the earlier fully-silent
 * variant, it emits a single terminal `onStatusChange("closed", fatalError)`
 * on a microtask (deferred so a wrapper constructor finishes wiring its
 * handlers first), because a consumer that never learns its session is dead
 * renders a pending state forever - the "stuck git-diff skeleton" incident.
 */
function createInertStreamSession(closedReason: string): IStreamSession {
  let closed = false;
  let statusHandler: StatusChangeHandler | null = null;
  let emissionScheduled = false;
  return {
    sendClientFrame: () => undefined,
    onServerFrame: () => undefined,
    // Never handshook, so it has no negotiated version - consumers take the
    // same conservative default they use before any session settles.
    getNegotiatedSchemaVersion: () => null,
    onStatusChange: (handler) => {
      statusHandler = handler;
      if (emissionScheduled) {
        return;
      }
      emissionScheduled = true;
      queueMicrotask(() => {
        if (closed) {
          return;
        }
        statusHandler?.("closed", {
          kind: "fatalError",
          details: {
            code: "CLIENT_CLOSED",
            reason: `stream client was already closed (${closedReason})`,
            incompatibleMethods: null,
            upgradeGuidance: null,
          },
        });
      });
    },
    requestReconnect: () => undefined,
    close: () => {
      closed = true;
    },
  };
}

/** Monotonic source for `WsStreamClient.instanceId` (log correlation only). */
let nextStreamClientId = 1;

/**
 * Monotonic source for announced stream SESSION ids. Module-scoped rather than
 * per-connection so the id names one connectivity episode uniquely across
 * every stream in the process - the authority keys live sessions by id, and
 * two connections reusing `s1` would let one's retraction clear the other's.
 */
let streamSessionSeq = 0;

export class WsStreamClient<
  Registry extends VersionedStreamRpcRegistry,
> implements IStreamClient<Registry> {
  /**
   * Stable per-instance tag (`stream-client-<n>`) carried in every lifecycle
   * log line so a "subscribe on a closed client" warning can be correlated
   * with the close that preceded it. Also the identity key consumers use to
   * scope per-client caches (e.g. the git status shared-subscription map).
   */
  readonly instanceId: string;

  private readonly options: WsStreamClientOptions<Registry>;
  /**
   * Serialized once here rather than per session: every member is a process
   * constant, and this client hands the same value to every session it owns
   * and to every one of their redials.
   */
  private readonly clientIdentity: ClientHandshakeIdentity;
  private readonly ownedSessions = new Set<StreamSession<Registry>>();
  private readonly methodSupport = new Map<string, StreamMethodSupport>();
  private readonly methodSchemaVersions = new Map<string, SchemaVersion>();
  private readonly methodSupportListeners = new Set<() => void>();
  private readonly closedListeners = new Set<() => void>();
  /**
   * Hosts this client has already run the mint flow for, successfully or not.
   * ONE attempt per host per client, for the life of the client.
   *
   * The bound is deliberately blunt, because the failure it prevents is worse
   * than the one it causes. A host that stays un-provisioned reports `missing`
   * on EVERY reconnect, so an unbounded policy turns a reconnect loop (an
   * expired sign-in, a flapping network) into a stream of mint requests, each
   * superseding the last. Giving up instead costs only the delegated credential,
   * and the host keeps running on the connection's client lease until the app is
   * restarted.
   *
   * RE-ARMED on a fresh edge, though - see {@link lastHostCredentialState}.
   * "One attempt per host per client" was written when a host that reported
   * `missing` kept reporting `missing`: repeating the attempt could only
   * repeat the same failure. A host that has since gone `active` and come back
   * `needs-reauth` is not that host. It held a credential, the cloud refused
   * it, and the host burned it precisely so that a client would mint another -
   * so refusing on the strength of an attempt that already succeeded leaves it
   * on the client lease until the app restarts.
   */
  private readonly provisionAttemptedHostIds = new Set<string>();
  /**
   * The last `hostCredentialState` each host reported, so a repeat can be told
   * from a TRANSITION.
   *
   * The distinction is the entire re-arm rule, and it is what keeps the
   * unbounded-mint failure above closed: a host stuck reporting `missing`
   * reports the same value every reconnect, matches its last observation, and
   * re-arms nothing however long the reconnect loop runs. Only a host that
   * reported something else in between - `active`, most of all - can arm a
   * second mint, and it can arm at most one per round trip through a working
   * credential.
   */
  private readonly lastHostCredentialState = new Map<
    string,
    HostCredentialState
  >();
  /**
   * Per host: the timer that re-asks after a `pending-elsewhere` wait. Cleared
   * on close so a retry can never outlive the transport that would carry the
   * credential it asks for.
   */
  private readonly provisionRetryTimers = new Map<string, TimerHandle>();
  /**
   * Hosts THIS client handed a credential to.
   *
   * The only provenance-bearing evidence of recovery available here, and the
   * reason it must exist separately from {@link lastHostCredentialState}: a
   * handoff writes `active` into that map itself, so by the time a retry
   * fires, "we delivered" and "some other transport's pre-burn ack arrived
   * late" are the same value. A reported `active` carries nothing to tell
   * them apart - which is precisely why `noteHostCredentialState` refuses to
   * act on one - so a retry that trusted the map could be consumed by an
   * acknowledgment formed BEFORE the burn it is meant to repair, leaving the
   * host unprovisioned with no edge left to wake anybody.
   *
   * Cleared on the same edge that re-arms an attempt: a host reporting
   * `missing`/`needs-reauth` again no longer holds what we gave it.
   */
  private readonly handedOffHostIds = new Set<string>();
  /**
   * Minted credentials waiting for a live connection to carry them, keyed by
   * host. The socket that triggered the mint can be gone by the time it
   * resolves - dropping the credential there would waste a mint that has
   * ALREADY superseded whatever the host was using.
   *
   * Keyed rather than a single slot because one client can hold sessions against
   * several hosts at once: two mints resolving close together would otherwise
   * overwrite each other, silently losing one credential and stranding its
   * session row as a host row nobody holds.
   */
  private readonly pendingProvisions = new Map<
    string,
    PendingHostCredentialProvision
  >();
  private readonly availabilityRecoveredListeners = new Set<() => void>();
  private closed = false;
  private closedReason: string | null = null;

  constructor(options: WsStreamClientOptions<Registry>) {
    this.options = options;
    this.clientIdentity = toClientHandshakeIdentity(options.clientIdentity);
    this.instanceId = `stream-client-${nextStreamClientId}`;
    nextStreamClientId += 1;
  }

  /**
   * Opens a long-lived session bound to a single streaming method. The
   * session connects lazily on construction, re-subscribes on every
   * reconnect using the exact method + params passed here, and tears down
   * only when the caller invokes `close()` or a fatal error arrives
   * from the host.
   */
  subscribe<Method extends keyof Registry & string>(
    method: Method,
    params: ParamsOf<Registry, Method>,
  ): IStreamSession {
    return this.subscribeWithParamsProvider(method, () => params);
  }

  /**
   * Opens a stream whose parameters are read immediately before every wire
   * subscribe, including physical reconnects. The provider must be a pure,
   * synchronous read: it may expose an applied resume cursor, but must not
   * create transport or application state as a side effect.
   */
  subscribeWithParamsProvider<Method extends keyof Registry & string>(
    method: Method,
    paramsProvider: () => ParamsOf<Registry, Method>,
  ): IStreamSession {
    if (this.closed) {
      // Defense-in-depth (tech-plan D4): a subscribe on an already-closed
      // client is a stale call from a torn-down consumer. Degrading to an
      // inert "no live transport" session, rather than throwing, keeps a
      // stray late subscribe from tearing the renderer down through its error
      // boundary (the crash class this rework removed). Production showed
      // this path IS reachable (a closed client left in the provider context
      // after a host respawn), so the inert session emits a terminal status
      // instead of staying silent, and the warning carries the close reason
      // so the closer can be identified from the log alone. The companion
      // `isClosed()` accessor lets callers detect this up front.
      const closedReason = this.closedReason ?? "unknown";
      console.warn(
        `[stream] subscribe on a closed WsStreamClient ignored (method=${String(
          method,
        )}, client=${this.instanceId}, closedReason=${closedReason})`,
      );
      return createInertStreamSession(closedReason);
    }
    let removeSession = (): void => undefined;
    const session = new StreamSession<Registry>({
      method,
      paramsProvider,
      registry: this.options.registry,
      endpoint: this.options.endpoint,
      bearer: this.options.bearer,
      auth: this.options.auth,
      evidence: this.options.evidence,
      webSocketFactory: this.options.webSocketFactory,
      dialTimeoutMs: this.options.dialTimeoutMs,
      openAckTimeoutMs: this.options.openAckTimeoutMs,
      pingIntervalMs: this.options.pingIntervalMs,
      pongTimeoutMs: this.options.pongTimeoutMs,
      initialBackoffMs: this.options.initialBackoffMs,
      maxBackoffMs: this.options.maxBackoffMs,
      clientIdentity: this.clientIdentity,
      onDispose: () => removeSession(),
      onManifest: (manifest, subscribedMethod, support) =>
        this.applyHostManifest(manifest, subscribedMethod, support),
      onTransportReconnect: (reconnectingMethod) =>
        this.resetMethodSupport(reconnectingMethod),
      onHostCredentialAck: (hostId, state) => {
        this.handleHostCredentialAck(hostId, state);
      },
      // The passive tap is delivered by the session itself, ahead of the
      // compatibility abort, so it fires on EVERY state-carrying ack rather
      // than only the ones whose method version also happened to negotiate.
      onHostCredentialState: this.options.onHostCredentialState,
      onAvailabilityRecovered: () => {
        this.emitAvailabilityRecovered();
      },
    });
    removeSession = () => {
      this.ownedSessions.delete(session);
      if (this.reconcileMethodSchemaVersion(method)) {
        this.notifyMethodSupportListeners();
      }
    };
    this.ownedSessions.add(session);
    return session;
  }

  /**
   * Tears the client down. `reason` is a short caller-authored tag recorded on
   * the instance and logged, so a later "subscribe on a closed client"
   * warning identifies WHO closed the transport - the instrumentation that
   * pins down any repeat of the closed-client-left-in-context wedge.
   */
  close(reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closedReason = reason;
    // Never outlive the transport with a live credential in memory: there is no
    // socket left to deliver it on, and the next client mints its own.
    this.discardAllPendingProvisions();
    this.clearAllProvisionRetries();
    console.info(
      `[stream] WsStreamClient closed (client=${this.instanceId}, reason=${reason}, sessions=${this.ownedSessions.size})`,
    );
    for (const session of Array.from(this.ownedSessions)) {
      session.close();
    }
    this.ownedSessions.clear();
    const listeners = Array.from(this.closedListeners);
    this.closedListeners.clear();
    const listenerErrors: unknown[] = [];
    listeners.forEach((listener) => {
      try {
        listener();
      } catch (error) {
        listenerErrors.push(error);
      }
    });
    if (listenerErrors.length > 0) {
      console.error(
        `[stream] ${listenerErrors.length} closed-listener(s) threw during close (client=${this.instanceId}, reason=${reason})`,
        listenerErrors,
      );
    }
  }

  /**
   * True once `close()` has run. Lets a long-lived consumer that may outlive
   * the client - mirroring the codebase's `isReleased` / `isDisposed` guards -
   * detect a torn-down transport and degrade up front, rather than leaning on
   * the inert-session fallback inside `subscribe()`.
   */
  isClosed(): boolean {
    return this.closed;
  }

  /** The `close()` reason tag, or `null` while the client is still open. */
  getClosedReason(): string | null {
    return this.closedReason;
  }

  /**
   * Subscribes to the client's terminal `close()`. Fires once, synchronously
   * inside `close()`, after every owned session has been torn down. NOT
   * retro-fired for an already-closed client - callers that may attach late
   * must check `isClosed()` first (the owner-side liveness guard does both).
   */
  onClosed(listener: () => void): () => void {
    if (this.closed) {
      return () => undefined;
    }
    this.closedListeners.add(listener);
    return () => {
      this.closedListeners.delete(listener);
    };
  }

  getMethodSupport<Method extends keyof Registry & string>(
    method: Method,
  ): StreamMethodSupport {
    return this.methodSupport.get(method) ?? "unknown";
  }

  getMethodSchemaVersion<Method extends keyof Registry & string>(
    method: Method,
  ): SchemaVersion | null {
    return this.methodSchemaVersions.get(method) ?? null;
  }

  subscribeMethodSupport(listener: () => void): () => void {
    this.methodSupportListeners.add(listener);
    return () => {
      this.methodSupportListeners.delete(listener);
    };
  }

  /**
   * Subscribes to positive evidence that the host endpoint just RECOVERED
   * availability after a period of being unreachable or unresponsive. Fired by
   * any owned session when (a) it re-opens after a drop (its status was
   * `"reconnecting"` when the handshake completed), or (b) a heartbeat pong
   * lands after a stall-length gap WITHOUT the socket ever dropping - the
   * host-event-loop-stall case, where an established stream survives the
   * 60s pong cutoff while fresh unary dials time out and strand their
   * queries in a permanent error state. Consumers use this to drive
   * `HostClient.notifyHostAvailabilityRecovered(hostId)` so those stranded
   * queries refetch; multiple sessions recovering at once each fire, so
   * consumers should coalesce.
   */
  subscribeAvailabilityRecovered(listener: () => void): () => void {
    this.availabilityRecoveredListeners.add(listener);
    return () => {
      this.availabilityRecoveredListeners.delete(listener);
    };
  }

  /**
   * Proactively drops and re-dials every open session immediately. Driven by a
   * device-wake / network-online signal: after an OS sleep the sockets can be
   * half-open (frozen by the OS) while the client still believes it is
   * subscribed, and it would otherwise wait out the full pong timeout (~60s)
   * before noticing and re-subscribing. Forcing the reconnect now makes the
   * host re-run its subscribe handler (re-registering the live request
   * context) within seconds of wake. No-op on a closed client.
   */
  /**
   * Pushes the freshly-rotated bearer onto every open session so each host
   * connection updates its credential lease IN PLACE, with no reconnect. Called
   * by the owner right after a proactive (or reactive) token refresh rotates the
   * lease. Sessions that are mid-reconnect - or whose host did not advertise
   * `credentialUpdate` support - simply skip; their next open frame already
   * carries the fresh bearer. No-op on a closed client.
   */
  notifyBearerRotated(): void {
    if (this.closed) {
      return;
    }
    for (const session of Array.from(this.ownedSessions)) {
      session.pushCredentialUpdate();
    }
  }

  reconnectAll(reason: string, options: ReconnectAllOptions): void {
    if (this.closed) {
      return;
    }
    // Wake-recovery trace (piped to the desktop log via the renderer-console
    // bridge): proves the wake signal arrived and how many sessions re-dialed.
    console.debug(
      `[stream] reconnectAll reason=${reason} sessions=${this.ownedSessions.size} probeFirst=${options.probeFirst}`,
    );
    for (const session of Array.from(this.ownedSessions)) {
      if (options.probeFirst) {
        session.reconnectIfUnresponsive(reason);
      } else {
        session.forceReconnect(reason);
      }
    }
  }

  /**
   * Runs on every `openAck` from a host that advertised the provisioning
   * capability. Two jobs, in this order:
   *
   *   1. deliver a credential minted earlier that never found a live socket;
   *   2. otherwise start one mint for a host reporting it has none.
   *
   * Delivery comes first so a reconnect finishes an interrupted handoff rather
   * than minting a second credential and orphaning the first as a phantom row in
   * Devices & Sessions.
   */
  private handleHostCredentialAck(
    hostId: string,
    state: HostCredentialState,
  ): void {
    if (this.closed) {
      return;
    }
    // Recorded before anything else can return early, so no path through this
    // method can lose a transition. A state that never reaches the map is
    // indistinguishable from one that never happened, and the very next ack
    // would then read as "unchanged" against a stale predecessor.
    const previousState = this.lastHostCredentialState.get(hostId) ?? null;
    this.lastHostCredentialState.set(hostId, state);
    if (
      previousState !== state &&
      (state === "missing" || state === "needs-reauth")
    ) {
      // A host that HAD a credential and no longer has a usable one. The two
      // states it can arrive in are the two the host uses to ask for another:
      // `missing` after a discard (revoked, owner switch), `needs-reauth`
      // after a burn - including the burn this change adds for a freshly
      // refreshed credential the cloud refused anyway, which is the whole
      // reason the re-arm has to exist at all. Without it that burn is a
      // one-way door for the rest of the app session: the host stops serving
      // its credential, asks for a replacement on every `openAck`, and the
      // client - having minted once, hours ago, successfully - never answers.
      this.provisionAttemptedHostIds.delete(hostId);
      // Whatever we handed this host, it is not holding it any more.
      this.handedOffHostIds.delete(hostId);
    }
    if (this.flushPendingProvision(hostId)) {
      return;
    }
    if (state === "active") {
      return;
    }
    const mint = this.options.hostCredentialMint;
    if (mint === null) {
      return;
    }
    if (this.provisionAttemptedHostIds.has(hostId)) {
      return;
    }
    if (!HOST_ID_UUID_PATTERN.test(hostId)) {
      // The server rejects a non-UUID hostId outright - such a host cannot hold
      // a delegated credential at all. Checked here so a legacy host does not
      // spend a mint request on every app run to be told 400.
      this.provisionAttemptedHostIds.add(hostId);
      console.debug(
        `[stream] host credential provisioning skipped, hostId is not a UUID (client=${this.instanceId}, host=${hostId})`,
      );
      return;
    }
    this.provisionAttemptedHostIds.add(hostId);
    void this.runMintFlow(mint, hostId, state);
  }

  private async runMintFlow(
    mint: HostCredentialMintFlow,
    hostId: string,
    state: Exclude<HostCredentialState, "active">,
  ): Promise<void> {
    let outcome: HostCredentialMintOutcome;
    try {
      outcome = await mint({ hostId, reason: state });
    } catch (cause) {
      console.warn(
        `[stream] host-credential mint flow threw (client=${this.instanceId}, host=${hostId})`,
        cause,
      );
      return;
    }
    if (outcome.kind === "pending-elsewhere") {
      // This client has not actually spent an attempt - the app is waiting on
      // a claim or a backoff window, not refusing. Give the marker back, and
      // arm the retry ourselves: the host's state does NOT change while that
      // window runs (it keeps reporting `needs-reauth`), so there is no edge
      // left to wake anybody, and "the next ack will ask again" is only true
      // if something else happens to reconnect.
      this.provisionAttemptedHostIds.delete(hostId);
      this.armProvisionRetry(hostId, outcome.retryAfterMs, state);
      return;
    }
    if (outcome.kind !== "provisioned") {
      return;
    }
    if (this.closed) {
      // Nothing can deliver it and nothing will collect it later.
      return;
    }
    // The access JWS the host verifies on handoff is short-lived, so a
    // credential that cannot be delivered inside its own lifetime is dead on
    // arrival. The deadline comes from the SERVER's `expiresIn` rather than from
    // decoding the token: an undecodable token would otherwise yield "no
    // deadline", which is precisely the case that must not be held forever.
    const holdForMs = Math.max(0, outcome.expiresIn * 1_000);
    this.discardPendingProvision(hostId);
    const pending: PendingHostCredentialProvision = {
      hostId,
      token: outcome.token,
      refreshToken: outcome.refreshToken,
      familyId: outcome.familyId,
      provisionedAt: outcome.provisionedAt,
      // Armed rather than checked lazily. A credential whose host never comes
      // back produces no further `openAck`, so a lazy check would never run and
      // the refresh JWE - a 30-day credential - would sit in renderer memory for
      // the life of the process.
      expiryTimer: setTimeout(() => {
        this.onPendingProvisionExpired(hostId);
      }, holdForMs),
    };
    this.pendingProvisions.set(hostId, pending);
    this.flushPendingProvision(hostId);
  }

  private onPendingProvisionExpired(hostId: string): void {
    if (!this.pendingProvisions.has(hostId)) {
      return;
    }
    // The server-side row lives on as a host session nobody holds; the next
    // successful provisioning of this host supersedes it, so it self-heals
    // rather than needing cleanup here. The attempt marker stays set on purpose:
    // re-minting from this same client would supersede a credential that may
    // since have been delivered by another one.
    this.discardPendingProvision(hostId);
    console.warn(
      `[stream] discarded host credential that expired before delivery (client=${this.instanceId}, host=${hostId})`,
    );
  }

  /** Drops one held credential and disarms its timer. Safe to call twice. */
  /**
   * Re-asks for a credential once the wait a `pending-elsewhere` answer named
   * has passed.
   *
   * Jittered so several transports told to wait on the SAME claim do not all
   * come back on the same millisecond and re-race the thing the claim exists
   * to serialize.
   *
   * Every precondition is re-checked at fire time rather than captured: this
   * runs up to an hour later (the ladder's top rung), by which point the
   * client may be closed, the credential may have been delivered by somebody
   * else, or this client may already be mid-attempt.
   *
   * `reason` is the state that BOUGHT the retry, carried rather than re-read.
   * Re-reading it made the mint's reason a function of the last arrival, and
   * the last arrival is exactly what cannot be trusted here.
   *
   * ## What is allowed to cancel this, and what is not
   *
   * A reported `active` is NOT. It has no provenance: an acknowledgment
   * formed before the burn can be processed after this timer was armed - the
   * arm sits behind a mint round trip, so an ack in flight across it is
   * ordinary rather than exotic - and consuming the retry on one strands the
   * host with nothing left to wake it while its socket stays up. That is the
   * same reason `noteHostCredentialState` is inert, applied to the same
   * report.
   *
   * Only {@link handedOffHostIds} - a delivery this client performed - and a
   * live attempt marker stop it.
   *
   * The accepted cost of that: if ANOTHER transport delivered and the
   * app-wide adoption claim has since lapsed, this re-asks and the fresh mint
   * supersedes a credential that was working. That is bounded on both ends -
   * inside the claim window the flow answers `pending-elsewhere` and re-arms
   * instead of minting, and the escalation ladder caps how often it can
   * repeat - and it resolves to a provisioned host, whereas the failure it
   * replaces resolves to an unprovisioned one.
   */
  private armProvisionRetry(
    hostId: string,
    retryAfterMs: number,
    reason: Exclude<HostCredentialState, "active">,
  ): void {
    if (this.closed) {
      return;
    }
    this.clearProvisionRetry(hostId);
    // FLOORED, and that floor is load-bearing rather than tidy. A wait can
    // legitimately arrive at or near zero - a claim that expired between the
    // flow's gate and its own clock read - and without a floor the retry fires
    // immediately, is answered `pending-elsewhere` again, and spins. Nothing
    // downstream bounds that: the flow's gates are cheap and would happily
    // answer thousands of times a second.
    const delayMs =
      Math.max(retryAfterMs, PROVISION_RETRY_MIN_DELAY_MS) +
      Math.floor(Math.random() * PROVISION_RETRY_JITTER_MS);
    const timer = setTimeout(() => {
      this.provisionRetryTimers.delete(hostId);
      if (this.closed) {
        return;
      }
      const mint = this.options.hostCredentialMint;
      if (mint === null) {
        return;
      }
      if (this.handedOffHostIds.has(hostId)) {
        // We carried a credential to this host ourselves and it has not asked
        // again since. Nothing to re-ask for, and this is the one form of
        // "recovered" that does not depend on believing a report.
        return;
      }
      if (this.provisionAttemptedHostIds.has(hostId)) {
        // An `openAck` beat the timer to it and an attempt is already running
        // or spent. Re-asking here would double-mint the very host the claim
        // is protecting.
        return;
      }
      this.provisionAttemptedHostIds.add(hostId);
      void this.runMintFlow(mint, hostId, reason);
    }, delayMs);
    this.provisionRetryTimers.set(hostId, timer);
  }

  private clearProvisionRetry(hostId: string): void {
    const timer = this.provisionRetryTimers.get(hostId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.provisionRetryTimers.delete(hostId);
    }
  }

  private clearAllProvisionRetries(): void {
    for (const timer of this.provisionRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.provisionRetryTimers.clear();
  }

  private discardPendingProvision(hostId: string): void {
    const pending = this.pendingProvisions.get(hostId);
    if (pending === undefined) {
      return;
    }
    clearTimeout(pending.expiryTimer);
    this.pendingProvisions.delete(hostId);
  }

  private discardAllPendingProvisions(): void {
    for (const hostId of Array.from(this.pendingProvisions.keys())) {
      this.discardPendingProvision(hostId);
    }
  }

  /**
   * Hands the credential held for `hostId` to the first live session bound to
   * that host. Returns whether anything was delivered - `false` also covers
   * "there was nothing held", which is the common path.
   */
  private flushPendingProvision(hostId: string): boolean {
    const pending = this.pendingProvisions.get(hostId);
    if (pending === undefined) {
      return false;
    }
    for (const session of Array.from(this.ownedSessions)) {
      if (session.pushHostCredentialProvision(hostId, pending)) {
        this.discardPendingProvision(hostId);
        // ASSUMED-ADOPTED, and recorded so the re-arm edge can see it. Nothing
        // acks an adoption: the host confirms only on its NEXT `openAck`, and
        // the socket that just carried the credential last reported
        // `needs-reauth`. Leaving that as the remembered state made a later
        // burn look like no transition at all - same state, marker still set -
        // so the replacement mint was suppressed for the life of the client.
        //
        // Optimistic on purpose. If the host in fact did not adopt, its next
        // ack says `missing`/`needs-reauth` and corrects this, which is a
        // transition and therefore re-arms; the app-wide claim and the
        // escalation ladder still bound how often that can turn into a mint.
        this.lastHostCredentialState.set(hostId, "active");
        // Recorded separately from the line above because only THIS fact has
        // provenance. See {@link handedOffHostIds}.
        this.handedOffHostIds.add(hostId);
        return true;
      }
    }
    return false;
  }

  private emitAvailabilityRecovered(): void {
    if (this.closed) {
      return;
    }
    // Guarded per listener: the emission happens inside a session's inbound
    // frame handling (the pong path), so a throwing consumer must not break
    // the socket's message processing or the other listeners.
    for (const listener of Array.from(this.availabilityRecoveredListeners)) {
      try {
        listener();
      } catch (error) {
        console.error(
          `[stream] availability-recovered listener threw (client=${this.instanceId})`,
          error,
        );
      }
    }
  }

  private updateMethodSupport(
    method: string,
    support: StreamMethodSupport,
  ): boolean {
    const previous = this.methodSupport.get(method) ?? "unknown";
    const versionChanged = this.reconcileMethodSchemaVersion(method);
    if (previous === support && !versionChanged) {
      return false;
    }
    this.methodSupport.set(method, support);
    return true;
  }

  private applyHostManifest(
    theirManifest: ConnectionManifest,
    subscribedMethod: string,
    subscribedMethodSupport: "supported" | "unsupported",
  ): void {
    const myManifest = selectConnectionManifestForPeer(
      this.options.registry,
      buildStreamManifest(this.options.registry),
      theirManifest,
    );
    let changed = false;
    for (const method of Object.keys(myManifest)) {
      if (method === subscribedMethod) {
        changed =
          this.updateMethodSupport(method, subscribedMethodSupport) || changed;
        continue;
      }
      const compat = checkStreamMethodCompatibility(
        this.options.registry,
        myManifest,
        theirManifest,
        "client",
        method,
      );
      changed =
        this.updateMethodSupportFromManifest(
          method,
          compat.ok ? "supported" : "unsupported",
        ) || changed;
    }
    if (changed) {
      this.notifyMethodSupportListeners();
    }
  }

  private updateMethodSupportFromManifest(
    method: string,
    support: "supported" | "unsupported",
  ): boolean {
    // Another session's process manifest is capability evidence, not evidence
    // that this method's already-open sessions lost their negotiations.
    const previous = this.methodSupport.get(method) ?? "unknown";
    if (previous === support) {
      return false;
    }
    this.methodSupport.set(method, support);
    return true;
  }

  private resetMethodSupport(reconnectingMethod: string): void {
    const hadMethodSupport = this.methodSupport.size > 0;
    // A reconnect may be a new host incarnation, so capability evidence is
    // client-wide and must be re-probed. Negotiated schema versions belong to
    // individual live sessions, though. Rebuild the method-level view from the
    // remaining sessions so another repo's still-open stream keeps v1.2 frame
    // routing while this session negotiates again.
    const versionChanged =
      this.reconcileMethodSchemaVersion(reconnectingMethod);
    if (!hadMethodSupport && !versionChanged) {
      return;
    }
    this.methodSupport.clear();
    this.notifyMethodSupportListeners();
  }

  private reconcileMethodSchemaVersion(method: string): boolean {
    const previous = this.methodSchemaVersions.get(method) ?? null;
    let liveVersion: SchemaVersion | null = null;
    for (const session of this.ownedSessions) {
      if (session.getMethod() !== method) {
        continue;
      }
      const sessionVersion = session.getNegotiatedSchemaVersion();
      if (sessionVersion !== null) {
        liveVersion = sessionVersion;
        break;
      }
    }
    if (liveVersion === null) {
      this.methodSchemaVersions.delete(method);
    } else {
      this.methodSchemaVersions.set(method, liveVersion);
    }
    return !schemaVersionEqual(previous, liveVersion);
  }

  private notifyMethodSupportListeners(): void {
    for (const listener of Array.from(this.methodSupportListeners)) {
      listener();
    }
  }
}

/**
 * Caller-side parameter payload for a streaming method, inferred from the
 * contract's `openRequestSchema`.
 */
export type ParamsOf<
  Registry extends VersionedStreamRpcRegistry,
  Method extends keyof Registry & string,
> = ExtractOpenRequest<Registry[Method]>;

export type StreamMethodSupport = "unknown" | "supported" | "unsupported";

/** A minted host credential held only until a live session can carry it. */
interface PendingHostCredentialProvision {
  readonly hostId: string;
  readonly token: string;
  readonly refreshToken: string;
  readonly familyId: string;
  readonly provisionedAt: string;
  /** Disarmed on delivery, on replacement, and on client close. */
  readonly expiryTimer: TimerHandle;
}

/**
 * The server requires a UUID hostId (`Host.hostId` is a Postgres `uuid`, so a
 * non-UUID cannot even be looked up on refresh) and answers 400 otherwise.
 * Mirrored client-side purely to avoid entering the INTERACTIVE mint for a host
 * that can never hold a credential.
 */
/**
 * Floor under any `pending-elsewhere` retry. See {@link WsStreamClient.armProvisionRetry}
 * - a near-zero wait must not become a spin.
 */
const PROVISION_RETRY_MIN_DELAY_MS = 1_000;
/**
 * Spread over the retry, so several transports told to wait on the SAME claim
 * do not all come back on one millisecond and re-race what the claim exists to
 * serialize.
 */
const PROVISION_RETRY_JITTER_MS = 250;

const HOST_ID_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function schemaVersionEqual(
  a: SchemaVersion | null,
  b: SchemaVersion | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.major === b.major && a.minor === b.minor;
}

type ExtractOpenRequest<MethodRegistry> =
  MethodRegistry extends Readonly<Record<number, infer Line>>
    ? Line extends {
        readonly versions: Readonly<Record<number, infer Entry>>;
      }
      ? Entry extends {
          readonly contract: {
            readonly openRequestSchema: infer OpenSchema;
          };
        }
        ? OpenSchema extends { readonly _output: infer Output }
          ? Output
          : unknown
        : unknown
      : unknown
    : unknown;

interface StreamSessionOptions<Registry extends VersionedStreamRpcRegistry> {
  readonly method: keyof Registry & string;
  readonly paramsProvider: () => unknown;
  readonly registry: Registry;
  readonly endpoint: HostEndpointProvider;
  readonly bearer: BearerSourceProvider;
  readonly auth: StreamAuthRevalidator | null;
  readonly evidence: TransportEvidenceReporter;
  readonly webSocketFactory: IStreamWebSocketFactory;
  readonly dialTimeoutMs: number;
  readonly openAckTimeoutMs: number;
  readonly pingIntervalMs: number;
  readonly pongTimeoutMs: number;
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
  /**
   * Already projected to the wire shape by the owning client: every session
   * this client opens sends the same process constant, so it is serialized
   * once rather than per session and per redial.
   */
  readonly clientIdentity: ClientHandshakeIdentity;
  readonly onDispose: () => void;
  readonly onManifest: (
    manifest: ConnectionManifest,
    subscribedMethod: keyof Registry & string,
    support: "supported" | "unsupported",
  ) => void;
  readonly onTransportReconnect: (
    reconnectingMethod: keyof Registry & string,
  ) => void;
  /**
   * Reports the connected host's own credential state, once per successful
   * handshake, and ONLY when that host advertised the provisioning capability
   * and actually reported a state. The owning client decides what to do; the
   * session just carries the frame.
   */
  readonly onHostCredentialAck: (
    hostId: string,
    state: HostCredentialState,
  ) => void;
  /**
   * Passive observation of the same state, delivered EARLIER than
   * `onHostCredentialAck` - before this session's application method can abort
   * the handshake on a version mismatch. The credential state is a handshake
   * fact, not a per-method one, so an observer must see it even from a host
   * this build cannot subscribe to. `null` when nobody is watching.
   */
  readonly onHostCredentialState:
    ((hostId: string, state: HostCredentialState) => void) | null;
  /**
   * Reports positive host-recovery evidence to the owning client - see
   * `WsStreamClient.subscribeAvailabilityRecovered` for the two emission
   * sites and why they exist.
   */
  readonly onAvailabilityRecovered: () => void;
}

/**
 * Slack added to `pingIntervalMs` before a pong gap counts as recovery
 * evidence. On a healthy connection consecutive pongs arrive one ping
 * interval apart (the ping timer is exact; the pong round-trip is
 * RTT-scale), so a gap exceeding the interval by several seconds means at
 * least one ping sat unanswered - the host was unresponsive and has just
 * come back. Kept well under `pongTimeoutMs - pingIntervalMs` so this
 * detects the stalls the drop cutoff deliberately tolerates.
 *
 * Known benign false positive: a backgrounded renderer throttles timers, so
 * pings go out late and the measured gap stretches without any host stall.
 * The resulting notify fires as the tab foregrounds and costs one refetch of
 * active host-scoped queries - freshness on return, not churn - so it is
 * accepted rather than special-cased with visibility heuristics.
 */
const PONG_GAP_RECOVERY_SLACK_MS = 5_000;

/**
 * How long a wake liveness probe waits for a pong before declaring the socket
 * dead and re-dialing (see `WsStreamSession.reconnectIfUnresponsive`).
 *
 * This value IS the wake mechanism: a half-open socket fails only by timeout,
 * so nothing else distinguishes "survived the sleep" from "gone". Too short and
 * a slow-but-alive session is dropped, re-creating the wake-vs-Wi-Fi race the
 * probe exists to end; too long and a genuinely dead remote session recovers
 * later than the old unconditional re-dial. 5s clears any plausible
 * localhost/LAN round trip with room to spare while staying far under the
 * heartbeat's own pong timeout.
 */
const WAKE_PROBE_TIMEOUT_MS = 5_000;

/**
 * One open stream. Owns the per-connect socket plus every timer wired to
 * it (dial, open-ack, heartbeat, reconnect backoff). The class is
 * state-machine-flavored - every inbound event runs through a `handleXxx`
 * on the current `phase` so invalid transitions surface as no-ops rather
 * than silent crashes.
 */
class StreamSession<
  Registry extends VersionedStreamRpcRegistry,
> implements IStreamSession {
  private readonly config: StreamSessionOptions<Registry>;

  private status: StreamConnectionStatus = "connecting";
  private negotiatedSchemaVersion: SchemaVersion | null = null;
  private serverFrameHandler: ServerFrameHandler | null = null;
  private statusHandler: StatusChangeHandler | null = null;
  private reconnectAttempt = 0;
  /**
   * Count of consecutive recoverable drops caused by a host slow-client
   * eviction (close reason prefixed `SLOW_CLIENT`). A genuinely slow renderer
   * would otherwise loop drop → reconnect → snapshot → stall → drop forever at
   * the fixed initial backoff (the delivered snapshot - or, on event-only
   * streams, the sustained-subscription dwell - resets `reconnectAttempt`
   * each cycle), hammering the host with full snapshots. We fold this
   * streak into the reconnect backoff so repeated evictions escalate toward
   * `maxBackoffMs`, and reset it on any non-slow-client drop. Other streams are
   * unaffected: their closes carry no SLOW_CLIENT marker, so the streak stays 0
   * and the backoff is identical to before.
   */
  private slowClientReconnectStreak = 0;
  private lastCloseWasSlowClient = false;
  /**
   * Bounds the rare "valid-but-rejected" loop: AuthnV3 keeps accepting the
   * bearer (revalidation returns "rotated") yet the host keeps rejecting the
   * open frame with `UNAUTHORIZED` because the token never actually changed
   * (clock skew / config mismatch). `revalidateThenReconnect` increments this
   * ONLY when a "rotated" revalidation left the next-dial bearer identical to
   * the just-rejected one; a real rotation, a transient `network-error`, or a
   * successful subscribe all reset it. At the cap the session goes terminal
   * (the user stays signed in, so recovery is a manual reload).
   */
  private noProgressUnauthorizedReconnects = 0;
  private disposed = false;

  private activeSocket: StreamWebSocketLike | null = null;
  private openFrameToken: string | null = null;
  /**
   * The hostId of the endpoint THIS connection dialed, captured at dial time.
   * Read from the live socket rather than from `endpoint()` on demand, because
   * the endpoint provider can already point at a different host by the time an
   * asynchronous mint resolves - and handing host A's credential to host B is
   * the one mistake this path must not make.
   */
  private openFrameHostId: string | null = null;
  /**
   * The live session this connection has announced to the selection authority,
   * or `null` while it has none.
   *
   * `/stream` is a LIVE SESSION and the authority's strongest evidence class
   * (invariant 5): it suppresses death accumulation entirely. Until this was
   * announced, a healthy long-lived stream counted for nothing, so three fresh
   * unary dials refused during an accept-loop or descriptor-pressure stall
   * reached the confirmed-death streak and failed the local host over while
   * its stream was still carrying frames.
   *
   * The hostId is stored ALONGSIDE the id rather than re-read at retraction
   * time: `openFrameHostId` is cleared on the same paths that retract, and a
   * session announced for host A must never be retracted against host B. An
   * announcement that is never retracted means the host can never be declared
   * dead again, so every path that drops the dialed identity retracts here
   * first - which is exactly the two places that clear `openFrameHostId`.
   */
  private announcedSession: { hostId: string; sessionId: string } | null = null;
  // Whether the host advertised `credentialUpdate` support in the current
  // connection's openAck. Gates `pushCredentialUpdate`; reset on every
  // reconnect and re-read from the next openAck.
  private supportsCredentialUpdate = false;
  /** Same contract as `supportsCredentialUpdate`, for the provision frame. */
  private supportsHostCredentialProvision = false;
  private phase: SessionPhase = "idle";
  private pendingBinaryEnvelope: StreamFrameEnvelope | null = null;
  private dialTimer: TimerHandle | null = null;
  private openAckTimer: TimerHandle | null = null;
  private pingIntervalTimer: IntervalHandle | null = null;
  /** In-flight wake liveness probe; see {@link reconnectIfUnresponsive}. */
  private wakeProbeTimer: TimerHandle | null = null;
  /**
   * `lastPongAt` as it stood BEFORE a wake probe rebased it, consumed by the
   * first pong that follows. The rebase keeps the heartbeat's stale pre-sleep
   * deadline from condemning an intact socket, but it also erases the very gap
   * the pong handler's availability-recovery edge measures - and on the
   * probe-succeeds path the socket is deliberately KEPT, so the reconnect
   * handshake's recovery emission never runs either. Without this baseline a
   * wake that bridges a sleep-length gap fired NEITHER recovery signal, and
   * queries stranded in error state before the sleep stayed stranded.
   * `Math.min` across overlapping probes keeps the earliest truth.
   */
  private preProbePongBaselineAt: number | null = null;
  /** Monotonic count of pongs received; the wake probe's liveness signal. */
  private pongSeq = 0;
  private backoffTimer: TimerHandle | null = null;
  /**
   * Armed when the subscribe completes; fires after
   * `HEALTHY_SUBSCRIBED_DWELL_MS` of SUSTAINED subscription and performs the
   * same loop-counter reset a delivered application frame does. Event-only
   * streams (agent inbox, worktree.changed, a quiet file-list watch) may
   * legitimately deliver nothing for hours - without this second reset
   * signal their `reconnectAttempt` would be a lifetime drop counter, and a
   * handful of cumulative ordinary drops would pin every later reconnect at
   * the backoff cap. Cleared on every drop/teardown path via
   * `resetForReconnect` / `teardownTimers` - which SETTLES it on elapsed
   * time rather than discarding it, see `subscribedAt`.
   */
  private healthyDwellTimer: TimerHandle | null = null;
  /**
   * Wall-clock stamp of the subscribe that armed `healthyDwellTimer`, or
   * null when nothing is subscribed. The timer alone cannot decide the
   * dwell: a backgrounded renderer throttles `setTimeout` (Chromium clamps
   * hidden pages to >=1/min), so a socket can be genuinely subscribed for
   * minutes with the callback still queued. Settling the dwell on elapsed
   * time at the drop keeps the reset the stream has already earned.
   */
  private subscribedAt: number | null = null;
  private lastPongAt: number;

  constructor(options: StreamSessionOptions<Registry>) {
    this.config = options;
    this.lastPongAt = Date.now();
    this.connect();
  }

  sendClientFrame(
    envelope: StreamFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ): void {
    if (this.disposed) {
      return;
    }
    if (this.phase !== "subscribed") {
      // Stream contracts are fire-and-forget: dropping a frame while
      // mid-reconnect is fine - Y.js CRDT convergence absorbs the delta
      // once the socket returns.
      return;
    }
    const socket = this.activeSocket;
    if (socket === null) {
      return;
    }
    if (!this.writeEnvelope(socket, envelope, binaryPayload)) {
      this.onSendFailure(socket);
    }
  }

  onServerFrame(handler: ServerFrameHandler): void {
    this.serverFrameHandler = handler;
  }

  onStatusChange(handler: StatusChangeHandler): void {
    this.statusHandler = handler;
  }

  getMethod(): keyof Registry & string {
    return this.config.method;
  }

  getNegotiatedSchemaVersion(): SchemaVersion | null {
    return this.negotiatedSchemaVersion;
  }

  requestReconnect(): void {
    if (this.disposed || this.activeSocket === null) {
      return;
    }
    this.teardownSocket(1000, "reconnect-requested-by-consumer");
    this.onTransportDrop();
  }

  close(): void {
    if (!this.disposeSession()) {
      return;
    }
    this.teardownTimers();
    this.teardownSocket(1000, "closed-by-caller");
    this.transitionTo("closed", { kind: "caller" });
  }

  /**
   * Proactively drops the current socket and re-dials immediately. Used on a
   * device-wake / network-online signal: the socket may be half-open (the OS
   * froze it during sleep) while we still believe we are subscribed, and we
   * would otherwise wait out the full pong timeout (~60s) before noticing.
   * `teardownSocket` closes the (possibly half-open) socket with its `onclose`
   * already detached, so it cannot re-enter the drop path; resetting the attempt
   * counters makes the redial immediate rather than on the accumulated backoff;
   * `onTransportDrop` re-arms the reconnect and the dial re-sends the subscribe
   * frame. No-op once the session is permanently closed.
   */
  forceReconnect(reason: string): void {
    if (this.disposed) {
      return;
    }
    this.teardownSocket(1000, reason);
    this.reconnectAttempt = 0;
    this.slowClientReconnectStreak = 0;
    this.onTransportDrop();
  }

  /**
   * Wake recovery that keeps a socket which is still ALIVE.
   *
   * `forceReconnect` on every session was the wake path's original shape, and
   * it is wrong for the case that dominates: a lid-open on the same network,
   * where the localhost/LAN socket to a local host survived the sleep intact.
   * Dropping it re-runs `initialize()` for every stream on a machine whose
   * Wi-Fi has not finished re-associating - so the cloud calls in those opens
   * fail, and (before this layer) each failure became a fatal close. That is
   * the overnight "all epics red by morning" report: the RECOVERY signal was
   * causing the damage, once per dark wake, all night.
   *
   * A half-open socket has no positive "dead" signal - the only way to learn
   * is to ask and wait - so the probe timeout IS the detector. It is set well
   * above any plausible localhost/LAN round trip and far below the heartbeat's
   * own pong timeout, so a live session is never dropped and a genuinely dead
   * one recovers only marginally slower than the unconditional re-dial did.
   * Timeout falls through to exactly the old behaviour.
   */
  reconnectIfUnresponsive(reason: string): void {
    if (this.disposed) {
      return;
    }
    const socket = this.activeSocket;
    // Nothing live to keep: an idle or mid-reconnect session has no socket
    // whose survival could be in question, so re-dial as before.
    if (socket === null || this.phase !== "subscribed") {
      this.forceReconnect(reason);
      return;
    }
    const pongSeqAtProbe = this.pongSeq;
    const sent = this.writeEnvelope(
      socket,
      { kind: "ping", hasBinaryPayload: false },
      null,
    );
    if (!sent) {
      // The socket refused the write - it is already gone in all but name.
      this.forceReconnect(reason);
      return;
    }
    // Rebase the heartbeat deadline onto the probe we just sent. After a sleep
    // longer than `pongTimeoutMs`, `lastPongAt` still holds a PRE-sleep
    // timestamp, so the already-armed interval's very next tick takes the
    // `missed-pongs` branch and tears down an intact socket before this probe
    // can be answered - the stale deadline pre-empting the detector that was
    // meant to decide. Nothing is weakened by moving it: an unanswered probe
    // still fails, just through the timeout below, which is deliberately set
    // far under `pongTimeoutMs`. The pre-rebase timestamp is preserved so the
    // probe's pong still answers the TRUE gap - see
    // {@link preProbePongBaselineAt}.
    this.preProbePongBaselineAt =
      this.preProbePongBaselineAt === null
        ? this.lastPongAt
        : Math.min(this.preProbePongBaselineAt, this.lastPongAt);
    this.lastPongAt = Date.now();
    this.clearWakeProbe();
    this.wakeProbeTimer = setTimeout(() => {
      this.wakeProbeTimer = null;
      if (this.disposed) {
        return;
      }
      // A pong landed after the probe went out: the socket survived the sleep
      // and re-subscribing would only cost the user their warm streams.
      if (this.pongSeq !== pongSeqAtProbe) {
        return;
      }
      // Something else already replaced the socket while we waited; that path
      // owns the recovery.
      if (this.activeSocket !== socket) {
        return;
      }
      this.forceReconnect(`${reason}-probe-timeout`);
    }, WAKE_PROBE_TIMEOUT_MS);
  }

  private clearWakeProbe(): void {
    if (this.wakeProbeTimer !== null) {
      clearTimeout(this.wakeProbeTimer);
      this.wakeProbeTimer = null;
    }
  }

  /**
   * Pushes the current bearer onto this open connection so the host rotates its
   * credential lease in place - no reconnect. No-op unless the session is fully
   * `subscribed` AND the host advertised `credentialUpdate` support in its
   * openAck; a mid-reconnect session just carries the fresh bearer in its next
   * open frame. Called by `WsStreamClient.notifyBearerRotated`.
   */
  pushCredentialUpdate(): void {
    if (this.disposed) {
      return;
    }
    if (this.phase !== "subscribed" || !this.supportsCredentialUpdate) {
      return;
    }
    const socket = this.activeSocket;
    if (socket === null) {
      return;
    }
    const token = this.currentBearerToken();
    if (token === null) {
      return;
    }
    const frame: ClientStreamCredentialUpdateFrame = {
      kind: "credentialUpdate",
      token,
    };
    if (!this.sendControlText(socket, frame)) {
      this.onSendFailure(socket);
    }
  }

  /**
   * Hands a minted credential to the host on the other end of THIS connection.
   * Returns whether the frame actually went out, so the owning client can keep
   * the credential pending and try the next session instead of dropping it.
   *
   * Refuses unless the connection is fully `subscribed`, the host advertised the
   * capability, and this connection is bound to the very host the credential was
   * minted for - a client can hold sessions against several hosts at once, and
   * the credential names its host in a claim the wrong host would reject anyway.
   */
  pushHostCredentialProvision(
    hostId: string,
    credential: {
      readonly token: string;
      readonly refreshToken: string;
      readonly familyId: string;
      readonly provisionedAt: string;
    },
  ): boolean {
    if (this.disposed) {
      return false;
    }
    if (this.phase !== "subscribed" || !this.supportsHostCredentialProvision) {
      return false;
    }
    if (this.openFrameHostId !== hostId) {
      return false;
    }
    const socket = this.activeSocket;
    if (socket === null) {
      return false;
    }
    const frame: ClientStreamHostCredentialProvisionFrame = {
      kind: "hostCredentialProvision",
      token: credential.token,
      refreshToken: credential.refreshToken,
      familyId: credential.familyId,
      provisionedAt: credential.provisionedAt,
    };
    if (!this.sendControlText(socket, frame)) {
      this.onSendFailure(socket);
      return false;
    }
    return true;
  }

  // ---- Internal wiring -------------------------------------------------- //

  private connect(): void {
    if (this.disposed) {
      return;
    }
    // Single-dial guard: a connect must never overwrite a live `activeSocket`.
    // Normally every reconnect path nulls the socket first (`onTransportDrop` /
    // `resetForReconnect`), but the async `revalidateThenReconnect` can resolve
    // and call `scheduleReconnect()` AFTER a concurrent `forceReconnect` (a wake
    // signal) already re-dialed — without this guard the late connect would
    // orphan the healthy socket (its `onclose`/`onmessage` stay attached and
    // have no identity check), flapping the connection on wake.
    if (this.activeSocket !== null) {
      return;
    }

    const selected = this.config.endpoint();
    if (selected === null || selected.websocketUrl === null) {
      this.transitionTo("reconnecting", null);
      this.scheduleReconnect();
      return;
    }

    if (this.reconnectAttempt === 0) {
      this.transitionTo("connecting", null);
    }

    let token: string;
    try {
      token = extractBearerForOpenFrame(this.config.bearer());
    } catch (cause) {
      if (cause instanceof MissingBearerTokenForOpenFrameError) {
        this.transitionTo("reconnecting", null);
        this.scheduleReconnect();
        return;
      }
      throw cause;
    }

    // A bearer that is ALREADY expired cannot open a session - the host is
    // guaranteed to reject it with UNAUTHORIZED before any stream state is
    // built. This is the resume-after-suspension case: the renderer's
    // proactive refresh timer was frozen along with the rest of its JS, so
    // the first re-dial after wake would otherwise burn a round-trip on a
    // certain rejection (surfacing a sign-in toast). Revalidate first and
    // dial with the rotated bearer. The local `exp` read is unverified and
    // advisory only - the reactive UNAUTHORIZED path stays the authority for
    // everything it cannot see (revocation, clock skew, config mismatch),
    // and an undecodable token falls through to a normal dial.
    const auth = this.config.auth;
    const expiresAtMs = readAccessTokenExpiryMs(token);
    if (auth !== null && expiresAtMs !== null && expiresAtMs <= Date.now()) {
      console.debug(
        `[stream] pre-dial bearer already expired; revalidating before dial method=${String(this.config.method)}`,
      );
      this.transitionTo("reconnecting", null);
      void this.revalidateThenReconnect(
        auth,
        {
          code: "UNAUTHORIZED",
          reason: "Bearer expired before dial (client resumed from suspension)",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
        token,
      );
      return;
    }

    const dialUrl = toStreamDialUrl(selected.websocketUrl);
    const socket = this.config.webSocketFactory.create(dialUrl);
    this.activeSocket = socket;
    this.openFrameToken = token;
    this.openFrameHostId = selected.hostId;
    this.phase = "dialing";
    this.pendingBinaryEnvelope = null;

    // Every handler ignores events from a socket that is no longer the active
    // one. `teardownSocket` detaches handlers before closing, so a torn-down
    // socket stays silent; this guard additionally protects against any socket
    // that was superseded without teardown (the `connect()` single-dial guard
    // makes that unreachable today, but keeping the four handlers symmetric
    // means a future double-socket path can never let a stale socket drive the
    // live session's state machine).
    socket.onopen = () => {
      if (socket !== this.activeSocket) {
        return;
      }
      this.handleOpen();
    };
    socket.onmessage = (event: StreamWebSocketMessageEvent) => {
      if (socket !== this.activeSocket) {
        return;
      }
      this.handleMessage(event);
    };
    socket.onerror = (_event: WebSocketErrorEvent) => {
      if (socket !== this.activeSocket) {
        return;
      }
      this.handleSocketError();
    };
    socket.onclose = (event: WebSocketCloseEvent) => {
      if (socket !== this.activeSocket) {
        return;
      }
      this.handleSocketClose(event);
    };

    this.dialTimer = setTimeout(() => {
      this.dialTimer = null;
      if (this.phase === "dialing") {
        this.teardownSocket(4000, "dial-timeout");
        this.onTransportDrop();
      }
    }, this.config.dialTimeoutMs);
  }

  private handleOpen(): void {
    if (this.phase !== "dialing") {
      return;
    }
    if (this.dialTimer !== null) {
      clearTimeout(this.dialTimer);
      this.dialTimer = null;
    }
    const socket = this.activeSocket;
    if (socket === null) {
      return;
    }

    const token = this.openFrameToken;
    if (token === null) {
      this.teardownSocket(4000, "missing-open-token");
      this.onTransportDrop();
      return;
    }
    const manifest = buildStreamManifest(this.config.registry);
    const openFrame: ClientStreamOpenFrame = {
      kind: "open",
      token,
      manifest,
      clientIdentity: this.config.clientIdentity,
    };
    if (!this.sendControlText(socket, openFrame)) {
      this.onSendFailure(socket);
      return;
    }
    this.phase = "awaitingOpenAck";

    this.openAckTimer = setTimeout(() => {
      this.openAckTimer = null;
      if (this.phase === "awaitingOpenAck") {
        this.teardownSocket(4000, "openAck-timeout");
        this.onTransportDrop();
      }
    }, this.config.openAckTimeoutMs);
  }

  private handleMessage(event: StreamWebSocketMessageEvent): void {
    if (event.type === "binary") {
      this.handleBinaryFrame(event.data);
      return;
    }
    this.handleTextFrame(event.data);
  }

  private handleTextFrame(raw: string): void {
    if (this.pendingBinaryEnvelope !== null) {
      // A prior envelope said `hasBinaryPayload: true` but a fresh text
      // frame arrived before its paired binary - protocol violation.
      this.teardownSocket(4003, "missing-binary-payload");
      this.onTransportDrop();
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      void cause;
      this.teardownSocket(4002, "malformed-text-frame");
      this.onTransportDrop();
      return;
    }

    if (!isObjectLike(parsed)) {
      this.teardownSocket(4002, "malformed-text-frame");
      this.onTransportDrop();
      return;
    }

    const kind = parsed["kind"];
    if (kind === "openAck") {
      this.handleOpenAckFrame(parsed);
      return;
    }
    if (kind === "fatalError") {
      this.handleFatalErrorFrame(parsed);
      return;
    }

    // Any non-control text frame must be an application stream frame. We
    // require only an envelope with `kind` + `hasBinaryPayload`; typed
    // wrappers above us validate the full contract schema.
    const envelopeParse = streamMethodFrameEnvelopeSchema.safeParse(parsed);
    if (!envelopeParse.success) {
      this.teardownSocket(4002, "malformed-text-frame");
      this.onTransportDrop();
      return;
    }
    const envelope: StreamFrameEnvelope = envelopeParse.data;

    if (this.phase !== "subscribed") {
      this.teardownSocket(4003, "stream-frame-before-subscribe");
      this.onTransportDrop();
      return;
    }

    if (envelope.kind === "pong") {
      const now = Date.now();
      // Measure the gap from the pre-probe baseline when a wake probe rebased
      // `lastPongAt`: against the rebased value the probe's own pong reads as
      // a round trip, and a sleep-length outage would emit no recovery at all.
      const answersWakeProbe = this.preProbePongBaselineAt !== null;
      const pongGapMs = now - (this.preProbePongBaselineAt ?? this.lastPongAt);
      this.preProbePongBaselineAt = null;
      this.lastPongAt = now;
      // Counted, not timestamped: a wake probe has to know whether a pong
      // ARRIVED, and two pongs inside the same millisecond are
      // indistinguishable by `lastPongAt` alone.
      this.pongSeq += 1;
      if (
        answersWakeProbe ||
        pongGapMs >= this.config.pingIntervalMs + PONG_GAP_RECOVERY_SLACK_MS
      ) {
        // Two distinct recovery edges share this emission. A probe-answering
        // pong is one unconditionally: probes are sent only on a device-wake /
        // network-online signal, an epoch in which host-scoped queries may
        // have failed while the socket itself survived - and a cycle shorter
        // than the heartbeat threshold left the gap check false, so the
        // stranded queries (whose other automatic refetch routes are
        // disabled) never recovered. A big gap WITHOUT a probe is the other:
        // the host answered after leaving at least one ping hanging (an
        // event-loop stall), again with no socket drop, so the reconnect
        // path's recovery emission never fires for either.
        this.config.onAvailabilityRecovered();
      }
      return;
    }

    if (envelope.kind === "ping") {
      // Host-originated keepalive. The `/stream` server actively pings
      // and expects a matching pong to clear its deadline; answer on the
      // wire without surfacing the ping to the contract-frame handler and
      // without touching `lastPongAt` (that bookkeeping tracks replies to
      // OUR pings, which is a separate liveness check).
      const socket = this.activeSocket;
      if (socket !== null) {
        const sent = this.writeEnvelope(
          socket,
          { kind: "pong", hasBinaryPayload: false },
          null,
        );
        if (!sent) {
          this.onSendFailure(socket);
        }
      }
      return;
    }

    if (envelope.hasBinaryPayload === true) {
      this.pendingBinaryEnvelope = envelope;
      return;
    }

    this.emitServerFrame(envelope, null);
  }

  private handleBinaryFrame(data: Uint8Array): void {
    if (this.pendingBinaryEnvelope === null) {
      this.teardownSocket(4003, "unexpected-binary-frame");
      this.onTransportDrop();
      return;
    }
    const envelope = this.pendingBinaryEnvelope;
    this.pendingBinaryEnvelope = null;
    this.emitServerFrame(envelope, data);
  }

  private handleOpenAckFrame(parsed: object): void {
    if (this.phase !== "awaitingOpenAck") {
      this.teardownSocket(4003, "unexpected-openAck");
      this.onTransportDrop();
      return;
    }
    const ackParse = hostStreamOpenAckFrameSchema.safeParse(parsed);
    if (!ackParse.success) {
      this.teardownSocket(4002, "malformed-text-frame");
      this.onTransportDrop();
      return;
    }
    if (this.openAckTimer !== null) {
      clearTimeout(this.openAckTimer);
      this.openAckTimer = null;
    }
    this.supportsCredentialUpdate = ackParse.data.capabilities.includes(
      STREAM_CAPABILITY_CREDENTIAL_UPDATE,
    );
    this.supportsHostCredentialProvision = ackParse.data.capabilities.includes(
      STREAM_CAPABILITY_HOST_CREDENTIAL_PROVISION,
    );
    const hostCredentialState = ackParse.data.hostCredentialState;

    const theirManifest = ackParse.data.manifest;
    const myManifest = selectConnectionManifestForPeer(
      this.config.registry,
      buildStreamManifest(this.config.registry),
      theirManifest,
    );
    const compat = checkStreamMethodCompatibility(
      this.config.registry,
      myManifest,
      theirManifest,
      "client",
      this.config.method,
    );

    const socket = this.activeSocket;
    if (socket === null) {
      return;
    }

    // Reported HERE, ahead of the compatibility abort below, because the
    // credential state is a property of the HANDSHAKE and not of this
    // session's application method: a host whose `hostCredentialState` says
    // `missing` said so whether or not our build agrees with it about one
    // method's version. Firing this only on the success path made the
    // observer's contract ("every state-carrying ack") false, and left an
    // observer unable to tell a version-skewed host apart from an
    // unreachable one. The MINT hook stays at the end of this method, where a
    // live session can actually carry the provision frame - only the passive
    // observation moves.
    this.reportHostCredentialState(hostCredentialState);

    if (!compat.ok) {
      this.config.onManifest(theirManifest, this.config.method, "unsupported");
      const terminalFrame: ClientStreamFatalErrorFrame = {
        kind: "fatalError",
        details: compat.details,
      };
      this.sendControlText(socket, terminalFrame);
      if (!this.disposeSession()) {
        return;
      }
      this.teardownTimers();
      this.teardownSocket(1000, "mirror-incompatible");
      this.transitionTo("closed", {
        kind: "fatalError",
        details: compat.details,
      });
      return;
    }

    const prepared = prepareStreamSubscribeRequest(
      this.config.registry,
      this.config.method,
      myManifest[this.config.method],
      theirManifest[this.config.method],
      this.config.paramsProvider(),
    );
    const subscribeFrame: ClientStreamSubscribeFrame = {
      kind: "subscribe",
      method: this.config.method,
      schemaVersion: prepared.onWireVersion,
      params: prepared.onWirePayload,
    };
    if (!this.sendControlText(socket, subscribeFrame)) {
      this.onSendFailure(socket);
      return;
    }
    this.negotiatedSchemaVersion = prepared.onWireVersion;
    this.config.onManifest(theirManifest, this.config.method, "supported");
    // Read BEFORE `transitionTo("open")` overwrites it: a session that was
    // "reconnecting" (dropped socket, or failed dial attempts) has just proved
    // the host is reachable again. The initial clean connect ("connecting" →
    // "open") is NOT recovery - nothing was stuck - so it stays silent.
    const recoveredFromUnavailable = this.status === "reconnecting";
    this.phase = "subscribed";
    // The subscription is established: this is a live session, and the
    // authority is told so before any outbound callback below can re-enter.
    this.announceSession();

    // Deliberately NOT resetting `reconnectAttempt` /
    // `noProgressUnauthorizedReconnects` here. The subscribe-ack only proves
    // the transport handshake; resolver-side initialization failures land
    // AFTER it as fatalError frames, and resetting the loop counters on every
    // ack made both the reconnect backoff and the UNAUTHORIZED give-up bound
    // unreachable for a host that acks then fails - an unbounded floor-delay
    // loop that hammers authn each lap (int #4781, field: traycer#892). The
    // counters reset on the first delivered APPLICATION frame instead - the
    // proof the stream is actually usable (see `emitServerFrame`) - or after
    // a sustained-subscription dwell for streams with nothing to say (see
    // `armHealthyDwell`).
    this.lastPongAt = Date.now();
    // A fresh handshake supersedes any wake-probe baseline: this path emits
    // its own recovery edge below, and a stale baseline would double-count
    // the outage on the first post-handshake pong.
    this.preProbePongBaselineAt = null;
    this.startHeartbeat();
    this.armHealthyDwell();
    this.transitionTo("open", null);
    if (recoveredFromUnavailable) {
      this.config.onAvailabilityRecovered();
    }
    // If the bearer rotated DURING the handshake - after the open frame was sent
    // but before we became `subscribed` - that rotation's `notifyBearerRotated`
    // was dropped (we weren't subscribed yet) and the open frame carried the now
    // stale token. Reconcile once here so the host still gets the fresh bearer in
    // place. No-op on the common path where the bearer is unchanged.
    if (
      this.supportsCredentialUpdate &&
      this.openFrameToken !== null &&
      this.currentBearerToken() !== this.openFrameToken
    ) {
      this.pushCredentialUpdate();
    }
    // Reported last, once the connection can actually carry a provision frame:
    // the owning client may respond to this synchronously by flushing a
    // credential minted on an earlier, now-dead socket.
    const hostId = this.openFrameHostId;
    if (
      this.supportsHostCredentialProvision &&
      hostCredentialState !== null &&
      hostId !== null
    ) {
      this.config.onHostCredentialAck(hostId, hostCredentialState);
    }
  }

  /**
   * Passive observation of the ack's credential state, split out from the mint
   * hook so it can fire before a compatibility abort. Guarded the same way the
   * mint is (capability + state + host id) and never allowed to throw into the
   * handshake.
   */
  private reportHostCredentialState(state: HostCredentialState | null): void {
    const observe = this.config.onHostCredentialState;
    const hostId = this.openFrameHostId;
    if (
      observe === null ||
      !this.supportsHostCredentialProvision ||
      state === null ||
      hostId === null
    ) {
      return;
    }
    try {
      observe(hostId, state);
    } catch (cause) {
      console.warn(
        `[stream] host-credential state observer threw (method=${this.config.method}, host=${hostId})`,
        cause,
      );
    }
  }

  /**
   * Forwards a host-published restart tombstone to the selection authority.
   *
   * Silent when the host published none - every host predating the tombstone,
   * and every ordinary fatal on a host that does publish them. Duplicates are
   * forwarded rather than filtered here: the authority keys episodes by
   * (hostId, tombstoneId) and treats a repeat as inert, and that rule belongs
   * in the one place that can apply it across every window in the app.
   */
  /**
   * Announces this connection's live session once its subscription is
   * established. Idempotent: a repeat while one is already announced is inert,
   * so a re-entrant handshake callback cannot double-count.
   */
  private announceSession(): void {
    if (this.announcedSession !== null) return;
    const hostId = this.openFrameHostId;
    if (hostId === null) return;
    streamSessionSeq += 1;
    const sessionId = `local-stream:s${streamSessionSeq}`;
    this.announcedSession = { hostId, sessionId };
    this.config.evidence.sessionEstablished(hostId, sessionId, "local-ws");
  }

  /**
   * Retracts the announced session, against the host it was announced FOR.
   * Idempotent, and called on every path that drops the dialed identity.
   */
  private retractSession(): void {
    const announced = this.announcedSession;
    if (announced === null) return;
    this.announcedSession = null;
    this.config.evidence.sessionLost(
      announced.hostId,
      announced.sessionId,
      "local-ws",
    );
  }

  private reportRestartIntentIfPresent(details: FatalErrorDetails): void {
    const restartIntent = details.restartIntent;
    if (restartIntent === undefined) {
      return;
    }
    const hostId = this.openFrameHostId;
    if (hostId === null) {
      // No dialed identity captured yet, so there is no host to file the
      // tombstone against. Dropping is right: a guess would hold the wrong
      // lease, and a fatal this early means nothing was serving anyway.
      return;
    }
    this.config.evidence.reportRestartIntent(
      hostId,
      restartIntent.tombstoneId,
      restartIntent.expiresAt,
    );
  }

  private handleFatalErrorFrame(parsed: object): void {
    const termParse = hostStreamFatalErrorFrameSchema.safeParse(parsed);
    if (!termParse.success) {
      this.teardownSocket(4002, "malformed-text-frame");
      this.onTransportDrop();
      return;
    }
    const details = termParse.data.details;
    // The restart tombstone (P1.4 / D5 / M1), read BEFORE the frame is routed
    // by `retryable`/`UNAUTHORIZED` so every arm reports it. The host is
    // stating that the outage it is about to cause is deliberate - the one
    // thing this window cannot infer for a restart it did not issue.
    //
    // `openFrameHostId`, not `endpoint()`: the identity THIS connection
    // dialed, for the same reason the credential path reads it - the endpoint
    // provider may already point somewhere else, and a tombstone filed
    // against the wrong host would hold the wrong lease.
    this.reportRestartIntentIfPresent(details);
    // `retryable` marks a transient host-side rejection. The stable subscribe-
    // timeout code is checked too because hosts through 1.1.9 emitted it without
    // the additive flag; a new client must still recover when paired with one of
    // those hosts. In either case credential recovery cannot help, so route it
    // through ordinary transport reconnect before the `UNAUTHORIZED` branch.
    if (
      details.retryable === true ||
      details.code === STREAM_SUBSCRIBE_TIMEOUT_FATAL_CODE
    ) {
      // A transient host blip must not count toward the credential give-up
      // bound, mirroring the `network-error` revalidation outcome: clear any
      // streak left by a prior genuine `UNAUTHORIZED` episode so a later real
      // rejection starts from a clean slate.
      this.noProgressUnauthorizedReconnects = 0;
      this.teardownSocket(1000, "host-retryable");
      this.onTransportDrop();
      return;
    }
    // `UNAUTHORIZED` is recoverable when an auth revalidator is wired: the
    // host rejected our bearer (e.g. it expired during an overnight sleep),
    // but a single-flight revalidation may rotate a fresh one that the next
    // dial carries. Every other fatalError (e.g. `INCOMPATIBLE` or a stream
    // domain code such as `CHAT_INVALID`), and the no-revalidator case, stays
    // terminal exactly as before.
    if (details.code === "UNAUTHORIZED" && this.config.auth !== null) {
      this.handleUnauthorizedFatalError(details, this.config.auth);
      return;
    }
    this.goTerminal(details);
  }

  /**
   * Recovers an `UNAUTHORIZED` open-frame rejection by revalidating the
   * credential and acting on the normalized outcome:
   *   - "rotated"       → re-dial; the next open frame carries the fresh bearer.
   *   - "network-error" → stay in reconnect backoff (transient); the next cycle
   *                       revalidates again once connectivity returns.
   *   - "rejected"      → terminal (the revalidator has already signed out).
   * A no-progress streak (revalidation keeps returning a current credential the
   * host keeps rejecting) is bounded and goes terminal to stop looping.
   */
  private handleUnauthorizedFatalError(
    details: FatalErrorDetails,
    auth: StreamAuthRevalidator,
  ): void {
    if (this.disposed) {
      return;
    }
    // Capture the bearer the host just rejected BEFORE teardown nulls it, so
    // after revalidation we can tell whether the next dial would carry a
    // DIFFERENT token (progress) or the same rejected one (no progress).
    const rejectedToken = this.openFrameToken;

    // The host closed this connection. Drop the (now-dead) socket and show
    // "reconnecting" synchronously while we revalidate — do NOT dispose; the
    // session is recoverable unless revalidation says otherwise.
    this.teardownSocket(1000, "host-unauthorized");
    this.slowClientReconnectStreak = 0;
    this.lastCloseWasSlowClient = false;
    this.resetForReconnect();

    void this.revalidateThenReconnect(auth, details, rejectedToken);
  }

  private async revalidateThenReconnect(
    auth: StreamAuthRevalidator,
    details: FatalErrorDetails,
    rejectedToken: string | null,
  ): Promise<void> {
    const outcome = await this.revalidateWithinBudget(auth);
    if (this.disposed) {
      return;
    }
    // Wake-recovery trace: which way the overnight-expired-bearer revalidation
    // resolved, so an on-device wake shows whether the fresh bearer landed.
    console.debug(
      `[stream] UNAUTHORIZED revalidate outcome=${outcome} method=${String(
        this.config.method,
      )}`,
    );
    if (outcome === "rejected") {
      // The credential was rejected (revoked / dead refresh token); the
      // revalidator has already signed out. Stop retrying.
      this.goTerminal(details);
      return;
    }
    if (outcome === "network-error") {
      // Transient (authn unreachable / refresh timed out): the bearer is
      // untouched. This is NOT a no-progress signal — a wake-time network blip
      // must not count toward the give-up bound — so reset the streak and stay
      // in reconnect backoff; the next cycle revalidates again once
      // connectivity returns.
      this.noProgressUnauthorizedReconnects = 0;
      this.scheduleReconnect();
      return;
    }
    // outcome === "rotated": authn accepts the credential. If the bearer the
    // NEXT dial will carry is still the one the host just rejected, no
    // progress was made (authn validates it but the host keeps rejecting —
    // clock skew / config mismatch). Bound that loop so we don't hammer authn
    // forever; otherwise reset and re-dial with the fresh token.
    if (rejectedToken !== null && this.currentBearerToken() === rejectedToken) {
      this.noProgressUnauthorizedReconnects += 1;
      if (
        this.noProgressUnauthorizedReconnects >=
        MAX_NO_PROGRESS_UNAUTHORIZED_RECONNECTS
      ) {
        // Retrying can't make progress. Go terminal so we stop looping. The
        // user is still signed in (no sign-out), so recovery is a manual reload.
        console.error(
          `[stream] giving up after ${this.noProgressUnauthorizedReconnects} ` +
            `no-progress UNAUTHORIZED reconnects (method=${String(
              this.config.method,
            )}); reload required`,
        );
        this.goTerminal(details);
        return;
      }
    } else {
      this.noProgressUnauthorizedReconnects = 0;
    }
    this.scheduleReconnect();
  }

  /**
   * Awaits the auth revalidation but never longer than `REVALIDATE_TIMEOUT_MS`.
   * Without the budget a hung refresh (a half-open authn socket after sleep)
   * would strand the session in "reconnecting" forever — `resetForReconnect`
   * deliberately armed no timer. On timeout (or a thrown revalidation) we treat
   * it as transient and let the normal reconnect backoff retry.
   */
  private async revalidateWithinBudget(
    auth: StreamAuthRevalidator,
  ): Promise<RevalidateOutcome> {
    let timer: TimerHandle | null = null;
    const budget = new Promise<RevalidateOutcome>((resolve) => {
      timer = setTimeout(() => resolve("network-error"), REVALIDATE_TIMEOUT_MS);
    });
    // Invoke inside a promise chain, never bare — see the twin in
    // `remote-session.ts`. A `revalidateForReconnect` that throws synchronously
    // would otherwise skip this `.catch` and the `finally` that clears the
    // budget timer, and surface as an unhandled rejection instead of the
    // "network-error" this method promises for a thrown revalidation.
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

  /** The bearer the next open frame would carry, or null if none is available. */
  private currentBearerToken(): string | null {
    try {
      return extractBearerForOpenFrame(this.config.bearer());
    } catch {
      return null;
    }
  }

  /**
   * Terminal teardown for a fatal error: dispose the session, clear timers,
   * close the socket, and surface the close reason. Used for non-recoverable
   * fatalErrors and the bounded/rejected `UNAUTHORIZED` outcomes.
   */
  private goTerminal(details: FatalErrorDetails): void {
    if (!this.disposeSession()) {
      return;
    }
    this.teardownTimers();
    this.teardownSocket(1000, "host-fatal-error");
    this.transitionTo("closed", {
      kind: "fatalError",
      details,
    });
  }

  private handleSocketError(): void {
    const socket = this.activeSocket;
    if (socket === null) {
      return;
    }
    this.teardownSocket(4005, "socket-error");
    this.onTransportDrop();
  }

  private handleSocketClose(event: WebSocketCloseEvent): void {
    if (this.disposed) {
      return;
    }
    // A host slow-client eviction is a recoverable close (no fatalError
    // frame) whose reason is prefixed `SLOW_CLIENT`. Flag it so the reconnect
    // backoff escalates across repeated evictions instead of retrying at the
    // fixed initial delay. `onTransportDrop` consumes the flag.
    this.lastCloseWasSlowClient = isSlowClientCloseReason(event.reason);
    this.onTransportDrop();
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.pingIntervalTimer = setInterval(() => {
      const now = Date.now();
      if (now - this.lastPongAt >= this.config.pongTimeoutMs) {
        this.teardownSocket(4004, "missed-pongs");
        this.onTransportDrop();
        return;
      }
      const activeSocket = this.activeSocket;
      if (activeSocket === null) {
        return;
      }
      if (this.phase !== "subscribed") {
        return;
      }
      const sent = this.writeEnvelope(
        activeSocket,
        { kind: "ping", hasBinaryPayload: false },
        null,
      );
      if (!sent) {
        this.onSendFailure(activeSocket);
      }
    }, this.config.pingIntervalMs);
  }

  private clearHeartbeat(): void {
    if (this.pingIntervalTimer !== null) {
      clearInterval(this.pingIntervalTimer);
      this.pingIntervalTimer = null;
    }
  }

  private onTransportDrop(): void {
    if (this.disposed) {
      return;
    }
    // Escalate backoff only for consecutive slow-client evictions; any other
    // drop resets the streak so normal reconnects are unaffected. The flag is
    // set by `handleSocketClose` and consumed here (every other drop path
    // leaves it false).
    if (this.lastCloseWasSlowClient) {
      this.slowClientReconnectStreak += 1;
    } else {
      this.slowClientReconnectStreak = 0;
    }
    this.lastCloseWasSlowClient = false;
    this.resetForReconnect();
    this.scheduleReconnect();
  }

  /**
   * Arms the sustained-subscription reset: staying subscribed past the dwell
   * is health even when the stream has nothing to say, so the loop counters
   * reset exactly as a delivered application frame would reset them. The
   * ack-then-fail loop this file's counters bound fails in milliseconds and
   * can never dwell this long. (Predicate precedent: the CLI monitor's
   * HEALTHY_OPEN_MS - "sustained openness past the subscribe-accept window
   * is health".)
   */
  private armHealthyDwell(): void {
    this.clearHealthyDwell();
    this.subscribedAt = Date.now();
    this.healthyDwellTimer = setTimeout(() => {
      this.healthyDwellTimer = null;
      this.resetLoopCounters();
    }, HEALTHY_SUBSCRIBED_DWELL_MS);
  }

  /**
   * Disarms the dwell and SETTLES it on elapsed time: if the socket really
   * did stay subscribed past `HEALTHY_SUBSCRIBED_DWELL_MS`, the reset is
   * applied here even though the timer never got to run.
   *
   * A timer is not a clock. `setTimeout` is throttled in a backgrounded
   * renderer, so on a quiet event-only stream - the exact case the dwell
   * exists to serve, since it has no application frames to reset on - a
   * drop can be processed while the callback is still queued. Clearing it
   * silently would discard a reset the stream had already earned and leave
   * `reconnectAttempt` a lifetime drop counter, restoring the pinned-at-cap
   * behavior this change removes. Elapsed time is the honest predicate.
   *
   * Ordering note: `onTransportDrop` calls `resetForReconnect()` (→ here)
   * BEFORE `scheduleReconnect()`, so a settled dwell zeroes the counter and
   * the redial is then attempt 1 - a healthy stream restarts its backoff
   * from the floor rather than resuming a lifetime ladder.
   */
  private clearHealthyDwell(): void {
    if (this.healthyDwellTimer !== null) {
      clearTimeout(this.healthyDwellTimer);
      this.healthyDwellTimer = null;
    }
    const subscribedAt = this.subscribedAt;
    this.subscribedAt = null;
    if (
      subscribedAt !== null &&
      Date.now() - subscribedAt >= HEALTHY_SUBSCRIBED_DWELL_MS
    ) {
      this.resetLoopCounters();
    }
  }

  /**
   * The single reset applied by all three health signals - a delivered
   * application frame, the dwell timer, and an elapsed-time dwell settle.
   */
  private resetLoopCounters(): void {
    this.reconnectAttempt = 0;
    this.noProgressUnauthorizedReconnects = 0;
  }

  /**
   * Clears the per-connect socket + timers and transitions to "reconnecting"
   * WITHOUT scheduling the redial. `onTransportDrop` follows it with
   * `scheduleReconnect`; the `UNAUTHORIZED` path follows it with a revalidation
   * that decides whether to reconnect or go terminal.
   */
  private resetForReconnect(): void {
    this.negotiatedSchemaVersion = null;
    this.config.onTransportReconnect(this.config.method);
    this.clearHeartbeat();
    if (this.openAckTimer !== null) {
      clearTimeout(this.openAckTimer);
      this.openAckTimer = null;
    }
    if (this.dialTimer !== null) {
      clearTimeout(this.dialTimer);
      this.dialTimer = null;
    }
    this.clearHealthyDwell();
    // Before the dialed identity is dropped - the retraction needs the host it
    // was announced for.
    this.retractSession();
    this.activeSocket = null;
    this.openFrameToken = null;
    this.openFrameHostId = null;
    this.supportsCredentialUpdate = false;
    this.supportsHostCredentialProvision = false;
    this.phase = "idle";
    this.pendingBinaryEnvelope = null;
    this.transitionTo("reconnecting", null);
  }

  private scheduleReconnect(): void {
    if (this.disposed) {
      return;
    }
    if (this.backoffTimer !== null) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
    // Fold the slow-client eviction streak into the attempt count so repeated
    // host evictions of a too-slow renderer escalate toward `maxBackoffMs`
    // rather than retrying at the initial delay (which resets on every
    // successful subscribe). For all other drops the streak is 0 and this is
    // exactly `backoffFor(reconnectAttempt, ...)`.
    const delay = backoffFor(
      Math.max(this.reconnectAttempt, this.slowClientReconnectStreak),
      this.config.initialBackoffMs,
      this.config.maxBackoffMs,
    );
    this.reconnectAttempt += 1;
    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = null;
      this.connect();
    }, delay);
  }

  private teardownTimers(): void {
    this.clearHeartbeat();
    // A pending wake probe must never outlive the session it was measuring:
    // its callback would otherwise force a reconnect on a disposed session.
    this.clearWakeProbe();
    if (this.dialTimer !== null) {
      clearTimeout(this.dialTimer);
      this.dialTimer = null;
    }
    if (this.openAckTimer !== null) {
      clearTimeout(this.openAckTimer);
      this.openAckTimer = null;
    }
    if (this.backoffTimer !== null) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
    this.clearHealthyDwell();
  }

  private teardownSocket(code: number, reason: string): void {
    const socket = this.activeSocket;
    // Same ordering rule as the drop path: retract while the announced host is
    // still known. `teardownSocket` is the caller-`close()` and fatal-error
    // leg, so between the two of them no announced session outlives its socket.
    this.retractSession();
    this.activeSocket = null;
    this.openFrameToken = null;
    this.openFrameHostId = null;
    this.pendingBinaryEnvelope = null;
    if (socket === null) {
      return;
    }
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close(code, reason);
    } catch (cause) {
      void cause;
    }
  }

  private sendControlText(
    socket: StreamWebSocketLike,
    frame:
      | ClientStreamOpenFrame
      | ClientStreamSubscribeFrame
      | ClientStreamFatalErrorFrame
      | ClientStreamCredentialUpdateFrame
      | ClientStreamHostCredentialProvisionFrame,
  ): boolean {
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch (cause) {
      void cause;
      return false;
    }
  }

  private writeEnvelope(
    socket: StreamWebSocketLike,
    envelope: StreamFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ): boolean {
    try {
      socket.send(JSON.stringify(envelope));
      if (binaryPayload !== null) {
        socket.send(binaryPayload);
      }
      return true;
    } catch (cause) {
      void cause;
      return false;
    }
  }

  private onSendFailure(socket: StreamWebSocketLike): void {
    if (this.disposed || this.activeSocket !== socket) {
      return;
    }
    this.teardownSocket(4005, "send-failed");
    this.onTransportDrop();
  }

  private emitServerFrame(
    envelope: StreamFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ): void {
    // Every server frame proves the socket can deliver work, so it resets the
    // transport backoff. Only a snapshot proves an epic stream completed its
    // establishing path: `earlyMeta`, permission changes, and incremental
    // frames can arrive before the host has initialized the cloud-backed
    // replica. Treating any of those as auth-loop progress lets an `earlyMeta`
    // → `UNAUTHORIZED` loop evade the give-up bound forever (int #4781 /
    // traycer#892). The dwell remains the separate health proof for quiet
    // non-epic streams.
    this.reconnectAttempt = 0;
    if (envelope.kind === "snapshot") {
      this.noProgressUnauthorizedReconnects = 0;
    }
    const handler = this.serverFrameHandler;
    if (handler === null) {
      return;
    }
    handler(envelope, binaryPayload);
  }

  private transitionTo(
    next: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ): void {
    if (this.status === next && next !== "reconnecting") {
      return;
    }
    this.status = next;
    const handler = this.statusHandler;
    if (handler === null) {
      return;
    }
    handler(next, reason);
  }

  private disposeSession(): boolean {
    if (this.disposed) {
      return false;
    }
    this.disposed = true;
    this.config.onDispose();
    return true;
  }
}

interface PreparedStreamSubscribeRequest {
  readonly onWireVersion: SchemaVersion;
  readonly onWirePayload: unknown;
}

/**
 * Computes what the `subscribe` control frame should actually declare on the
 * wire - the streaming analog of `ws-rpc-client.ts`'s `prepareRequestPayload`.
 *
 * `checkStreamMethodCompatibility` already proved `mine`/`theirs` are
 * bridgeable before this runs. For a same-major minor skew that only ever
 * means one thing: MY OWN registry carries a contract at the peer's exact
 * (older) minor - that's what made `canBridgeStream()` return `true`. Per the
 * framework's asymmetric contract, the older side never transforms, so the
 * newer side is the one that must downgrade what it declares: sending my own
 * canonical here would declare a minor the older peer's dispatch table has
 * never heard of, even though the abstract compatibility check passed (this
 * is what broke `chat.subscribe@1.1` against host-v1.0.0 - the compat check
 * passed, but the client still declared `1.1`, which host-v1.0.0's registry
 * has no contract for). Cross-major skew never reaches here: streams have no
 * cross-major bridge, so `compat.ok` would already be `false`.
 */
export function prepareStreamSubscribeRequest(
  registry: VersionedStreamRpcRegistry,
  method: string,
  myCanonical: SchemaVersion,
  theirCanonical: SchemaVersion,
  params: unknown,
): PreparedStreamSubscribeRequest {
  if (
    myCanonical.major !== theirCanonical.major ||
    myCanonical.minor <= theirCanonical.minor
  ) {
    return { onWireVersion: myCanonical, onWirePayload: params };
  }
  const methodRegistry = registry[method] as StreamMethodVersionRegistry;
  const olderLine = methodRegistry[myCanonical.major];
  const olderEntry = olderLine.versions[theirCanonical.minor];
  return {
    onWireVersion: theirCanonical,
    onWirePayload: olderEntry.contract.openRequestSchema.parse(params),
  };
}

type SessionPhase = "idle" | "dialing" | "awaitingOpenAck" | "subscribed";

/**
 * Cap on consecutive `UNAUTHORIZED` reconnects where revalidation keeps
 * returning a current credential the host keeps rejecting (no token rotation
 * making progress). After this many no-progress cycles the session goes
 * terminal instead of looping forever — a rare clock-skew / config-mismatch
 * edge whose recovery is a manual reload (the user is still signed in).
 */
const MAX_NO_PROGRESS_UNAUTHORIZED_RECONNECTS = 3;
/**
 * How long a connection must STAY subscribed before that alone resets the
 * reconnect loop counters (see `armHealthyDwell`). Long enough that the
 * subscribe-ack-then-fatal loop (which fails in milliseconds) can never
 * reach it; short enough that one long-lived healthy connection between two
 * ordinary drops always does. Mirrors the CLI monitor's HEALTHY_OPEN_MS.
 */
const HEALTHY_SUBSCRIBED_DWELL_MS = 10_000;

/**
 * Upper bound on how long an `UNAUTHORIZED` revalidation may run before the
 * stream gives up waiting and treats it as a transient `network-error`. Caps
 * the "reconnecting" window so a hung authn refresh (a half-open socket after
 * sleep) can never strand the session — the normal reconnect backoff then
 * retries.
 */
const REVALIDATE_TIMEOUT_MS = 10_000;

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Marker prefix the host puts on the WebSocket close reason when it evicts a
 * slow client (a recoverable drop, not a fatalError). Kept in sync with the
 * host's `dropConnection("SLOW_CLIENT: …")` call in the chat session.
 */
const SLOW_CLIENT_CLOSE_REASON_PREFIX = "SLOW_CLIENT";

/**
 * True when a recoverable close came from a host slow-client eviction.
 * Detecting it lets the reconnect backoff escalate for a persistently slow
 * renderer without changing any other close path. A missing/empty reason
 * (some environments drop it) simply reads as "not a slow-client close", which
 * degrades to the prior fixed-backoff behavior.
 */
function isSlowClientCloseReason(reason: string): boolean {
  return reason.startsWith(SLOW_CLIENT_CLOSE_REASON_PREFIX);
}

/**
 * Rewrite a host directory entry's `websocketUrl` to the `/stream` path.
 *
 * Host directory entries today advertise a single `websocketUrl` that
 * targets the unary `/rpc` endpoint. `WsStreamClient` always needs to land
 * on `/stream`, so the stream transport rewrites the path suffix locally
 * rather than forcing every directory producer to carry a second field.
 *
 * Behaviour:
 *   - `…/rpc`   → `…/stream`
 *   - `…/stream` left unchanged (idempotent)
 *   - no path / bare host → append `/stream`
 *   - any other trailing segment → append `/stream` to the existing path
 *
 * Query strings and fragments (if present) are preserved verbatim so future
 * entries carrying auth hints or build identifiers keep working.
 */
export function toStreamDialUrl(websocketUrl: string): string {
  const queryIdx = websocketUrl.indexOf("?");
  const fragIdx = websocketUrl.indexOf("#");
  const cutIdx = pickFirst(queryIdx, fragIdx);
  const base = cutIdx === -1 ? websocketUrl : websocketUrl.slice(0, cutIdx);
  const tail = cutIdx === -1 ? "" : websocketUrl.slice(cutIdx);

  if (base.endsWith("/stream")) {
    return base + tail;
  }
  if (base.endsWith("/rpc")) {
    return `${base.slice(0, -"/rpc".length)}/stream${tail}`;
  }
  const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${trimmed}/stream${tail}`;
}

function pickFirst(a: number, b: number): number {
  if (a === -1) {
    return b;
  }
  if (b === -1) {
    return a;
  }
  return Math.min(a, b);
}

export { streamMethodFrameEnvelopeSchema };
