import { createContext, use } from "react";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";

/**
 * Streaming-transport seam. The single `IHostStreamClient<HostStreamRpcRegistry>`
 * exposed here rides next to the unary host runtime and powers every
 * Epic / notifications subscription the GUI opens — a `WsStreamClient` for a
 * local active host, a `RemoteStreamClient` for a remote one (T14). Tests
 * bypass this entire provider by mounting the per-Epic / notifications stores
 * with injected stream-client factories.
 */
export interface StreamRuntimeBinding {
  readonly wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>;
}

export const StreamRuntimeContext = createContext<StreamRuntimeBinding | null>(
  null,
);

export function useWsStreamClient(): IHostStreamClient<HostStreamRpcRegistry> | null {
  const value = use(StreamRuntimeContext);
  return value === null ? null : value.wsStreamClient;
}
