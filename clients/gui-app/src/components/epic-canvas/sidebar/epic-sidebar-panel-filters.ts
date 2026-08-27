/**
 * The facet filters for the Agents and Artifacts panels, as raw MATCH sets.
 *
 * A match set is the honest answer to "which nodes does this filter select",
 * and it is deliberately all these hooks return. Ancestor expansion - pulling
 * in a matched node's parents so a nested match stays reachable - is a
 * RENDERING concession made by whoever draws a tree, and it belongs to that
 * caller: expanding here would mean every consumer inherits path nodes that
 * matched nothing. The sidebar trees expand through
 * {@link expandMatchesToVisibleIds}, once, after intersecting every narrowing;
 * the mobile switcher's flat lists never expand at all, because a flat list has
 * no path to keep reachable.
 *
 * `null` means "not narrowing" throughout, the same no-op value an inactive
 * search uses, so the two compose without either side special-casing the other.
 */
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import type { ChatFilter } from "@/stores/epics/left-panel-store";
import { useEpicArtifactRecords, useEpicTreeIndex } from "@/lib/epic-selectors";
import { isEpicArtifactKind } from "@/lib/artifacts/node-display";
import { useEpicStore } from "@/hooks/use-epic-store";
import {
  isArtifactUnread,
  useArtifactReadStateStore,
} from "@/stores/epics/artifact-read-state-store";
import {
  CHAT_ORIGIN,
  CHAT_OWNERSHIP,
  isArtifactFilterActive,
  isChatFilterActive,
  matchesChatOwnershipFilter,
  useArtifactFilter,
  useChatFilter,
} from "@/stores/epics/left-panel-store";
import { CHATS_TREE_FILTER } from "@/components/epic-canvas/sidebar/epic-sidebar-selection";

/**
 * Heading for a surface whose list is empty only because a filter is on. It has
 * to be distinguishable from "there is nothing here yet": one is a state the
 * user created and can undo, the other is not.
 */
export const FILTERED_EMPTY_TITLE = "No matches for the current filters.";

/** Which of the Agents facets is doing the hiding, when only one of them is. */
export function chatFilterEmptyStateDescription(filter: ChatFilter): string {
  const interfaceActive = filter.origin !== CHAT_ORIGIN.All;
  const ownershipActive = filter.ownership !== CHAT_OWNERSHIP.All;
  if (interfaceActive && !ownershipActive) {
    return "The Interface filter is hiding the other agents.";
  }
  if (ownershipActive && !interfaceActive) {
    return "The Ownership filter is hiding the other agents.";
  }
  return "The current filters are hiding the other agents.";
}

/**
 * The Artifacts counterpart. Named rather than derived because its three facets
 * combine freely - a status and a kind constraint routinely narrow together, so
 * singling one out would be a guess.
 */
export const ARTIFACT_FILTER_EMPTY_DESCRIPTION =
  "Status, Type, or Read state may be hiding artifacts.";

/**
 * Nodes the active interface and ownership filters MATCH. Every local agent is
 * owned by the viewer; collaborators' agents arrive only as cloud rows, which
 * are not in the tree and answer both axes directly at their own call site.
 * `null` when neither filter is active.
 */
export function useChatFilterMatchIds(
  epicId: string,
): ReadonlySet<string> | null {
  const filter = useChatFilter(epicId);
  const liveRecords = useEpicArtifactRecords();
  return useMemo(() => {
    if (!isChatFilterActive(filter)) return null;
    const includeLocal = matchesChatOwnershipFilter(true, filter.ownership);
    return new Set(
      liveRecords.flatMap((record): string[] =>
        includeLocal &&
        CHATS_TREE_FILTER(record.type) &&
        (filter.origin === CHAT_ORIGIN.All ||
          (filter.origin === CHAT_ORIGIN.Gui && record.type === "chat") ||
          (filter.origin === CHAT_ORIGIN.Tui &&
            record.type === "terminal-agent"))
          ? [record.id]
          : [],
      ),
    );
  }, [filter, liveRecords]);
}

/**
 * Artifacts the active status / kind / read filter MATCHES. Status and read are
 * evaluated only against artifacts that carry them; specs and reviews (status
 * `null`, never assignable) drop out whenever a status constraint is set.
 * `null` when no filter is active.
 */
export function useArtifactFilterMatchIds(
  epicId: string,
): ReadonlySet<string> | null {
  const filter = useArtifactFilter(epicId);
  const artifacts = useEpicStore((s) => s.artifacts);
  const readState = useArtifactReadStateStore(
    useShallow((s) => ({
      seedAtByEpic: s.seedAtByEpic,
      lastSeenByArtifact: s.lastSeenByArtifact,
    })),
  );
  return useMemo(() => {
    if (!isArtifactFilterActive(filter)) return null;
    const statusSet = new Set<number>(filter.statuses);
    const kindSet = new Set<string>(filter.kinds);
    const matches = new Set<string>();
    for (const id of artifacts.allIds) {
      if (!Object.hasOwn(artifacts.byId, id)) continue;
      const artifact = artifacts.byId[id];
      if (kindSet.size > 0 && !kindSet.has(artifact.kind)) continue;
      if (
        statusSet.size > 0 &&
        (artifact.status === null || !statusSet.has(artifact.status))
      ) {
        continue;
      }
      if (filter.read !== "all") {
        const unread = isArtifactUnread({
          epicId,
          artifactId: artifact.id,
          updatedAt: artifact.updatedAt,
          seedAtByEpic: readState.seedAtByEpic,
          lastSeenByArtifact: readState.lastSeenByArtifact,
        });
        if (filter.read === "unread" && !unread) continue;
        if (filter.read === "read" && unread) continue;
      }
      matches.add(artifact.id);
    }
    return matches;
  }, [filter, artifacts, readState, epicId]);
}

/** One artifact a "mark all as read" pass would advance, and to what. */
export interface ArtifactReadTarget {
  readonly id: string;
  readonly updatedAt: number;
}

/**
 * The unread artifacts a panel's "Mark all as read" would clear. Read state is
 * renderer-side, so this walks the projection rather than asking the host.
 */
export function useUnreadArtifactReadTargets(
  epicId: string,
): ReadonlyArray<ArtifactReadTarget> {
  const records = useEpicArtifactRecords();
  const tree = useEpicTreeIndex();
  const readState = useArtifactReadStateStore(
    useShallow((s) => ({
      seedAtByEpic: s.seedAtByEpic,
      lastSeenByArtifact: s.lastSeenByArtifact,
    })),
  );
  return useMemo(
    () =>
      records.flatMap((record) => {
        if (!isEpicArtifactKind(record.type)) return [];
        if (!Object.hasOwn(tree.nodeById, record.id)) return [];
        const node = tree.nodeById[record.id];
        return isArtifactUnread({
          epicId,
          artifactId: record.id,
          updatedAt: node.updatedAt,
          seedAtByEpic: readState.seedAtByEpic,
          lastSeenByArtifact: readState.lastSeenByArtifact,
        })
          ? [{ id: record.id, updatedAt: node.updatedAt }]
          : [];
      }),
    [epicId, readState, records, tree],
  );
}
