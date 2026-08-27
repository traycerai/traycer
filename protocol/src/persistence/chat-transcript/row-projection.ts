import type { ContentBlock } from "@traycer/protocol/persistence/epic/content-blocks";
import type { ChatEvent } from "@traycer/protocol/persistence/epic/chat-events";
import type {
  Message,
  UserMessage,
} from "@traycer/protocol/persistence/epic/messages";

import { assistantTurnKey } from "@traycer/protocol/persistence/chat-transcript/fork-boundary";
import {
  compareCanonicalRowOrder,
  forkedChatLinkRowSource,
  notificationAnchorRowSource,
} from "@traycer/protocol/persistence/chat-transcript/row-order";
import { partitionSetupCardWindows } from "@traycer/protocol/persistence/chat-transcript/setup-card-windows";

/**
 * # The transcript row projection
 *
 * The one enumeration of "which rows does this chat have, in what order" -
 * shared by the host (which numbers ordinals from it) and the renderer (which
 * draws them).
 *
 * ## Why this exists rather than a comparator
 *
 * The first attempt at this was `buildCanonicalTranscriptRows`: one row per
 * persisted record, sorted by `timestamp`. A cold review found that claim false
 * in three ways at once, and the shape of every one of them is the same - a row
 * is not a record:
 *
 * 1. **Records to rows is MANY-TO-MANY.** Every `AssistantMessage` sharing a
 *    turn key folds into one turn; that turn then SPLITS into several rows
 *    around its steer blocks; and the persisted user records those steers point
 *    at are suppressed at top level and re-rendered nested.
 * 2. **Rows exist that no record produces.** Setup cards fold from `setup.*`
 *    events; a `turn.stopped` arriving before any assistant record synthesizes
 *    a durable completed row; a stopped turn ending on a steer gets a
 *    synthesized trailing boundary row.
 * 3. **Placement is not purely a sort.** An assistant row is keyed on
 *    `rowAnchorAt`, not on the record `timestamp` the host rewrites on every
 *    streaming delta - and EVERY row of one turn shares that single value, so
 *    intra-turn order rests on sort stability alone. On top of that the genesis
 *    setup card pins to the top regardless of its key, and a mid-chat one is
 *    woven above its anchor BY ID.
 *
 * An ordinal numbered from a one-per-record enumeration puts bodies under the
 * wrong rows for the rest of a transcript, and nothing about that failure is
 * loud - it looks like a chat whose messages are subtly shuffled.
 *
 * ## Durable rows only
 *
 * Three of the renderer's row sources are client-only: the optimistic pending
 * user echo, the live assistant row, and the pre-turn "Working..." indicator.
 * They carry no ordinal. That is sound because all three sort into the TAIL,
 * and the tail is pinned hydrated - so the client interleaves them at render
 * time and the host never has to name them.
 *
 * The same reasoning covers the two places this projection deliberately differs
 * from a live renderer, both of which add a row in the TAIL and neither of
 * which the host could know about:
 *
 * 1. `runState` is modelled as absent, so the live turn's trailing indicator
 *    row is omitted. Against a transcript with no active turn the two
 *    enumerations are identical row for row; with one, this is a prefix of what
 *    the renderer draws. Both are pinned by the equivalence corpus.
 * 2. A `turn.stopped` naming a user message that exists only as an OPTIMISTIC
 *    pending echo synthesizes a stopped row in the renderer and not here -
 *    correctly, since the host does not hold that message either. It
 *    materializes once the record persists.
 *
 * ## Consume, do not mirror
 *
 * The renderer builds its rows THROUGH the exported helpers here rather than
 * beside them. That is not a style preference. `eventMaterializesTranscriptRow`
 * shipped with a copy of its condition in the renderer that disagreed on the
 * empty string - an event carrying `sourceChatId: ""` would have occupied an
 * ordinal here and drawn nothing there. A predicate that can disagree with its
 * consumer does not get to have one.
 */

