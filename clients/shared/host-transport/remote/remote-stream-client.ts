import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import type {
  SchemaVersion,
  VersionedStreamRpcRegistry,
} from "@traycer/protocol/framework/versioned-stream-rpc";
import type {
  IHostStreamClient,
  ReconnectAllOptions,
} from "../host-stream-client";
import type { IStreamSession } from "../i-stream-session";
import type { ParamsOf, StreamMethodSupport } from "../ws-stream-client";
import type { IRemoteSession } from "./remote-session";

/** Monotonic source for `RemoteStreamClient.instanceId` (log correlation). */
let nextRemoteStreamClientId = 0;

/**
 * `IHostStreamClient` over the persistent remote session — the streaming
 * sibling of `WsStreamClient`. Because the typed wrappers depend only on
 * `IStreamClient` (transport-seam spike extraction), this is a drop-in for the
 * local client: `TerminalStreamClient`, `ChatStreamClient`, … run unchanged
 * over the mux. The lifecycle superset (`close`/`isClosed`/
 * `notifyBearerRotated`/`reconnectAll`) is what lets the app-wide/durable
 * stream provider tree select this transport by `kind` with no wrapper change
 * (T14).
 */
export class RemoteStreamClient<
  RpcRegistry extends VersionedRpcRegistry,
  StreamRegistry extends VersionedStreamRpcRegistry,
> implements IHostStreamClient<StreamRegistry> {
  private readonly session: IRemoteSession<RpcRegistry, StreamRegistry>;
  readonly instanceId = `remote-stream-client-${nextRemoteStreamClientId++}`;

  constructor(session: IRemoteSession<RpcRegistry, StreamRegistry>) {
    this.session = session;
  }

  subscribe<Method extends keyof StreamRegistry & string>(
    method: Method,
    params: ParamsOf<StreamRegistry, Method>,
  ): IStreamSession {
    return this.subscribeWithParamsProvider(method, () => params);
  }

  subscribeWithParamsProvider<Method extends keyof StreamRegistry & string>(
    method: Method,
    paramsProvider: () => ParamsOf<StreamRegistry, Method>,
  ): IStreamSession {
    return this.session.subscribeWithParamsProvider(method, paramsProvider);
  }

  /** Pushes a rotated bearer in place (no reconnect) if the host supports it. */
  notifyBearerRotated(): void {
    this.session.notifyBearerRotated();
  }

  isClosed(): boolean {
    return this.session.isClosed();
  }

  /** Always `null`: the mux session exposes no closed-reason to report. */
  getClosedReason(): string | null {
    return null;
  }

  /**
   * Fires when the shared session reaches terminal close - a session-level
   * fatal (e.g. `INCOMPATIBLE`, or a bounded/rejected `UNAUTHORIZED`
   * recovery), or the keep-warm linger expiring after the last consumer's
   * release closing it for real. This is
   * what lets the owner-side liveness guard rebuild the transport instead of
   * serving a permanently-dead client (`start()` no-ops once the session is
   * closed). NOT retro-fired for an already-closed session - callers pair
   * this with `isClosed()`, exactly as with `WsStreamClient.onClosed`.
   */
  onClosed(listener: () => void): () => void {
    return this.session.onClosed(listener);
  }

  close(_reason: string): void {
    this.session.close();
  }

  /**
   * Reconnects THIS client's session and no other (see
   * {@link IRemoteSession.wake} / {@link IRemoteSession.forceReconnect}).
   *
   * There is no endpoint to re-resolve - a remote session's attach address is
   * the relay's fixed WS URL, never a per-host one that moves on respawn - but
   * `probeFirst` still names two genuinely different demands. Probe-first
   * forwards to the session's own wake: poke the socket, re-dial only on a
   * failed verdict, pull a stale backoff wait forward. Forced
   * (`probeFirst: false`) is a caller declaring the current socket not worth
   * probing - a person tapping Retry now, an endpoint-change sweep - and it
   * drops the socket and re-dials with no backoff delay. It used to be
   * flattened into `wake`, which made Retry-now a spectator to the very 10s
   * probe window the person was trying to cut short.
   *
   * Scope is the whole point, and it is why this is NOT the cache-wide sweep.
   * The caller here is asking about a connection it can name - a user tapping
   * Retry on a banner that told them about ONE session - and a verdict and its
   * remedy must share scope. A button that reports session A and then dials A,
   * B and C is lying about at least two of them. Runtime resume is a different
   * question with a different answer (`wakeHeldRemoteSessions`): there the
   * evidence is about the whole process, so the whole cache is in scope.
   *
   * Production builds this over an ACQUIRED view, so a client whose consumer
   * has released inherits that view's ownership guard and this becomes a no-op
   * rather than hurrying a session nobody holds.
   */
  reconnectAll(reason: string, options: ReconnectAllOptions): void {
    if (options.probeFirst) {
      this.session.wake(reason, options.wakeProbe);
    } else {
      this.session.forceReconnect(reason);
    }
  }

  /**
   * Whether the session backing THIS client is carrying traffic right now
   * (see {@link IRemoteSession.isReady}) - full attach, every live stream
   * restored, and the host still attached at the relay.
   *
   * Exact by construction: one client, one shared session, no lookup by host.
   * A ready one-shot session or a lingering keep-warm one for the same host
   * cannot answer here, which is the whole reason a surface speaking for one
   * connection must ask its client rather than scan the cache.
   */
  isReady(): boolean {
    return this.session.isReady();
  }

  /**
   * Bridges the session's ready-boundary transition (full attach + every
   * live stream restored; see
   * `RemoteSession.subscribeAvailabilityRecovered`) to availability-recovered
   * listeners - the same "endpoint recovered" evidence `WsStreamClient`
   * surfaces when a session re-opens after a drop, PLUS the clean first open
   * (a remote session's first dial races the queries that created it; see
   * the session contract for why). This is what un-strands errored
   * host-scoped queries for a tab bound to a NON-active remote host, whose
   * only recovery evidence is its own transport (the registry-liveness +
   * relay-resume path only covers the active host).
   */
  subscribeAvailabilityRecovered(listener: () => void): () => void {
    return this.session.subscribeAvailabilityRecovered(listener);
  }

  /**
   * Always `"unknown"` (see {@link IHostStreamClient.getMethodSupport}): the
   * mux session resolves an incompatible method as a fatal error on that
   * stream's subscribe attempt, not a queryable pre-check, so there is no
   * learned-support cache to report here yet.
   */
  getMethodSupport<Method extends keyof StreamRegistry & string>(
    _method: Method,
  ): StreamMethodSupport {
    return "unknown";
  }

  /** No-op: {@link getMethodSupport} never changes, so nothing to notify. */
  subscribeMethodSupport(_listener: () => void): () => void {
    return () => {};
  }

  /**
   * Always `null` (see {@link IHostStreamClient.getMethodSchemaVersion}): the
   * mux session has no learned-schema-version cache to report, mirroring
   * {@link getMethodSupport}'s degrade-quietly treatment for remote hosts.
   */
  getMethodSchemaVersion<Method extends keyof StreamRegistry & string>(
    _method: Method,
  ): SchemaVersion | null {
    return null;
  }
}
