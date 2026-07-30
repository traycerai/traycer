import { createContext, use, useCallback, useSyncExternalStore } from "react";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
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

/**
 * Returns only a live app-wide stream client. A closed client is hidden
 * immediately while `HostStreamProvider` rebuilds it, so consumers detach from
 * dead sessions and rebind when the replacement reaches context.
 */
export function useWsStreamClient(): IHostStreamClient<HostStreamRpcRegistry> | null {
  const value = use(StreamRuntimeContext);
  const client = value?.wsStreamClient ?? null;
  const subscribe = useCallback(
    (callback: () => void) => {
      if (client === null) {
        return () => undefined;
      }
      return client.onClosed(callback);
    },
    [client],
  );
  const getSnapshot = useCallback(() => {
    if (client === null || client.isClosed()) {
      return null;
    }
    return client;
  }, [client]);
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

// Both method-support readers ride the same `subscribeMethodSupport` store and
// null-client handling; only the per-snapshot read differs. The readers are
// module-level constants so `getSnapshot`'s identity stays keyed on
// `[client, method]` alone.
function useStreamMethodValue<T>(
  method: keyof HostStreamRpcRegistry & string,
  read: (
    client: IHostStreamClient<HostStreamRpcRegistry>,
    method: keyof HostStreamRpcRegistry & string,
  ) => T,
): T | null {
  const client = useWsStreamClient();
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
    return read(client, method);
  }, [client, method, read]);
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

const readMethodSupport = (
  client: IHostStreamClient<HostStreamRpcRegistry>,
  method: keyof HostStreamRpcRegistry & string,
) => client.getMethodSupport(method);

const readMethodSchemaVersion = (
  client: IHostStreamClient<HostStreamRpcRegistry>,
  method: keyof HostStreamRpcRegistry & string,
) => client.getMethodSchemaVersion(method);

export function useStreamMethodSupport(
  method: keyof HostStreamRpcRegistry & string,
): StreamMethodSupport | null {
  return useStreamMethodValue(method, readMethodSupport);
}

export function useStreamMethodSchemaVersion(
  method: keyof HostStreamRpcRegistry & string,
): SchemaVersion | null {
  return useStreamMethodValue(method, readMethodSchemaVersion);
}
