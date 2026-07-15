import { useMemo } from "react";
import {
  useMutationState,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useHostClient } from "@/lib/host";
import { toastFromHostError } from "@/lib/host-error-toast";
import {
  cloudEpicTasksQueryKeyMatchesScope,
  setEpicPinnedInCloudTaskCaches,
} from "@/lib/cloud-epic-tasks-query/cache";
import { epicMutationKeys } from "@/lib/query-keys";
import {
  resetCloudEpicTasksPagesForScope,
  setCloudEpicTasksPagePinned,
} from "@/stores/epics/cloud-epic-tasks-pages-store";

interface SetEpicPinnedMutationContext {
  readonly hostId: string | null;
  readonly userId: string | null;
}

interface SetEpicPinnedVariables {
  readonly epicId: string;
  readonly pinned: boolean;
}

/**
 * Personal, default-host-scoped history pin mutation.
 *
 * Optimistic by design (the justified response-equals-state case: the RPC's
 * `{ pinned }` response is exactly the bit the request wrote): `onMutate`
 * flips the row in the scoped first-page query cache and in every retained
 * "Show more" tail so the toggle renders instantly, and `onError` restores
 * the previous state with the inverse patch (each row's control is disabled
 * while its own mutation is pending, so the pre-mutate state is exactly the
 * opposite bit) plus the error toast.
 *
 * `onSuccess` then reconciles in the background: a pin reorders rows across
 * server page boundaries, which makes every retained pagination cursor
 * stale (a later "Show more" against an old cursor could silently skip
 * rows), so the scope's tails are reset - rejecting in-flight ones via the
 * generation guard - and the active first page refetches with no pending UI
 * while the optimistic state keeps rendering.
 */
export function useEpicSetPinned() {
  const client = useHostClient();
  const queryClient = useQueryClient();
  return useHostMutation({
    client,
    method: "epic.setPinned",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: epicMutationKeys.setPinned(),
      onMutate: (
        variables: SetEpicPinnedVariables,
      ): SetEpicPinnedMutationContext => {
        const hostId = client.getActiveHostId();
        const userId = client.getRequestContextUserId();
        if (hostId !== null && userId !== null) {
          applyPinnedPatch(
            queryClient,
            { hostId, userId },
            variables.epicId,
            variables.pinned,
          );
        }
        return { hostId, userId };
      },
      onSuccess: async (
        _response,
        _variables,
        ctx: SetEpicPinnedMutationContext,
      ) => {
        if (ctx.hostId === null || ctx.userId === null) return;
        const scope = { hostId: ctx.hostId, userId: ctx.userId };
        resetCloudEpicTasksPagesForScope(ctx.hostId, ctx.userId);
        queryClient.removeQueries({
          type: "inactive",
          predicate: (query) =>
            cloudEpicTasksQueryKeyMatchesScope(query.queryKey, scope),
        });
        await queryClient.invalidateQueries({
          type: "active",
          predicate: (query) =>
            cloudEpicTasksQueryKeyMatchesScope(query.queryKey, scope),
        });
      },
      onError: (
        error,
        variables: SetEpicPinnedVariables,
        ctx: SetEpicPinnedMutationContext | undefined,
      ) => {
        if (ctx !== undefined && ctx.hostId !== null && ctx.userId !== null) {
          applyPinnedPatch(
            queryClient,
            { hostId: ctx.hostId, userId: ctx.userId },
            variables.epicId,
            !variables.pinned,
          );
        }
        toastFromHostError(error, "Couldn't update pinned task.");
      },
    },
  });
}

function applyPinnedPatch(
  queryClient: QueryClient,
  scope: { readonly hostId: string; readonly userId: string },
  epicId: string,
  pinned: boolean,
): void {
  setEpicPinnedInCloudTaskCaches(queryClient, scope, epicId, pinned);
  setCloudEpicTasksPagePinned(scope.hostId, scope.userId, epicId, pinned);
}

/**
 * epicIds with an in-flight `epic.setPinned` mutation. `useEpicSetPinned()`
 * is a single mutation instance shared across every history row, so reading
 * `.isPending`/`.variables` off it only ever reflects the most-recently
 * fired call - a second row's click would make an earlier still-pending row
 * read as idle. Reading every pending mutation with this shared key from the
 * mutation cache instead lets each row track its own request independently.
 */
export function usePendingSetPinnedEpicIds(): ReadonlySet<string> {
  const pendingVariables = useMutationState({
    filters: {
      mutationKey: epicMutationKeys.setPinned(),
      status: "pending",
    },
    select: (mutation) => mutation.state.variables,
  });

  return useMemo(
    () =>
      new Set(
        pendingVariables.flatMap((variables) =>
          isSetEpicPinnedVariables(variables) ? [variables.epicId] : [],
        ),
      ),
    [pendingVariables],
  );
}

function isSetEpicPinnedVariables(
  value: unknown,
): value is SetEpicPinnedVariables {
  if (value === null || typeof value !== "object") return false;
  return (
    "epicId" in value &&
    typeof value.epicId === "string" &&
    "pinned" in value &&
    typeof value.pinned === "boolean"
  );
}
