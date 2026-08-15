import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ResourcesStreamClient } from "@traycer-clients/shared/host-transport/resources-stream-client";
import {
  useStreamHostId,
  useStreamMethodSupport,
  useWsStreamClient,
} from "@/lib/host/stream-runtime-context";
import { useGlobalResourcesPreCheckUnsupported } from "@/hooks/resources/use-global-resources-unsupported";
import { resourcesRegistry } from "@/stores/resources/resources-registry";
import {
  createResourcesStore,
  type ResourcesStreamClientFactory,
} from "@/stores/resources/resources-store";
import { getResourcesStreamClientFactoryOverride } from "@/providers/resources-stream-factory-override";
import { useSettingsStore } from "@/stores/settings/settings-store";

export interface ResourcesStreamMountProps {
  readonly epicId: string;
}

/**
 * Headless lifecycle owner for one epic's `resources.subscribe` stream. Mounted
 * inside the epic pane (where the app-wide `WsStreamClient` and the epic id are
 * both in scope), it acquires the registry entry for `epicId` and releases it on
 * unmount. Rendering is delegated to the app-level surfaces that read the
 * registry by `epicId`, so this mount emits nothing itself.
 *
 * Deferred until the stream client binds (`useWsStreamClient()` is `null` during
 * the initial host-hydration gap); the effect re-runs when it becomes available.
 *
 * Gated behind the settings that actually consume resource data (the header
 * popover and the sidebar chips) — with both off, no consumer would ever read
 * the entry, so the stream stays closed. Both booleans join the effect deps so
 * toggling a setting live acquires/releases without remounting the pane.
 */
export function ResourcesStreamMount(
  props: ResourcesStreamMountProps,
): ReactNode {
  const { epicId } = props;
  const wsStreamClient = useWsStreamClient();
  // Named for the same reason the global mount is: these entries are what the
  // registry aggregates when no global stream exists (a pre-v1.1 host), so a
  // reader checking "did this come from the machine I name" must be able to
  // answer it for the fallback too, not just the global entry.
  const hostId = useStreamHostId();
  const resourcesSupport = useStreamMethodSupport("resources.subscribe");
  const resourcesUnsupported = resourcesSupport === "unsupported";
  const showGlobalResourceMonitor = useSettingsStore(
    (state) => state.showGlobalResourceMonitor,
  );
  const showNavigatorResourceStats = useSettingsStore(
    (state) => state.showNavigatorResourceStats,
  );
  const streamWanted = showGlobalResourceMonitor || showNavigatorResourceStats;

  useEffect(() => {
    if (resourcesUnsupported || !streamWanted) return;
    const override = getResourcesStreamClientFactoryOverride();
    if (override === null && wsStreamClient === null) return;
    // Token identifies the transport this entry is bound to; a host swap changes
    // the `WsStreamClient` identity and rebuilds the store (see the registry).
    const clientToken: unknown = override !== null ? override : wsStreamClient;
    const streamClientFactory: ResourcesStreamClientFactory =
      override !== null
        ? override
        : (scope, callbacks) => {
            if (wsStreamClient === null) {
              throw new Error(
                "ResourcesStreamMount: WsStreamClient missing at open time.",
              );
            }
            return new ResourcesStreamClient({
              wsStreamClient,
              scope,
              callbacks,
            });
          };
    resourcesRegistry.acquire(epicId, clientToken, hostId, () =>
      createResourcesStore({
        scope: { kind: "epic", epicId },
        streamClientFactory,
      }),
    );
    return () => {
      resourcesRegistry.release(epicId);
    };
  }, [epicId, hostId, resourcesUnsupported, streamWanted, wsStreamClient]);

  return null;
}

