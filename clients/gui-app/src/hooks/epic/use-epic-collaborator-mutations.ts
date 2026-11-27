import { hostWriteFailureOutcome } from "@/lib/host/host-write-outcome";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import { grantedRole } from "@traycer/protocol/common/permission-role";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ListEpicCollaboratorsResponse } from "@traycer/protocol/host/epic/unary-schemas";
import { toastIndeterminateHostWrite } from "@/lib/owner-host-write-error-toast";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { toastFromHostError } from "@/lib/host-error-toast";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { projectCollaborators } from "@/hooks/epics/use-epic-collaborators-query";
import {
  captureEpicCollaboratorsCacheOwner,
  epicCollaboratorsQueryKey,
  type EpicCollaboratorsCacheOwner,
} from "@/hooks/epics/epic-collaborators-query-key";

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
 * The serving peer and viewer are captured together at mutate time so the
 * response updates the cache entry for the request that produced it.
 */

function installCollaboratorSnapshot(
  queryClient: QueryClient,
  ctx: EpicCollaboratorsCacheOwner,
  epicId: string,
  data: ListEpicCollaboratorsResponse,
): readonly unknown[] | null {
  if (ctx.hostId === null) return null;
  const queryKey = epicCollaboratorsQueryKey(
    ctx.hostId,
    epicId,
    ctx.viewerUserId,
  );
  // Cancel before installing the authoritative mutation response. Revert
  // restores the pre-fetch cache before the new response is written.
  if (ctx.hostId === POOL_HOST_ID)
    void queryClient.cancelQueries({ queryKey, exact: true }, { revert: true });
  queryClient.setQueryData(queryKey, data);
  return queryKey;
}

function settleCollaboratorWriteFailure(
  queryClient: QueryClient,
  failure: { readonly error: HostRpcError; readonly fallback: string },
  epicId: string,
  ctx: EpicCollaboratorsCacheOwner | undefined,
): void {
  if (
    ctx?.hostId !== POOL_HOST_ID ||
    hostWriteFailureOutcome(failure.error, ctx.hostId) !== "unknown"
  ) {
    toastFromHostError(failure.error, failure.fallback);
    return;
  }
  toastIndeterminateHostWrite();
  const scope = {
    queryKey: epicCollaboratorsQueryKey(ctx.hostId, epicId, ctx.viewerUserId),
    exact: true,
  };
  void queryClient.cancelQueries(scope, { revert: true });
  void queryClient.invalidateQueries(scope);
}

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
      onMutate: () => captureEpicCollaboratorsCacheOwner(client),
      onSuccess: (data, variables, ctx) => {
        const collaborators = projectCollaborators(data.collaborators);
        if (variables.input.kind === "team") {
          const input = variables.input;
          // The list the host answered with is what proves the grant landed,
          // and it only ever reports a role somebody holds.
          const role = grantedRole(input.role);
          if (
            role !== null &&
            collaborators.teams.some(
              (team) => team.teamId === input.teamId && team.role === role,
            )
          ) {
            Analytics.getInstance().track(AnalyticsEvent.ShareInviteSent, {
              target: "team",
              role,
            });
          }
        }
        const queryKey = installCollaboratorSnapshot(
          queryClient,
          ctx,
          variables.epicId,
          data,
        );
        if (
          queryKey !== null &&
          ctx.hostId === POOL_HOST_ID &&
          !data.collaboratorsAvailable
        )
          void queryClient.invalidateQueries({ queryKey, exact: true });
      },
      onError: (error, variables, ctx) =>
        settleCollaboratorWriteFailure(
          queryClient,
          { error, fallback: "Couldn't invite collaborators." },
          variables.epicId,
          ctx,
        ),
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
      onMutate: () => captureEpicCollaboratorsCacheOwner(client),
      onSuccess: (data, variables, ctx) => {
        if (variables.input.intent !== "invite") {
          const collaborators = projectCollaborators(data.collaborators);
          variables.input.changes.forEach((change) => {
            const newRole = grantedRole(change.newRole);
            const wasChanged =
              change.teamId !== undefined
                ? collaborators.teams.some(
                    (team) =>
                      team.teamId === change.teamId && team.role === newRole,
                  )
                : collaborators.directUsers.some(
                    (user) =>
                      user.userId === change.userId && user.role === newRole,
                  );
            if (newRole === null || !wasChanged) return;
            Analytics.getInstance().track(AnalyticsEvent.ShareRoleChanged, {
              target: change.teamId === undefined ? "person" : "team",
              role: newRole,
            });
          });
        }
        const queryKey = installCollaboratorSnapshot(
          queryClient,
          ctx,
          variables.epicId,
          data,
        );
        if (
          queryKey !== null &&
          ctx.hostId === POOL_HOST_ID &&
          !data.collaboratorsAvailable
        )
          void queryClient.invalidateQueries({ queryKey, exact: true });
      },
      onError: (error, variables, ctx) =>
        settleCollaboratorWriteFailure(
          queryClient,
          { error, fallback: "Couldn't update role." },
          variables.epicId,
          ctx,
        ),
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
      onMutate: () => captureEpicCollaboratorsCacheOwner(client),
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
        const queryKey = installCollaboratorSnapshot(
          queryClient,
          ctx,
          variables.epicId,
          data,
        );
        if (
          queryKey !== null &&
          ctx.hostId === POOL_HOST_ID &&
          !data.collaboratorsAvailable
        )
          void queryClient.invalidateQueries({
            queryKey,
            exact: true,
            refetchType: "none",
          });
      },
      onError: (error, variables, ctx) =>
        settleCollaboratorWriteFailure(
          queryClient,
          { error, fallback: "Couldn't remove collaborator." },
          variables.epicId,
          ctx,
        ),
    },
  });
}
