import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { subscribeAnyHostRowChanged } from "@traycer-clients/shared/host-client/host-connection-registry";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import { planRestrictedReprobeAtFromClosedReason } from "@traycer-clients/shared/host-transport/remote/config";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { useHostBinding } from "@/lib/host/runtime";
import { resolveAppWideHostClient } from "@/lib/host/binding-host-client";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import {
  hostTransportKey,
  remoteAwareOwnerIdentity,
} from "@/lib/host/transport-key";
import { buildHostStreamClient } from "@/hooks/host/use-host-stream-client-for";
import { useStreamAuthRevalidator } from "@/lib/host/stream-auth-revalidator";
import { StreamRuntimeContext } from "@/lib/host/stream-runtime-context";
import type { StreamRuntimeBinding } from "@/lib/host/stream-runtime-context";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { useReactiveOwnerIdentityKey } from "@/hooks/host/use-reactive-owner-identity-key";
import { useStreamWakeReconnect } from "@/lib/host/stream-wake-reconnect";
import { processReconnectEngine } from "@traycer-clients/shared/host-client/host-connection-reconnect-engine";
import { useRunnerHost } from "@/providers/use-runner-host";
import {
  AVAILABILITY_RECOVERY_COOLDOWN_MS,
  wireAvailabilityRecovery,
} from "@/lib/host/availability-recovery";
import { appLogger } from "@/lib/logger";

export interface HostStreamProviderProps {
  readonly children: ReactNode;
}

/**
 * Mounts the app-wide `WsStreamClient` for the React-lifetime stream consumers (notifications, git-diff, voice dictation, migration) bound to the active host + `RequestContext`.
 */
export function HostStreamProvider(props: HostStreamProviderProps): ReactNode {
  const binding = useHostBinding();
  const auth = useStreamAuthRevalidator();
  const authnBaseUrl = useRunnerHost().authnBaseUrl;
  // The app-wide client, APP-WIDE BY CONSTRUCTION: this is a top-level provider, so no re-provided `HostRuntimeContext` is above it.
  // Stated explicitly all the same, because the failure if one ever were is that the WINDOW's stream client follows whichever settings panel is open.
  const effectiveHostId = useEffectiveHostId();
  const appHostClient = useMemo(
    () => resolveAppWideHostClient(binding, effectiveHostId),
    [binding, effectiveHostId],
  );
  const readiness = useReactiveHostReadiness(appHostClient);
  const transportKey = useReactiveHostTransportKey(appHostClient);
  // Identity = the machine host + the signed-in user (plus, for a remote host, its public key + relay attach identity - R-1).
  // Stable across a host restart (hostId is the device id; only the endpoint URL moves), so the effect below keeps the SAME client rather than rebuilding on every `transportKey` change.
  const identityKey = useReactiveOwnerIdentityKey(appHostClient);
  const requestContextUserId = readiness.requestContextUserId;
  const [value, setValue] = useState<StreamRuntimeBinding | null>(null);
  // Liveness escape hatch: bumped when the served client turns out to be closed (see the guard effect below), forcing the build effect to mint a fresh client even though the identity never changed.
  const [rebuildNonce, setRebuildNonce] = useState(0);
  // Set while the build effect's cleanup is intentionally closing the client to rebuild it, so the liveness guard's `onClosed` handler can tell that teardown-close apart from a genuine underneath-close and skip a redundant (and otherwise infinitely-looping).
  const teardownInProgressRef = useRef(false);
  // Backoff for the liveness guard's rebuilds.
  // Held via `useState`'s one-shot initializer rather than `useRef(create())`, which would rebuild and discard the closure on every render.
  const [rebuildBackoff] = useState(() =>
    processReconnectEngine().createRebuildPacer(),
  );

  // Builds AND owns the client's lifecycle inside this ONE effect, rather than a `useMemo` (as this provider did before S1's session cache) - see `useHostClientFor`'s identically-shaped effect (`hooks/host/use-host-client-for.ts`) for the full "why": a.
  useEffect(() => {
    if (binding === null) {
      setValue(null);
      return;
    }
    if (identityKey === null || requestContextUserId === null) {
      setValue(null);
      return;
    }
    const target = appHostClient?.getActiveHost() ?? null;
    if (target === null) {
      setValue(null);
      return;
    }
    const wsStreamClient = buildHostStreamClient({
      target,
      endpoint: () => appHostClient?.getActiveHost() ?? null,
      bearer: () => binding.hostClient.getRequestContext()?.credentials ?? null,
      authnBaseUrl,
      auth,
      userId: requestContextUserId,
      // The app-wide epic stream: snapshot-shaped, replay-safe.
      proactiveWakeEligible: true,
      // Never eager-start: this acquire is guaranteed exactly one matching release (unlike the old memo-based build), but the connect-on-first- subscribe laziness is an independent, unchanged behavior.
      autoStart: false,
    });
    if (wsStreamClient === null) {
      setValue(null);
      return;
    }
    appLogger.debug("[stream] app stream client created", {
      hostId: target.hostId,
      client: wsStreamClient.instanceId,
      hasTransport: true,
    });
    // Derived from `target` and the `userId` the client above was actually built with - NOT the render's `identityKey`, and for the same reason the published `hostId` below comes from `target`.
    rebuildBackoff.markBuilt(
      Date.now(),
      remoteAwareOwnerIdentity(target, requestContextUserId),
    );
    // The client and the host it dials are published in ONE value, so no consumer can observe the new host beside the old client.
    let holds = 0;
    let tornDown = false;
    const closeIfUnheld = (): void => {
      if (!tornDown || holds > 0) return;
      wsStreamClient.close("app-stream-provider-teardown");
    };
    const retain = (): (() => void) => {
      holds += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds -= 1;
        closeIfUnheld();
      };
    };
    setValue({ wsStreamClient, hostId: target.hostId, retain });

    return () => {
      tornDown = true;
      teardownInProgressRef.current = true;
      closeIfUnheld();
      teardownInProgressRef.current = false;
    };
  }, [
    binding,
    appHostClient,
    auth,
    authnBaseUrl,
    identityKey,
    requestContextUserId,
    readiness.hostId,
    rebuildBackoff,
    rebuildNonce,
  ]);
  // Liveness guard: a CLOSED client must be replaced, not left unavailable until the window reloads.
  // Legitimate closes (identity change / unmount) are always paired with a value change or teardown, so this effect's subscription is gone before they fire; anything else closing the served client lands here and forces a rebuild via `rebuildNonce`.
  useEffect(() => {
    if (value === null) return;
    const client = value.wsStreamClient;
    let backoffTimer: number | null = null;
    const rebuild = (): void => {
      if (teardownInProgressRef.current) return;
      const planRestrictedReprobeAt = planRestrictedReprobeAtFromClosedReason(
        client.getClosedReason(),
      );
      if (planRestrictedReprobeAt !== null) {
        backoffTimer = window.setTimeout(
          () => {
            backoffTimer = null;
            setRebuildNonce((nonce) => nonce + 1);
          },
          Math.max(0, planRestrictedReprobeAt - Date.now()),
        );
        return;
      }
      const delayMs = rebuildBackoff.nextRebuildDelayMs(Date.now());
      appLogger.warn(
        "[stream] app stream client closed underneath the provider - rebuilding",
        {
          client: client.instanceId,
          closedReason: client.getClosedReason(),
          rebuildDelayMs: delayMs,
        },
      );
      if (delayMs === 0) {
        setRebuildNonce((nonce) => nonce + 1);
        return;
      }
      backoffTimer = window.setTimeout(() => {
        backoffTimer = null;
        setRebuildNonce((nonce) => nonce + 1);
      }, delayMs);
    };
    if (client.isClosed()) {
      rebuild();
    } else {
      const unsubscribe = client.onClosed(rebuild);
      return () => {
        unsubscribe();
        if (backoffTimer !== null) {
          window.clearTimeout(backoffTimer);
        }
      };
    }
    return () => {
      if (backoffTimer !== null) {
        window.clearTimeout(backoffTimer);
      }
    };
  }, [value, rebuildBackoff]);
  useStreamWakeReconnect(value?.wsStreamClient ?? null);
  useReconnectStreamOnEndpointChange(
    value?.wsStreamClient ?? null,
    transportKey,
  );

  // On an in-place bearer rotation (token refresh), push the fresh credential onto the app-wide stream client's open sessions so the host updates each connection's lease without a reconnect.
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

  // The app-wide stream heartbeats against the effective host continuously, so its recovery evidence (session re-open after a drop, pong after a stall-length gap) un-strands every host-scoped query left in a terminal error state while that host was stalled or.
  const recoveredHostId = readiness.hostId;
  useEffect(() => {
    if (
      wsStreamClient === null ||
      hostClient === null ||
      recoveredHostId === null
    ) {
      return;
    }
    return wireAvailabilityRecovery({
      wsStreamClient,
      target: {
        notifyRecoveredForNamedHost: () => {
          hostClient.notifyHostAvailabilityRecovered(recoveredHostId);
        },
      },
      cooldownMs: AVAILABILITY_RECOVERY_COOLDOWN_MS,
      now: () => Date.now(),
    });
  }, [wsStreamClient, hostClient, recoveredHostId]);

  return (
    <StreamRuntimeContext.Provider value={value}>
      {props.children}
    </StreamRuntimeContext.Provider>
  );
}

