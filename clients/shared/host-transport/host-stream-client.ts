import type {
  SchemaVersion,
  VersionedStreamRpcRegistry,
} from "@traycer/protocol/framework/versioned-stream-rpc";
import type { IStreamClient } from "./i-stream-client";
import type { StreamMethodSupport } from "./ws-stream-client";

/**
 * `WsStreamClient` and `RemoteStreamClient` both implement this unchanged (structural typing - `WsStreamClient` predates this interface and is not declared against it, but its method signatures already match).
 */
/**
 * Caller-supplied sizing for the probe a probe-first reconnect runs, for the one caller that holds better evidence than the transport's default: a mobile resume that measured how long the runtime was backgrounded.
 */
export type WakeProbeTuning = {
  /** Deadline for the probe's answer, in ms. */
  readonly timeoutMs: number;
  /**
   * When the probe proves the socket dead, redial with NO backoff delay instead of entering the ladder at its current rung.
   * Earned only by a probe a user is actively waiting on (a foregrounded app): the person is already looking at the screen, and sleeping out a rung after proving the socket dead is pure added outage.
   */
  readonly immediateRedialOnFailure: boolean;
};

export type ReconnectAllOptions = {
  /** Keep sessions whose socket answers a liveness ping. */
  readonly probeFirst: boolean;
  /**
   * Probe sizing when `probeFirst` is true; `null` means the transport's
   * default wake probe. Meaningless (and ignored) when `probeFirst` is false.
   */
  readonly wakeProbe: WakeProbeTuning | null;
};

export interface IHostStreamClient<
  Registry extends VersionedStreamRpcRegistry,
> extends IStreamClient<Registry> {
  // `subscribeWithParamsProvider` is inherited from `IStreamClient`: it is a subscribe-shaped capability, and the typed wrappers that use it depend on that narrower seam.
  close(reason: string): void;
  isClosed(): boolean;
  /** The reason recorded at close, or `null` while still open. */
  getClosedReason(): string | null;
  /**
   * Subscribes to the client's terminal `close()`; returns an unsubscribe.
   * Not retro-fired for an already-closed client - late attachers must check `isClosed()` first (the owner-side liveness guard does both).
   */
  onClosed(listener: () => void): () => void;
  /**
   * Stable per-instance tag carried in lifecycle log lines and used as the identity key for per-client caches (e.g. the git-status shared subscription map).
   */
  readonly instanceId: string;
  notifyBearerRotated(): void;
  /**
   * Nudges every open session to reconnect immediately (skip backoff) - used when a local host respawns at a new `websocketUrl` under the same identity, and by the OS/app wake path (`subscribeWakeSignals`).
   * The current socket, alive or not, points at the wrong place; it must be dropped.
   */
  reconnectAll(reason: string, options: ReconnectAllOptions): void;
  /**
   * Whether this client is currently carrying traffic - the readiness of the session(s) IT owns, never a lookup by host.
   */
  isReady(): boolean;
  /** Learned per-method compatibility with the connected host, keyed by stream method name. */
  getMethodSupport<Method extends keyof Registry & string>(
    method: Method,
  ): StreamMethodSupport;
  /** Notified whenever any method's `getMethodSupport` result changes. */
  subscribeMethodSupport(listener: () => void): () => void;
  /** Learned wire schema version for the connected host, keyed by stream method name. */
  getMethodSchemaVersion<Method extends keyof Registry & string>(
    method: Method,
  ): SchemaVersion | null;
  /**
   * Positive host-recovery evidence: fires when a session (re)opens after a drop or a stall-length silent gap - see `WsStreamClient.subscribeAvailabilityRecovered` for the two emission points.
   */
  subscribeAvailabilityRecovered(listener: () => void): () => void;
}

/**
 * The slice of a stream client that reports negotiated per-method support - all a capability reader needs.
 * A session store can hand this to its consumers so they read the bound host's capabilities off the very client their subscription rides on, without being handed the whole transport.
 */
export type StreamMethodSupportSource<
  Registry extends VersionedStreamRpcRegistry,
> = Pick<
  IHostStreamClient<Registry>,
  "getMethodSupport" | "subscribeMethodSupport"
>;
