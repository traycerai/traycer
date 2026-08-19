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
 * Mounts the app-wide `WsStreamClient` for the React-lifetime stream consumers
 * (notifications, git-diff, voice dictation, migration) bound to the active
 * host + `RequestContext`.
 *
 * The client is keyed on host IDENTITY (`remoteAwareOwnerIdentity`: hostId +
 * signed-in user, plus - for a remote host - its public key and relay attach
 * URL), NOT on the endpoint URL. A host restart keeps the same identity: the
 * directory row's endpoint fields move while its id does not, so the live
 * `endpoint()` provider re-dials the new address on the SAME client instead of
 * the client being rebuilt-and-closed (which churns every consumer and can
 * strand an in-flight subscribe). This used to be spelled as `HostClient.bind`
 * taking its `sameHostId` path; P4.2 deleted both, and the identity key is now
 * the only thing deciding rebuild-vs-re-dial. The client is rebuilt only
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
  // The app-wide client, APP-WIDE BY CONSTRUCTION: this is a top-level
  // provider, so no re-provided `HostRuntimeContext` is above it. Stated
  // explicitly all the same, because the failure if one ever were is that the
  // WINDOW's stream client follows whichever settings panel is open. A scoped
  // surface that needs a pinned stream has its own seam for it
  // (`useScopedStreamBinding`) and must not reach for this one.
  //
  // This provider used to read the SPINE, whose answers came from the active
  // slot; P4.2 deleted the slot, so every question below ("which host", "what
  // is its transport", "who owns it") resolves the selection layer's effective
  // host through the same id-pinned requester any other app-wide consumer uses.
  const effectiveHostId = useEffectiveHostId();
  const appHostClient = useMemo(
    () => resolveAppWideHostClient(binding, effectiveHostId),
    [binding, effectiveHostId],
  );
  const readiness = useReactiveHostReadiness(appHostClient);
  const transportKey = useReactiveHostTransportKey(appHostClient);
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
  // ready boundary drives `notifyRecoveredForNamedHost()`, the ONLY designed
  // signal that un-strands host-scoped queries left in a terminal error state
  // (`availability-recovery.ts`); withholding the client until readiness is
  // `ready` means the one mechanism that can RESTORE readiness is disabled
  // for exactly as long as readiness is broken. A host that restarts, or a
  // compat probe that failed mid-dial, then needs a manual Retry to come
  // back. The client is built from the identity the client is bound to; the
  // effect below still refuses to build one without a bound host and a live
  // request context, which is the real precondition.
  const identityKey = useReactiveOwnerIdentityKey(appHostClient);
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
  // Backoff for the liveness guard's rebuilds. Held via `useState`'s one-shot
  // initializer rather than `useRef(create())`, which would rebuild and
  // discard the closure on every render.
  //
  // The rebuild policy now lives in the connection registry's reconnect engine
  // (redesign P4.1 / connection-registry §6) instead of a module this provider
  // owned. The PACER is still per-owner - the streak measures "rebuilding THIS
  // client keeps failing", and this provider keeps ONE client that retargets
  // across hosts rather than one client per host, so a per-host pacer would
  // split a single client's streak in half. Cross-endpoint carry-over is
  // handled where it always was, by `markBuilt`'s identity comparison.
  const [rebuildBackoff] = useState(() =>
    processReconnectEngine().createRebuildPacer(),
  );

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
      hostId: target.hostId,
      client: wsStreamClient.instanceId,
      hasTransport: true,
    });
    // Derived from `target` and the `userId` the client above was actually
    // built with - NOT the render's `identityKey`, and for the same reason the
    // published `hostId` below comes from `target`. A host swap landing between
    // commit and this passive effect makes the render's answer name the
    // PREVIOUS endpoint while the client dials the new one, and `markBuilt`
    // reads that name to decide whether the streak carries: same name, so the
    // old endpoint's quick-close streak survives onto a client dialed at a new
    // one, and a terminal-class close there can be paced by up to the full
    // ceiling before the identity-change render lands and clears it. That is
    // exactly the cross-endpoint pacing the streak reset exists to prevent, so
    // the identity has to come from the same read as the client it describes.
    //
    // Not `target.hostId` either: identity includes the authenticated user and
    // a remote host's public key / relay coordinates, so a new user or a
    // rotated remote identity on the SAME machine is a different endpoint.
    // `remoteAwareOwnerIdentity` is the same helper `useReactiveOwnerIdentityKey`
    // projects through, so successive builds compare like for like.
    rebuildBackoff.markBuilt(
      Date.now(),
      remoteAwareOwnerIdentity(target, requestContextUserId),
    );
    // The client and the host it dials are published in ONE value, so no
    // consumer can observe the new host beside the old client.
    //
    // `target.hostId`, NOT `readiness.hostId`: the latter is this render's
    // answer, while `target` was read from the live `HostClient` inside this
    // effect. A host swap landing between commit and this passive effect makes
    // those two different machines, and the client below is built from
    // `target` — so publishing the render-time name would ship
    // `{ client for B, hostId: A }` until a later render corrected it. The name
    // has to come from the same read as the thing it names.
    setValue({ wsStreamClient, hostId: target.hostId });

    return () => {
      teardownInProgressRef.current = true;
      wsStreamClient.close("app-stream-provider-teardown");
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

  // The app-wide stream heartbeats against the effective host continuously, so
  // its recovery evidence (session re-open after a drop, pong after a
  // stall-length gap) un-strands every host-scoped query left in a terminal
  // error state while that host was stalled or restarting. This is the
  // production caller the mechanism was designed for.
  //
  // The recovery NAMES ITS HOST. It used to call the client's no-argument
  // `notifyAvailabilityRecovered()`, which read the active slot to decide
  // whose queries to un-strand - so with the slot deleted (P4.2) that call
  // would have become a permanent no-op, silently: every stranded query on a
  // stalled host would stay errored with no path back, and nothing would
  // fail. `notifyHostAvailabilityRecovered(hostId)` says the same thing about
  // a host the caller can actually name, which here is the host this stream
  // is heartbeating against. The target member below carries no argument for
  // the same reason it is now spelled `notifyRecoveredForNamedHost`: the host
  // is captured in this closure, not read from anywhere.
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

/**
 * One arm, same rationale as `useReactiveHostReadiness` (redesign P4.2): a
 * transport move is a ROW change, so the registry reports it whether or not
 * anything re-points. The slot arm this used to carry alongside it is gone
 * with the slot - the registry was already delivering the same wake, which is
 * what made removing it a deletion rather than a migration.
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
