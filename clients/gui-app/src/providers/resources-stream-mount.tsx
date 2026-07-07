import { useEffect, type ReactNode } from "react";
import { ResourcesStreamClient } from "@traycer-clients/shared/host-transport/resources-stream-client";
import {
  useStreamMethodSupport,
  useWsStreamClient,
} from "@/lib/host/stream-runtime-context";
import { resourcesRegistry } from "@/stores/resources/resources-registry";
import {
  createResourcesStore,
  type ResourcesStreamClientFactory,
} from "@/stores/resources/resources-store";
import { getResourcesStreamClientFactoryOverride } from "@/providers/resources-stream-factory-override";

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
 */
export function ResourcesStreamMount(
  props: ResourcesStreamMountProps,
): ReactNode {
  const { epicId } = props;
  const wsStreamClient = useWsStreamClient();
  const resourcesSupport = useStreamMethodSupport("resources.subscribe");
  const resourcesUnsupported = resourcesSupport === "unsupported";

  useEffect(() => {
    if (resourcesUnsupported) return;
    const override = getResourcesStreamClientFactoryOverride();
    if (override === null && wsStreamClient === null) return;
    // Token identifies the transport this entry is bound to; a host swap changes
    // the `WsStreamClient` identity and rebuilds the store (see the registry).
    const clientToken: unknown = override !== null ? override : wsStreamClient;
    const streamClientFactory: ResourcesStreamClientFactory =
      override !== null
        ? override
        : (id, callbacks) => {
            if (wsStreamClient === null) {
              throw new Error(
                "ResourcesStreamMount: WsStreamClient missing at open time.",
              );
            }
            return new ResourcesStreamClient({
              wsStreamClient,
              epicId: id,
              callbacks,
            });
          };
    resourcesRegistry.acquire(epicId, clientToken, () =>
      createResourcesStore({ epicId, streamClientFactory }),
    );
    return () => {
      resourcesRegistry.release(epicId);
    };
  }, [epicId, resourcesUnsupported, wsStreamClient]);

  return null;
}
