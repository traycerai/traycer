import { useQueryClient } from "@tanstack/react-query";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { type HostRpcRegistry } from "@/lib/host";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { cloudEpicTasksLastViewedQueryKeyMatchesScope } from "@/lib/cloud-epic-tasks-query/cache";
import { epicMutationKeys } from "@/lib/query-keys";
import { resetLastViewedCloudEpicTasksPagesForScope } from "@/stores/epics/cloud-epic-tasks-pages-store";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

/**
 * Thrown from `onMutate` when the session holds no cloud verdict at dispatch
 * AND the epic is not the local-homed one carved out below.
 *
 * `epic.recordViewed` writes personal cloud recency through a local-host
 * connection that carries no renderer verdict of its own, and its one caller
 * is a passive route effect gated on a RENDER-time verdict. React can flush
 * an already-committed effect before it renders the store update that
 * withdrew the verdict, so the render gate alone lets a demotion that lands
 * between commit and effect dispatch on a bearer the cloud stopped vouching
 * for. Re-read here, at dispatch, in the one mutation every caller shares -
 * the same shape as `EPIC_PIN_UNAUTHORIZED_MESSAGE`.
 *
 * It is NOT unconditionally a cloud write. The host's `epic.recordViewed`
 * resolver admits a local-homed epic on the local `epicHomeVerdict` alone and
 * returns before it builds any cloud header, so recording recency for such an
 * epic spends no cloud capability - and refusing it would leave an offline or
 * free-tier user's own machine unable to remember what they just looked at.
 * Unlike `epic.setPinned`, that local arm needs no version gate: it exists on
 * every host this client negotiates with, so the caller's local-home fact is
 * the whole predicate.
 */
export const EPIC_RECORD_VIEWED_UNAUTHORIZED_MESSAGE =
  "record-viewed refused: the session holds no cloud verdict";

interface RecordEpicViewedMutationContext {
  readonly hostId: string;
  readonly userId: string | null;
}

interface RecordEpicViewedVariables {
  readonly epicId: string;
  /**
   * Whether the epic is durable on the serving host's disk - the caller's own
   * reading, from the live session that owns that fact.
   *
   * Taken from the caller rather than re-derived here, exactly as
   * `SetEpicPinnedVariables.isLocalHome` is: the route decided admission from
   * this reading, and a second derivation at dispatch is how the two come to
   * disagree. Stripped by `mapVariables` and never sent - the host reads
   * durability from its own `epicHomeVerdict`, and a client-asserted home is
   * not something it has any business trusting.
   */
  readonly isLocalHome: boolean;
  /** The accepted peer can establish that the account view row was written. */
  readonly refreshAccountHistory?: boolean;
}

/** Records task recency on the named serving peer captured for the open. */
export function useEpicRecordViewed(hostId: string | null) {
  const namedClient = useHostClientForHostId(hostId);
  const client = hostId === null ? null : namedClient;
  const queryClient = useQueryClient();
  // Generics spelled out for the same reason as `useEpicSetPinned`:
  // `RecordEpicViewedVariables` is wider than the request schema, and
  // `TVariables` defaults to the request shape when nothing names it.
  return useHostMutation<
    HostRpcRegistry,
    "epic.recordViewed",
    RecordEpicViewedMutationContext,
    RecordEpicViewedVariables
  >({
    client,
    method: "epic.recordViewed",
    // `isLocalHome` is a DISPATCH-side fact, not a request field: the wire
    // shape stays `{ epicId }` exactly as the schema declares it.
    mapVariables: ({ epicId }) => ({ epicId }),
    options: {
      mutationKey: epicMutationKeys.recordViewed(),
      onMutate: (
        variables: RecordEpicViewedVariables,
      ): RecordEpicViewedMutationContext => {
        if (
          hostId === null ||
          (!variables.isLocalHome &&
            !authorizesCloudCapability(useAuthStore.getState().status))
        ) {
          throw new Error(EPIC_RECORD_VIEWED_UNAUTHORIZED_MESSAGE);
        }
        return { hostId, userId: client?.getRequestContextUserId() ?? null };
      },
      onSuccess: async (_response, variables, { hostId, userId }) => {
        if (
          userId === null ||
          client?.getRequestContextUserId() !== userId ||
          useAuthStore.getState().contextMetadata?.userId !== userId
        ) {
          return;
        }
        const hostIds = new Set([hostId]);
        if (variables.refreshAccountHistory === true) {
          // History keys name the peer selected for that exact request,
          // including organization-filtered pages served by a different peer.
          const readers = queryClient.getQueryCache().findAll({
            type: "active",
            predicate: ({ queryKey }) =>
              cloudEpicTasksLastViewedQueryKeyMatchesScope(queryKey, {
                hostId: null,
                userId,
              }),
          });
          for (const { queryKey } of readers) {
            const reader = queryKey[1];
            if (typeof reader === "string") hostIds.add(reader);
          }
        }
        for (const peer of hostIds) {
          resetLastViewedCloudEpicTasksPagesForScope(peer, userId);
        }
        const matchesLastViewed = (queryKey: readonly unknown[]): boolean => {
          const peer = queryKey[1];
          return (
            typeof peer === "string" &&
            hostIds.has(peer) &&
            cloudEpicTasksLastViewedQueryKeyMatchesScope(queryKey, {
              hostId: peer,
              userId,
            })
          );
        };
        queryClient.removeQueries({
          type: "inactive",
          predicate: (query) => matchesLastViewed(query.queryKey),
        });
        await queryClient.invalidateQueries({
          type: "active",
          predicate: (query) => matchesLastViewed(query.queryKey),
        });
      },
      // Viewing is background telemetry-like state. Older hosts expose this
      // optional method as unsupported, and transient failures should not
      // interrupt navigation with a toast - nor should the dispatch-time
      // refusal above, which is the route's own decision made late.
    },
  });
}
