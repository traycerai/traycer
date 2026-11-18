import { useSyncExternalStore } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { RequiredHostMethodVersion } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type { SetChatArchivedResponse } from "@traycer/protocol/host/epic/unary-schemas";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { useEpicSessionHostId } from "@/hooks/epic/use-epic-session-host-id";
import { useHostBinding } from "@/lib/host";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";
import { readLocalHostIdSnapshot } from "@/lib/host/local-host-id-snapshot";
import {
  ownerGoneRecordWriteRequirement,
  readSelectionFleetSnapshot,
  recordWriteServingHostId,
  routeRecordWrite,
  subscribeRecordWriteRouting,
  type OwnerGoneRecordWriteMethod,
  type OwnerGoneWriteRoute,
} from "@/lib/host/owner-gone-write-routing";

export interface EpicRecordMutationTarget {
  readonly hostId: string | null;
}

export interface EpicRecordMutationContext extends EpicRecordMutationTarget {
  readonly viewerHostId: string | null;
}

/**
 * An archive or delete's context: also the host the call was sent to, which is
 * a stand-in when the owner was down, so its record lists are refreshed too.
 */
export interface EpicRecordLifecycleMutationContext extends EpicRecordMutationContext {
  readonly servingHostId: string | null;
}

/**
 * The host whose record a lifecycle write changed, by the receiving host's
 * answer - the one value every follow-up of an archive or delete is keyed to
 * (suppression, session release, tile close, confirmed removal, read-back,
 * the requested notice, and the record-list refresh beside the serving host's).
 *
 * - `applied`: the host the call was sent to (`servingHostId`, decided once
 *   where the route was chosen) enacted it on a record of its own. When that
 *   was a stand-in, authority had moved to it after the row was read.
 * - `requested`: the stand-in wrote the cloud row of the owner it reports
 *   (`ownerHostId`); a peer that predates that field reports none, and the
 *   owner the routed row names is used.
 *
 * Never the routed row's host alone: ownership can move between what the
 * client read and what the receiving host holds.
 */
export function enactedOwnerHostId(
  response: Pick<SetChatArchivedResponse, "outcome" | "ownerHostId">,
  ctx: Pick<EpicRecordLifecycleMutationContext, "hostId" | "servingHostId">,
): string | null {
  if (response.outcome === "applied") return ctx.servingHostId ?? ctx.hostId;
  return response.ownerHostId ?? ctx.hostId;
}

/**
 * Where one archive or delete goes, read from a single routing decision: the
 * client it is sent on, the floor its dispatch must clear, and the host it
 * went to (for the lifecycle callbacks' cache refresh).
 */
export interface EpicRecordLifecycleMutationRoute {
  readonly client: (
    target: EpicRecordMutationTarget,
  ) => HostClient<HostRpcRegistry> | null;
  readonly requiredHostMethodVersion: (
    target: EpicRecordMutationTarget,
  ) => RequiredHostMethodVersion | null;
  readonly servingHostId: (target: EpicRecordMutationTarget) => string | null;
}

/** Record writes follow their owner; the viewing epic may only hold a replica. */
export function useEpicRecordMutationClient(): (
  target: EpicRecordMutationTarget,
) => HostClient<HostRpcRegistry> | null {
  const sessionClient = useEpicSessionHostClient();
  const binding = useHostBinding();
  return ({ hostId }) => {
    if (hostId === null) return null;
    if (sessionClient?.getActiveHostId() === hostId) return sessionClient;
    return resolveNamedHostClient(binding, hostId);
  };
}

/**
 * Archive and delete of an agent record (`epic.setChatArchived`,
 * `epic.deleteChat`, `epic.deleteTuiAgent`, and the archive's read-back).
 *
 * Sent to the record's owner, like every record write, while the owner's
 * session can serve. When it cannot, the same call goes to a live host - the
 * epic's session host first, then this machine's host, then any other live host
 * of the account that negotiated `method`'s non-owner minor
 * (`recordWriteServingHostId`) - which writes the change to the cloud row and
 * answers `outcome: "requested"`. With no such host the call still goes to the
 * owner and fails the way it always has.
 *
 * Rename is not on this path: only archive and delete have a cloud write a
 * host other than the owner may make.
 */
export function useEpicRecordLifecycleMutationClient(
  method: OwnerGoneRecordWriteMethod,
): EpicRecordLifecycleMutationRoute {
  const sessionClient = useEpicSessionHostClient();
  const binding = useHostBinding();
  const routeFor = (
    target: EpicRecordMutationTarget,
  ): OwnerGoneWriteRoute | null => {
    if (target.hostId === null) return null;
    const known = lifecycleRoutes.get(target);
    if (known !== undefined && known.method === method) return known.route;
    const route = routeRecordWrite({
      ownerHostId: target.hostId,
      method,
      fleet: readSelectionFleetSnapshot(),
      preferredHostIds: () => [
        sessionClient?.getActiveHostId() ?? null,
        readLocalHostIdSnapshot(),
      ],
    });
    lifecycleRoutes.set(target, { method, route });
    return route;
  };
  return {
    client: (target) => {
      const route = routeFor(target);
      if (route === null) return null;
      if (sessionClient?.getActiveHostId() === route.hostId) {
        return sessionClient;
      }
      return resolveNamedHostClient(binding, route.hostId);
    },
    // The owner serves every minor of its own record. A stand-in was chosen on
    // a cached manifest, so its dispatch must still clear the non-owner minor:
    // a host that restarted older in between would otherwise apply the write
    // to its own copy and answer `applied` for a record it never held.
    requiredHostMethodVersion: (target) =>
      routeFor(target)?.fellBack === true
        ? ownerGoneRecordWriteRequirement(method)
        : null,
    servingHostId: (target) => routeFor(target)?.hostId ?? null,
  };
}

/**
 * Each dispatch's route, decided ONCE and shared by `onMutate`, the client
 * choice and the dispatch floor: TanStack hands all of them the same variables
 * object, and two reads of the fleet could disagree about where the call went.
 * Weakly keyed, so a settled dispatch's entry goes with it.
 */
const lifecycleRoutes = new WeakMap<
  EpicRecordMutationTarget,
  {
    readonly method: OwnerGoneRecordWriteMethod;
    readonly route: OwnerGoneWriteRoute;
  }
>();

/**
 * The host an archive or delete of a record owned by `ownerHostId` would be
 * sent to right now - the same answer `useEpicRecordLifecycleMutationClient`
 * sends to - for gating the control on the host that will serve it. `null`
 * when there is no owner.
 */
export function useRecordWriteServingHostId(
  ownerHostId: string | null,
  method: OwnerGoneRecordWriteMethod,
): string | null {
  const sessionHostId = useEpicSessionHostId();
  return useSyncExternalStore(subscribeRecordWriteRouting, () =>
    readRecordWriteServingHostId(ownerHostId, method, sessionHostId),
  );
}

/** {@link useRecordWriteServingHostId}, read once, for a batch's gate. */
export function readRecordWriteServingHostId(
  ownerHostId: string | null,
  method: OwnerGoneRecordWriteMethod,
  sessionHostId: string | null,
): string | null {
  if (ownerHostId === null) return null;
  return recordWriteServingHostId({
    ownerHostId,
    method,
    fleet: readSelectionFleetSnapshot(),
    preferredHostIds: () => [sessionHostId, readLocalHostIdSnapshot()],
  });
}
