import { useEffect } from "react";
import { ResourcesStreamClient } from "@traycer-clients/shared/host-transport/resources-stream-client";
import {
  useStreamHostId,
  useStreamMethodSupport,
  useWsStreamClient,
} from "@/lib/host/stream-runtime-context";
import { resourcesRegistry } from "@/stores/resources/resources-registry";
import {
  createResourcesStore,
  type ResourcesStreamClientFactory,
} from "@/stores/resources/resources-store";
import { getResourcesStreamClientFactoryOverride } from "@/providers/resources-stream-factory-override";

/**
 * Holds the registry entry for `epicId` - one epic's `resources.subscribe`
 * stream - while `wanted`, releasing it when that turns false or the caller
 * unmounts. The registry is lease-counted, so every holder of one epic shares
 * a single stream and it closes with the last of them.
 *
 * The holders are the surfaces that DRAW an epic's numbers: each resource chip
 * (`OwnerResourceChip`) while it is mounted, and the pane's
 * `EpicResourcesFallbackMount` for an old host's global monitor. Nothing
 * holds one for an epic that is merely open.
 *
 * Deferred until the stream client binds (`useWsStreamClient()` is `null` during
 * the initial host-hydration gap); the effect re-runs when it becomes available.
 */
export function useEpicResourcesLease(epicId: string, wanted: boolean): void {
  const wsStreamClient = useWsStreamClient();
  // Named for the same reason the global mount is: these entries are what the
  // registry aggregates when no global stream exists (a pre-v1.1 host), so a
  // reader checking "did this come from the machine I name" must be able to
  // answer it for the fallback too, not just the global entry.
  const hostId = useStreamHostId();
  const resourcesSupport = useStreamMethodSupport("resources.subscribe");
  const resourcesUnsupported = resourcesSupport === "unsupported";

  useEffect(() => {
    if (resourcesUnsupported || !wanted) return;
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
                "useEpicResourcesLease: WsStreamClient missing at open time.",
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
  }, [epicId, hostId, resourcesUnsupported, wanted, wsStreamClient]);
}
