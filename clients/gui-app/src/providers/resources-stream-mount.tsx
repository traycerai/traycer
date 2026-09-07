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

export interface GlobalResourcesStreamMountProps {
  /** True only while the resource-monitor popover is actually visible. */
  readonly interactive: boolean;
}

/** Headless owner of one epic's `resources.subscribe` stream. Deferred until the stream client binds. Gated behind the settings that consume resource data; both booleans join the effect deps. */
export function ResourcesStreamMount(
  props: ResourcesStreamMountProps,
): ReactNode {
  const { epicId } = props;
  const wsStreamClient = useWsStreamClient();
  // Fallback entries must carry the host name too: the registry aggregates
  // them when no global stream exists.
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

export function GlobalResourcesStreamMount(
  props: GlobalResourcesStreamMountProps,
): ReactNode {
  const wsStreamClient = useWsStreamClient();
  // Host id from the same binding as the client. A scoped reader checks
  // against the machine this transport is dialing.
  const hostId = useStreamHostId();
  // Gate on the pre-stream verdict only. The full verdict includes this stream,
  // so gating acquire on it would acquire/release loop.
  const resourcesUnsupported = useGlobalResourcesPreCheckUnsupported();
  // Bumped ONLY by the recovery listener below — never during a render.
  const [reprobeGeneration, setReprobeGeneration] = useState(0);
  // Stream identity is transport plus re-probe generation. A bump rebuilds
  // even if a second lease holder would keep the old entry.
  const reacquireToken = useMemo(
    () => ({ transport: wsStreamClient, reprobeGeneration }),
    [wsStreamClient, reprobeGeneration],
  );

  /**
   * Re-probe a terminal incompatible close. A version verdict self-heals; a terminal close does not, so drive off transport recovery.
   */
  useEffect(() => {
    if (wsStreamClient === null) return;
    return wsStreamClient.subscribeAvailabilityRecovered(() => {
      // Read imperatively: as an effect dep this verdict acquire/release loops.
      // Gate on unsupported so an ordinary reconnect does not rebuild a working stream.
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
    // hostId is a dep: a late-resolving id must rebuild rather than leave the
    // projection speaking for the wrong machine.
  }, [hostId, reacquireToken, resourcesUnsupported, wsStreamClient]);

  // After acquire, same deps: re-state demand on the entry acquire just
  // installed via getGlobal.
  useEffect(() => {
    resourcesRegistry
      .getGlobal()
      ?.setDemand(props.interactive ? "interactive" : "background");
  }, [
    hostId,
    props.interactive,
    reacquireToken,
    resourcesUnsupported,
    wsStreamClient,
  ]);

  return null;
}
