import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import type { VersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import type {
  HostRequestAuthority,
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
 * auto-retry. `RemoteSession.sendUnary` AWAITS a session that is still on its
 * way to ready and throws a `RetryableTransportError` only once the attach
 * attempt it was riding has failed (still provably pre-send), so the existing
 * `createRetryingMessenger` wrapper retries that case on backoff exactly as it
 * does for a local dial failure — and nothing else. Before that await existed,
 * this messenger's callers reliably burned their whole retry budget inside the
 * first dial of a session they had themselves just created; read
 * `sendUnary`'s docblock before reasoning about the class of a failure here.
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
    authority: HostRequestAuthority,
  ): Promise<ResponseOfMethod<RpcRegistry, Method>> {
    // The authority's abort signal is forwarded, not dropped. It is the only
    // way a cancelled read can escape a session that is still dialing now
    // that `sendUnary` parks instead of failing fast - and the local
    // transport has always honored it (`WsRpcClient`), so dropping it here
    // made the two transports disagree about what cancellation means. The
    // endpoint/bearer halves of the authority stay unused on purpose: this
    // session owns its own relay endpoint and presents its own in-channel
    // bearer.
    return this.session.sendUnary(method, params, authority.abortSignal);
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
    authority: HostRequestAuthority,
  ): Promise<ResponseOfMethod<RpcRegistry, Method>> {
    return this.session.sendUnary(method, params, authority.abortSignal);
  }
}
