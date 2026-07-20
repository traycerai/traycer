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
export interface IHostStreamClient<
  Registry extends VersionedStreamRpcRegistry,
> extends IStreamClient<Registry> {
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
   * identity. A remote session has no equivalent "same identity, new address"
   * transition (the relay attach endpoint is fixed, per-fleet, not per-host),
   * so `RemoteStreamClient` implements this as a no-op; its own resume/backoff
   * machinery already owns reconnection.
   */
  reconnectAll(reason: string): void;
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
}
