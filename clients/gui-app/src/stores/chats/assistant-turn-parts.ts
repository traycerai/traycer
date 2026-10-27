import { QUEUE_PAUSED_AFTER_ERROR_CODE } from "@traycer/protocol/host/agent/gui/agent-runtime";
import { isKnownInterviewDisplayToolName } from "@traycer/protocol/host/agent/gui/interview-tools";
import { isRoutingCancellationNotice } from "@/stores/chats/hidden-transcript-notices";
import type { MessageSegment } from "@/stores/composer/chat-store";

/**
 * # One long agent turn, drawn as several list items
 *
 * The transcript list keeps only what is on screen mounted, but its unit is a
 * ROW, and a row is a whole turn. The row unit comes from the protocol's shared
 * projection (`planAssistantTurnRows`: "maximal runs of non-steer blocks"), so
 * a turn with no steer is one row however long it runs - a 48-minute turn with
 * hundreds of tool calls is one row of about 2,500 nodes, and every chat switch
 * mounts all of it.
 *
 * This module cuts such a row into PARTS, below the ordinal layer. Every part
 * carries its row's ordinal, so hydration (`visibleOrdinalRange` reads each
 * list item's ordinal), the skeleton index, the host's rows and the fold state
 * are all untouched; only what the list mounts changes.
 *
 * ## The cut rule, and why it reads nothing but the segments
 *
 * A cut comes before each text segment the turn draws on its own, except one
 * that nothing precedes - a part that renders zero items would be an empty list
 * row.
 *
 * "Nothing precedes it" has to be decided the same way by three readers that do
 * NOT share their inputs: this pass (which has only the model), the renderer
 * (which also has the thinking setting, the queue-pause line and the host's
 * live promotion set) and chat find (which has its own copies of two of those).
 * A rule that consulted any of them would let the list build four parts while
 * the body drew three, and the mismatch is unrepresentable rather than merely
 * unlikely only if the rule reads the segments alone.
 *
 * So {@link alwaysDrawnSegment} is deliberately CONSERVATIVE: every segment a
 * setting can hide counts as drawing nothing. The cost is at most a cut not
 * taken - a leading run of thinking rides along with the first text instead of
 * standing as its own part - and the guarantee is that no setting can empty a
 * part.
 *
 * Promotion is the one render-time input that needs no conservatism: promoting
 * a tool out of an activity run moves it out of the group and pushes it as its
 * own item at the same position, so it can only ever leave the item count the
 * same or raise it. It can never empty a part.
 */

/** Which slice of a split assistant turn one list row draws. */
export interface TranscriptRowPart {
  /** 0-based position among the row's parts. */
  readonly index: number;
  /** How many parts the row is drawn as. Always at least 2. */
  readonly count: number;
}

/**
 * Interned so a row rebuilt per streaming token hands the same part object
 * back, and the row components' `memo` boundary is not invalidated by it.
 */
const partsByCount = new Map<number, readonly TranscriptRowPart[]>();

export function transcriptRowPart(
  index: number,
  count: number,
): TranscriptRowPart {
  let parts = partsByCount.get(count);
  if (parts === undefined) {
    parts = Array.from({ length: count }, (_unused, at) => ({
      index: at,
      count,
    }));
    partsByCount.set(count, parts);
  }
  return parts[index];
}

/**
 * Whether this segment draws an item of its own whatever the reader's settings
 * and whatever line the chat negotiated - see the module doc for why the
 * answer has to be settings-blind.
 *
 * Exhaustive over the segment taxonomy on purpose: a new kind that draws
 * nothing and is admitted here by a permissive default would be able to empty
 * part 0.
 */
// eslint-disable-next-line complexity
function alwaysDrawnSegment(segment: MessageSegment): boolean {
  switch (segment.kind) {
    case "text":
      return true;
    case "tool":
      // A tool whose name is one of the interview display tools is dropped
      // whenever the turn also carries the interview it belongs to.
      return !isKnownInterviewDisplayToolName(segment.toolName);
    case "file_change":
    case "file_change_group":
    case "command":
    case "subagent":
    case "artifact_operation":
    case "todo":
    case "plan":
    case "compaction":
    case "autonomous_resume":
      return true;
    case "reasoning":
      // Layout > Chat > Thinking can hide it, and a run of nothing but
      // reasoning then draws no group at all.
      return false;
    case "approval":
      // A pending approval is routed to the composer-slot queue instead.
      return segment.decision !== null;
    case "interview":
      return segment.status !== "streaming";
    case "error":
      // The queue-pause notice is drawn only on a line with no `pausedReason`.
      return segment.code !== QUEUE_PAUSED_AFTER_ERROR_CODE;
    case "provider_notice":
      return !isRoutingCancellationNotice(segment);
    case "setup-card":
    case "forked-chat-link":
    case "imported-chat-marker":
    case "auto-judge-unattended-denial":
    case "auto-judge-notice":
      // Synthesized `role: "system"` rows only; an assistant turn's renderer
      // draws nothing for them.
      return false;
    default: {
      const _exhaustive: never = segment;
      void _exhaustive;
      return false;
    }
  }
}

