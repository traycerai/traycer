import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { useHostBinding } from "@/lib/host/runtime";
import { hostTransportKey } from "@/lib/host/transport-key";
import { buildHostStreamClient } from "@/hooks/host/use-host-stream-client-for";
import { useStreamAuthRevalidator } from "@/lib/host/stream-auth-revalidator";
import { StreamRuntimeContext } from "@/lib/host/stream-runtime-context";
import type { StreamRuntimeBinding } from "@/lib/host/stream-runtime-context";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { useReactiveOwnerIdentityKey } from "@/hooks/host/use-reactive-owner-identity-key";
import { useStreamWakeReconnect } from "@/lib/host/stream-wake-reconnect";
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
 * A client that survives at least this long before closing underneath the
 * provider is considered to have genuinely worked - its close resets the
 * rebuild backoff below. Anything shorter is a "quick close": the rebuild
 * likely dials straight into the same failure.
 */
const REBUILD_HEALTHY_LIFETIME_MS = 30_000;
const REBUILD_BACKOFF_BASE_MS = 1_000;
const REBUILD_BACKOFF_MAX_MS = 30_000;

/**
 * Mounts the app-wide `WsStreamClient` for the React-lifetime stream consumers
 * (notifications, git-diff, voice dictation, migration) bound to the active
 * host + `RequestContext`.
 *
 * The client is keyed on host IDENTITY (`remoteAwareOwnerIdentity`: hostId +
 * signed-in user, plus - for a remote host - its public key and relay attach
 * URL), NOT on the endpoint URL. A host restart keeps the same identity -
 * `HostClient.bind` takes its `sameHostId` path and only swaps the endpoint -
 * so the live `endpoint()` provider re-dials the new address on the SAME
 * client instead of the client being rebuilt-and-closed (which churns every
 * consumer and can strand an in-flight subscribe). The client is rebuilt only
 * on a genuine identity change (host swap / sign-out / user switch / a
 * same-host remote public-key rotation, R-1); a same-identity endpoint move
 * drives an immediate re-dial nudge, not a rebuild.
 *
 * The per-tab durable streams (chat / terminal) and the epic stream OWN their
 * transports via `openDurableStreamTransport`; this provider serves only the
 * consumers that read the client from context. Must be rendered inside a
 * `<HostRuntimeProvider>`.
 */
