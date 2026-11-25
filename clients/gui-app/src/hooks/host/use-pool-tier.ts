import { useMemo, useSyncExternalStore } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  decideHostStreamDispatch,
  hostRpcServingTierHostId,
  readProcessHostRpcTierPlan,
  type HostStreamRpcMethod,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import {
  getNegotiatedHostMethods,
  subscribeNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import { useAppServingDecision } from "@/lib/host/app-serving-decision";
import { resolvePoolTierHostClient } from "@/lib/host/binding-host-client";
import { remoteAwareOwnerIdentityKey } from "@/lib/host/transport-key";
import { useStreamAuthRevalidator } from "@/lib/host/stream-auth-revalidator";
import { useHostStreamClientBindingFor } from "@/hooks/host/use-host-stream-client-for";

/**
 * The requester of the peer that answers account-wide `method` for an
 * app-wide surface: in a build with a pool, the serving computer's when it
 * negotiated the method and may answer it for this person, the pool's
 * otherwise; without one, `surfaceClient`. For a family whose own keys and
 * replicas are filed under its requester's host (History), so that host is
 * the answering peer's and a move between peers is one refetch.
 */
export function useAnsweringHostClient(
  surfaceClient: HostClient<HostRpcRegistry> | null,
  method: "epic.listTasks" | "organization.history",
): HostClient<HostRpcRegistry> | null {
  const serving = useAppServingDecision();
  const plan = readProcessHostRpcTierPlan();
  const answeringHostId =
    plan.pool === null
      ? null
      : hostRpcServingTierHostId(
          method,
          surfaceClient?.getActiveHostId() ?? null,
          plan,
          null,
          serving,
          null,
        );
  return useMemo(
    () =>
      plan.pool === null || surfaceClient === null
        ? surfaceClient
        : surfaceClient.createRequesterForHostId(answeringHostId),
    [answeringHostId, plan.pool, surfaceClient],
  );
}

/** {@link resolvePoolTierHostClient}, memoized on the surface's client. */
export function usePoolTierHostClient(
  surfaceClient: HostClient<HostRpcRegistry>,
): HostClient<HostRpcRegistry>;
export function usePoolTierHostClient(
  surfaceClient: HostClient<HostRpcRegistry> | null,
): HostClient<HostRpcRegistry> | null;
export function usePoolTierHostClient(
  surfaceClient: HostClient<HostRpcRegistry> | null,
): HostClient<HostRpcRegistry> | null {
  return useMemo(
    () =>
      surfaceClient === null ? null : resolvePoolTierHostClient(surfaceClient),
    [surfaceClient],
  );
}

/**
 * THE way a gui-app surface gets a stream client for a route that is not
 * `target-host`: the peer `decideHostStreamDispatch` names for `method`, from
 * the surface's own host (`surfaceHostId`, carried by `surfaceStreamClient`)
 * and the app's serving decision. An account-wide stream opens on the serving
 * computer when it negotiated the method and may serve it for this person,
 * and on the pool otherwise; a pool-only stream always on the pool in a build
 * with one. Without a pool both stay on the surface's own client, as before.
 * The bell uses the surface computer's authority for its cloud feed, so the
 * only computer it can open on is the one carrying its other feeds.
 *
 * `client` is `null` while the routed peer's client is not built yet, is
 * still the previous user's, or the route refuses: a binding is used only
 * once its owner identity is the signed-in user's, so a subscription is never
 * opened on a session another account owns. The routed peer moving is a
 * resubscribe on the new client, as on a reconnect. `peerHostId` names the
 * routed peer (`null` on a refusal), for a caller whose recovery or lane
 * bookkeeping depends on which peer serves the stream.
 */
export function useRoutedStreamClient(
  method: HostStreamRpcMethod,
  surfaceHostId: string | null,
  surfaceStreamClient: IHostStreamClient<HostStreamRpcRegistry> | null,
  options: {
    readonly userId: string | null;
    readonly computerScope: "app-serving-peer" | "surface-computer";
  },
): RoutedStreamClient {
  const binding = useHostBinding();
  const appServing = useAppServingDecision();
  const plan = readProcessHostRpcTierPlan();
  const target =
    surfaceHostId === null
      ? null
      : (binding?.hostClient.resolveHostById(surfaceHostId) ?? null);
  const targetMethods = useSyncExternalStore(
    subscribeNegotiatedManifests,
    () =>
      surfaceHostId === null ? null : getNegotiatedHostMethods(surfaceHostId),
  );
  const serving =
    options.computerScope === "surface-computer"
      ? {
          servingPeer: target,
          servingPeerMethods: targetMethods,
          servingPeerEnvironmentId: null,
        }
      : appServing;
  const decision = decideHostStreamDispatch(
    method,
    target,
    targetMethods,
    plan,
    null,
    serving,
  );
  const routed = decision.kind === "dispatch" ? decision.entry : null;
  const onSurface = routed !== null && routed.hostId === surfaceHostId;
  const streamAuth = useStreamAuthRevalidator();
  const routedBinding = useHostStreamClientBindingFor(
    plan.pool === null || onSurface ? null : routed,
    streamAuth,
  );
  // A build with no pool keeps every stream on the surface's own client, as
  // before the routes existed, whether or not its entry has resolved.
  if (plan.pool === null) {
    return { client: surfaceStreamClient, peerHostId: surfaceHostId };
  }
  if (routed === null) return { client: null, peerHostId: null };
  if (onSurface) {
    return { client: surfaceStreamClient, peerHostId: routed.hostId };
  }
  const owner = remoteAwareOwnerIdentityKey(routed, options.userId);
  return {
    client:
      routedBinding !== null &&
      owner !== null &&
      routedBinding.transportKey === owner
        ? routedBinding.client
        : null,
    peerHostId: routed.hostId,
  };
}

export interface RoutedStreamClient {
  readonly client: IHostStreamClient<HostStreamRpcRegistry> | null;
  readonly peerHostId: string | null;
}
