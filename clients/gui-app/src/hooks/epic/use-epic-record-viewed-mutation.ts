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
  readonly hostId: string | null;
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
}

/**
 * Records task recency on a NAMED host.
 *
 * Takes the host rather than resolving `useHostClient()`, and that is the whole
 * correction: the local-home arm above is served out of the naming host's OWN
 * store, so a caller that learned "this epic is local-homed" from one machine's
 * live session and then dispatched on the window's effective host sent the write
 * to a process that does not have the epic. The two hosts are the same value on
 * a single-host install and on an unpinned window, which is why it survived
 * review twice - and differ exactly when a surface is pinned, which is the
 * configuration the local-first work exists for.
 *
 * `isLocalHome` and the host it came from are ONE fact; `useEpicSessionHostIdForEpic`
 * is its other half. `null` means no session has stated a home, and resolves the FOLLOWING client
 * - correct for the cloud arm, which any host proxies to the account, and
 * unreachable for the local arm, which needs an `isLocalHome` no session
 * supplied.
 *
 * Same shape as `useLocalStoreRebindMutation(hostId)`, for the same reason.
 */
export function useEpicRecordViewed(hostId: string | null) {
  // `useHostClientForHostId` rather than a directory lookup of my own: it is
  // the one sanctioned resolver for "the client for this id" (AGENTS.md), and
  // its `null` arm already falls back to the FOLLOWING client - so the
  // no-session case resolves the window's host through the same code path
  // instead of through a second decision at the call site.
  const client = useHostClientForHostId(hostId);
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
          !variables.isLocalHome &&
          !authorizesCloudCapability(useAuthStore.getState().status)
        ) {
          throw new Error(EPIC_RECORD_VIEWED_UNAUTHORIZED_MESSAGE);
        }
        return {
          hostId: client?.getActiveHostId() ?? null,
          userId: client?.getRequestContextUserId() ?? null,
        };
      },
      onSuccess: async (_response, _variables, context) => {
        if (context.hostId === null || context.userId === null) return;
        const scope = { hostId: context.hostId, userId: context.userId };
        resetLastViewedCloudEpicTasksPagesForScope(
          context.hostId,
          context.userId,
        );
        queryClient.removeQueries({
          type: "inactive",
          predicate: (query) =>
            cloudEpicTasksLastViewedQueryKeyMatchesScope(query.queryKey, scope),
        });
        await queryClient.invalidateQueries({
          type: "active",
          predicate: (query) =>
            cloudEpicTasksLastViewedQueryKeyMatchesScope(query.queryKey, scope),
        });
      },
      // Viewing is background telemetry-like state. Older hosts expose this
      // optional method as unsupported, and transient failures should not
      // interrupt navigation with a toast - nor should the dispatch-time
      // refusal above, which is the route's own decision made late.
    },
  });
}
