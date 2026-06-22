import { useMemo } from "react";
import {
  useMutationState,
  type UseMutationResult,
} from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { WorktreeBindingOwnerKind } from "@traycer/protocol/host/worktree-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { WORKTREE_BINDING_INVALIDATIONS } from "@/hooks/worktree/invalidations";
import { workspaceMutationKeys } from "@/lib/query-keys";

type RemoveBindingEntryRequest = RequestOfMethod<
  HostRpcRegistry,
  "workspaceBinding.removeEntry"
>;

export function useWorkspaceBindingRemoveEntryForClient(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "workspaceBinding.removeEntry">,
  HostRpcError,
  RemoveBindingEntryRequest,
  { readonly hostId: string | null }
> {
  return useHostScopedMutationForClient(client, {
    method: "workspaceBinding.removeEntry",
    mutationKey: workspaceMutationKeys.removeBindingEntry(),
    errorMessage: "Couldn't remove this folder.",
    invalidateMethods: WORKTREE_BINDING_INVALIDATIONS,
  });
}

/**
 * Workspace paths with an in-flight `workspaceBinding.removeEntry` for the given
 * owner. Tracks every pending removal (not just the most recent), so each
 * folder row reflects its own pending state when removals overlap - reading
 * `mutation.variables` off the single shared mutation would only ever match the
 * last-clicked row, re-enabling the others mid-flight.
 */
export function usePendingRemoveBindingEntryPaths(owner: {
  readonly epicId: string;
  readonly ownerId: string;
  readonly ownerKind: WorktreeBindingOwnerKind;
}): ReadonlySet<string> {
  const pendingVariables = useMutationState({
    filters: {
      mutationKey: workspaceMutationKeys.removeBindingEntry(),
      status: "pending",
    },
    select: (mutation) => mutation.state.variables,
  });

  return useMemo(
    () =>
      new Set(
        pendingVariables.flatMap((variables) =>
          isRemoveBindingEntryRequest(variables) &&
          variables.epicId === owner.epicId &&
          variables.ownerId === owner.ownerId &&
          variables.ownerKind === owner.ownerKind
            ? [variables.workspacePath]
            : [],
        ),
      ),
    [owner.epicId, owner.ownerId, owner.ownerKind, pendingVariables],
  );
}

function isRemoveBindingEntryRequest(
  value: unknown,
): value is RemoveBindingEntryRequest {
  if (value === null || typeof value !== "object") return false;
  return (
    "epicId" in value &&
    typeof value.epicId === "string" &&
    "ownerId" in value &&
    typeof value.ownerId === "string" &&
    "ownerKind" in value &&
    typeof value.ownerKind === "string" &&
    "workspacePath" in value &&
    typeof value.workspacePath === "string"
  );
}
