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
/**
 * Published ONCE per client by every provider (memoised, or held in state):
 * consumers key effects on the binding's identity - the session-import
 * controller's mount-time probe among them - so a binding re-minted per
 * render would tear those down and re-run them every render.
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
  /**
   * Pins the transport for a consumer that outlives the surface this binding
   * was read from, returning the matching release.
   *
   * A run started from a host-scoped panel keeps streaming after the panel
   * closes, and the scoped transport is reference-counted: without a pin it
   * closes at that panel's unmount and takes the run's subscription with it.
   * The returned release must be called exactly once, when the run's own need
   * for the transport ends.
   *
   * Every binding the app publishes today hands one out, the app-wide one
   * included: it is rebuilt when the window points at another host, and a run
   * started or attached on it has to outlive that. `null` is reserved for a
   * binding that genuinely has nothing to pin - a test harness, or a transport
   * that never closes under its consumers - and is a promise rather than an
   * absence: a caller writes `retain?.()` and is done rather than guessing
   * which kind of binding it holds.
   */
  readonly retain: (() => () => void) | null;
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
 * The whole binding a surface sits under, for the callers that must HAND IT
 * ON rather than read from it: starting an import or a migration aims a run at
 * one machine, and the target travels with the request as a single value -
 * transport, host name and transport lease together. Reading those three from
 * three hooks is how a run ends up filed under one host and executed on
 * another.
 *
 * `null` whenever `useWsStreamClient` is, for the reason `useStreamHostId`
 * gives: no caller may name a host it has no working stream to.
 */
export function useStreamRuntimeBinding(): StreamRuntimeBinding | null {
  const value = use(StreamRuntimeContext);
  const client = useWsStreamClient();
  return client === null ? null : value;
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
