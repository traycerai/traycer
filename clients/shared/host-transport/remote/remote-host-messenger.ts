import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import type { VersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import type {
  HostRequestOptions,
  IHostMessenger,
  RequestOfMethod,
  ResponseOfMethod,
} from "../host-messenger";
import type { IRemoteSession } from "./remote-session";

/**
 * `IHostMessenger` over the persistent remote session - the unary sibling of `WsRpcClient`, selected by `HostDirectoryEntry.kind === "remote"`.
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
    options: HostRequestOptions,
  ): Promise<ResponseOfMethod<RpcRegistry, Method>> {
    // The authority's abort signal is forwarded, not dropped.
    return this.session.sendUnary(
      method,
      params,
      options.idempotencyKey,
      options.authority.abortSignal,
      // No caller-specific budget: the session's shared
      // `UNARY_RESPONSE_TIMEOUT_MS` applies, as it always has.
      undefined,
      options.replayMustBeKeyed,
    );
  }

  /**
   * Applies the caller's response budget to the remote unary timer.
   * This used to drop the argument on the floor, on the reasoning that the mux session owns its own response-wait semantics.
   */
  requestWithResponseTimeout<Method extends keyof RpcRegistry & string>(
    method: Method,
    params: RequestOfMethod<RpcRegistry, Method>,
    responseTimeoutMs: number,
    options: HostRequestOptions,
  ): Promise<ResponseOfMethod<RpcRegistry, Method>> {
    return this.session.sendUnary(
      method,
      params,
      options.idempotencyKey,
      options.authority.abortSignal,
      responseTimeoutMs,
      options.replayMustBeKeyed,
    );
  }
}