export function GlobalResourcesStreamMount(): ReactNode {
  const wsStreamClient = useWsStreamClient();
  // Taken from the SAME binding as the client above, never from a prop or a
  // scope model: the host id republished on the projection is what a scoped
  // reader checks its data against, so it has to be the host this transport is
  // actually dialing rather than the one the caller believes it asked for.
  const hostId = useStreamHostId();
  // The PRE-STREAM verdict only, never the full one the panel reads. The full
  // one includes this stream's own negotiation, so gating the acquire on it
  // would be a loop: acquire → learn `unsupported` → release → the verdict dies
  // with the store → acquire again. The pre-check cannot move as a result of
  // anything this effect does, which is what makes it safe to gate on.
  //
  // So a host convicted only by its own stream keeps that stream open. It costs
  // one idle subscription: an `@1.0` host answers a global probe with a single
  // empty projection and then, having nothing to say about an epic that does
  // not exist, stays silent.
  const resourcesUnsupported = useGlobalResourcesPreCheckUnsupported();
  // Bumped ONLY by the recovery listener below — never during a render.
  const [reprobeGeneration, setReprobeGeneration] = useState(0);
  // "Which stream should be open": the transport, plus the re-probe generation.
  // The generation belongs in the identity rather than in the effect alone, so
  // a bump rebuilds the entry even when a second lease holder would otherwise
  // keep the existing one alive.
  const reacquireToken = useMemo(
    () => ({ transport: wsStreamClient, reprobeGeneration }),
    [wsStreamClient, reprobeGeneration],
  );

  /**
   * Re-probes a verdict that cannot clear itself.
   *
   * A version verdict self-heals: that stream stays open, a drop takes its
   * negotiated version with it, and the resume re-negotiates. A TERMINAL
   * incompatible close has no such path — it fails only the stream, while the
   * shared session stays healthy, so the transport identity never changes and
   * nothing above would ever rebuild. A host that advertises no bridgeable
   * `resources.subscribe` and is then upgraded in place would keep being called
   * incapable for as long as this surface stayed mounted.
   *
   * Driven off transport recovery, which is the only positive evidence that the
   * host on the other end may not be the one we judged.
   */
  useEffect(() => {
    if (wsStreamClient === null) return;
    return wsStreamClient.subscribeAvailabilityRecovered(() => {
      // Read IMPERATIVELY. As an effect dependency this verdict is a loop:
      // it changes → the effect re-runs → release/acquire → the fresh store
      // reports `unknown` → it changes again. Edge-triggered off recovery it
      // cannot self-perpetuate, because a re-probe that lands on the same
      // terminal verdict emits no further recovery event.
      //
      // Gated on `unsupported` so an ordinary reconnect — including the clean
      // first open, which `RemoteStreamClient` also reports — does not tear
      // down and rebuild a working stream, losing its projection each time.
      if (resourcesRegistry.getGlobalScopeSupport(hostId) !== "unsupported") {
        return;
      }
      setReprobeGeneration((generation) => generation + 1);
    });
  }, [hostId, wsStreamClient]);

  useEffect(() => {
    if (resourcesUnsupported) return;
    const override = getResourcesStreamClientFactoryOverride();
    if (override === null && wsStreamClient === null) return;
    const clientToken: unknown = reacquireToken;
    const streamClientFactory: ResourcesStreamClientFactory =
      override !== null
        ? override
        : (scope, callbacks) => {
            if (wsStreamClient === null) {
              throw new Error(
                "GlobalResourcesStreamMount: WsStreamClient missing at open time.",
              );
            }
            return new ResourcesStreamClient({
              wsStreamClient,
              scope,
              callbacks,
            });
          };
    resourcesRegistry.acquireGlobal(clientToken, hostId, () =>
      createResourcesStore({
        scope: { kind: "global" },
        streamClientFactory,
      }),
    );
    return () => {
      resourcesRegistry.releaseGlobal();
    };
    // `hostId` belongs in the deps, not just in the closure: the name is fixed
    // at acquire time, so a host id that resolves after its transport did must
    // rebuild the entry rather than leave the projection speaking for the wrong
    // machine. In practice it now moves WITH `wsStreamClient` (one binding, one
    // change), so this rarely fires on its own.
  }, [hostId, reacquireToken, resourcesUnsupported, wsStreamClient]);

  return null;
}
