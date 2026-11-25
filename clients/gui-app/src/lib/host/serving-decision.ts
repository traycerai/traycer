import { useCallback, useMemo, useSyncExternalStore } from "react";
import { environmentHostBindingSchema } from "@traycer/protocol/host/environment/contracts";
import {
  POOL_HOST_ID,
  type HostDirectoryEntry,
} from "@traycer-clients/shared/host-client/host-directory";
import type { HostServingDecision } from "@traycer-clients/shared/host-client/host-rpc-routing";
import type { ServingPeer } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import {
  getNegotiatedHostMethods,
  subscribeNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { queryClient } from "@/lib/query-client";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

/**
 * The serving decision every account-wide route reads: the selection
 * authority's serving peer, resolved against the live directory, with what
 * that peer negotiated and, for a team computer, the environment it serves.
 *
 * One reader for dispatch (`HostClient`, through the runtime's routing port)
 * and one hook for keys and gates, over the same three sources, so a
 * surface's key, its capability read and its call all name the same peer.
 */

/** The serving peer's host id: a computer's id, `POOL_HOST_ID`, or `null`. */
export function servingPeerHostIdOf(peer: ServingPeer | null): string | null {
  if (peer === null) return null;
  return peer.kind === "pool" ? POOL_HOST_ID : peer.hostId;
}

/**
 * The environment a computer serves, from a binding answer this app already
 * holds: the pool's (`environment.binding.read`) or the computer's own
 * (`environment.host.read`). Read only for a team computer, which answers its
 * own environment's Guide and Skills and nothing else account-wide; `null`
 * until such an answer is cached, so those calls stay on the pool until then.
 */
function cachedServedEnvironmentId(hostId: string): string | null {
  for (const method of ["environment.binding.read", "environment.host.read"]) {
    for (const query of queryClient.getQueryCache().findAll({
      predicate: (candidate) =>
        hostQueryKeys.matchesMethodOnAnyHost(candidate.queryKey, method),
    })) {
      const binding = environmentHostBindingSchema.safeParse(query.state.data);
      if (binding.success && binding.data.hostId === hostId) {
        return binding.data.environment.environmentId;
      }
    }
  }
  return null;
}

function isTeamOwned(entry: HostDirectoryEntry): boolean {
  return entry.owner?.kind === "team";
}

function decisionFor(
  peerHostId: string | null,
  findHostById: (hostId: string) => HostDirectoryEntry | null,
  environmentId: (hostId: string) => string | null,
): HostServingDecision {
  const servingPeer = peerHostId === null ? null : findHostById(peerHostId);
  if (servingPeer === null || peerHostId === POOL_HOST_ID) {
    return {
      servingPeer,
      servingPeerMethods: null,
      servingPeerEnvironmentId: null,
    };
  }
  return {
    servingPeer,
    servingPeerMethods: getNegotiatedHostMethods(servingPeer.hostId),
    servingPeerEnvironmentId: isTeamOwned(servingPeer)
      ? environmentId(servingPeer.hostId)
      : null,
  };
}

/** The decision as it stands now, for dispatch. */
export function readHostServingDecision(
  findHostById: (hostId: string) => HostDirectoryEntry | null,
): HostServingDecision {
  return decisionFor(
    servingPeerHostIdOf(useSelectionAuthorityStore.getState().servingPeer),
    findHostById,
    cachedServedEnvironmentId,
  );
}

/** The serving peer's host id, reactively. A primitive, so render-stable. */
export function useServingPeerHostId(): string | null {
  return useSelectionAuthorityStore((state) =>
    servingPeerHostIdOf(state.servingPeer),
  );
}

function subscribeQueryCache(onChange: () => void): () => void {
  return queryClient.getQueryCache().subscribe(onChange);
}

/**
 * The same decision, reactively, for the keys and gates of a render. It
 * re-renders when the serving peer moves, when that peer's manifest arrives
 * or changes, and when a team computer's served environment becomes known.
 */
export function useHostServingDecision(
  findHostById: (hostId: string) => HostDirectoryEntry | null,
): HostServingDecision {
  const peerHostId = useServingPeerHostId();
  const methods = useSyncExternalStore(subscribeNegotiatedManifests, () =>
    peerHostId === null || peerHostId === POOL_HOST_ID
      ? null
      : getNegotiatedHostMethods(peerHostId),
  );
  const teamPeerId =
    peerHostId !== null &&
    peerHostId !== POOL_HOST_ID &&
    findHostById(peerHostId)?.owner?.kind === "team"
      ? peerHostId
      : null;
  const readEnvironment = useCallback(
    () => (teamPeerId === null ? null : cachedServedEnvironmentId(teamPeerId)),
    [teamPeerId],
  );
  const environmentId = useSyncExternalStore(
    subscribeQueryCache,
    readEnvironment,
  );
  const servingPeer = peerHostId === null ? null : findHostById(peerHostId);
  return useMemo(
    () => ({
      servingPeer,
      servingPeerMethods: methods,
      servingPeerEnvironmentId: environmentId,
    }),
    [environmentId, methods, servingPeer],
  );
}
