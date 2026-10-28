import type { MessageSegment } from "@/stores/composer/chat-store";

/**
 * Whether a rendered segment holds a given protocol block id, at any depth.
 *
 * A block id names a protocol block, and the rendered projection nests them: a
 * subagent card owns `children` (themselves nestable), a file-change group owns
 * `files`, and a promoted run owns `segments`. So a navigation target - a
 * cross-tile jump, a comm-graph event, a notification - can name an id that
 * belongs to a segment several levels inside the turn.
 *
 * One definition, because two readers resolve the same id and must agree:
 * `messageIdForBlock` decides which MESSAGE holds the block, and
 * `assistantTurnPartIndexOfSegment` decides which PART of that message's row
 * draws it. A shallower rule in either one sends a jump to a row that does not
 * hold the block it named.
 */
export type SegmentBlockNode =
  | MessageSegment
  | {
      readonly id: string;
      readonly children: ReadonlyArray<SegmentBlockNode>;
    }
  | {
      readonly id: string;
      readonly files: ReadonlyArray<SegmentBlockNode>;
    }
  | {
      readonly id: string;
      readonly segments: ReadonlyArray<SegmentBlockNode>;
    }
  | {
      readonly id: string;
      readonly group: {
        readonly segments: ReadonlyArray<SegmentBlockNode>;
      };
    };

/** The nested nodes one segment owns, whatever shape it nests them in. */
export function segmentBlockChildren(
  segment: SegmentBlockNode,
): ReadonlyArray<SegmentBlockNode> {
  if ("children" in segment) return segment.children;
  if ("files" in segment) return segment.files;
  if ("segments" in segment) return segment.segments;
  if ("group" in segment) return segment.group.segments;
  return [];
}

/** See the module doc: the one nesting-aware block-id test. */
export function segmentContainsBlockId(
  segment: SegmentBlockNode,
  blockId: string,
): boolean {
  if (segment.id === blockId) return true;
  return segmentBlockChildren(segment).some((child) =>
    segmentContainsBlockId(child, blockId),
  );
}