/** What produced a row - enough for a range read to know what to hydrate. */
export type TranscriptRowSource =
  | { readonly kind: "user"; readonly messageId: string }
  | {
      readonly kind: "assistant-slice";
      readonly turnKey: string;
      /** Every record contributing to the turn, in walk order. */
      readonly messageIds: readonly string[];
      /**
       * The blocks THIS slice renders, in order.
       *
       * Carried rather than left derivable: a client holding the turn's records
       * would otherwise have to re-run `planAssistantTurnRows` to find out which
       * blocks belong to which slice - a third implementation of the split, in
       * the place where getting it wrong is least visible.
       */
      readonly blockIds: readonly string[];
      readonly chunkIndex: number;
      readonly split: boolean;
      /** True for a row synthesized to carry a stopped turn's boundary. */
      readonly synthesizedBoundary: boolean;
      /**
       * The turn's events that DECORATE this row rather than produce it.
       *
       * A row is not only what it is built from. The renderer folds a turn's
       * `turn.started` / `turn.completed` / `turn.stopped` / `turn.interrupted`
       * into its elapsed counter, and its `checkpoint.captured` into the
       * restore affordance - and it does that by scanning the WHOLE event
       * array, which a windowed client no longer has.
       *
       * So they travel with the row. Without this, a hydration that reported
       * success renders a turn with no duration and no restore point: the
       * quietest possible failure, because the row is there and merely poorer
       * than it was.
       *
       * Every slice of one turn names the same ids. That is not waste - the
       * range reader charges a record once however many rows introduce it.
       */
      readonly decoratingEventIds: readonly string[];
    }
  | {
      readonly kind: "steer";
      readonly turnKey: string;
      /**
       * The turn's records - needed even when {@link steeredMessageId} is set,
       * because the steer BLOCK lives in an assistant record and carries the
       * badge, mode and sender the row renders.
       */
      readonly messageIds: readonly string[];
      /**
       * The steered user record, when one survives. `null` means the block was
       * orphaned by a checkpoint rewrite and the row renders from the block
       * alone - so its identity comes from a QUEUE ITEM, not a record.
       */
      readonly steeredMessageId: string | null;
      /** The steer block itself, inside one of {@link messageIds}. */
      readonly blockId: string;
      readonly queueItemId: string;
    }
  | {
      readonly kind: "stopped-turn";
      readonly turnKey: string;
      readonly eventId: string;
    }
  | { readonly kind: "forked-chat-link"; readonly eventId: string }
  | { readonly kind: "notification-anchor"; readonly eventId: string }
  | {
      readonly kind: "setup-card";
      readonly windowIndex: number;
      readonly eventIds: readonly string[];
    };

/**
 * A row's identity, order and provenance - never its content.
 *
 * The ordinal of a row IS its index in the array {@link projectTranscriptRows}
 * returns.
 */
export interface TranscriptRowDescriptor {
  /** The renderer's row id, verbatim. This is the `(kind, id)` identity echo. */
  readonly rowId: string;
  /**
   * The placement key. For an assistant row this is `rowAnchorAt`, NOT the
   * record timestamp - see the module doc. Rows pinned or woven by id
   * (setup cards) still carry theirs, but it does not decide their position.
   */
  readonly createdAt: number;
  readonly source: TranscriptRowSource;
}

export interface TranscriptRowProjectionInput {
  readonly messages: readonly Message[];
  readonly events: readonly ChatEvent[];
  /**
   * The turn currently running, or `null`. Decides `turnComplete`, which gates
   * the synthesized stopped-turn boundary row and the stopped-turn synthesis.
   */
  readonly activeTurnId: string | null;
  /** Owner chat id - part of a setup card's row id. */
  readonly chatId: string;
}

// ---------------------------------------------------------------------------
// Row ids. Exported because the renderer must build the same strings; a second
// template literal that agreed by inspection is the drift this module prevents.
// ---------------------------------------------------------------------------

export function assistantRowId(turnKey: string): string {
  return `assistant:${turnKey}`;
}

/**
 * A slice's row id. `split` is sticky for the WHOLE turn: adding one steer
 * block renames every slice row of that turn, because an unsplit turn's single
 * row keeps the bare `assistant:<key>` id.
 */
export function assistantSliceRowId(
  turnKey: string,
  chunkIndex: number,
  split: boolean,
): string {
  if (!split) return assistantRowId(turnKey);
  return `${assistantRowId(turnKey)}:part:${chunkIndex}`;
}

export function queueSteerRowId(queueItemId: string): string {
  return `steer:${queueItemId}`;
}

export function forkedChatLinkRowId(eventId: string): string {
  return `forked-chat-link:${eventId}`;
}

