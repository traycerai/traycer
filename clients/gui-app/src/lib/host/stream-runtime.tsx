import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { useHostBinding } from "@/lib/host/runtime";
import { hostTransportKey } from "@/lib/host/transport-key";
import { buildHostStreamClient } from "@/hooks/host/use-host-stream-client-for";
import { useStreamAuthRevalidator } from "@/lib/host/stream-auth-revalidator";
import { useCloseWsStreamClientOnReplace } from "@/lib/host/use-close-ws-stream-client-on-replace";
import { StreamRuntimeContext } from "@/lib/host/stream-runtime-context";
import type { StreamRuntimeBinding } from "@/lib/host/stream-runtime-context";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { useStreamWakeReconnect } from "@/lib/host/stream-wake-reconnect";
import { appLogger } from "@/lib/logger";

export interface HostStreamProviderProps {
  readonly children: ReactNode;
}

/**
 * Mounts the app-wide `WsStreamClient` for the React-lifetime stream consumers
 * (notifications, git-diff, voice dictation, migration) bound to the active
 * host + `RequestContext`.
 *
 * The client is keyed on host IDENTITY (hostId + signed-in user), NOT on the
 * endpoint URL. A host restart keeps the same identity - `HostClient.bind`
 * takes its `sameHostId` path and only swaps the endpoint - so the live
 * `endpoint()` provider re-dials the new address on the SAME client instead of
 * the client being rebuilt-and-closed (which churns every consumer and can
 * strand an in-flight subscribe). The client is rebuilt only on a genuine
 * identity change (host swap / sign-out / user switch); a same-identity
 * endpoint move drives an immediate re-dial nudge, not a rebuild.
 *
 * The per-tab durable streams (chat / terminal) and the epic stream OWN their
 * transports via `openDurableStreamTransport`; this provider serves only the
 * consumers that read the client from context. Must be rendered inside a
 * `<HostRuntimeProvider>`.
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
  // Identity = the machine host + the signed-in user. Stable across a host
  // restart (hostId is the device id; only the endpoint URL moves), so the
  // memo below keeps the SAME client rather than rebuilding on every
  // `transportKey` change. `null` until both are known - the "host
  // communication may start" gate, equivalent to the old `readiness.isReady`.
  const identityKey =
    readiness.hostId === null || readiness.requestContextUserId === null
      ? null
      : `${readiness.hostId}\x1f${readiness.requestContextUserId}`;
  const value = useMemo<StreamRuntimeBinding | null>(() => {
    if (binding === null) return null;
    if (identityKey === null) return null;
    const wsStreamClient = buildHostStreamClient({
      endpoint: () => binding.hostClient.getActiveHost(),
      bearer: () => binding.hostClient.getRequestContext()?.credentials ?? null,
      auth,
    });
    return { wsStreamClient };
  }, [binding, auth, identityKey]);
  useEffect(() => {
    if (value === null) return;
    appLogger.debug("[stream] app stream client created", {
      hostId: readiness.hostId,
      hasTransport:
        binding !== null && binding.hostClient.getActiveHost() !== null,
    });
  }, [binding, readiness.hostId, value]);
  useCloseWsStreamClientOnReplace(value?.wsStreamClient ?? null);
  useStreamWakeReconnect(value?.wsStreamClient ?? null);
  useReconnectStreamOnEndpointChange(
    value?.wsStreamClient ?? null,
    transportKey,
  );

  // On an in-place bearer rotation (token refresh), push the fresh credential
  // onto the app-wide stream client's open sessions so the host updates each
  // connection's lease without a reconnect.
  const wsStreamClient = value?.wsStreamClient ?? null;
  const hostClient = binding?.hostClient ?? null;
  useEffect(() => {
    if (wsStreamClient === null || hostClient === null) {
      return;
    }
    return hostClient.onBearerRotated(() => {
      wsStreamClient.notifyBearerRotated();
    });
  }, [wsStreamClient, hostClient]);

  return (
    <StreamRuntimeContext.Provider value={value}>
      {props.children}
    </StreamRuntimeContext.Provider>
  );
}

/**
 * Forces an immediate re-dial when the active host gains a (new) dialable
 * endpoint UNDER a stable client - a host restart / re-provision that moved to a
 * new websocketUrl, or simply came back available, while the identity (and
 * therefore the client) stayed the same. The dropped socket would re-dial on
 * its own once its reconnect backoff elapses; nudging skips that wait so
 * recovery is instant. No nudge on a client REBUILD (a fresh client already
 * dials the current endpoint) or while the endpoint is gone (`transportKey`
 * null) - the next non-null transition fires it.
 */
function useReconnectStreamOnEndpointChange(
  client: WsStreamClient<HostStreamRpcRegistry> | null,
  transportKey: string | null,
): void {
  const previous = useRef<{
    readonly client: WsStreamClient<HostStreamRpcRegistry> | null;
    readonly transportKey: string | null;
  }>({ client: null, transportKey: null });
  useEffect(() => {
    const prev = previous.current;
    previous.current = { client, transportKey };
    if (
      client !== null &&
      prev.client === client &&
      transportKey !== null &&
      prev.transportKey !== transportKey
    ) {
      appLogger.debug(
        "[stream] app stream endpoint changed - reconnecting",
        {},
      );
      client.reconnectAll("host-endpoint-change");
    }
  }, [client, transportKey]);
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
