import { createContext, use } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";

export interface ActivityGroupOpenState {
  readonly openIds: ReadonlySet<string>;
  readonly setOpen: (groupId: string, open: boolean) => void;
  /**
   * Groups that have RENDERED a nested reasoning header at least once.
   *
   * A group whose only segment is one reasoning block renders that block
   * unheaded, because the group's own label already says the same words. That
   * rule is a pure function of the group's shape - and the shape shrinks as well
   * as grows: a command backgrounds mid-turn, a question tool's interview lands,
   * `buildAssistantSegments` suppresses a subagent spawn tool. The group id
   * comes from the first segment, so `[reasoning, X] -> [reasoning]` happens
   * under an unchanged id. Left to shape alone the header would vanish under the
   * reader and, since a headerless body always shows, unfold a completed trace
   * nobody opened.
   *
   * So it latches, and it lives HERE rather than in component state for the
   * reason `openIds` does: chat tiles fully remount per tab switch, and
   * LegendList can unmount a row that scrolls away. A latch that died with the
   * mount would let the header vanish and the trace unfold on the next remount -
   * the same discontinuity, just deferred.
   *
   * Unlike `openIds` this is uncapped, and entries are never deleted or evicted
   * once added; see `markHeaded` and the store itself for why any bound would
   * defeat the purpose.
   */
  readonly headedIds: ReadonlySet<string>;
  /**
   * Records that these REASONING SEGMENTS showed a header of their own. Two
   * conditions, both load-bearing: the children must actually be rendered (a
   * collapsed settled group renders none, so a shrink before the first open must
   * leave no trace), and the group must actually contain reasoning that is not
   * itself headerless (a command-only group renders no reasoning header at all,
   * and marking it was both meaningless and, while this set was capped, a way to
   * spend the budget a real latch needed).
   *
   * Keyed by SEGMENT id, not by group id, and that is not cosmetic. A group's id
   * is `deriveActivityGroupRenderId(segments[0].id)` - derived from its FIRST
   * member - so a `[command, reasoning]` group whose command is later promoted
   * out becomes `[reasoning]` under a DIFFERENT id. A group-keyed latch is
   * orphaned by exactly that move, and the surviving sole reasoning block goes
   * headerless and unfolds its trace: the discontinuity this set exists to
   * prevent, arriving through the id rather than through the shape. Segment ids
   * are stable across it.
   */
  readonly markHeaded: (segmentIds: ReadonlyArray<string>) => void;
}

/**
 * Cap on remembered "expanded" activity group ids per chat-messages mount.
 * Default state is collapsed, so we only store explicit opens and drop the
 * entry when the user collapses again - this keeps the working set
 * proportional to "currently expanded", not "ever toggled". The FIFO cap
 * is belt-and-braces protection against a session that opens thousands of
 * groups without ever collapsing.
 */
export const MAX_ACTIVITY_GROUP_OPEN_IDS = 256;

export const ActivityGroupOpenStoreContext =
  createContext<StoreApi<ActivityGroupOpenState> | null>(null);

function useActivityGroupStoreFromContext(): StoreApi<ActivityGroupOpenState> {
  const store = use(ActivityGroupOpenStoreContext);
  if (store === null) {
    throw new Error(
      "activity-group-open store hook used outside ActivityGroupOpenStoreProvider",
    );
  }
  return store;
}

export function useActivityGroupOpen(groupId: string): boolean {
  const store = useActivityGroupStoreFromContext();
  return useStore(store, (state) => state.openIds.has(groupId));
}

export function useSetActivityGroupOpen(): (
  groupId: string,
  open: boolean,
) => void {
  const store = useActivityGroupStoreFromContext();
  return store.getState().setOpen;
}

/**
 * `null` for a group with no sole reasoning block to ask about - the caller only
 * has a question when the headerless rule is in play, and passing a group id
 * here would silently read the wrong keyspace.
 */
export function useActivityGroupEverHeaded(segmentId: string | null): boolean {
  const store = useActivityGroupStoreFromContext();
  return useStore(
    store,
    (state) => segmentId !== null && state.headedIds.has(segmentId),
  );
}

export function useMarkActivityGroupHeaded(): (
  segmentIds: ReadonlyArray<string>,
) => void {
  const store = useActivityGroupStoreFromContext();
  return store.getState().markHeaded;
}