export function setupCardRowId(
  chatId: string,
  windowIndex: number,
  createdAt: number,
): string {
  return `setup-card:${chatId}:${windowIndex}:${createdAt}`;
}

// ---------------------------------------------------------------------------
// Turn folding
// ---------------------------------------------------------------------------

/**
 * The durable subset of the renderer's turn accumulator - the fields that
 * decide row COUNT and row ORDER. Everything the accumulator carries for
 * rendering (senders, cost, image resolutions) is deliberately absent.
 */
export interface DurableTurnAccumulator {
  readonly turnKey: string;
  /** Concatenated across records in walk order. */
  readonly blocks: readonly ContentBlock[];
  /** `min` across records, a real value beating `null` (legacy records). */
  readonly startedAt: number | null;
  /** `max` across records. */
  readonly timestamp: number;
  /** In walk order; the LAST is the fork boundary's id. */
  readonly messageIds: readonly string[];
}

interface MutableTurnAccumulator {
  readonly turnKey: string;
  blocks: ContentBlock[];
  startedAt: number | null;
  timestamp: number;
  messageIds: string[];
}

function minNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/**
 * Folds every assistant record sharing a turn key into one accumulator, keyed
 * in first-appearance order.
 *
 * `startedAt` takes the minimum so a turn split across records (subagent flows,
 * migrated snapshots) anchors at the earliest recorded start; `timestamp` takes
 * the maximum so the last-resort anchor reflects the real turn end.
 */
export function accumulateDurableTurns(
  messages: readonly Message[],
): ReadonlyMap<string, DurableTurnAccumulator> {
  const turns = new Map<string, MutableTurnAccumulator>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const turnKey = assistantTurnKey(message);
    const existing = turns.get(turnKey);
    if (existing === undefined) {
      turns.set(turnKey, {
        turnKey,
        blocks: [...message.blocks],
        startedAt: message.startedAt,
        timestamp: message.timestamp,
        messageIds: [message.messageId],
      });
      continue;
    }
    existing.blocks.push(...message.blocks);
    existing.startedAt = minNullable(existing.startedAt, message.startedAt);
    if (message.timestamp > existing.timestamp) {
      existing.timestamp = message.timestamp;
    }
    existing.messageIds.push(message.messageId);
  }
  return turns;
}

/**
 * The one field {@link nestedSteeredMessageIds} reads off a turn.
 *
 * Deliberately structural rather than {@link DurableTurnAccumulator}: the
 * renderer's accumulator carries a dozen more fields for rendering, and asking
 * it to satisfy the durable shape would push it to either restate this walk or
 * build a throwaway adapter. Both are how a shared function ends up with a
 * second implementation beside it.
 */
export interface BlockBearingTurn {
  readonly blocks: readonly ContentBlock[];
}

/**
 * The persisted user records rendered NESTED inside an assistant turn rather
 * than at top level.
 *
 * A steer block naming a record that is still in the transcript suppresses that
 * record's top-level row. A block whose record is gone (checkpoint rewrote the
 * block, the row was written once and lost) suppresses nothing and renders from
 * the block alone.
 */
export function nestedSteeredMessageIds(
  turns: Iterable<BlockBearingTurn>,
  userMessagesById: ReadonlyMap<string, UserMessage>,
): ReadonlySet<string> {
  const messageIds = new Set<string>();
  for (const turn of turns) {
    for (const block of turn.blocks) {
      if (block.type === "steer" && userMessagesById.has(block.messageId)) {
        messageIds.add(block.messageId);
      }
    }
  }
  return messageIds;
}

export function userMessagesById(
  messages: readonly Message[],
): ReadonlyMap<string, UserMessage> {
  const usersById = new Map<string, UserMessage>();
  for (const message of messages) {
    if (message.role === "user") usersById.set(message.messageId, message);
  }
  return usersById;
}

// ---------------------------------------------------------------------------
// The steer split
// ---------------------------------------------------------------------------

/**
 * One row of a turn, as an index into the turn's block array. Indices rather
 * than blocks so the renderer can map them straight back to its own array
 * without this module having to carry content.
 */
export type AssistantTurnRowPlanEntry =
  | {
      readonly kind: "slice";
      readonly chunkIndex: number;
      readonly blockIndices: readonly number[];
    }
  | { readonly kind: "steer"; readonly blockIndex: number };

