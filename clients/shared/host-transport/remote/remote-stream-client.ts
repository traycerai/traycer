import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import type {
  SchemaVersion,
  VersionedStreamRpcRegistry,
} from "@traycer/protocol/framework/versioned-stream-rpc";
import type { IHostStreamClient } from "../host-stream-client";
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
    return this.session.subscribe(method, params);
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
   * No-op close subscription: a remote session self-heals via its own
   * resume/backoff loop (Architecture §3) rather than closing underneath the
   * provider, so there is no underneath-close to notify. The owner-side
   * liveness guard's `isClosed()` re-check still covers a terminal close.
   */
  onClosed(_listener: () => void): () => void {
    return () => {};
  }

  close(_reason: string): void {
    this.session.close();
  }

  /**
   * No-op (see {@link IHostStreamClient.reconnectAll}): a remote session's
   * attach endpoint is the relay's fixed WS URL, never a per-host address that
   * moves on respawn, so there is nothing to nudge. The session's own
   * resume/backoff loop (Architecture §3) already owns reconnection.
   */
  reconnectAll(_reason: string): void {}

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
