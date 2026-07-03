import type { VersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { IStreamSession } from "./i-stream-session";
import type { ParamsOf } from "./ws-stream-client";

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
}
