import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import {
  useEpicBatchUpdateRoles,
  useEpicGrantAccess,
} from "@/hooks/epic/use-epic-collaborator-mutations";
import { projectCollaborators } from "@/hooks/epics/use-epic-collaborators-query";
import {
  collaboratorMatchesInvite,
  inviteKey,
  type QueuedInvite,
} from "@/lib/epic-invites";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { appLogger } from "@/lib/logger";
import { hostQueryKeys, epicMutationKeys } from "@/lib/query-keys";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

export interface SendQueuedInvitesArgs {
  readonly epicId: string;
  readonly queuedInvites: ReadonlyArray<QueuedInvite>;
  readonly existingByInviteKey: ReadonlyMap<string, string>;
}

export interface SendQueuedInvitesResult {
  readonly succeededInviteKeys: ReadonlySet<string>;
  readonly succeededNewInvites: ReadonlyArray<QueuedInvite>;
  readonly succeededReInvites: ReadonlyArray<QueuedInvite>;
  readonly failedInvites: ReadonlyArray<QueuedInvite>;
}

interface SendQueuedInvitesContext {
  readonly hostId: string | null;
}

export interface QueuedReInviteGroup {
  readonly userId: string;
  readonly invite: QueuedInvite;
  readonly matchingInvites: ReadonlyArray<QueuedInvite>;
}

export interface QueuedInviteBatches {
  readonly reInvites: ReadonlyArray<QueuedReInviteGroup>;
  readonly newInvites: ReadonlyArray<QueuedInvite>;
}

/**
 * Splits the queue into re-invites (existing user ids) and net-new identifiers,
 * then runs `epic.batchUpdateRoles` and `epic.grantAccess` sequentially so
 * mid-queue failures land in the structured per-invite result. The caller
 * owns the user-facing summary toasts.
 */
export function useEpicSendQueuedInvites(): UseMutationResult<
  SendQueuedInvitesResult,
  Error,
  SendQueuedInvitesArgs,
  SendQueuedInvitesContext
> {
  const batchUpdateRoles = useEpicBatchUpdateRoles();
  const grantAccess = useEpicGrantAccess();
  const client = useHostClient();
  const queryClient = useQueryClient();

  return useMutation<
    SendQueuedInvitesResult,
    Error,
    SendQueuedInvitesArgs,
    SendQueuedInvitesContext
  >({
    mutationKey: epicMutationKeys.sendQueuedInvites(),
    onMutate: () => ({ hostId: client.getActiveHostId() }),
    mutationFn: async ({ epicId, queuedInvites, existingByInviteKey }) => {
      const inviteBatches = buildQueuedInviteBatches({
        queuedInvites,
        existingByInviteKey,
      });

      const succeededInviteKeys = new Set<string>();
      const succeededNewInvites: QueuedInvite[] = [];
      const succeededReInvites: QueuedInvite[] = [];

      if (inviteBatches.reInvites.length > 0) {
        try {
          const response = await batchUpdateRoles.mutateAsync({
            epicId,
            input: {
              intent: "invite",
              changes: inviteBatches.reInvites.map((item) => ({
                userId: item.userId,
                newRole: item.invite.role,
              })),
            },
          });
          const directUsers = projectCollaborators(
            response.collaborators,
          ).directUsers;
          inviteBatches.reInvites.forEach((item) => {
            const succeeded = directUsers.some(
              (row) =>
                row.userId === item.userId && row.role === item.invite.role,
            );
            if (succeeded) {
              item.matchingInvites.forEach((invite) => {
                succeededInviteKeys.add(inviteKey(invite));
              });
              succeededReInvites.push(item.invite);
            }
          });
        } catch (error) {
          appLogger.errorSummary(
            "[epic-invites] queued re-invite batch failed",
            {
              epicId,
              inviteCount: inviteBatches.reInvites.length,
            },
            error,
          );
          // Underlying hook owns the generic error toast.
        }
      }

      if (inviteBatches.newInvites.length > 0) {
        try {
          const response = await grantAccess.mutateAsync({
            epicId,
            input: {
              kind: "users",
              invites: inviteBatches.newInvites.map((invite) => ({
                identifier: invite.identifier,
                identifierType: invite.identifierType,
                role: invite.role,
              })),
            },
          });
          const directUsers = projectCollaborators(
            response.collaborators,
          ).directUsers;
          inviteBatches.newInvites.forEach((invite) => {
            const succeeded = directUsers.some(
              (row) =>
                collaboratorMatchesInvite(row, invite) &&
                row.role === invite.role,
            );
            if (succeeded) {
              succeededInviteKeys.add(inviteKey(invite));
              succeededNewInvites.push(invite);
            }
          });
        } catch (error) {
          appLogger.errorSummary(
            "[epic-invites] queued new-invite batch failed",
            {
              epicId,
              inviteCount: inviteBatches.newInvites.length,
            },
            error,
          );
          // Underlying hook owns the generic error toast.
        }
      }

      const failedInvites = queuedInvites.filter(
        (invite) => !succeededInviteKeys.has(inviteKey(invite)),
      );

      return {
        succeededInviteKeys,
        succeededNewInvites,
        succeededReInvites,
        failedInvites,
      };
    },
    onSuccess: (result, _variables, ctx) => {
      result.succeededNewInvites.forEach((invite) => {
        Analytics.getInstance().track(AnalyticsEvent.ShareInviteSent, {
          target: "person",
          role: invite.role,
        });
      });
      result.succeededReInvites.forEach((invite) => {
        Analytics.getInstance().track(AnalyticsEvent.ShareRoleChanged, {
          target: "person",
          role: invite.role,
        });
      });
      if (ctx.hostId === null) return;
      void queryClient.invalidateQueries({
        queryKey: hostQueryKeys.methodScope<keyof HostRpcRegistry & string>(
          ctx.hostId,
          "epic.listCollaborators",
        ),
      });
    },
  });
}

export function buildQueuedInviteBatches(args: {
  readonly queuedInvites: ReadonlyArray<QueuedInvite>;
  readonly existingByInviteKey: ReadonlyMap<string, string>;
}): QueuedInviteBatches {
  const reInviteByUserId = new Map<
    string,
    { invite: QueuedInvite; matchingInvites: QueuedInvite[] }
  >();
  const reInviteKeySet = new Set<string>();

  args.queuedInvites.forEach((invite) => {
    const key = inviteKey(invite);
    const userId = args.existingByInviteKey.get(key);
    if (userId === undefined) return;
    reInviteKeySet.add(key);
    const existing = reInviteByUserId.get(userId);
    if (existing === undefined) {
      reInviteByUserId.set(userId, { invite, matchingInvites: [invite] });
      return;
    }
    existing.matchingInvites.push(invite);
  });

  return {
    reInvites: Array.from(reInviteByUserId, ([userId, item]) => ({
      userId,
      invite: item.invite,
      matchingInvites: item.matchingInvites,
    })),
    newInvites: args.queuedInvites.filter(
      (invite) => !reInviteKeySet.has(inviteKey(invite)),
    ),
  };
}
