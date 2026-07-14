import { useMemo } from "react";
import { useMutationState, useQueryClient } from "@tanstack/react-query";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useHostClient } from "@/lib/host";
import { toastFromHostError } from "@/lib/host-error-toast";
import { cloudEpicTasksQueryKeyMatchesScope } from "@/lib/cloud-epic-tasks-query/cache";
import { epicMutationKeys } from "@/lib/query-keys";
import { resetCloudEpicTasksPagesForScope } from "@/stores/epics/cloud-epic-tasks-pages-store";

interface SetEpicPinnedMutationContext {
  readonly hostId: string | null;
  readonly userId: string | null;
}

interface SetEpicPinnedVariables {
  readonly epicId: string;
  readonly pinned: boolean;
}

/** Personal, default-host-scoped history pin mutation. */
export function useEpicSetPinned() {
  const client = useHostClient();
  const queryClient = useQueryClient();
  return useHostMutation({
    client,
    method: "epic.setPinned",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: epicMutationKeys.setPinned(),
      onMutate: () => ({
        hostId: client.getActiveHostId(),
        userId: client.getRequestContextUserId(),
      }),
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
      onError: (error) => {
        toastFromHostError(error, "Couldn't update pinned task.");
      },
    },
  });
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
