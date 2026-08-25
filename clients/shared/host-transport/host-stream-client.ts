import type {
  SchemaVersion,
  VersionedStreamRpcRegistry,
} from "@traycer/protocol/framework/versioned-stream-rpc";
import type { IStreamClient } from "./i-stream-client";
import type { StreamMethodSupport } from "./ws-stream-client";

/**
 * The stream-client lifecycle surface the app-wide/durable provider tree
 * actually consumes, beyond the subscribe-only `IStreamClient` seam: closing,
 * detecting closed, pushing a rotated bearer in place, and nudging every open
 * session to reconnect immediately.
 *
 * `WsStreamClient` and `RemoteStreamClient` both implement this unchanged
 * (structural typing - `WsStreamClient` predates this interface and is not
 * declared against it, but its method signatures already match). Typing the
 * provider tree's ownership layer (`buildHostStreamClient` and its consumers)
 * against this interface instead of the concrete `WsStreamClient` is what lets
 * it select between the two by `HostDirectoryEntry.kind` (T14).
 */
/** See {@link IHostStreamClient.reconnectAll}. */
export type ReconnectAllOptions = {
  /** Keep sessions whose socket answers a liveness ping. */
  readonly probeFirst: boolean;
};

export interface IHostStreamClient<
  Registry extends VersionedStreamRpcRegistry,
> extends IStreamClient<Registry> {
  // `subscribeWithParamsProvider` is inherited from `IStreamClient`: it is a
  // subscribe-shaped capability, and the typed wrappers that use it depend on
  // that narrower seam.
  close(reason: string): void;
  isClosed(): boolean;
  /** The reason recorded at close, or `null` while still open. */
  getClosedReason(): string | null;
  /**
   * Subscribes to the client's terminal `close()`; returns an unsubscribe.
   * Fires once when the client closes. NOT retro-fired for an already-closed
   * client - late attachers must check `isClosed()` first (the owner-side
   * liveness guard does both).
   */
  onClosed(listener: () => void): () => void;
  /**
   * Stable per-instance tag carried in lifecycle log lines and used as the
   * identity key for per-client caches (e.g. the git-status shared
   * subscription map).
   */
  readonly instanceId: string;
  notifyBearerRotated(): void;
  /**
   * Nudges every open session to reconnect immediately (skip backoff) - used
   * when a LOCAL host respawns at a new `websocketUrl` under the same
   * identity, and by the OS/app wake path (`subscribeWakeSignals`). A remote
   * session has no equivalent "same identity, new address" transition (the
   * relay attach endpoint is fixed, per-fleet, not per-host), so
   * `RemoteStreamClient` cannot re-resolve anything; it forwards to the
   * session's own wake - pull a pending redial forward, and probe a socket
   * whose keepalive interval may have been frozen along with the runtime.
   *
   * `options.probeFirst` distinguishes the two callers, and getting it wrong is
   * a real regression in either direction:
   *
   *  - `false` - the address CHANGED (host respawn). The current socket, alive
   *    or not, points at the wrong place; it must be dropped.
   *  - `true` - an OS wake. Most sockets survive a lid-open, and dropping a
   *    live one re-runs every stream's open against a machine whose network has
   *    not finished coming back. Probe each session and re-dial only the dead.
   */
  reconnectAll(reason: string, options: ReconnectAllOptions): void;
  /**
   * Whether this client is currently carrying traffic - the readiness of the
   * session(s) IT owns, never a lookup by host. A surface that speaks for one
   * connection must ask the client it speaks for: a per-host readiness scan can
   * answer off an unrelated session (a completed one-shot, a keep-warm entry
   * nobody holds) and hide the very outage the surface exists to report.
   *
   * The two transports own one connection and many respectively, so the shape
   * of "ready" differs and both are honest about their own: `RemoteStreamClient`
   * answers for its single shared mux session, `WsStreamClient` answers "none of
   * the sessions I own is disconnected" - vacuously true when it owns none,
   * since a client that has not subscribed to anything is not evidence of an
   * outage.
   */
  isReady(): boolean;
  /**
   * Learned per-method compatibility with the connected host, keyed by
   * stream method name. `"unknown"` until a subscribe attempt resolves.
   * `RemoteStreamClient` always reports `"unknown"` today - the mux session
   * surfaces an incompatible method as a fatal error on that one stream
   * rather than a cacheable pre-check, so remote hosts don't yet get the
   * degrade-quietly treatment `WsStreamClient` provides for local hosts.
   */
  getMethodSupport<Method extends keyof Registry & string>(
    method: Method,
  ): StreamMethodSupport;
  /** Notified whenever any method's `getMethodSupport` result changes. */
  subscribeMethodSupport(listener: () => void): () => void;
  /**
   * Learned wire schema version for the connected host, keyed by stream
   * method name. `null` until a subscribe attempt resolves - mirrors
   * `getMethodSupport`'s cacheable pre-check.
   */
  getMethodSchemaVersion<Method extends keyof Registry & string>(
    method: Method,
  ): SchemaVersion | null;
  /**
   * Positive host-recovery evidence: fires when a session (re)opens after a
   * drop or a stall-length silent gap - see
   * `WsStreamClient.subscribeAvailabilityRecovered` for the two emission
   * points. Consumers drive `HostClient.notifyHostAvailabilityRecovered(hostId)`
   * off it so stranded unary queries refetch. `RemoteStreamClient` delegates to
   * `RemoteSession.subscribeAvailabilityRecovered`, which fires at EVERY
   * ready boundary - including the clean first open, because a remote
   * session's first dial races (and strands) the very queries that created
   * it.
   */
  subscribeAvailabilityRecovered(listener: () => void): () => void;
}

/**
 * The slice of a stream client that reports negotiated per-method support -
 * all a capability reader needs. A session store can hand this to its
 * consumers so they read the BOUND host's capabilities off the very client
 * their subscription rides on, without being handed the whole transport.
 */
export type StreamMethodSupportSource<
  Registry extends VersionedStreamRpcRegistry,
> = Pick<
  IHostStreamClient<Registry>,
  "getMethodSupport" | "subscribeMethodSupport"
>;
