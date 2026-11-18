import type { ChatActivityTimelineItem } from "@/components/chat/chat-activity-groups";

/**
 * Which part of a split assistant turn each timeline item belongs to, one
 * entry per item.
 *
 * The timeline is already ordered and an activity group never spans a text
 * segment (`buildChatActivityTimeline` flushes its run before every non-
 * activity segment), so a part is a contiguous run of items and the walk is
 * the whole rule: a new part opens at the item that draws the next cut.
 *
 * Shared between the renderer and chat find so a unit and the anchor it paints
 * on resolve to the SAME list row. Both walk their own timeline - find's is
 * built with the host's live promotion set and the renderer's with the same
 * set from context - and both land on the same answer, because promotion moves
 * a tool out of its group and pushes it at the same position rather than
 * reordering or dropping anything. The cuts themselves read nothing but the
 * segments; see `assistant-turn-parts.ts`.
 */
export function assistantTurnPartIndexes(
  timeline: ReadonlyArray<ChatActivityTimelineItem>,
  cuts: readonly string[],
): readonly number[] {
  const indexes: number[] = [];
  let part = 0;
  let nextCut = 0;
  for (const item of timeline) {
    if (
      nextCut < cuts.length &&
      item.kind === "segment" &&
      item.segment.id === cuts[nextCut]
    ) {
      part += 1;
      nextCut += 1;
    }
    indexes.push(part);
  }
  return indexes;
}
