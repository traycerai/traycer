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
    return this.session.sendUnary(
      method,
      params,
      authority.abortSignal,
      null,
      // No caller-specific budget: the session's shared
      // `UNARY_RESPONSE_TIMEOUT_MS` applies, as it always has.
      undefined,
    );
  }

  /**
   * Applies the caller's response budget to the remote unary timer.
   *
   * This used to drop the argument on the floor, on the reasoning that the mux
   * session owns its own response-wait semantics. It does own the resume and
   * backoff loop, but `sendUnary` still arms a per-request timer, so the budget
   * was silently the shared 30s default no matter what a caller asked for -
   * while the local transport (`WsRpcClient`) honored it. A method sized for a
   * slow host-side probe (`host.getRateLimitUsage` allows ~180s, since a
   * same-profile custodian can hold the per-config-dir gate for minutes) was
   * therefore cut off at 30s whenever the surface targeted a REMOTE host, and
   * the two transports disagreed about what the caller had asked for.
   */
  requestWithResponseTimeout<Method extends keyof RpcRegistry & string>(
    method: Method,
    params: RequestOfMethod<RpcRegistry, Method>,
    responseTimeoutMs: number,
    authority: HostRequestAuthority,
  ): Promise<ResponseOfMethod<RpcRegistry, Method>> {
    return this.session.sendUnary(
      method,
      params,
      authority.abortSignal,
      null,
      responseTimeoutMs,
    );
  }
}
