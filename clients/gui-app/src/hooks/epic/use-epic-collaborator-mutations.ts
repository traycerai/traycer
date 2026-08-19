import { useQueryClient } from "@tanstack/react-query";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { toastFromHostError } from "@/lib/host-error-toast";
import { queryKeys } from "@/lib/query-keys";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { projectCollaborators } from "@/hooks/epics/use-epic-collaborators-query";

/**
 * SESSION-SCOPED, all three. These hooks are mounted by exactly one surface -
 * the Epic Sharing panel, inside the Epic canvas - and the collaborator list
 * that panel renders is read on the Epic session's client, so the mutations
 * that edit that list must land on the same host or the cache write below
 * targets a key nobody is reading. They used to resolve `useHostClient()`, the
 * app-wide host, which is not the session's host for the whole of a re-point
 * that is establishing and after one that failed (`EpicSessionProvider` keeps
 * the previous handle rendered; only the tile subtree is made inert). The
 * Sharing panel's own comment recorded this as deferred work; this is it.
 *
 * `hostId` is captured at mutate time, per the host-swap convention, so a
 * swap while the request is in flight cannot write another machine's cache.
 */
/**
 * Mutation hook for `epic.grantAccess`.
 *
 * On success, writes the returned `ListEpicCollaboratorsResponse` directly
 * into the `epic.listCollaborators` cache entry so the Sharing panel updates
 * immediately without a separate network round-trip.
 */
export function useEpicGrantAccess() {
  const client = useEpicSessionHostClient();
  const queryClient = useQueryClient();
  return useHostMutation({
    client,
    method: "epic.grantAccess",
    mapVariables: (variables) => variables,
    options: {
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onSuccess: (data, variables, ctx) => {
        const collaborators = projectCollaborators(data.collaborators);
        if (variables.input.kind === "team") {
          const input = variables.input;
          const wasGranted = collaborators.teams.some(
            (team) => team.teamId === input.teamId && team.role === input.role,
          );
          if (wasGranted) {
            Analytics.getInstance().track(AnalyticsEvent.ShareInviteSent, {
              target: "team",
              role: input.role,
            });
          }
        }
        const hostId = ctx.hostId;
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
  const client = useEpicSessionHostClient();
  const queryClient = useQueryClient();
  return useHostMutation({
    client,
    method: "epic.batchUpdateRoles",
    mapVariables: (variables) => variables,
    options: {
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onSuccess: (data, variables, ctx) => {
        if (variables.input.intent !== "invite") {
          const collaborators = projectCollaborators(data.collaborators);
          variables.input.changes.forEach((change) => {
            const wasChanged =
              change.teamId !== undefined
                ? collaborators.teams.some(
                    (team) =>
                      team.teamId === change.teamId &&
                      team.role === change.newRole,
                  )
                : collaborators.directUsers.some(
                    (user) =>
                      user.userId === change.userId &&
                      user.role === change.newRole,
                  );
            if (!wasChanged) return;
            Analytics.getInstance().track(AnalyticsEvent.ShareRoleChanged, {
              target: change.teamId === undefined ? "person" : "team",
              role: change.newRole,
            });
          });
        }
        const hostId = ctx.hostId;
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
  const client = useEpicSessionHostClient();
  const queryClient = useQueryClient();
  return useHostMutation({
    client,
    method: "epic.revokeCollaborator",
    mapVariables: (variables) => variables,
    options: {
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onSuccess: (data, variables, ctx) => {
        const collaborators = projectCollaborators(data.collaborators);
        const input = variables.input;
        const wasRevoked =
          input.kind === "team"
            ? !collaborators.teams.some((team) => team.teamId === input.teamId)
            : !collaborators.directUsers.some(
                (user) => user.userId === input.userId,
              );
        if (wasRevoked) {
          Analytics.getInstance().track(AnalyticsEvent.ShareAccessRevoked, {
            target: input.kind === "team" ? "team" : "person",
          });
        }
        const hostId = ctx.hostId;
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
