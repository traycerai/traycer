import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useEpicCollaboratorsQuery } from "@/hooks/epics/use-epic-collaborators-query";
import type { HostRpcRegistry } from "@/lib/host";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

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

export function useMentionCollaboratorsForClient(
  client: HostClient<HostRpcRegistry> | null,
  epicId: string,
): ReadonlyArray<MentionCollaborator> {
  // The COMPOSER's host, passed down by whichever surface mounted it: the
  // collab tile's floating draft (tab client) or the Epic sidebar's reply/edit
  // composers (session client). It used to read the app-active host "matching
  // the Sharing panel this cache entry is shared with" - but the composer that
  // posts the comment is Epic-scoped, so during an A→B re-point the picker
  // offered B's collaborator list for a thread being written to A (D15).
  // `epic.listCollaborators` is a cloud read, so the picker may only populate
  // itself while this session holds a verdict. Withheld, the suggestion list
  // is empty and the popover says "No matching collaborators" - an honest
  // statement about what it can offer, and the same thing it says before the
  // query has answered. It never asserts that the epic HAS no collaborators.
  const cloudAuthorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const { data } = useEpicCollaboratorsQuery(epicId, {
    client,
    enabled: cloudAuthorized,
    poll: false,
    staleTime: undefined,
  });
  return useMemo<ReadonlyArray<MentionCollaborator>>(() => {
    // The verdict gates the PROJECTION as well as the request. `enabled:
    // false` stops the next fetch, but TanStack keeps the last `data` on the
    // shared cache entry, so a picker that read only `data` kept offering the
    // names and email addresses it loaded under the verdict the session has
    // since lost. Withheld means empty, whatever the cache still holds.
    if (!cloudAuthorized || data === undefined) return [];
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
  }, [cloudAuthorized, data]);
}
