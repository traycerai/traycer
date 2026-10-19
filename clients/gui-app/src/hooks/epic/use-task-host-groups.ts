import { useMemo } from "react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { hostUnavailability } from "@traycer-clients/shared/host-client/remote-fetcher";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import type { TaskHostRow } from "@traycer/protocol/host/task-host-summary";
import {
  taskHostGroups,
  type TaskHostDirectoryFact,
  type TaskHostGroup,
} from "@/components/epic-canvas/sidebar/task-host-groups-model";
import {
  useCloudChatHasCloudAuthorization,
  useCloudChatList,
} from "@/hooks/chats/use-cloud-chat-queries";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { useEpicShareableTeams } from "@/hooks/epic/use-epic-shareable-teams";
import { useEpicCollaboratorsQuery } from "@/hooks/epics/use-epic-collaborators-query";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useAuthStore } from "@/stores/auth/auth-store";

const EMPTY_CHATS: readonly CloudChatSummary[] = [];
const EMPTY_DIRECTORY: readonly HostDirectoryEntry[] = [];

/** A directory entry's state: `null` when the directory cannot say. */
function directoryFact(entry: HostDirectoryEntry): TaskHostDirectoryFact {
  const unavailability = hostUnavailability(entry);
  if (unavailability === null) return { label: entry.label, state: "online" };
  if (unavailability === "offline") {
    return { label: entry.label, state: "offline" };
  }
  return { label: entry.label, state: null };
}

/** The task's chats per owning host, as the Agents tree lists them. */
function agentCounts(
  chats: readonly CloudChatSummary[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const chat of chats) {
    // The tree hides archived chats by default; so does the count.
    if (chat.isArchived) continue;
    counts.set(chat.ownerHostId, (counts.get(chat.ownerHostId) ?? 0) + 1);
  }
  return counts;
}

/**
 * The task's hosts grouped by owner, as the Hosts section shows them, each
 * input from a source the person is authorized for. Shared with the
 * composer's mirror line so the line names a host the way the section does.
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
  const chats = useCloudChatList({
    client,
    taskId: epicId,
    enabled: hosts !== null,
  }).data?.chats;
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
      directory: new Map(
        directory.map((entry) => [entry.hostId, directoryFact(entry)] as const),
      ),
      agentCountByHostId: agentCounts(chats ?? EMPTY_CHATS),
    });
  }, [hosts, viewerUserId, shareableTeams, collaborators, directory, chats]);
}
