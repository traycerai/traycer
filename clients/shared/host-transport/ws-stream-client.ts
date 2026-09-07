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
import { CLIENT_SERVED_STREAM_MAJORS } from "./served-stream-majors";
import {
  getMemoizedStreamMethodSupport,
  recordNegotiatedStreamMethodSupport,
} from "./stream-method-support-registry";
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
import {
  clockSkewStreamReason,
  type ServerClockSkewSignal,
} from "@traycer-clients/shared/clock/server-time-offset-tracker";
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
import { dialPriorityForMethod } from "./dial-priority";
import type {
  IStreamWebSocketFactory,
  StreamWebSocketLike,
  StreamWebSocketMessageEvent,
} from "./ws-stream-factory";
import type { WebSocketCloseEvent, WebSocketErrorEvent } from "./ws-factory";
import type { IntervalHandle, TimerHandle } from "./timer-handle";
import type { ReconnectAllOptions } from "./host-stream-client";
import { backoffFor } from "./backoff";

export interface WsStreamClientOptions<
  Registry extends VersionedStreamRpcRegistry,
> {
  readonly registry: Registry;
  /**
   * The host this client talks to, or `null` for a client with no host identity (the CLI's, a test double's).
   */
  readonly hostId: string | null;
  readonly endpoint: HostEndpointProvider;
  readonly bearer: BearerSourceProvider;
  /**
   * Auth recovery hook invoked when the host rejects an open frame with `unauthorized` (the overnight-wake case: the bearer expired during sleep).
   * `null` keeps the legacy behaviour (an `unauthorized` fatalError is terminal), which is correct for short-lived/dev clients that have no revalidator and cannot recover an auth rejection by retrying the same bearer.
   */
  readonly auth: StreamAuthRevalidator | null;
  /**
   * Verdict on whether this machine's wall clock is trustworthy, from the shared server-time offset tracker.
   * Read at the two places an auth failure could be a lie: the pre-dial expiry gate and the no-progress `unauthorized` bound.
   */
  readonly clock: ServerClockSkewSignal | null;
  /**
   * Mints a device credential when a connected host reports it has none, so the host can act on the user's behalf after the client disconnects.
   * An opted-out client never sends the provision frame; the host stays on this connection's credential lease, exactly as before the capability existed.
   */
  readonly hostCredentialMint: HostCredentialMintFlow | null;
  /**
   * Observation tap for the `openAck.hostCredentialState` a connected host reports.
   * Fired on every ack that carries a state (the host must advertise the provision capability), before the client acts on it - so an observer sees `"active"` acks the mint machinery ignores.
   */
  readonly onHostCredentialState:
    | ((hostId: string, state: HostCredentialState) => void)
    | null;
  /** Where this transport's observations reach the selection authority. */
  readonly evidence: TransportEvidenceReporter;
  readonly webSocketFactory: IStreamWebSocketFactory;
  readonly dialTimeoutMs: number;
  readonly openAckTimeoutMs: number;
  readonly pingIntervalMs: number;
  readonly pongTimeoutMs: number;
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
  /**
   * Who this client IS, sent on every `open` frame this transport writes - including every reconnect, since each redial re-authenticates and is therefore re-gated by the host.
   * Required, not defaulted, for the same reason `evidence` is: a new construction site has to answer the question rather than inherit a silent answer.
   */
  readonly clientIdentity: FirstPartyClientIdentity;
}

/** Shared-state transport for `/stream`. */

