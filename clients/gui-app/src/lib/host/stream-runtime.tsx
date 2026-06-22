import {
  useCallback,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import { useHostBinding } from "@/lib/host/runtime";
import { hostTransportKey } from "@/lib/host/transport-key";
import { buildHostStreamClient } from "@/hooks/host/use-host-stream-client-for";
import { useStreamAuthRevalidator } from "@/lib/host/stream-auth-revalidator";
import { useCloseWsStreamClientOnReplace } from "@/lib/host/use-close-ws-stream-client-on-replace";
import { StreamRuntimeContext } from "@/lib/host/stream-runtime-context";
import type { StreamRuntimeBinding } from "@/lib/host/stream-runtime-context";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { useStreamWakeReconnect } from "@/lib/host/stream-wake-reconnect";

export interface HostStreamProviderProps {
  readonly children: ReactNode;
}

/**
 * Mounts a `WsStreamClient` bound to the active host + `RequestContext`
 * exposed by the host runtime binding. Rebuilds the stream client whenever
 * the underlying host binding changes (e.g. host swap / sign-out). Must
 * be rendered inside a `<HostRuntimeProvider>`.
 */
export function HostStreamProvider(props: HostStreamProviderProps): ReactNode {
  const binding = useHostBinding();
  const auth = useStreamAuthRevalidator();
  const readiness = useReactiveHostReadiness(
    binding === null ? null : binding.hostClient,
  );
  const transportKey = useReactiveHostTransportKey(
    binding === null ? null : binding.hostClient,
  );
  const value = useMemo<StreamRuntimeBinding | null>(() => {
    if (binding === null) return null;
    if (!readiness.isReady) return null;
    if (transportKey === null) return null;
    const wsStreamClient = buildHostStreamClient({
      endpoint: () => binding.hostClient.getActiveHost(),
      bearer: () => binding.hostClient.getRequestContext()?.credentials ?? null,
      auth,
    });
    return { wsStreamClient };
  }, [binding, auth, readiness.isReady, transportKey]);
  useCloseWsStreamClientOnReplace(value?.wsStreamClient ?? null);
  useStreamWakeReconnect(value?.wsStreamClient ?? null);

  return (
    <StreamRuntimeContext.Provider value={value}>
      {props.children}
    </StreamRuntimeContext.Provider>
  );
}

function useReactiveHostTransportKey<Registry extends VersionedRpcRegistry>(
  client: HostClient<Registry> | null,
): string | null {
  const subscribe = useCallback(
    (callback: () => void) => {
      if (client === null) {
        return () => undefined;
      }
      return client.onChange(callback);
    },
    [client],
  );
  const getSnapshot = useCallback(() => readHostTransportKey(client), [client]);
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

function readHostTransportKey<Registry extends VersionedRpcRegistry>(
  client: HostClient<Registry> | null,
): string | null {
  return hostTransportKey(client?.getActiveHost() ?? null);
}
