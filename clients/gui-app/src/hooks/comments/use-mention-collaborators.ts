import { useMemo } from "react";
import { useEpicCollaboratorsQuery } from "@/hooks/epics/use-epic-collaborators-query";

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
  const { data } = useEpicCollaboratorsQuery(epicId, {
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
