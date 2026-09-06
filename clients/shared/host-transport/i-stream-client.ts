import type { SchemaVersion } from "@traycer/protocol/framework/index";
import type { VersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { IStreamSession } from "./i-stream-session";
import type { ParamsOf } from "./ws-stream-client";

/**
 * What `subscribeWithParamsProvider` re-reads before every wire subscribe.
 *
 * The argument is the version the params are about to be DECLARED at, so a
 * method served on more than one major can shape its open request for the
 * major that was actually negotiated - which is knowable only here, after the
 * open-ack selection and before the subscribe frame is written. A provider
 * that serves one line ignores it, so widening this cost existing providers
 * nothing.
 *
 * `null` means the transport cannot report a version: it is the runtime
 * worker's stream proxy, which invokes the provider on the WORKER side and
 * pushes the value across, where the negotiation is main's to observe. A
 * provider that gets `null` must answer with what it would send before any
 * handshake - its newest line - and never guess an older one; the proxy
 * carries only single-major epic methods, so no multi-major consumer is
 * reached through it.
 */
export type StreamParamsProvider<
  Registry extends VersionedStreamRpcRegistry,
  Method extends keyof Registry & string,
> = (onWireVersion: SchemaVersion | null) => ParamsOf<Registry, Method>;

/**
 * Subscribe-only seam over a streaming transport (transport-seam spike).
 *
 * The typed stream wrappers (`TerminalStreamClient`, `ChatStreamClient`, …) only
 * ever call `subscribe(...)`, but they used to type their dependency as the
 * concrete `WsStreamClient`, whose private members make a different producer
 * class non-substitutable (nominal typing on privates). Depending on this
 * interface instead lets a remote mux transport (`RemoteStreamClient`) stand in
 * for the local `WsStreamClient` with no wrapper change — the entire
 * "upper layers unchanged" delta the spike proved.
 *
 * `WsStreamClient` implements it unchanged, so every existing caller keeps
 * compiling.
 */
export interface IStreamClient<Registry extends VersionedStreamRpcRegistry> {
  /**
   * Opens a long-lived session bound to a single streaming method. The returned
   * `IStreamSession` re-declares the same method on every reconnect and tears
   * down only on `close()` or a fatal error.
   */
  subscribe<Method extends keyof Registry & string>(
    method: Method,
    params: ParamsOf<Registry, Method>,
  ): IStreamSession;

  /**
   * Opens a stream pinned to an exact client schema version. The peer must
   * advertise that version or a newer minor on the same major; otherwise the
   * session closes through the ordinary pre-subscribe unsupported path.
   *
   * This is for requests whose newer fields carry safety semantics and must
   * never be projected through an older additive-minor schema.
   */
  subscribeAtVersion?<Method extends keyof Registry & string>(
    method: Method,
    schemaVersion: SchemaVersion,
    params: ParamsOf<Registry, Method>,
  ): IStreamSession;

  /**
   * Opens a session whose params are re-read immediately before EVERY wire
   * subscribe, including the re-declare that follows a physical reconnect —
   * rather than freezing whatever was current when the session was created.
   *
   * On this seam rather than only on `IHostStreamClient` because it is a
   * subscribe-shaped capability, and the wrappers that need it (an epic
   * offering the root state it already holds, and any future resume cursor)
   * depend on this narrow interface. Leaving it upstairs would make a wrapper
   * that offers reattach state non-substitutable over a remote transport —
   * exactly the substitutability this seam exists to provide, and exactly the
   * transport that needs the feature most.
   *
   * The provider must be a pure, synchronous read: it may report applied
   * client state, but must not create transport or application state as a
   * side effect. `WsStreamClient` and `RemoteStreamClient` both implement it,
   * and both re-invoke it on reconnect.
   *
   * The provider is handed the version it is about to be declared at - see
   * {@link StreamParamsProvider}.
   */
  subscribeWithParamsProvider<Method extends keyof Registry & string>(
    method: Method,
    paramsProvider: StreamParamsProvider<Registry, Method>,
  ): IStreamSession;

  /**
   * The schema version the peer negotiated for `method`, or `null` when it is
   * not (yet) known. Wrappers use it to gate additive minor-line features
   * (e.g. `ChatStreamClient.sameTurnSteeringProtocolSupported`).
   *
   * Part of this seam rather than the concrete `WsStreamClient` because those
   * wrappers depend on the interface: leaving it off would make a wrapper that
   * gates on a minor version non-substitutable over a remote transport.
   * `RemoteStreamClient` answers `null` (the mux carries no per-method
   * negotiation), so a gated feature degrades to "unsupported" over a remote
   * host instead of being falsely advertised.
   */
  getMethodSchemaVersion<Method extends keyof Registry & string>(
    method: Method,
  ): SchemaVersion | null;
}