export interface AssistantTurnRowPlan {
  /**
   * Whether the turn holds any steer block. Sticky for the whole turn because
   * it changes every slice row's ID, not just the split ones.
   */
  readonly split: boolean;
  readonly entries: readonly AssistantTurnRowPlanEntry[];
  /** The chunk index a synthesized trailing row would take. */
  readonly nextChunkIndex: number;
}

/**
 * Plans a turn's rows: maximal runs of non-steer blocks become slices, each
 * steer block becomes its own row between them.
 *
 * A turn with no blocks and no steer still plans ONE slice - an empty assistant
 * row is what a turn that produced nothing renders as, and it must occupy an
 * ordinal like any other.
 */
export function planAssistantTurnRows(
  blocks: readonly ContentBlock[],
): AssistantTurnRowPlan {
  const split = blocks.some((block) => block.type === "steer");
  const entries: AssistantTurnRowPlanEntry[] = [];
  let chunk: number[] = [];
  let chunkIndex = 0;

  const flush = (): void => {
    if (chunk.length === 0) return;
    entries.push({ kind: "slice", chunkIndex, blockIndices: chunk });
    chunk = [];
    chunkIndex += 1;
  };

  blocks.forEach((block, index) => {
    if (block.type === "steer") {
      flush();
      entries.push({ kind: "steer", blockIndex: index });
      return;
    }
    chunk.push(index);
  });
  flush();

  if (entries.length === 0 && !split) {
    return {
      split: false,
      entries: [{ kind: "slice", chunkIndex: 0, blockIndices: [] }],
      nextChunkIndex: 1,
    };
  }
  return { split, entries, nextChunkIndex: chunkIndex };
}

/**
 * Whether a turn needs a synthesized trailing assistant row.
 *
 * A stopped turn's `completedAt`/`stopped` marker is stamped on its LAST
 * assistant row. When the turn's final block is a steer, the last planned row
 * is a `role: "user"` bubble that cannot carry it - so without this the marker
 * lands on the chunk BEFORE the steer (wrong boundary) or, for a steer-only
 * turn, on no row at all (dropped entirely).
 *
 * This is why a turn's durable row count depends on an EVENT and not only on
 * its records. A host enumeration reading messages alone gets every
 * stopped-steer-terminated turn wrong.
 */
export function assistantTurnNeedsTrailingRow(input: {
  readonly plan: AssistantTurnRowPlan;
  readonly turnComplete: boolean;
  readonly stopped: boolean;
  /**
   * Whether the turn carries a live run indicator. Always `false` in the
   * durable projection; the renderer passes its real value, which is what adds
   * the live turn's trailing row on top of this enumeration.
   */
  readonly hasRunState: boolean;
}): boolean {
  const needs = input.hasRunState || (input.turnComplete && input.stopped);
  if (!needs) return false;
  const last = input.plan.entries.at(-1);
  // Already ends on an assistant row: the marker (or run state) attaches to it
  // in place and no row is added.
  return last !== undefined && last.kind === "steer";
}

// ---------------------------------------------------------------------------
// Stopped turns
// ---------------------------------------------------------------------------

export interface TurnStoppedInfo {
  readonly stoppedAt: number;
  readonly reason: string | null;
  readonly messageId: string | null;
  /** The `turn.stopped` event itself - what a synthesized row hydrates from. */
  readonly eventId: string;
}

const EMPTY_EVENT_IDS: readonly string[] = [];

/**
 * Event types a turn's rows RENDER WITH but are not built from.
 *
 * `turn.*` drives the elapsed counter; `checkpoint.captured` drives the restore
 * affordance. Both are folded by `turnId` in `rendered-messages.ts` over the
 * whole event array - which is exactly the array a windowed client stops
 * having, so the ids travel with the row instead.
 *
 * `turn.stopped` appears here AND can materialize a row of its own. That is not
 * a contradiction: the row it synthesizes exists only when the turn wrote no
 * assistant record, and the marker it stamps on a turn that DID is a different
 * use of the same event. Listing it in both places is what makes a range serve
 * it either way.
 */