/**
 * Forces an immediate re-dial when the active host gains a (new) dialable endpoint UNDER a stable client - a host restart / re-provision that moved to a new websocketUrl, or simply came back available, while the identity (and therefore the client) stayed the.
 */
function useReconnectStreamOnEndpointChange(
  client: IHostStreamClient<HostStreamRpcRegistry> | null,
  transportKey: string | null,
): void {
  const previous = useRef<{
    readonly client: IHostStreamClient<HostStreamRpcRegistry> | null;
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
      // The host moved to a new address: the current socket points somewhere that no longer serves this host, so it must be dropped whether or not it still answers.
      // Not a wake - no probe.
      client.reconnectAll("host-endpoint-change", {
        probeFirst: false,
        wakeProbe: null,
      });
    }
  }, [client, transportKey]);
}

/**
 * One arm, same rationale as `useReactiveHostReadiness` (redesign P4.2): a transport move is a ROW change, so the registry reports it whether or not anything re-points.
 * The slot arm this used to carry alongside it is gone with the slot - the registry was already delivering the same wake, which is what made removing it a deletion rather than a migration.
 */
function useReactiveHostTransportKey<Registry extends VersionedRpcRegistry>(
  client: HostClient<Registry> | null,
): string | null {
  const subscribe = useCallback((callback: () => void) => {
    return subscribeAnyHostRowChanged(callback);
  }, []);
  const getSnapshot = useCallback(() => readHostTransportKey(client), [client]);
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

function readHostTransportKey<Registry extends VersionedRpcRegistry>(
  client: HostClient<Registry> | null,
): string | null {
  return hostTransportKey(client?.getActiveHost() ?? null);
}
