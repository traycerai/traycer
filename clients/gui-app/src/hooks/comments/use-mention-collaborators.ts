import { useMemo } from "react";
import { useEpicCollaboratorsQuery } from "@/hooks/epics/use-epic-collaborators-query";
import { useHostClient } from "@/lib/host";

/**
 * Mention-picker view over the existing `epic.listCollaborators` query.
 * Returns the flat per-user rows the Tiptap mention extension's suggestion
 * source needs. Re-uses the Sharing-panel query so the picker shares the
 * same host-scoped cache entry - no extra RPC traffic when both views are
 * mounted.
 */
export interface MentionCollaborator {
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
}

export function useMentionCollaborators(
  epicId: string,
): ReadonlyArray<MentionCollaborator> {
  // App-active host, matching the Sharing panel this cache entry is shared
  // with (see the hook's doc for why the chat tree differs).
  const client = useHostClient();
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
