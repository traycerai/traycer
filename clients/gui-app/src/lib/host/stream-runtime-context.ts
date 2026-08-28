import { createContext, use, useCallback, useSyncExternalStore } from "react";
import type {
  IHostStreamClient,
  StreamMethodSupportSource as SharedStreamMethodSupportSource,
} from "@traycer-clients/shared/host-transport/host-stream-client";
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
  /**
   * The host `wsStreamClient` is dialing, carried HERE rather than looked up
   * beside it so the transport and its name are one value that changes once.
   *
   * A reader that labels this stream's output with a host id fetched from
   * anywhere else — the active-host hook, a scope model, a directory row — is
   * reading a second answer to "which machine is this" that updates on its own
   * schedule. Those two answers disagree for the commit between a host swap and
   * the effect that rebuilds this binding, which is long enough to render one
   * machine's processes under another's name and aim an action at the wrong
   * one. Take the name from the binding you took the client from.
   *
   * `null` only when the owner genuinely cannot name one.
   */
  readonly hostId: string | null;
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

/**
 * The host the LIVE stream client in context is bound to — `null` whenever
 * `useWsStreamClient` is also `null`, so a caller can never name a host it has
 * no working stream to. Both values come off the same binding object, which is
 * what makes the pair atomic (see `StreamRuntimeBinding.hostId`).
 */
export function useStreamHostId(): string | null {
  const value = use(StreamRuntimeContext);
  const client = useWsStreamClient();
  return client === null ? null : (value?.hostId ?? null);
}

/**
 * The host-registry specialisation of the shared method-support slice - all
 * `useStreamMethodSupportFor` needs, and what a session handle exposes so its
 * consumers can read the bound host's capabilities without the whole transport.
 */
export type StreamMethodSupportSource =
  SharedStreamMethodSupportSource<HostStreamRpcRegistry>;

// Both method-support readers ride the same `subscribeMethodSupport` store and
// null-client handling; only the per-snapshot read differs. The readers are
// module-level constants so `getSnapshot`'s identity stays keyed on
// `[client, method]` alone.
function useStreamMethodValueForClient<
  TClient extends StreamMethodSupportSource,
  T,
>(
  client: TClient | null,
  method: keyof HostStreamRpcRegistry & string,
  read: (client: TClient, method: keyof HostStreamRpcRegistry & string) => T,
): T | null {
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

function useStreamMethodValue<T>(
  method: keyof HostStreamRpcRegistry & string,
  read: (
    client: IHostStreamClient<HostStreamRpcRegistry>,
    method: keyof HostStreamRpcRegistry & string,
  ) => T,
): T | null {
  const client = useWsStreamClient();
  return useStreamMethodValueForClient(client, method, read);
}

const readMethodSupport = (
  client: StreamMethodSupportSource,
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

/**
 * Method-support reader for an EXPLICIT client instance, not the app-wide
 * default-host `StreamRuntimeContext`. A per-tab tile (`useHostStreamClientFor`,
 * or a session store's own durable transport) dials a client for its bound
 * host, which may not be the app's default/active host -
 * `useStreamMethodSupport` would read the wrong client's negotiated
 * capabilities in that case.
 */
export function useStreamMethodSupportFor(
  client: StreamMethodSupportSource | null,
  method: keyof HostStreamRpcRegistry & string,
): StreamMethodSupport | null {
  return useStreamMethodValueForClient(client, method, readMethodSupport);
}

export function useStreamMethodSchemaVersionFor(
  client: IHostStreamClient<HostStreamRpcRegistry> | null,
  method: keyof HostStreamRpcRegistry & string,
): SchemaVersion | null {
  return useStreamMethodValueForClient(client, method, readMethodSchemaVersion);
}
