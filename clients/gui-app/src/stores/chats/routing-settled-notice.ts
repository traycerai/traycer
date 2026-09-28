import type { MessageSegment } from "@/stores/composer/chat-store";

/**
 * Which provider notice on a row the settled card absorbs, or `null`.
 *
 * When routing ends having tried everything, the host writes ONE
 * `fallback_settled` notice carrying a `receipt` onto the latest attempt's row
 * - the row whose error block carries the recovery actions
 * (`manualRungAnchorSegmentId`). That pair renders as one card: the notice's
 * headline and receipt above the error card's actions, where the error was.
 * Three dividers and a red error, the shape this replaces, told the user four
 * times that something ended and never in one place what to do next.
 *
 * ## The predicate
 *
 * - A `provider_notice` segment whose `receipt` is non-null. The kind alone
 *   cannot decide it: every superseded settlement notice shares the kind and
 *   carries `receipt: null`, and those stay dividers.
 * - TOP-LEVEL only (`parentId === null`). A notice on a subagent's thread
 *   nests under that subagent and is not about this turn's routing.
 * - The LAST such notice on the row, should the host ever write two: the later
 *   settlement describes the state the card's actions act on.
 *
 * Asked of ONE row's segments, never of the whole turn: the pairing is only
 * honest when both halves render together, and a steer splitting them onto two
 * rows leaves each where it is - the divider above, the error card with its
 * actions below - which is exactly the older-host shape.
 */
export function routingSettledNoticeSegmentId(
  segments: ReadonlyArray<MessageSegment>,
): string | null {
  let last: string | null = null;
  for (const segment of segments) {
    if (segment.kind !== "provider_notice") continue;
    if (segment.parentId !== null || segment.receipt === null) continue;
    last = segment.id;
  }
  return last;
}
