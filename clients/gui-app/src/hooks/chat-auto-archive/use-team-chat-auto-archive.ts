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
import {
  SupersededAuthEraError,
  type ChosenSignIn,
} from "@/lib/auth/auth-service";
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
        const era = auth.currentAuthEra();
        if (era.identity !== userId) throw new Error();
        const result = await auth.getTeamChatAutoArchive(teamId, era);
        if (result.kind !== "ok") throw new Error();
        return result.record;
      },
      enabled: auth !== null && userId !== null && teamId !== null,
    }),
  );
}

/**
 * One save: the choice, and the sign-in that made it, read when the person
 * chose. Saves queue, so the one sent later must still go out as them.
 */
export interface TeamChatAutoArchiveSave {
  readonly request: TeamChatAutoArchiveSetRequest;
  readonly chosenBy: ChosenSignIn;
}

/**
 * Saves a team's setting. Last write wins on the server, so saves queue in
 * order (`teamChatAutoArchiveWriteScope`), and the saved record the server
 * answers becomes the read's entry. A save whose sign-in is gone by the time
 * its turn comes is not sent, and says nothing to whoever is signed in now.
 */
export function useTeamChatAutoArchiveSetMutation(
  teamId: string,
): UseMutationResult<
  TeamChatAutoArchiveRecord,
  Error,
  TeamChatAutoArchiveSave
> {
  const auth = useHostBinding()?.auth ?? null;
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: chatAutoArchiveMutationKeys.setTeam(teamId),
    scope: teamChatAutoArchiveWriteScope(teamId),
    mutationFn: async (save) => {
      if (auth === null) throw new Error();
      const result = await auth.setTeamChatAutoArchive(
        teamId,
        save.request,
        save.chosenBy,
      );
      if (result.kind !== "ok") throw new Error();
      return result.record;
    },
    onSuccess: async (record, save) => {
      const queryKey = authQueryKeys.teamChatAutoArchive(
        auth,
        save.chosenBy.userId,
        teamId,
      );
      // An older read still in flight must not land after this save.
      await queryClient.cancelQueries({ queryKey });
      queryClient.setQueryData(queryKey, record);
    },
    onError: (error) => {
      if (error instanceof SupersededAuthEraError) return;
      toastFromAuthError(error, "Couldn't save the auto-archive setting.");
    },
  });
}
