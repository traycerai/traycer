import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import type { VersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import type {
  IHostMessenger,
  RequestOfMethod,
  ResponseOfMethod,
} from "../host-messenger";
import type { IRemoteSession } from "./remote-session";

/**
 * `IHostMessenger` over the persistent remote session — the unary sibling of
 * `WsRpcClient`, selected by `HostDirectoryEntry.kind === "remote"`.
 *
 * The unary policy is exact local parity (audit C3): single-flight, no post-send
 * auto-retry. `RemoteSession.sendUnary` throws a `RetryableTransportError` only
 * while the session is not yet ready (provably pre-send), so the existing
 * `createRetryingMessenger` wrapper retries that case on backoff exactly as it
 * does for a local dial failure — and nothing else.
 */
export class RemoteHostMessenger<
  RpcRegistry extends VersionedRpcRegistry,
  StreamRegistry extends VersionedStreamRpcRegistry,
> implements IHostMessenger<RpcRegistry> {
  private readonly session: IRemoteSession<RpcRegistry, StreamRegistry>;

  constructor(session: IRemoteSession<RpcRegistry, StreamRegistry>) {
    this.session = session;
  }

  request<Method extends keyof RpcRegistry & string>(
    method: Method,
    params: RequestOfMethod<RpcRegistry, Method>,
  ): Promise<ResponseOfMethod<RpcRegistry, Method>> {
    return this.session.sendUnary(method, params);
  }

  /**
   * The remote mux session owns its own response-wait semantics (its
   * resume/backoff loop, not a per-frame timer), so the extended timeout is a
   * no-op here - the call delegates to the same single-flight `sendUnary` as
   * {@link request}. Present for `IHostMessenger` parity.
   */
  requestWithResponseTimeout<Method extends keyof RpcRegistry & string>(
    method: Method,
    params: RequestOfMethod<RpcRegistry, Method>,
    _responseTimeoutMs: number,
  ): Promise<ResponseOfMethod<RpcRegistry, Method>> {
    return this.session.sendUnary(method, params);
  }
}
