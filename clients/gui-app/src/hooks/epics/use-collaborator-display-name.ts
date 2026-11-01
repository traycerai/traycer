import { useMemo } from "react";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import {
  useEpicCollaboratorsQuery,
  type EpicCollaboratorView,
} from "@/hooks/epics/use-epic-collaborators-query";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

/**
 * A collaborator's name as a transcript's sender label prints it - their
 * display name, else their email - or `null` when the task's collaborator
 * list does not name them. The list's last fallback is the bare user id,
 * which names nobody a reader knows, so it reads `null` too.
 */
function collaboratorDisplayName(
  rows: ReadonlyArray<EpicCollaboratorView>,
  userId: string | null,
): string | null {
  if (userId === null) return null;
  const row = rows.find((collaborator) => collaborator.userId === userId);
  if (row === undefined) return null;
  const name = row.displayName.trim();
  return name.length === 0 || name === userId ? null : name;
}

/**
 * {@link collaboratorDisplayName} over the task's `epic.listCollaborators`,
 * asked of the Epic session's host behind the cloud verdict exactly as the
 * Agents tree asks it, so every surface shares that one cache entry and the
 * name agrees with the sender label on the same person's messages.
 */
export function useCollaboratorDisplayName(
  epicId: string,
  userId: string | null,
): string | null {
  const cloudAuthorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const { data } = useEpicCollaboratorsQuery(epicId, {
    client: useEpicSessionHostClient(),
    enabled: cloudAuthorized && epicId.length > 0,
    poll: undefined,
    staleTime: undefined,
  });
  return useMemo(
    () =>
      data === undefined
        ? null
        : collaboratorDisplayName(data.flatRows, userId),
    [data, userId],
  );
}