/**
 * Builds the inert `IStreamSession` returned when `subscribe()` is called on a closed client.
 * "No live transport": it drops outbound frames and its `close()` only suppresses the pending status emission - so a stale late subscribe degrades without throwing.
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

let nextStreamClientId = 1;

let streamSessionSeq = 0;

export class WsStreamClient<
  Registry extends VersionedStreamRpcRegistry,
> implements IStreamClient<Registry> {
  /**
   * Stable per-instance tag (`stream-client-<n>`) carried in every lifecycle log line so a "subscribe on a closed client" warning can be correlated with the close that preceded it.
   */
  readonly instanceId: string;

  private readonly options: WsStreamClientOptions<Registry>;
  /**
   * Serialized once here rather than per session: every member is a process constant, and this client hands the same value to every session it owns and to every one of their redials.
   */
  private readonly clientIdentity: ClientHandshakeIdentity;
  private readonly ownedSessions = new Set<StreamSession<Registry>>();
  private readonly methodSupport = new Map<string, StreamMethodSupport>();
  /** Whether any handshake of this client's has settled. */
  private hasCompletedHandshake = false;
  private readonly methodSchemaVersions = new Map<string, SchemaVersion>();
  private readonly methodSupportListeners = new Set<() => void>();
  private readonly closedListeners = new Set<() => void>();
  /**
   * Hosts this client has already run the mint flow for, successfully or not.
   * The bound is deliberately blunt, because the failure it prevents is worse than the one it causes.
   */
  private readonly provisionAttemptedHostIds = new Set<string>();
  /**
   * The last `hostCredentialState` each host reported, so a repeat can be told from a transition.
   * Only a host that reported something else in between - `active`, most of all - can arm a second mint, and it can arm at most one per round trip through a working credential.
   */
  private readonly lastHostCredentialState = new Map<
    string,
    HostCredentialState
  >();
  /**
   * Per host: the timer that re-asks after a `pending-elsewhere` wait.
   * Cleared on close so a retry can never outlive the transport that would carry the credential it asks for.
   */
  private readonly provisionRetryTimers = new Map<string, TimerHandle>();
  /** Hosts this client handed a credential to. */
  private readonly handedOffHostIds = new Set<string>();
  /**
   * Minted credentials waiting for a live connection to carry them, keyed by host.
   * The socket that triggered the mint can be gone by the time it resolves - dropping the credential there would waste a mint that has already superseded whatever the host was using.
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
   * Opens a long-lived session bound to a single streaming method.
   * The session connects lazily on construction, re-subscribes on every reconnect using the exact method + params passed here, and tears down only when the caller invokes `close()` or a fatal error arrives from the host.
   */
  subscribe<Method extends keyof Registry & string>(
    method: Method,
    params: ParamsOf<Registry, Method>,
  ): IStreamSession {
    return this.subscribeWithParamsProviderInternal(method, () => params, null);
  }

  subscribeAtVersion<Method extends keyof Registry & string>(
    method: Method,
    schemaVersion: SchemaVersion,
    params: ParamsOf<Registry, Method>,
  ): IStreamSession {
    return this.subscribeWithParamsProviderInternal(
      method,
      () => params,
      schemaVersion,
    );
  }

  /**
   * Opens a stream whose parameters are read immediately before every wire subscribe, including physical reconnects.
   * The provider must be a pure, synchronous read: it may expose an applied resume cursor, but must not create transport or application state as a side effect.
   */
  subscribeWithParamsProvider<Method extends keyof Registry & string>(
    method: Method,
    paramsProvider: () => ParamsOf<Registry, Method>,
  ): IStreamSession {
    return this.subscribeWithParamsProviderInternal(
      method,
      paramsProvider,
      null,
    );
  }

  private subscribeWithParamsProviderInternal<
    Method extends keyof Registry & string,
  >(
    method: Method,
    paramsProvider: () => ParamsOf<Registry, Method>,
    requiredSchemaVersion: SchemaVersion | null,
  ): IStreamSession {
    if (this.closed) {
      // Defense-in-depth (tech-plan D4): a subscribe on an already-closed client is a stale call from a torn-down consumer.
      // Degrading to an inert "no live transport" session, rather than throwing, keeps a stray late subscribe from tearing the renderer down through its error boundary (the crash class this rework removed).
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
      requiredSchemaVersion,
      registry: this.options.registry,
      endpoint: this.options.endpoint,
      bearer: this.options.bearer,
      auth: this.options.auth,
      clock: this.options.clock,
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
      onManifest: (manifest, subscribedMethod, support, handshakeHostId) =>
        this.applyHostManifest(
          manifest,
          subscribedMethod,
          support,
          handshakeHostId,
        ),
      onTransportReconnect: (reconnectingMethod) =>
        this.resetMethodSupport(reconnectingMethod),
      onHostCredentialAck: (hostId, state) => {
        this.handleHostCredentialAck(hostId, state);
      },
      // The passive tap is delivered by the session itself, ahead of the compatibility abort, so it fires on every state-carrying ack rather than only the ones whose method version also happened to negotiate.
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

  /** Tears the client down. */
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

  /** True once `close()` has run. */
  isClosed(): boolean {
    return this.closed;
  }

  /** The `close()` reason tag, or `null` while the client is still open. */
  getClosedReason(): string | null {
    return this.closedReason;
  }

  /**
   * Whether nothing this client owns is currently disconnected (see {@link IHostStreamClient.isReady}).
   * This client is not one connection: it owns N independent per-method sockets, each with its own status and its own reconnect loop, so "ready" can only mean "none of mine is down".
   */
  isReady(): boolean {
    if (this.closed) {
      return false;
    }
    for (const session of this.ownedSessions) {
      if (!session.isOpen()) {
        return false;
      }
    }
    return true;
  }

  /**
   * Subscribes to the client's terminal `close()`.
   * Fires once, synchronously inside `close()`, after every owned session has been torn down.
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
    const own = this.methodSupport.get(method);
    if (own !== undefined) return own;
    return this.seededMethodSupport(method);
  }

  /**
   * What a previous handshake with this same host computed for `method`, for a client that has not handshaken yet.
   * So the seed speaks once, before first contact, and then never again for this client.
   */
  private seededMethodSupport(method: string): StreamMethodSupport {
    if (this.hasCompletedHandshake) return "unknown";
    if (this.options.hostId === null) return "unknown";
    const memoized = getMemoizedStreamMethodSupport(
      this.options.hostId,
      method,
    );
    return memoized === "supported" ? "supported" : "unknown";
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
   * Subscribes to positive evidence that the host endpoint just recovered availability after a period of being unreachable or unresponsive.
   */
  subscribeAvailabilityRecovered(listener: () => void): () => void {
    this.availabilityRecoveredListeners.add(listener);
    return () => {
      this.availabilityRecoveredListeners.delete(listener);
    };
  }

  /** Proactively drops and re-dials every open session immediately. */
  /**
   * Pushes the freshly-rotated bearer onto every open session so each host connection updates its credential lease IN place, with no reconnect.
   * Called by the owner right after a proactive (or reactive) token refresh rotates the lease.
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
   * Runs on every `openAck` from a host that advertised the provisioning capability.
   * deliver a credential minted earlier that never found a live socket; 2.
   */
  private handleHostCredentialAck(
    hostId: string,
    state: HostCredentialState,
  ): void {
    if (this.closed) {
      return;
    }
    // Recorded before anything else can return early, so no path through this method can lose a transition.
    // A state that never reaches the map is indistinguishable from one that never happened, and the very next ack would then read as "unchanged" against a stale predecessor.
    const previousState = this.lastHostCredentialState.get(hostId) ?? null;
    this.lastHostCredentialState.set(hostId, state);
    if (
      previousState !== state &&
      (state === "missing" || state === "needs-reauth")
    ) {
      // A host that had a credential and no longer has a usable one.
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
      // The server rejects a non-UUID hostId outright - such a host cannot hold a delegated credential at all.
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
      // This client has not actually spent an attempt - the app is waiting on a claim or a backoff window, not refusing.
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
    // The access jws the host verifies on handoff is short-lived, so a credential that cannot be delivered inside its own lifetime is dead on arrival.
    // The deadline comes from the server's `expiresIn` rather than from decoding the token: an undecodable token would otherwise yield "no deadline", which is precisely the case that must not be held forever.
    const holdForMs = Math.max(0, outcome.expiresIn * 1_000);
    this.discardPendingProvision(hostId);
    const pending: PendingHostCredentialProvision = {
      hostId,
      token: outcome.token,
      refreshToken: outcome.refreshToken,
      familyId: outcome.familyId,
      provisionedAt: outcome.provisionedAt,
      // Armed rather than checked lazily.
      // A credential whose host never comes back produces no further `openAck`, so a lazy check would never run and the refresh jwe - a 30-day credential - would sit in renderer memory for the life of the process.
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
    // The server-side row lives on as a host session nobody holds; the next successful provisioning of this host supersedes it, so it self-heals rather than needing cleanup here.
    // The attempt marker stays set on purpose: re-minting from this same client would supersede a credential that may since have been delivered by another one.
    this.discardPendingProvision(hostId);
    console.warn(
      `[stream] discarded host credential that expired before delivery (client=${this.instanceId}, host=${hostId})`,
    );
  }

  /** Drops one held credential and disarms its timer. Safe to call twice. */
  /**
   * Re-asks for a credential once the wait a `pending-elsewhere` answer named has passed.
   * Jittered so several transports told to wait on the same claim do not all come back on the same millisecond and re-race the thing the claim exists to serialize.
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
    // Floored, and that floor is load-bearing rather than tidy.
    // A wait can legitimately arrive at or near zero - a claim that expired between the flow's gate and its own clock read - and without a floor the retry fires immediately, is answered `pending-elsewhere` again, and spins.
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
        // We carried a credential to this host ourselves and it has not asked again since.
        return;
      }
      if (this.provisionAttemptedHostIds.has(hostId)) {
        // An `openAck` beat the timer to it and an attempt is already running or spent.
        // Re-asking here would double-mint the very host the claim is protecting.
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

  /** Hands the credential held for `hostId` to the first live session bound to that host. */
  private flushPendingProvision(hostId: string): boolean {
    const pending = this.pendingProvisions.get(hostId);
    if (pending === undefined) {
      return false;
    }
    for (const session of Array.from(this.ownedSessions)) {
      if (session.pushHostCredentialProvision(hostId, pending)) {
        this.discardPendingProvision(hostId);
        // Assumed-adopted, and recorded so the re-arm edge can see it.
        // Nothing acks an adoption: the host confirms only on its next `openAck`, and the socket that just carried the credential last reported `needs-reauth`.
        this.lastHostCredentialState.set(hostId, "active");
        // Recorded separately from the line above because only this fact has
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
    // Guarded per listener: the emission happens inside a session's inbound frame handling (the pong path), so a throwing consumer must not break the socket's message processing or the other listeners.
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
    handshakeHostId: string | null,
  ): void {
    // First contact. From here on this client answers only from its own
    // evidence - see `seededMethodSupport`.
    this.hasCompletedHandshake = true;

    const myManifest = selectConnectionManifestForPeer(
      this.options.registry,
      buildStreamManifest(this.options.registry, CLIENT_SERVED_STREAM_MAJORS),
      theirManifest,
    );
    let changed = false;
    for (const method of Object.keys(myManifest)) {
      if (method === subscribedMethod) {
        changed =
          this.updateMethodSupport(method, subscribedMethodSupport) || changed;
        if (handshakeHostId !== null) {
          recordNegotiatedStreamMethodSupport(
            handshakeHostId,
            method,
            subscribedMethodSupport,
          );
        }
        continue;
      }
      const compat = checkStreamMethodCompatibility(
        this.options.registry,
        myManifest,
        theirManifest,
        "client",
        method,
      );
      const support: "supported" | "unsupported" = compat.ok
        ? "supported"
        : "unsupported";
      changed =
        this.updateMethodSupportFromManifest(method, support) || changed;
      if (handshakeHostId !== null) {
        recordNegotiatedStreamMethodSupport(handshakeHostId, method, support);
      }
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
    // A reconnect may be a new host incarnation, so capability evidence is client-wide and must be re-probed.
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

/** Server requires a UUID hostId (Postgres uuid); reject non-UUIDs before entering the interactive mint. */
/** Floor under any `pending-elsewhere` retry. See {@link WsStreamClient.armProvisionRetry} - a near-zero wait must not become a spin. */
const PROVISION_RETRY_MIN_DELAY_MS = 1_000;
/**
 * Spread over the retry, so several transports told to wait on the same claim do not all come back on one millisecond and re-race what the claim exists to serialize.
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

function incompatiblePinnedStreamDetails(
  method: string,
  requiredVersion: SchemaVersion,
  hostVersion: SchemaVersion | undefined,
): FatalErrorDetails {
  return {
    code: "INCOMPATIBLE",
    reason: `Stream method '${method}' requires schema @${requiredVersion.major}.${requiredVersion.minor}`,
    incompatibleMethods: [
      {
        method,
        clientCanonical: requiredVersion,
        hostCanonical: hostVersion ?? null,
        blocking:
          hostVersion === undefined ? "host-missing-method" : "no-bridge",
      },
    ],
    upgradeGuidance: null,
  };
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
  /** Exact client version to declare; rejects older peers before subscribe. */
  readonly requiredSchemaVersion: SchemaVersion | null;
  readonly registry: Registry;
  readonly endpoint: HostEndpointProvider;
  readonly bearer: BearerSourceProvider;
  readonly auth: StreamAuthRevalidator | null;
  /** See `WsStreamClientOptions.clock`. */
  readonly clock: ServerClockSkewSignal | null;
  readonly evidence: TransportEvidenceReporter;
  readonly webSocketFactory: IStreamWebSocketFactory;
  readonly dialTimeoutMs: number;
  readonly openAckTimeoutMs: number;
  readonly pingIntervalMs: number;
  readonly pongTimeoutMs: number;
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
  /**
   * Already projected to the wire shape by the owning client: every session this client opens sends the same process constant, so it is serialized once rather than per session and per redial.
   */
  readonly clientIdentity: ClientHandshakeIdentity;
  readonly onDispose: () => void;
  readonly onManifest: (
    manifest: ConnectionManifest,
    subscribedMethod: keyof Registry & string,
    support: "supported" | "unsupported",
    /**
     * The host this handshake was with (`openFrameHostId`), or `null` when the open frame named none.
     * Carried so the client can attribute the verdicts it computes to a host rather than to itself - see `stream-method-support-registry.ts`.
     */
    hostId: string | null,
  ) => void;
  readonly onTransportReconnect: (
    reconnectingMethod: keyof Registry & string,
  ) => void;
  /**
   * Reports the connected host's own credential state, once per successful handshake, and only when that host advertised the provisioning capability and actually reported a state.
   */
  readonly onHostCredentialAck: (
    hostId: string,
    state: HostCredentialState,
  ) => void;
  /**
   * Passive observation of the same state, delivered earlier than `onHostCredentialAck` - before this session's application method can abort the handshake on a version mismatch.
   * The credential state is a handshake fact, not a per-method one, so an observer must see it even from a host this build cannot subscribe to.
   */
  readonly onHostCredentialState:
    | ((hostId: string, state: HostCredentialState) => void)
    | null;
  /**
   * Reports positive host-recovery evidence to the owning client - see `WsStreamClient.subscribeAvailabilityRecovered` for the two emission sites and why they exist.
   */
  readonly onAvailabilityRecovered: () => void;
}

/**
 * Slack added to `pingIntervalMs` before a pong gap counts as recovery evidence.
 * Kept well under `pongTimeoutMs - pingIntervalMs` so this detects the stalls the drop cutoff deliberately tolerates.
 */
const PONG_GAP_RECOVERY_SLACK_MS = 5_000;

/**
 * How long a wake liveness probe waits for a pong before declaring the socket dead and re-dialing (see `WsStreamSession.reconnectIfUnresponsive`).
 * This value IS the wake mechanism: a half-open socket fails only by timeout, so nothing else distinguishes "survived the sleep" from "gone".
 */
const WAKE_PROBE_TIMEOUT_MS = 5_000;

/**
 * One open stream.
 * The class is state-machine-flavored - every inbound event runs through a `handleXxx` on the current `phase` so invalid transitions surface as no-ops rather than silent crashes.
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
   * Count of consecutive recoverable drops caused by a host slow-client eviction (close reason prefixed `SLOW_CLIENT`).
   */
  private slowClientReconnectStreak = 0;
  private lastCloseWasSlowClient = false;
  /** At the cap the session goes terminal (the user stays signed in, so recovery is a manual reload). */
  private noProgressUnauthorizedReconnects = 0;
  /**
   * Live subscription to the clock tracker's `skewed → ok` edge while this session is parked, or `null` when it is not parked.
   */
  private clockParkUnsubscribe: (() => void) | null = null;
  private disposed = false;

  private activeSocket: StreamWebSocketLike | null = null;
  private openFrameToken: string | null = null;
  /** The hostId of the endpoint this connection dialed, captured at dial time. */
  private openFrameHostId: string | null = null;
  /**
   * The live session this connection has announced to the selection authority, or `null` while it has none.
   * `/stream` is a live session and the authority's strongest evidence class (invariant 5): it suppresses death accumulation entirely.
   */
  private announcedSession: { hostId: string; sessionId: string } | null = null;
  // Whether the host advertised `credentialUpdate` support in the current connection's openAck.
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
   * `lastPongAt` as it stood before a wake probe rebased it, consumed by the first pong that follows.
   * Without this baseline a wake that bridges a sleep-length gap fired neither recovery signal, and queries stranded in error state before the sleep stayed stranded.
   */
  private preProbePongBaselineAt: number | null = null;
  /** Monotonic count of pongs received; the wake probe's liveness signal. */
  private pongSeq = 0;
  /**
   * When the oldest ping still awaiting a pong was written, or `null` while every ping has been answered.
   * Oldest rather than latest, because a stalled host can leave two pings hanging and the first pong then answers the first of them.
   */
  private oldestUnansweredPingSentAt: number | null = null;
  private backoffTimer: TimerHandle | null = null;
  /**
   * Armed when the subscribe completes; fires after `HEALTHY_SUBSCRIBED_DWELL_MS` of sustained subscription and performs the same loop-counter reset a delivered application frame does.
   * Cleared on every drop/teardown path via `resetForReconnect` / `teardownTimers` - which settles it on elapsed time rather than discarding it, see `subscribedAt`.
   */
  private healthyDwellTimer: TimerHandle | null = null;
  /**
   * Wall-clock stamp of the subscribe that armed `healthyDwellTimer`, or null when nothing is subscribed.
   * The timer alone cannot decide the dwell: a backgrounded renderer throttles `setTimeout` (Chromium clamps hidden pages to >=1/min), so a socket can be genuinely subscribed for minutes with the callback still queued.
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
      // Stream contracts are fire-and-forget: dropping a frame while mid-reconnect is fine - Y.js CRDT convergence absorbs the delta once the socket returns.
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

  /**
   * Whether this session is carrying traffic right now.
   * `"open"` is the only status that qualifies: `"connecting"` has not arrived yet, `"reconnecting"` has lost the socket, and `"closed"` is over.
   */
  isOpen(): boolean {
    return !this.disposed && this.status === "open";
  }

  close(): void {
    if (!this.disposeSession()) {
      return;
    }
    this.teardownTimers();
    this.teardownSocket(1000, "closed-by-caller");
    this.transitionTo("closed", { kind: "caller" });
  }

  /** Proactively drops the current socket and re-dials immediately. */
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
   * Wake recovery that keeps a socket which is still alive.
   * Dropping it re-runs `initialize()` for every stream on a machine whose Wi-Fi has not finished re-associating - so the cloud calls in those opens fail, and (before this layer) each failure became a fatal close.
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
    this.notePingSent(Date.now());
    // Rebase the heartbeat deadline onto the probe we just sent.
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
   * Pushes the current bearer onto this open connection so the host rotates its credential lease in place - no reconnect.
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
   * Hands a minted credential to the host on the other end of this connection.
   * Returns whether the frame actually went out, so the owning client can keep the credential pending and try the next session instead of dropping it.
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
    // A dial is happening, so nothing is parked any more - whether we got here from the recovery edge itself or from a wake `forceReconnect` that ran straight through the park.
    // Idempotent, and the only place besides `disposeSession` that releases the subscription.
    this.clearClockPark();
    // Single-dial guard: a connect must never overwrite a live `activeSocket`.
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

    // A bearer that is already expired cannot open a session - the host is guaranteed to reject it with unauthorized before any stream state is built.
    const auth = this.config.auth;
    const expiresAtMs = readAccessTokenExpiryMs(token);
    if (auth !== null && expiresAtMs !== null && expiresAtMs <= Date.now()) {
      // The expiry read IS A comparison against `Date.now()`, so on a machine whose clock is hours off it says "expired" about a bearer minted seconds ago.
      if (this.parkIfClockSkewed("pre-dial-expiry")) {
        return;
      }
      console.debug(
        `[stream] pre-dial bearer already expired; revalidating before dial method=${String(this.config.method)}`,
      );
      this.transitionTo("reconnecting", null);
      void this.revalidateThenReconnect(
        auth,
        {
          code: "UNAUTHORIZED",
          reason: this.preDialExpiryReason(),
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
        token,
      );
      return;
    }

    const dialUrl = toStreamDialUrl(selected.websocketUrl);
    const socket = this.config.webSocketFactory.create(
      dialUrl,
      // A session is bound to one subscription method for its whole life, so every redial it makes classifies the same way.
      dialPriorityForMethod(this.config.method),
    );
    this.activeSocket = socket;
    this.openFrameToken = token;
    this.openFrameHostId = selected.hostId;
    this.phase = "dialing";
    this.pendingBinaryEnvelope = null;

    // Every handler ignores events from a socket that is no longer the active one.
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
    const manifest = buildStreamManifest(
      this.config.registry,
      CLIENT_SERVED_STREAM_MAJORS,
    );
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

    // Any non-control text frame must be an application stream frame.
    // We require only an envelope with `kind` + `hasBinaryPayload`; typed wrappers above us validate the full contract schema.
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
      // Measure the gap from the pre-probe baseline when a wake probe rebased `lastPongAt`: against the rebased value the probe's own pong reads as a round trip, and a sleep-length outage would emit no recovery at all.
      const answersWakeProbe = this.preProbePongBaselineAt !== null;
      const pongGapMs = now - (this.preProbePongBaselineAt ?? this.lastPongAt);
      // How long the host sat on the oldest ping it had not yet answered.
      const hostAnswerMs =
        this.oldestUnansweredPingSentAt === null
          ? null
          : now - this.oldestUnansweredPingSentAt;
      this.oldestUnansweredPingSentAt = null;
      this.preProbePongBaselineAt = null;
      this.lastPongAt = now;
      // Counted, not timestamped: a wake probe has to know whether a pong arrived, and two pongs inside the same millisecond are indistinguishable by `lastPongAt` alone.
      this.pongSeq += 1;
      const stallLengthGap =
        pongGapMs >= this.config.pingIntervalMs + PONG_GAP_RECOVERY_SLACK_MS;
      const hostAnsweredLate =
        hostAnswerMs !== null && hostAnswerMs >= PONG_GAP_RECOVERY_SLACK_MS;
      if (answersWakeProbe || (stallLengthGap && hostAnsweredLate)) {
        // Two distinct recovery edges share this emission.
        // A big gap without a probe is the other: the host answered after leaving at least one ping hanging (an event-loop stall), again with no socket drop, so the reconnect path's recovery emission never fires for either.
        this.config.onAvailabilityRecovered();
      } else if (stallLengthGap) {
        console.debug(
          `[stream] pong gap of ${pongGapMs}ms was the client's own late ping (host answered in ${hostAnswerMs ?? -1}ms) - no recovery`,
        );
      }
      return;
    }

    if (envelope.kind === "ping") {
      // Host-originated keepalive.
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
    const selectedManifest = selectConnectionManifestForPeer(
      this.config.registry,
      buildStreamManifest(this.config.registry, CLIENT_SERVED_STREAM_MAJORS),
      theirManifest,
    );
    const requiredVersion = this.config.requiredSchemaVersion;
    const theirVersion = theirManifest[this.config.method];
    const pinnedVersionSupported =
      requiredVersion === null ||
      (theirVersion !== undefined &&
        theirVersion.major === requiredVersion.major &&
        theirVersion.minor >= requiredVersion.minor);
    const compat = pinnedVersionSupported
      ? checkStreamMethodCompatibility(
          this.config.registry,
          selectedManifest,
          theirManifest,
          "client",
          this.config.method,
        )
      : {
          ok: false as const,
          details: incompatiblePinnedStreamDetails(
            this.config.method,
            requiredVersion,
            theirVersion,
          ),
        };

    const socket = this.activeSocket;
    if (socket === null) {
      return;
    }

    // Firing this only on the success path made the observer's contract ("every state-carrying ack") false, and left an observer unable to tell a version-skewed host apart from an unreachable one.
    // The mint hook stays at the end of this method, where a live session can actually carry the provision frame - only the passive observation moves.
    this.reportHostCredentialState(hostCredentialState);

    if (!compat.ok) {
      this.config.onManifest(
        theirManifest,
        this.config.method,
        "unsupported",
        this.openFrameHostId,
      );
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
      selectedManifest[this.config.method],
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
    this.config.onManifest(
      theirManifest,
      this.config.method,
      "supported",
      this.openFrameHostId,
    );
    // Read before `transitionTo("open")` overwrites it: a session that was "reconnecting" (dropped socket, or failed dial attempts) has just proved the host is reachable again.
    const recoveredFromUnavailable = this.status === "reconnecting";
    this.phase = "subscribed";
    // The subscription is established: this is a live session, and the
    // authority is told so before any outbound callback below can re-enter.
    this.announceSession();

    // Deliberately not resetting `reconnectAttempt` / `noProgressUnauthorizedReconnects` here.
    this.lastPongAt = Date.now();
    // A fresh handshake supersedes any wake-probe baseline: this path emits its own recovery edge below, and a stale baseline would double-count the outage on the first post-handshake pong.
    // Same for a ping the old socket never answered - the new socket owes nothing for it.
    this.preProbePongBaselineAt = null;
    this.oldestUnansweredPingSentAt = null;
    this.startHeartbeat();
    this.armHealthyDwell();
    this.transitionTo("open", null);
    if (recoveredFromUnavailable) {
      this.config.onAvailabilityRecovered();
    }
    // Reconcile once here so the host still gets the fresh bearer in place.
    if (
      this.supportsCredentialUpdate &&
      this.openFrameToken !== null &&
      this.currentBearerToken() !== this.openFrameToken
    ) {
      this.pushCredentialUpdate();
    }
    // Reported last, once the connection can actually carry a provision frame: the owning client may respond to this synchronously by flushing a credential minted on an earlier, now-dead socket.
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
   * Passive observation of the ack's credential state, split out from the mint hook so it can fire before a compatibility abort.
   * Guarded the same way the mint is (capability + state + host id) and never allowed to throw into the handshake.
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

  /** Forwards a host-published restart tombstone to the selection authority. Silent when the host published none. */
  /** Announces this connection's live session once subscribed. Idempotent so a re-entrant handshake cannot double-count. */
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
      // No dialed identity captured yet, so there is no host to file the tombstone against.
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
    // The host is stating that the outage it is about to cause is deliberate - the one thing this window cannot infer for a restart it did not issue.
    this.reportRestartIntentIfPresent(details);
    // `retryable` marks a transient host-side rejection.
    // The stable subscribe- timeout code is checked too because hosts through 1.1.9 emitted it without the additive flag; a new client must still recover when paired with one of those hosts.
    if (
      details.retryable === true ||
      details.code === STREAM_SUBSCRIBE_TIMEOUT_FATAL_CODE
    ) {
      this.noProgressUnauthorizedReconnects = 0;
      this.teardownSocket(1000, "host-retryable");
      this.onTransportDrop();
      return;
    }
    // Every other fatalError (e.g. `incompatible` or a stream domain code such as `CHAT_INVALID`), and the no-revalidator case, stays terminal exactly as before.
    if (details.code === "UNAUTHORIZED" && this.config.auth !== null) {
      this.handleUnauthorizedFatalError(details, this.config.auth);
      return;
    }
    this.goTerminal(details);
  }

  /**
   * Recovers an `unauthorized` open-frame rejection by revalidating the credential and acting on the normalized outcome: - "rotated" → re-dial; the next open frame carries the fresh bearer.
   */
  private handleUnauthorizedFatalError(
    details: FatalErrorDetails,
    auth: StreamAuthRevalidator,
  ): void {
    if (this.disposed) {
      return;
    }
    // Capture the bearer the host just rejected before teardown nulls it, so after revalidation we can tell whether the next dial would carry a different token (progress) or the same rejected one (no progress).
    const rejectedToken = this.openFrameToken;

    // The host closed this connection.
    // Drop the (now-dead) socket and show "reconnecting" synchronously while we revalidate - do not dispose; the session is recoverable unless revalidation says otherwise.
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
      // Transient (authn unreachable / refresh timed out): the bearer is untouched.
      // This is not a no-progress signal - a wake-time network blip must not count toward the give-up bound - so reset the streak and stay in reconnect backoff; the next cycle revalidates again once connectivity returns.
      this.noProgressUnauthorizedReconnects = 0;
      this.scheduleReconnect();
      return;
    }
    // outcome === "rotated": authn accepts the credential.
    // Bound that loop so we don't hammer authn forever; otherwise reset and re-dial with the fresh token.
    if (rejectedToken !== null && this.currentBearerToken() === rejectedToken) {
      // "authn validates it, the host rejects it" has exactly two causes, and only one of them is this session's fault.
      // If our clock is running fast, that is why - park before the counter moves, so skew can never contribute to the terminal bound.
      if (this.parkIfClockSkewed("no-progress-unauthorized")) {
        return;
      }
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
   * Without the budget a hung refresh (a half-open authn socket after sleep) would strand the session in "reconnecting" forever - `resetForReconnect` deliberately armed no timer.
   */
  private async revalidateWithinBudget(
    auth: StreamAuthRevalidator,
  ): Promise<RevalidateOutcome> {
    let timer: TimerHandle | null = null;
    const budget = new Promise<RevalidateOutcome>((resolve) => {
      timer = setTimeout(() => resolve("network-error"), REVALIDATE_TIMEOUT_MS);
    });
    // Invoke inside a promise chain, never bare - see the twin in `remote-session.ts`.
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

  /**
   * Parks this session if - and only if - the shared tracker reads the local clock as wrong IN the direction that can cause this failure: running ahead, where a valid bearer reads as expired locally.
   */
  private parkIfClockSkewed(trigger: string): boolean {
    if (this.disposed) {
      return false;
    }
    const clock = this.config.clock;
    if (clock === null || !clock.canMakeValidBearersLookExpired()) {
      return false;
    }
    if (this.clockParkUnsubscribe !== null) {
      return true;
    }
    console.warn(
      `[stream] parking session on system-clock skew ` +
        `(trigger=${trigger}, method=${String(this.config.method)}): ` +
        clockSkewStreamReason(clock.currentState()),
    );
    this.teardownTimers();
    this.teardownSocket(1000, "clock-skew-park");
    this.phase = "idle";
    // Subscribe before the status emit, and re-check disposal after it.
    this.clockParkUnsubscribe = clock.subscribeToRecovery(() => {
      this.resumeFromClockPark();
    });
    // "reconnecting", not "closed": the session IS coming back, and consumers already render this state as an interruption rather than a failure.
    this.transitionTo("reconnecting", null);
    if (this.disposed) {
      this.clearClockPark();
    }
    return true;
  }

  /** The `skewed → ok` edge: the clock was corrected, so dial immediately. */
  private resumeFromClockPark(): void {
    if (this.clockParkUnsubscribe === null) {
      return;
    }
    if (this.disposed) {
      // Release, never just bail: a disposed session that returns here still holding its handle stays in the tracker's listener set forever.
      this.clearClockPark();
      return;
    }
    console.info(
      `[stream] system clock corrected; resuming parked session ` +
        `method=${String(this.config.method)}`,
    );
    this.reconnectAttempt = 0;
    this.slowClientReconnectStreak = 0;
    this.resetLoopCounters();
    // `connect()` releases the park subscription itself.
    this.connect();
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
   * Why the pre-dial gate believes the bearer is unusable, for the details a later `goTerminal` would surface.
   * Replaces the fabricated "client resumed from suspension" copy this gate used to assert unconditionally.
   */
  private preDialExpiryReason(): string {
    const clock = this.config.clock;
    if (clock !== null && clock.canMakeValidBearersLookExpired()) {
      return clockSkewStreamReason(clock.currentState());
    }
    return "Bearer expired before dial (local token expiry read)";
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
   * Terminal teardown for a fatal error: dispose the session, clear timers, close the socket, and surface the close reason.
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
    // A host slow-client eviction is a recoverable close (no fatalError frame) whose reason is prefixed `SLOW_CLIENT`.
    // Flag it so the reconnect backoff escalates across repeated evictions instead of retrying at the fixed initial delay.
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
        return;
      }
      this.notePingSent(now);
    }, this.config.pingIntervalMs);
  }

  /** Records a ping on the wire; only the oldest unanswered one is kept. */
  private notePingSent(at: number): void {
    if (this.oldestUnansweredPingSentAt === null) {
      this.oldestUnansweredPingSentAt = at;
    }
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
    // Escalate backoff only for consecutive slow-client evictions; any other drop resets the streak so normal reconnects are unaffected.
    // The flag is set by `handleSocketClose` and consumed here (every other drop path leaves it false).
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
   * Arms the sustained-subscription reset: staying subscribed past the dwell is health even when the stream has nothing to say, so the loop counters reset exactly as a delivered application frame would reset them.
   * The ack-then-fail loop this file's counters bound fails in milliseconds and can never dwell this long.
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
   * Disarms the dwell and settles it on elapsed time: if the socket really did stay subscribed past `HEALTHY_SUBSCRIBED_DWELL_MS`, the reset is applied here even though the timer never got to run.
   * A timer is not a clock.
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
   * Clears the per-connect socket + timers and transitions to "reconnecting" without scheduling the redial.
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
    // For all other drops the streak is 0 and this is exactly `backoffFor(reconnectAttempt, ...)`.
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
    // Same ordering rule as the drop path: retract while the announced host is still known.
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
    // Every server frame proves the socket can deliver work, so it resets the transport backoff.
    // Only a snapshot proves an epic stream completed its establishing path: `earlyMeta`, permission changes, and incremental frames can arrive before the host has initialized the cloud-backed replica.
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
    // The single choke point for both `close()` and `goTerminal()`.
    // A parked session's tracker subscription is the one handle that is not a timer, so `teardownTimers` cannot reach it: left attached it would re-dial a disposed session the next time somebody's clock came right.
    this.clearClockPark();
    this.config.onDispose();
    return true;
  }
}

interface PreparedStreamSubscribeRequest {
  readonly onWireVersion: SchemaVersion;
  readonly onWirePayload: unknown;
}

/**
 * Computes what the `subscribe` control frame should actually declare on the wire - the streaming analog of `ws-rpc-client.ts`'s `prepareRequestPayload`.
 * `checkStreamMethodCompatibility` already proved `mine`/`theirs` are bridgeable before this runs.
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
 * Cap on consecutive `unauthorized` reconnects where revalidation keeps returning a current credential the host keeps rejecting (no token rotation making progress).
 * After this many no-progress cycles the session goes terminal instead of looping forever - a rare clock-skew / config-mismatch edge whose recovery is a manual reload (the user is still signed in).
 */
const MAX_NO_PROGRESS_UNAUTHORIZED_RECONNECTS = 3;
/**
 * How long a connection must stay subscribed before that alone resets the reconnect loop counters (see `armHealthyDwell`).
 * Long enough that the subscribe-ack-then-fatal loop (which fails in milliseconds) can never reach it; short enough that one long-lived healthy connection between two ordinary drops always does.
 */
const HEALTHY_SUBSCRIBED_DWELL_MS = 10_000;

/**
 * Upper bound on how long an `unauthorized` revalidation may run before the stream gives up waiting and treats it as a transient `network-error`.
 * Caps the "reconnecting" window so a hung authn refresh (a half-open socket after sleep) can never strand the session - the normal reconnect backoff then retries.
 */
const REVALIDATE_TIMEOUT_MS = 10_000;

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Marker prefix the host puts on the WebSocket close reason when it evicts a slow client (a recoverable drop, not a fatalError).
 */
const SLOW_CLIENT_CLOSE_REASON_PREFIX = "SLOW_CLIENT";

/**
 * True when a recoverable close came from a host slow-client eviction.
 * Detecting it lets the reconnect backoff escalate for a persistently slow renderer without changing any other close path.
 */
function isSlowClientCloseReason(reason: string): boolean {
  return reason.startsWith(SLOW_CLIENT_CLOSE_REASON_PREFIX);
}

/**
 * Rewrite a host directory entry's `websocketUrl` to the `/stream` path.
 * `WsStreamClient` always needs to land on `/stream`, so the stream transport rewrites the path suffix locally rather than forcing every directory producer to carry a second field.
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
