import type { SchemaVersion } from "@traycer/protocol/framework/index";
import type { VersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { IStreamSession } from "./i-stream-session";
import type { ParamsOf } from "./ws-stream-client";

/** Subscribe-only seam over a streaming transport (transport-seam spike). */
export interface IStreamClient<Registry extends VersionedStreamRpcRegistry> {
  /**
   * Opens a long-lived session bound to a single streaming method.
   * The returned `IStreamSession` re-declares the same method on every reconnect and tears down only on `close()` or a fatal error.
   */
  subscribe<Method extends keyof Registry & string>(
    method: Method,
    params: ParamsOf<Registry, Method>,
  ): IStreamSession;

  /**
   * Opens a stream pinned to an exact client schema version.
   * The peer must advertise that version or a newer minor on the same major; otherwise the session closes through the ordinary pre-subscribe unsupported path.
   */
  subscribeAtVersion?<Method extends keyof Registry & string>(
    method: Method,
    schemaVersion: SchemaVersion,
    params: ParamsOf<Registry, Method>,
  ): IStreamSession;

  /**
   * Opens a session whose params are re-read immediately before every wire subscribe, including the re-declare that follows a physical reconnect - rather than freezing whatever was current when the session was created.
   * The provider must be a pure, synchronous read: it may report applied client state, but must not create transport or application state as a side effect.
   */
  subscribeWithParamsProvider<Method extends keyof Registry & string>(
    method: Method,
    paramsProvider: () => ParamsOf<Registry, Method>,
  ): IStreamSession;

  /**
   * The schema version the peer negotiated for `method`, or `null` when it is not (yet) known.
   * Wrappers use it to gate additive minor-line features (e.g. `ChatStreamClient.sameTurnSteeringProtocolSupported`).
   */
  getMethodSchemaVersion<Method extends keyof Registry & string>(
    method: Method,
  ): SchemaVersion | null;
}