/** Where one part's segments sit in the turn: `[from, to)`. */
export interface AssistantTurnPartRange {
  readonly from: number;
  readonly to: number;
}

interface AssistantTurnPartPlan {
  /**
   * The ids of the text segments that START a part, in order. Empty for a turn
   * that stays one row.
   *
   * APPEND-ONLY while a turn streams: a new text block appends an id and leaves
   * every earlier one where it was, so a part is never rekeyed or remounted
   * mid-stream.
   */
  readonly cuts: readonly string[];
  /** One entry per part, so `ranges.length === cuts.length + 1`. */
  readonly ranges: readonly AssistantTurnPartRange[];
}

/**
 * One turn's plan, cached on its segments array.
 *
 * `transcriptListRows` and the row-reuse pass both rerun on every streaming
 * token, so an uncached walk here would be O(every segment of every rendered
 * turn) per token. Segment arrays are rebuilt only when their turn's blocks
 * change, so keying on the array both collapses that and makes staleness
 * unrepresentable.
 */
const planBySegments = new WeakMap<
  ReadonlyArray<MessageSegment>,
  AssistantTurnPartPlan
>();

function assistantTurnPartPlan(
  segments: ReadonlyArray<MessageSegment>,
): AssistantTurnPartPlan {
  const cached = planBySegments.get(segments);
  if (cached !== undefined) return cached;
  const cuts: string[] = [];
  const ranges: AssistantTurnPartRange[] = [];
  let from = 0;
  let drawnBefore = false;
  for (let at = 0; at < segments.length; at += 1) {
    const segment = segments[at];
    if (segment.kind === "text") {
      if (drawnBefore) {
        cuts.push(segment.id);
        ranges.push({ from, to: at });
        from = at;
      }
      drawnBefore = true;
      continue;
    }
    if (alwaysDrawnSegment(segment)) drawnBefore = true;
  }
  ranges.push({ from, to: segments.length });
  const plan: AssistantTurnPartPlan = { cuts, ranges };
  planBySegments.set(segments, plan);
  return plan;
}

/** See {@link AssistantTurnPartPlan.cuts}. */
export function assistantTurnPartCuts(
  segments: ReadonlyArray<MessageSegment>,
): readonly string[] {
  return assistantTurnPartPlan(segments).cuts;
}

/**
 * The segments one part covers. The row-reuse pass compares exactly this slice
 * to decide whether a part keeps its rendered body, which is what lets an
 * earlier part of a streaming turn bail while the part at the live edge
 * re-renders.
 */
export function assistantTurnPartSegmentRange(
  segments: ReadonlyArray<MessageSegment>,
  partIndex: number,
): AssistantTurnPartRange {
  const { ranges } = assistantTurnPartPlan(segments);
  return ranges[Math.min(Math.max(partIndex, 0), ranges.length - 1)];
}

/**
 * The list key of one part. Part 0 keeps the ROW's key, so an unsplit turn and
 * every scroll anchor saved before this existed name the same thing they always
 * did; later parts hang off the text segment they start at, which is stable for
 * the life of the turn.
 */
export function assistantTurnPartKey(
  rowKey: string,
  cuts: readonly string[],
  index: number,
): string {
  return index === 0 ? rowKey : `${rowKey}#${cuts[index - 1]}`;
}

/**
 * Which part draws `segmentId`, for navigation: a block, a find unit or a
 * fullscreen app has to resolve to the part that holds it, not to part 0.
 * Falls back to part 0 for an id this turn does not carry.
 */
export function assistantTurnPartIndexOfSegment(
  segments: ReadonlyArray<MessageSegment>,
  segmentId: string,
): number {
  const { ranges } = assistantTurnPartPlan(segments);
  if (ranges.length === 1) return 0;
  const at = segments.findIndex((segment) => segment.id === segmentId);
  if (at === -1) return 0;
  return Math.max(
    0,
    ranges.findIndex((range) => at >= range.from && at < range.to),
  );
}