export function HostStreamProvider(props: HostStreamProviderProps): ReactNode {
  const binding = useHostBinding();
  const auth = useStreamAuthRevalidator();
  const authnBaseUrl = useRunnerHost().authnBaseUrl;
  const readiness = useReactiveHostReadiness(
    binding === null ? null : binding.hostClient,
  );
  const transportKey = useReactiveHostTransportKey(
    binding === null ? null : binding.hostClient,
  );
  // Identity = the machine host + the signed-in user (plus, for a remote
  // host, its public key + relay attach identity - R-1). Stable across a
  // host restart (hostId is the device id; only the endpoint URL moves), so
  // the effect below keeps the SAME client rather than rebuilding on every
  // `transportKey` change. `null` until both are known - the "host
  // communication may start" gate, equivalent to the old `readiness.isReady`.
  // The BOUND HOST IDENTITY is the whole gate. It used to be composed with
  // `useSurfaceReadiness("default-host")`, which made the app-wide stream
  // client exist only while the default-host surface reported ready - and
  // that inverted the dependency it was supposed to protect. The stream's
  // ready boundary drives `notifyAvailabilityRecovered()`, the ONLY designed
  // signal that un-strands host-scoped queries left in a terminal error state
  // (`availability-recovery.ts`); withholding the client until readiness is
  // `ready` means the one mechanism that can RESTORE readiness is disabled
  // for exactly as long as readiness is broken. A host that restarts, or a
  // compat probe that failed mid-dial, then needs a manual Retry to come
  // back. The client is built from the identity the client is bound to; the
  // effect below still refuses to build one without a bound host and a live
  // request context, which is the real precondition.
  const identityKey = useReactiveOwnerIdentityKey(
    binding === null ? null : binding.hostClient,
  );
  const requestContextUserId = readiness.requestContextUserId;
  const [value, setValue] = useState<StreamRuntimeBinding | null>(null);
  // Liveness escape hatch: bumped when the served client turns out to be
  // closed (see the guard effect below), forcing the build effect to mint a
  // fresh client even though the identity never changed.
  const [rebuildNonce, setRebuildNonce] = useState(0);
  // Set while the build effect's cleanup is intentionally closing the client
  // to rebuild it, so the liveness guard's `onClosed` handler can tell that
  // teardown-close apart from a genuine underneath-close and skip a redundant
  // (and otherwise infinitely-looping) rebuild.
  const teardownInProgressRef = useRef(false);
  // Backoff state for the liveness guard's rebuilds. Without it, a
  // terminal-class close (incompatible protocol, plan restriction) loops hot:
  // rebuild → fresh session → grant mint + relay dial + handshake → same
  // fatal → onClosed → rebuild, one full mint/dial cycle per round trip,
  // indefinitely. Quick successive closes back the next rebuild off
  // exponentially; a client that lived a while resets the streak.
  const rebuildBackoffRef = useRef({ quickCloses: 0, builtAt: 0 });

  // Builds AND owns the client's lifecycle inside this ONE effect, rather
  // than a `useMemo` (as this provider did before S1's session cache) - see
  // `useHostClientFor`'s identically-shaped effect
  // (`hooks/host/use-host-client-for.ts`) for the full "why": a discarded
  // `useMemo` invocation (StrictMode dev double-invoke, or a discarded
  // concurrent render in prod) used to be harmless (each built its own
  // independent, unstarted client that GC reclaimed); under the shared
  // `(hostId, userId)` session cache (Architecture §4 / S1) a discarded
  // acquire instead holds a live, never-released reference on the ONE shared
  // session, so the session's refCount would never return to zero. This
  // effect's cleanup is guaranteed to run for exactly the committed acquire,
  // so it supersedes both the old `useMemo` AND
  // `useCloseWsStreamClientOnReplace` (which only protected against closing a
  // STABLE memoized client too eagerly - moot now that the client is built
  // and closed by this same effect).
  useEffect(() => {
    if (binding === null) {
      setValue(null);
      return;
    }
    if (identityKey === null || requestContextUserId === null) {
      setValue(null);
      return;
    }
    const target = binding.hostClient.getActiveHost();
    if (target === null) {
      setValue(null);
      return;
    }
    const wsStreamClient = buildHostStreamClient({
      target,
      endpoint: () => binding.hostClient.getActiveHost(),
      bearer: () => binding.hostClient.getRequestContext()?.credentials ?? null,
      authnBaseUrl,
      auth,
      userId: requestContextUserId,
      // Never eager-start: this acquire is guaranteed exactly one matching
      // release (unlike the old memo-based build), but the connect-on-first-
      // subscribe laziness is an independent, unchanged behavior.
      autoStart: false,
    });
    if (wsStreamClient === null) {
      setValue(null);
      return;
    }
    appLogger.debug("[stream] app stream client created", {
      hostId: readiness.hostId,
      client: wsStreamClient.instanceId,
      hasTransport: true,
    });
    rebuildBackoffRef.current.builtAt = Date.now();
    setValue({ wsStreamClient });

    return () => {
      teardownInProgressRef.current = true;
      wsStreamClient.close("app-stream-provider-teardown");
      teardownInProgressRef.current = false;
    };
  }, [
    binding,
    auth,
    authnBaseUrl,
    identityKey,
    requestContextUserId,
    readiness.hostId,
    rebuildNonce,
  ]);
  // Liveness guard: a CLOSED client must be replaced, not left unavailable
  // until the window reloads. Legitimate closes (identity change / unmount)
  // are always paired with a value change or teardown, so this effect's
  // subscription is gone before they fire; anything else closing the served
  // client lands here and forces a rebuild via `rebuildNonce`. The build
  // effect owns the close, and `useWsStreamClient` hides the dead instance
  // during the handoff; the `isClosed()` re-check covers closes that happened
  // while this effect itself was disconnected.
  useEffect(() => {
    if (value === null) return;
    const client = value.wsStreamClient;
    let backoffTimer: number | null = null;
    const rebuild = (): void => {
      if (teardownInProgressRef.current) return;
      const backoff = rebuildBackoffRef.current;
      const lifetimeMs = Date.now() - backoff.builtAt;
      if (lifetimeMs >= REBUILD_HEALTHY_LIFETIME_MS) {
        backoff.quickCloses = 0;
      } else {
        backoff.quickCloses += 1;
      }
      // The FIRST quick close still rebuilds immediately - the guard's whole
      // point is instant recovery from the closed-client wedge. Backoff kicks
      // in from the second consecutive quick close, which is what a
      // terminal-class fatal (each fresh dial ending the same way) looks like
      // and a one-off wedge does not.
      const delayMs =
        backoff.quickCloses <= 1
          ? 0
          : Math.min(
              REBUILD_BACKOFF_MAX_MS,
              REBUILD_BACKOFF_BASE_MS * 2 ** (backoff.quickCloses - 2),
            );
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
  }, [value]);
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

  // The app-wide stream heartbeats against the active host continuously, so
  // its recovery evidence (session re-open after a drop, pong after a
  // stall-length gap) drives `notifyAvailabilityRecovered()` - un-stranding
  // every host-scoped query left in a terminal error state while the host
  // was stalled or restarting. This is the production caller that method was
  // designed for; the stream client and the host client are bound to the
  // same active-host identity by construction here.
  useEffect(() => {
    if (wsStreamClient === null || hostClient === null) {
      return;
    }
    return wireAvailabilityRecovery({
      wsStreamClient,
      target: hostClient,
      cooldownMs: AVAILABILITY_RECOVERY_COOLDOWN_MS,
      now: () => Date.now(),
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
