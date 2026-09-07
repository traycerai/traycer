import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useEpicCollaboratorsQuery } from "@/hooks/epics/use-epic-collaborators-query";
import type { HostRpcRegistry } from "@/lib/host";

/** Mention-picker view over the existing `epic.listCollaborators` query. */
export interface MentionCollaborator {
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
}

export function useMentionCollaboratorsForClient(
  client: HostClient<HostRpcRegistry> | null,
  epicId: string,
): ReadonlyArray<MentionCollaborator> {
  // The COMPOSER's host, passed down by whichever surface mounted it: the collab tile's floating draft (tab client) or the Epic sidebar's reply/edit composers (session client).
  const { data } = useEpicCollaboratorsQuery(epicId, {
    client,
    poll: false,
    staleTime: undefined,
  });
  return useMemo<ReadonlyArray<MentionCollaborator>>(() => {
    if (data === undefined) return [];
    const seen = new Set<string>();
    const rows: MentionCollaborator[] = [];
    for (const entry of data.flatRows) {
      if (entry.userId === null) continue;
      if (seen.has(entry.userId)) continue;
      seen.add(entry.userId);
      rows.push({
        userId: entry.userId,
        displayName: entry.displayName,
        email: entry.email,
      });
    }
    return rows;
  }, [data]);
}
