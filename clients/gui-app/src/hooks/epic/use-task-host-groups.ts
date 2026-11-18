import { useMemo } from "react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { TaskHostRow } from "@traycer/protocol/host/task-host-summary";
import {
  taskHostGroups,
  type TaskHostGroup,
} from "@/components/epic-canvas/sidebar/task-host-groups-model";
import { useCloudChatHasCloudAuthorization } from "@/hooks/chats/use-cloud-chat-queries";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { useEpicShareableTeams } from "@/hooks/epic/use-epic-shareable-teams";
import { useEpicCollaboratorsQuery } from "@/hooks/epics/use-epic-collaborators-query";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useAuthStore } from "@/stores/auth/auth-store";

const EMPTY_DIRECTORY: readonly HostDirectoryEntry[] = [];

/**
 * The task's hosts grouped by owner, each input from a source the person
 * is authorized for. The composer's mirror line names a host from these.
 */
export function useTaskHostGroups(
  epicId: string,
  hosts: readonly TaskHostRow[] | null,
): readonly TaskHostGroup[] {
  const client = useEpicSessionHostClient();
  const cloudAuthorized = useCloudChatHasCloudAuthorization();
  const viewerUserId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  // The person's teams, projected from their team subscriptions at sign-in.
  const shareableTeams = useEpicShareableTeams();
  const collaborators = useEpicCollaboratorsQuery(epicId, {
    client,
    enabled: cloudAuthorized && hosts !== null,
    poll: false,
    staleTime: undefined,
  }).data?.flatRows;
  const directory = useHostDirectoryList().data ?? EMPTY_DIRECTORY;
  return useMemo(() => {
    if (hosts === null || viewerUserId === null) return [];
    return taskHostGroups({
      hosts,
      viewerUserId,
      teams: shareableTeams.map((team) => ({
        teamId: team.teamId,
        name: team.slug,
      })),
      collaboratorNames: new Map(
        (collaborators ?? []).flatMap((row) =>
          row.userId === null ? [] : [[row.userId, row.displayName] as const],
        ),
      ),
      directoryLabels: new Map(
        directory.map((entry) => [entry.hostId, entry.label] as const),
      ),
    });
  }, [hosts, viewerUserId, shareableTeams, collaborators, directory]);
}
