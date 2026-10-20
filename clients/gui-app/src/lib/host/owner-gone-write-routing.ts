import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import {
  negotiatedVersionMeetsRequirement,
  type RequiredHostMethodVersion,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  getNegotiatedHostMethodVersion,
  subscribeNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import {
  isSurfacePinDeposed,
  type SurfacePinFleetView,
} from "@/stores/host/surface-host-selection-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

/**
 * Where an archive or delete goes when the host it belongs to is gone.
 *
 * Archive and delete of an agent record, and delete of a Task, are written on
 * the host that owns the record. When that host's session is down the write
 * goes to a host whose session is up instead: that host writes the cloud row
 * and the owner finishes the change when it is back (the host answers
 * `outcome: "requested"`, issue #1628). Nothing here decides the outcome - the
 * receiving host does, from its own copy of the record - this only picks where
 * the call is sent.
 *
 * Both facts are the selection authority's LEASE, the vocabulary every status
 * surface already derives from (`use-host-lease.ts`), read at the moment of the
 * write. There is no second liveness mechanism and nothing is stored.
 *
 *  - "The owner cannot serve" is {@link isSurfacePinDeposed}: positive evidence
 *    only - a `dead` lease, or a host missing from a fleet the authority has
 *    already enumerated. Before the authority attaches, or while it has
 *    published no fleet, nothing is deposed and the write goes to the owner as
 *    it always has.
 *  - "A host is live" is a `ready` or `degraded` lease: the host itself is up
 *    (`use-bounded-host-load.ts` reads the same two statuses the same way).
 *    `connecting` is the authority having no evidence yet and
 *    `restarting-expected` is a hold, so neither is chosen as a fallback.
 *
 * When the owner is down and no host is live, the answer is the owner again:
 * the write fails as it did before this existed and says so.
 *
 * An agent-record write also needs the stand-in to have NEGOTIATED the minor
 * that taught a host to write another host's record
 * ({@link OWNER_GONE_RECORD_WRITE_FLOORS}): an older host can only apply the
 * write to its own copy, so in a mixed-version fleet it is passed over for a
 * later live host that can. Unknown evidence (no handshake yet) fails closed.
 */

/** The agent-record writes a host other than the owner may make. */
export type OwnerGoneRecordWriteMethod =
  | "epic.setChatArchived"
  | "epic.deleteChat"
  | "epic.deleteTuiAgent";

/** The minor at which each write gained the non-owner (`requested`) arm. */
const OWNER_GONE_RECORD_WRITE_FLOORS: Readonly<
  Record<OwnerGoneRecordWriteMethod, SchemaVersion>
> = {
  "epic.setChatArchived": { major: 1, minor: 1 },
  "epic.deleteChat": { major: 1, minor: 2 },
  "epic.deleteTuiAgent": { major: 1, minor: 1 },
};

/**
 * The floor a stand-in's dispatch of `method` must clear: the minor that
 * writes a record another host owns. Selection reads a cached manifest; the
 * dispatch enforces this against the handshake of the connection carrying
 * the write, so a stand-in that restarted older is refused, not written to.
 */
export function ownerGoneRecordWriteRequirement(
  method: OwnerGoneRecordWriteMethod,
): RequiredHostMethodVersion {
  return { method, version: OWNER_GONE_RECORD_WRITE_FLOORS[method] };
}

/**
 * Whether `hostId`'s last handshake negotiated `method` at or above the minor
 * that writes a record another host owns. `false` before any handshake.
 */
export function hostTakesOwnerGoneRecordWrite(
  hostId: string,
  method: OwnerGoneRecordWriteMethod,
): boolean {
  return negotiatedVersionMeetsRequirement(
    getNegotiatedHostMethodVersion(hostId, method) ?? undefined,
    ownerGoneRecordWriteRequirement(method),
  );
}

/** The authority's fleet view, read imperatively at the moment of a write. */
export function readSelectionFleetSnapshot(): SurfacePinFleetView {
  const state = useSelectionAuthorityStore.getState();
  return { authorityAttached: state.attached, leases: state.leases };
}

/** Whether a lease is positive evidence that its host can take a call now. */
export function isLeaseServing(lease: HostLeaseSnapshot): boolean {
  return lease.status === "ready" || lease.status === "degraded";
}

/**
 * The first live host that `accepts`, trying `preferredHostIds` in order and
 * then every other host of the fleet in the authority's order.
 * `excludedHostId` (the host that is down) is never answered. `null` when no
 * such host is live.
 */
export function pickLiveHostId(
  preferredHostIds: readonly (string | null)[],
  fleet: SurfacePinFleetView,
  excludedHostId: string,
  accepts: (hostId: string) => boolean,
): string | null {
  if (!fleet.authorityAttached) return null;
  const servingHostIds = new Set(
    fleet.leases.filter(isLeaseServing).map((lease) => lease.hostId),
  );
  const ordered = [
    ...preferredHostIds,
    ...fleet.leases.map((lease) => lease.hostId),
  ];
  for (const hostId of ordered) {
    if (hostId === null || hostId === excludedHostId) continue;
    if (servingHostIds.has(hostId) && accepts(hostId)) return hostId;
  }
  return null;
}

export interface OwnerGoneWriteRoute {
  /** The host the write is sent to. */
  readonly hostId: string;
  /** `true` when the owner is down and the write went to another live host. */
  readonly fellBack: boolean;
}

/**
 * The host an owner-routed write is sent to: the owner while it can serve,
 * otherwise the first live host `fallbackAccepts` (see {@link pickLiveHostId}),
 * otherwise the owner.
 *
 * `preferredHostIds` is a thunk because it is only needed on the fallback path,
 * and reading it can touch app-wide state the ordinary path never does.
 */
export function routeOwnerGoneWrite(args: {
  readonly ownerHostId: string;
  readonly fleet: SurfacePinFleetView;
  readonly preferredHostIds: () => readonly (string | null)[];
  readonly fallbackAccepts: (hostId: string) => boolean;
}): OwnerGoneWriteRoute {
  const { ownerHostId, fleet } = args;
  if (!isSurfacePinDeposed(ownerHostId, fleet)) {
    return { hostId: ownerHostId, fellBack: false };
  }
  const liveHostId = pickLiveHostId(
    args.preferredHostIds(),
    fleet,
    ownerHostId,
    args.fallbackAccepts,
  );
  if (liveHostId === null) return { hostId: ownerHostId, fellBack: false };
  return { hostId: liveHostId, fellBack: true };
}

/**
 * The host an agent-record archive or delete would be sent to right now:
 * {@link routeOwnerGoneWrite} with the method's floor as the fallback's test.
 * The send path and every affordance gate read this one answer, so a control
 * is offered on the evidence of the host that will serve it - not of an owner
 * that is down and may never have handshaken with this renderer.
 */
export function recordWriteServingHostId(args: {
  readonly ownerHostId: string;
  readonly method: OwnerGoneRecordWriteMethod;
  readonly fleet: SurfacePinFleetView;
  readonly preferredHostIds: () => readonly (string | null)[];
}): string {
  return routeRecordWrite(args).hostId;
}

/** {@link recordWriteServingHostId}, with whether the owner was passed over. */
export function routeRecordWrite(args: {
  readonly ownerHostId: string;
  readonly method: OwnerGoneRecordWriteMethod;
  readonly fleet: SurfacePinFleetView;
  readonly preferredHostIds: () => readonly (string | null)[];
}): OwnerGoneWriteRoute {
  return routeOwnerGoneWrite({
    ownerHostId: args.ownerHostId,
    fleet: args.fleet,
    preferredHostIds: args.preferredHostIds,
    fallbackAccepts: (hostId) =>
      hostTakesOwnerGoneRecordWrite(hostId, args.method),
  });
}

/**
 * Fires when either input of {@link recordWriteServingHostId} can have
 * changed: the authority's fleet, or any host's negotiated manifest.
 */
export function subscribeRecordWriteRouting(listener: () => void): () => void {
  const unsubscribeFleet = useSelectionAuthorityStore.subscribe(listener);
  const unsubscribeManifests = subscribeNegotiatedManifests(listener);
  return () => {
    unsubscribeFleet();
    unsubscribeManifests();
  };
}
