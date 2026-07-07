import { createContext, use, useCallback, useSyncExternalStore } from "react";
import type {
  StreamMethodSupport,
  WsStreamClient,
} from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";

/**
 * Streaming-transport seam. The single `WsStreamClient<HostStreamRpcRegistry>`
 * exposed here rides next to the unary host runtime and powers every
 * Epic / notifications subscription the GUI opens. Tests bypass this entire
 * provider by mounting the per-Epic / notifications stores with injected
 * stream-client factories.
 */
export interface StreamRuntimeBinding {
  readonly wsStreamClient: WsStreamClient<HostStreamRpcRegistry>;
}

export const StreamRuntimeContext = createContext<StreamRuntimeBinding | null>(
  null,
);

export function useWsStreamClient(): WsStreamClient<HostStreamRpcRegistry> | null {
  const value = use(StreamRuntimeContext);
  return value === null ? null : value.wsStreamClient;
}

export function useStreamMethodSupport(
  method: keyof HostStreamRpcRegistry & string,
): StreamMethodSupport | null {
  const value = use(StreamRuntimeContext);
  const client = value?.wsStreamClient ?? null;
  const subscribe = useCallback(
    (callback: () => void) => {
      if (client === null) {
        return () => undefined;
      }
      return client.subscribeMethodSupport(callback);
    },
    [client],
  );
  const getSnapshot = useCallback(() => {
    if (client === null) {
      return null;
    }
    return client.getMethodSupport(method);
  }, [client, method]);
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