const TURN_DECORATING_EVENT_TYPES: ReadonlySet<ChatEvent["type"]> = new Set([
  "turn.started",
  "turn.completed",
  "turn.stopped",
  "turn.interrupted",
  "checkpoint.captured",
]);

/**
 * Decorating event ids per turn, in event order.
 *
 * Keyed on `turnId` because that is what the renderer's folds key on. An event
 * with no `turnId` decorates nothing and is skipped - it is chat-level state,
 * and chat-level state rides the snapshot rather than a row.
 */
export function decoratingEventIdsByTurn(
  events: readonly ChatEvent[],
): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, string[]>();
  for (const event of events) {
    if (event.turnId === null) continue;
    if (!TURN_DECORATING_EVENT_TYPES.has(event.type)) continue;
    const held = out.get(event.turnId);
    if (held === undefined) {
      out.set(event.turnId, [event.eventId]);
      continue;
    }
    held.push(event.eventId);
  }
  return out;
}

/**
 * `turn.stopped` events keyed by `turnId`, in event order.
 *
 * The host's terminal latch guarantees at most one per turn attempt, so
 * last-write-wins is a defensive fallback rather than an expected overwrite.
 * Insertion order is load-bearing: it decides tie order among synthesized
 * stopped rows.
 */
export function turnStoppedInfoByTurnKey(
  events: readonly ChatEvent[],
): ReadonlyMap<string, TurnStoppedInfo> {
  const out = new Map<string, TurnStoppedInfo>();
  for (const event of events) {
    if (event.type !== "turn.stopped" || event.turnId === null) continue;
    out.set(event.turnId, {
      stoppedAt: event.timestamp,
      reason: event.message,
      messageId: event.messageId,
      eventId: event.eventId,
    });
  }
  return out;
}

/**
 * Turn keys whose Stop landed before any assistant record existed, and which
 * therefore render as a synthesized completed row.
 *
 * The guard is retention-based: a turn whose records were branched away stops
 * producing a folded row and starts producing a synthetic one, and both must
 * land on the same ordinal count.
 */
