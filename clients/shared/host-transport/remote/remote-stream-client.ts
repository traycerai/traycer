import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import type { VersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { IHostStreamClient } from "../host-stream-client";
import type { IStreamSession } from "../i-stream-session";
import type { ParamsOf } from "../ws-stream-client";
import type { IRemoteSession } from "./remote-session";

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

  close(): void {
    this.session.close();
  }

  /**
   * No-op (see {@link IHostStreamClient.reconnectAll}): a remote session's
   * attach endpoint is the relay's fixed WS URL, never a per-host address that
   * moves on respawn, so there is nothing to nudge. The session's own
   * resume/backoff loop (Architecture §3) already owns reconnection.
   */
  reconnectAll(_reason: string): void {}
}
