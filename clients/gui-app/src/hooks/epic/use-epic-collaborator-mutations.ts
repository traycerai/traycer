import { useQueryClient } from "@tanstack/react-query";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useHostClient } from "@/lib/host/runtime";
import { toastFromHostError } from "@/lib/host-error-toast";
import { queryKeys } from "@/lib/query-keys";

/**
 * Mutation hook for `epic.grantAccess`.
 *
 * On success, writes the returned `ListEpicCollaboratorsResponse` directly
 * into the `epic.listCollaborators` cache entry so the Sharing panel updates
 * immediately without a separate network round-trip.
 */
export function useEpicGrantAccess() {
  const client = useHostClient();
  const queryClient = useQueryClient();
  return useHostMutation({
    client,
    method: "epic.grantAccess",
    mapVariables: (variables) => variables,
    options: {
      onSuccess: (data, variables) => {
        const hostId = client.getActiveHostId();
        if (hostId === null) return;
        queryClient.setQueryData(
          queryKeys.hostMethod<HostRpcRegistry, "epic.listCollaborators">(
            hostId,
            "epic.listCollaborators",
            { epicId: variables.epicId },
          ),
          data,
        );
      },
      onError: (error) => {
        toastFromHostError(error, "Couldn't invite collaborators.");
      },
    },
  });
}

/**
 * Mutation hook for `epic.batchUpdateRoles`.
 *
 * On success, writes the returned `ListEpicCollaboratorsResponse` directly
 * into the `epic.listCollaborators` cache entry.
 */
export function useEpicBatchUpdateRoles() {
  const client = useHostClient();
  const queryClient = useQueryClient();
  return useHostMutation({
    client,
    method: "epic.batchUpdateRoles",
    mapVariables: (variables) => variables,
    options: {
      onSuccess: (data, variables) => {
        const hostId = client.getActiveHostId();
        if (hostId === null) return;
        queryClient.setQueryData(
          queryKeys.hostMethod<HostRpcRegistry, "epic.listCollaborators">(
            hostId,
            "epic.listCollaborators",
            { epicId: variables.epicId },
          ),
          data,
        );
      },
      onError: (error) => {
        toastFromHostError(error, "Couldn't update role.");
      },
    },
  });
}

/**
 * Mutation hook for `epic.revokeCollaborator`.
 *
 * On success, writes the returned `ListEpicCollaboratorsResponse` directly
 * into the `epic.listCollaborators` cache entry.
 */
export function useEpicRevokeCollaborator() {
  const client = useHostClient();
  const queryClient = useQueryClient();
  return useHostMutation({
    client,
    method: "epic.revokeCollaborator",
    mapVariables: (variables) => variables,
    options: {
      onSuccess: (data, variables) => {
        const hostId = client.getActiveHostId();
        if (hostId === null) return;
        queryClient.setQueryData(
          queryKeys.hostMethod<HostRpcRegistry, "epic.listCollaborators">(
            hostId,
            "epic.listCollaborators",
            { epicId: variables.epicId },
          ),
          data,
        );
      },
      onError: (error) => {
        toastFromHostError(error, "Couldn't remove collaborator.");
      },
    },
  });
}