function stoppedTurnsWithoutRecords(input: {
  readonly stoppedByTurnKey: ReadonlyMap<string, TurnStoppedInfo>;
  readonly retainedTurnKeys: ReadonlySet<string>;
  readonly retainedUserMessageIds: ReadonlySet<string>;
  readonly activeTurnId: string | null;
}): readonly { readonly turnKey: string; readonly stopped: TurnStoppedInfo }[] {
  const out: { turnKey: string; stopped: TurnStoppedInfo }[] = [];
  for (const [turnKey, stopped] of input.stoppedByTurnKey) {
    if (turnKey === input.activeTurnId) continue;
    if (input.retainedTurnKeys.has(turnKey)) continue;
    if (stopped.messageId === null) continue;
    if (!input.retainedUserMessageIds.has(stopped.messageId)) continue;
    out.push({ turnKey, stopped });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

/**
 * Enumerates a chat's durable transcript rows, in the order they are drawn.
 *
 * The returned array's indices ARE the ordinals. Assembly mirrors the
 * renderer's `baseRows` concatenation exactly, because a stable sort keeps
 * input order for ties and every row of a turn shares one key - so the
 * concatenation order is not incidental, it is part of the answer.
 */
export function projectTranscriptRows(
  input: TranscriptRowProjectionInput,
): readonly TranscriptRowDescriptor[] {
  const turns = accumulateDurableTurns(input.messages);
  const usersById = userMessagesById(input.messages);
  const nestedSteered = nestedSteeredMessageIds(turns.values(), usersById);
  const stoppedByTurnKey = turnStoppedInfoByTurnKey(input.events);
  const decoratingEventIdsByTurnKey = decoratingEventIdsByTurn(input.events);

  const base: TranscriptRowDescriptor[] = [];
  const emittedTurns = new Set<string>();
  // The most recent NON-suppressed user record in walk order - the legacy
  // anchor fallback for a record persisted before `startedAt` existed. It is
  // walk-order dependent, not `createdAt`-order dependent, which is why this
  // module fixes the walk order rather than sorting first.
  let lastUserTimestamp: number | null = null;

  for (const message of input.messages) {
    if (message.role === "user") {
      // A steered user record is a mid-turn interjection rendered inside its
      // turn. Updating the anchor here would mis-anchor a LATER turn on the
      // steer instant, so it is skipped entirely, not merely un-emitted.
      if (nestedSteered.has(message.messageId)) continue;
      lastUserTimestamp = message.timestamp;
      base.push({
        rowId: message.messageId,
        createdAt: message.timestamp,
        source: { kind: "user", messageId: message.messageId },
      });
      continue;
    }
    const turnKey = assistantTurnKey(message);
    if (emittedTurns.has(turnKey)) continue;
    const turn = turns.get(turnKey);
    if (turn === undefined) continue;
    emittedTurns.add(turnKey);
    base.push(
      ...describeTurnRows({
        turn,
        usersById,
        lastUserTimestamp,
        activeTurnId: input.activeTurnId,
        stopped: stoppedByTurnKey.get(turnKey) ?? null,
        decoratingEventIdsByTurnKey,
      }),
    );
  }

  const retainedUserMessageIds = new Set(usersById.keys());
  for (const entry of stoppedTurnsWithoutRecords({
    stoppedByTurnKey,
    retainedTurnKeys: new Set(turns.keys()),
    retainedUserMessageIds,
    activeTurnId: input.activeTurnId,
  })) {
    base.push({
      rowId: assistantRowId(entry.turnKey),
      createdAt: entry.stopped.stoppedAt,
      source: {
        kind: "stopped-turn",
        turnKey: entry.turnKey,
        eventId: entry.stopped.eventId,
      },
    });
  }

  // Event rows are appended in two passes, all fork links before all
  // notification anchors, because that is the renderer's `baseRows` order. For
  // two events sharing a timestamp the resulting tie order differs from the
  // event log's own order - matching that exactly is the point.
  for (const event of input.events) {
    if (forkedChatLinkRowSource(event) === null) continue;
    base.push({
      rowId: forkedChatLinkRowId(event.eventId),
      createdAt: event.timestamp,
      source: { kind: "forked-chat-link", eventId: event.eventId },
    });
  }
  for (const event of input.events) {
    if (notificationAnchorRowSource(event) === null) continue;
    base.push({
      rowId: chatTranscriptEventRowId(event.eventId),
      createdAt: event.timestamp,
      source: { kind: "notification-anchor", eventId: event.eventId },
    });
  }

  return placeSetupCards(base, input);
}

/**
 * The notification-anchor row's id. Lives here rather than in the GUI's jump
 * store so the host can build it; the store re-exports it for its jump targets.
 */
export function chatTranscriptEventRowId(eventId: string): string {
  return `chat-event:${eventId}`;
}

function describeTurnRows(input: {
  readonly turn: DurableTurnAccumulator;
  readonly usersById: ReadonlyMap<string, UserMessage>;
  readonly lastUserTimestamp: number | null;
  readonly activeTurnId: string | null;
  readonly stopped: TurnStoppedInfo | null;
  readonly decoratingEventIdsByTurnKey: ReadonlyMap<string, readonly string[]>;
}): readonly TranscriptRowDescriptor[] {
  const { turn } = input;
  // Every branch of the renderer's timing derivation returns this same anchor;
  // the autonomous-resume lifecycle window it also computes moves the ELAPSED
  // counter, never the row's position. So ordering needs none of that
  // machinery - which is most of why this projection stayed small.
  const rowAnchorAt =
    turn.startedAt ?? input.lastUserTimestamp ?? turn.timestamp;
  const turnComplete = input.activeTurnId !== turn.turnKey;
  const blocks = turn.blocks;
  const plan = planAssistantTurnRows(blocks);
  const decoratingEventIds =
    input.decoratingEventIdsByTurnKey.get(turn.turnKey) ?? EMPTY_EVENT_IDS;

  const rows: TranscriptRowDescriptor[] = plan.entries.map((entry) => {
    if (entry.kind === "steer") {
      const block = blocks[entry.blockIndex];
      if (block.type !== "steer") {
        throw new Error("row-projection: plan named a non-steer block");
      }
      const steeredRecord = input.usersById.get(block.messageId);
      return {
        rowId:
          steeredRecord === undefined
            ? queueSteerRowId(block.queueItemId)
            : steeredRecord.messageId,
        // Anchored at the turn start, not the block's own timestamp, so the
        // steer bubble stays contiguous with its surrounding slices.
        createdAt: rowAnchorAt,
        source: {
          kind: "steer",
          turnKey: turn.turnKey,
          messageIds: turn.messageIds,
          steeredMessageId:
            steeredRecord === undefined ? null : block.messageId,
          blockId: block.blockId,
          queueItemId: block.queueItemId,
        },
      };
    }
    return {
      rowId: assistantSliceRowId(turn.turnKey, entry.chunkIndex, plan.split),
      createdAt: rowAnchorAt,
      source: {
        kind: "assistant-slice",
        turnKey: turn.turnKey,
        messageIds: turn.messageIds,
        blockIds: entry.blockIndices.map((index) => blocks[index].blockId),
        chunkIndex: entry.chunkIndex,
        split: plan.split,
        synthesizedBoundary: false,
        decoratingEventIds,
      },
    };
  });

  if (
    assistantTurnNeedsTrailingRow({
      plan,
      turnComplete,
      stopped: input.stopped !== null,
      hasRunState: false,
    })
  ) {
    rows.push({
      rowId: assistantSliceRowId(turn.turnKey, plan.nextChunkIndex, true),
      // Reuses the turn anchor exactly: every other row of the turn does, and
      // position here rests on push order under the stable sort, not on a
      // numerically later value.
      createdAt: rowAnchorAt,
      source: {
        kind: "assistant-slice",
        turnKey: turn.turnKey,
        messageIds: turn.messageIds,
        // A synthesized boundary carries no blocks of its own - it exists to
        // hold the stopped marker the trailing steer bubble cannot.
        blockIds: [],
        chunkIndex: plan.nextChunkIndex,
        split: true,
        synthesizedBoundary: true,
        decoratingEventIds,
      },
    });
  }
  return rows;
}

/**
 * Sorts the base rows and weaves the setup cards in.
 *
 * Three placements, and only one of them is a sort:
 *
 * - the GENESIS card (window 0 with no `setup.creating` event) pins to ordinal
 *   0, because its stamp is back-filled and can land after the first message;
 * - a card whose `triggeringMessageId` names a row that exists is woven
 *   immediately ABOVE that row, by id - the card is announced before the slow
 *   `git worktree add` while its message persists only after, so a timestamp
 *   sort would place it below and then jump it above;
 * - anything else floats by `createdAt`, including a card whose anchor was
 *   branched away, so it still renders instead of vanishing.
 *
 * Ordinals are therefore assigned AFTER the weave. This is the structural
 * reason a shared comparator was never going to be enough.
 */
function placeSetupCards(
  base: readonly TranscriptRowDescriptor[],
  input: TranscriptRowProjectionInput,
): readonly TranscriptRowDescriptor[] {
  const windows = partitionSetupCardWindows(input.events);
  if (windows.length === 0) {
    return [...base].sort(compareCanonicalRowOrder);
  }

  const cards = windows.map((window, windowIndex) => ({
    descriptor: {
      rowId: setupCardRowId(input.chatId, windowIndex, window.createdAt),
      createdAt: window.createdAt,
      source: {
        kind: "setup-card" as const,
        windowIndex,
        eventIds: window.events.map((event) => event.eventId),
      },
    },
    anchorId: window.triggeringMessageId,
  }));

  const pinGenesis = !windows[0].hasCreatingEvent;
  const baseIds = new Set(base.map((row) => row.rowId));
  const cardsByAnchor = new Map<string, TranscriptRowDescriptor[]>();
  const floating: TranscriptRowDescriptor[] = [];
  cards.forEach((card, index) => {
    if (pinGenesis && index === 0) return;
    if (card.anchorId !== null && baseIds.has(card.anchorId)) {
      const held = cardsByAnchor.get(card.anchorId);
      if (held === undefined) {
        cardsByAnchor.set(card.anchorId, [card.descriptor]);
        return;
      }
      held.push(card.descriptor);
      return;
    }
    floating.push(card.descriptor);
  });

  const sorted = [...base, ...floating].sort(compareCanonicalRowOrder);
  const woven: TranscriptRowDescriptor[] = [];
  for (const row of sorted) {
    const anchored = cardsByAnchor.get(row.rowId);
    if (anchored !== undefined) woven.push(...anchored);
    woven.push(row);
  }
  return pinGenesis ? [cards[0].descriptor, ...woven] : woven;
}
