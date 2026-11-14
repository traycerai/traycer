import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  TeamChatAutoArchiveRecord,
  TeamChatAutoArchiveSetRequest,
} from "@traycer-clients/shared/host-client/team-chat-auto-archive";
import { useHostBinding } from "@/lib/host";
import { toastFromAuthError } from "@/lib/auth-error-toast";
import {
  authQueryKeys,
  chatAutoArchiveMutationKeys,
  teamChatAutoArchiveWriteScope,
} from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * A team's chat auto-archive setting, read on the person's sign-in. `null`
 * data is a team that never saved one: off, nothing archived. A refused or
 * failed read is an error, with no words of the route's own.
 */
export function useTeamChatAutoArchiveQuery(
  teamId: string | null,
): UseQueryResult<TeamChatAutoArchiveRecord | null> {
  const auth = useHostBinding()?.auth ?? null;
  const userId = useAuthStore((state) =>
    state.status === "signed-in"
      ? (state.contextMetadata?.userId ?? null)
      : null,
  );
  return useQuery(
    queryOptions({
      queryKey: authQueryKeys.teamChatAutoArchive(auth, userId, teamId ?? ""),
      queryFn: async () => {
        if (auth === null || teamId === null) throw new Error();
        const result = await auth.getTeamChatAutoArchive(teamId);
        if (result.kind !== "ok") throw new Error();
        return result.record;
      },
      enabled: auth !== null && userId !== null && teamId !== null,
    }),
  );
}

interface TeamSaveContext {
  /** Who saved, captured so a switch mid-flight writes no one else's entry. */
  readonly userId: string | null;
}

/**
 * Saves a team's setting. Last write wins on the server, so saves queue in
 * order (`teamChatAutoArchiveWriteScope`), and the saved record the server
 * answers becomes the read's entry.
 */
export function useTeamChatAutoArchiveSetMutation(
  teamId: string,
): UseMutationResult<
  TeamChatAutoArchiveRecord,
  Error,
  TeamChatAutoArchiveSetRequest,
  TeamSaveContext
> {
  const auth = useHostBinding()?.auth ?? null;
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: chatAutoArchiveMutationKeys.setTeam(teamId),
    scope: teamChatAutoArchiveWriteScope(teamId),
    onMutate: () => ({
      userId: useAuthStore.getState().contextMetadata?.userId ?? null,
    }),
    mutationFn: async (request) => {
      if (auth === null) throw new Error();
      const result = await auth.setTeamChatAutoArchive(teamId, request);
      if (result.kind !== "ok") throw new Error();
      return result.record;
    },
    onSuccess: async (record, _request, context) => {
      const queryKey = authQueryKeys.teamChatAutoArchive(
        auth,
        context.userId,
        teamId,
      );
      // An older read still in flight must not land after this save.
      await queryClient.cancelQueries({ queryKey });
      queryClient.setQueryData(queryKey, record);
    },
    onError: (error) => {
      toastFromAuthError(error, "Couldn't save the auto-archive setting.");
    },
  });
}
