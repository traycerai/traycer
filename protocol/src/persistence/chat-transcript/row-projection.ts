import type { ContentBlock } from "@traycer/protocol/persistence/epic/content-blocks";
import type { ChatEvent } from "@traycer/protocol/persistence/epic/chat-events";
import type {
  AssistantMessage,
  Message,
  UserMessage,
} from "@traycer/protocol/persistence/epic/messages";
import type { ChatSessionAnchor } from "@traycer/protocol/persistence/epic/senders";

import {
  EMPTY_ROW_CONTEXT,
  type TranscriptRowContext,
} from "@traycer/protocol/persistence/chat-transcript/row-context";

import {
  checkpointChangePaths,
  checkpointEventTurnKey,
  latestCheckpointPerTurn,
  overlappingCheckpointKeys,
  turnCheckpointManifestSchema,
} from "@traycer/protocol/persistence/epic/checkpoint-manifests";

import { assistantTurnKey } from "@traycer/protocol/persistence/chat-transcript/fork-boundary";
import {
  autoJudgeNoticeRowSource,
  autoJudgeUnattendedDenialRowSource,
  eventMaterializesTranscriptRow,
  forkedChatLinkRowSource,
  importedChatMarkerRowSource,
  notificationAnchorRowSource,
} from "@traycer/protocol/persistence/chat-transcript/row-order";
import {
  partitionSetupCardWindows,
  SETUP_DERIVATION_EVENT_TYPES,
} from "@traycer/protocol/persistence/chat-transcript/setup-card-windows";
import {
  applySteerLifecycleEvent,
  STEER_LIFECYCLE_EVENT_TYPES,
  type SteerLifecycleFold,
} from "@traycer/protocol/persistence/chat-transcript/steer-lifecycle";
import {
  canonicalFoldJson,
  compareTranscriptRowOrder,
  EMPTY_TRANSCRIPT_FOLD_STATE,
  eventRowUnitKey,
  isSetupCardUnitKey,
  setupCardUnitKey,
  TRANSCRIPT_FOLD_STATE_VERSION,
  TRANSCRIPT_MESSAGE_FOLD_FACTS_VERSION,
  TRANSCRIPT_ROW_PASS,
  TRANSCRIPT_ROW_SECTION,
  TRANSCRIPT_ROW_SLOT,
  transcriptMessageFoldFactsEqual,
  turnRowUnitKey,
  userRowUnitKey,
  type CheckpointPathChange,
  type CheckpointTurnPaths,
  type PositionedEvent,
  type PositionedMessage,
  type PositionedMessageFacts,
  type PositionedTurnEvent,
  type StoredCheckpointTurn,
  type StoredTranscriptRow,
  type TranscriptFoldChange,
  type TranscriptFoldLoad,
  type TranscriptFoldLoadResult,
  type TranscriptFoldResult,
  type TranscriptFoldRow,
  type TranscriptFoldState,
  type TranscriptFoldUnit,
  type TranscriptMessageFoldFacts,
  type TranscriptRowOrder,
  type TranscriptTurnUnitState,
  type TranscriptWalkRegion,
} from "@traycer/protocol/persistence/chat-transcript/row-projection-fold-state";

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
 *    setup card pins to the top regardless of its key, a mid-chat one is
 *    woven above its anchor BY ID, and an imported chat's provenance marker
 *    pins above even the genesis card.
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
      /**
       * Every surviving steered user record of this turn - see the same field
       * on the `steer` variant.
       *
       * On an assistant slice for the same reason `messageIds` is: the
       * renderer folds the WHOLE turn out of these shared records, so a slice
       * hydrated without them regenerates the turn's steer rows as orphans.
       */
      readonly steeredMessageIds: readonly string[];
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
      /**
       * EVERY surviving steered user record of the turn, not just this row's.
       *
       * The turn is the unit the renderer folds, and it folds it out of the
       * assistant records that {@link messageIds} names - records every row of
       * the turn shares. So a range that served only this row's own steered
       * record still hands the renderer the whole turn, minus the other steers'
       * user messages: it re-derives those rows, finds no record, and treats
       * them as ORPHANED. An orphan takes its identity from the queue item
       * (`steer:<queueItemId>`) rather than from the message, so the id
       * disagrees with the one the skeleton published, its ordinal is
       * suppressed, and the row draws unplaced at the tail while a placeholder
       * sits at its real position.
       *
       * Shared across the turn's rows exactly as {@link messageIds} and
       * `decoratingEventIds` are, and free for the same reason: the range
       * reader charges a record once however many rows name it.
       */
      readonly steeredMessageIds: readonly string[];
      /** The steer block itself, inside one of {@link messageIds}. */
      readonly blockId: string;
      readonly queueItemId: string;
    }
  | {
      readonly kind: "stopped-turn";
      readonly turnKey: string;
      readonly eventId: string;
      /**
       * The user record whose Stop this row reports.
       *
       * The row renders through `renderStoppedTurnsWithoutAssistantRecords`,
       * which emits NOTHING unless the referenced message is present - so a
       * hydration that served only the event reports success and draws no row,
       * while the span still counts it hydrated and `transcriptListRows`
       * suppresses its ordinal rather than leaving a placeholder.
       *
       * Never null: the row is synthesized only for a stop whose `messageId` is
       * both set and retained (the stopped-turn branch of `foldTranscriptRows`),
       * which is the same condition the renderer re-checks.
       */
      readonly triggeringMessageId: string;
    }
  | { readonly kind: "forked-chat-link"; readonly eventId: string }
  | { readonly kind: "notification-anchor"; readonly eventId: string }
  | { readonly kind: "imported-chat-marker"; readonly eventId: string }
  | {
      readonly kind: "auto-judge-unattended-denial";
      readonly eventId: string;
    }
  | { readonly kind: "auto-judge-notice"; readonly eventId: string }
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
  /**
   * What this row renders WITH - see {@link TranscriptRowContext}.
   *
   * Always an object, never absent, so a consumer reads fields rather than
   * branching on the container first. Empty for the many rows whose rendering
   * depends on nothing around them.
   */
  readonly context: TranscriptRowContext;
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

/**
 * The turn key an assistant row id names, or `null` for any other row id.
 *
 * The inverse of {@link assistantSliceRowId}, and it lives beside it for the
 * reason everything else in this file does: a consumer that stripped the split
 * suffix by hand would be a second copy of the id format, and the two would
 * disagree the first time one moved.
 *
 * What it is FOR: {@link TranscriptRowContext} is keyed by row id, and a turn's
 * context is shared by every row the turn produces - so a renderer holding a
 * turn key needs the mapping in this direction to read it. A turn key is a
 * `turnId` or a `ts:<millis>` fallback (see `assistantTurnKey`), neither of
 * which can end in `:part:<digits>`, so the strip is unambiguous.
 */
export function assistantRowTurnKey(rowId: string): string | null {
  const prefix = assistantRowId("");
  if (!rowId.startsWith(prefix)) return null;
  const turnKey = rowId.slice(prefix.length).replace(/:part:\d+$/, "");
  // The bare prefix names no turn. Answered here rather than left to callers,
  // because an empty key is a map lookup that quietly matches nothing.
  return turnKey === "" ? null : turnKey;
}

export function queueSteerRowId(queueItemId: string): string {
  return `steer:${queueItemId}`;
}

export function forkedChatLinkRowId(eventId: string): string {
  return `forked-chat-link:${eventId}`;
}

export function importedChatMarkerRowId(eventId: string): string {
  return `imported-chat-marker:${eventId}`;
}

export function autoJudgeUnattendedDenialRowId(eventId: string): string {
  return `auto-judge-unattended-denial:${eventId}`;
}

export function autoJudgeNoticeRowId(eventId: string): string {
  return `auto-judge-notice:${eventId}`;
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
 * Does this turn OPEN with an autonomous-resume divider - i.e. is it a turn the
 * host started with no user message of its own?
 *
 * Two signals, because neither alone covers the record population. A modern
 * `in_turn` block is a notification appended into an already-RUNNING ordinary
 * turn, so it says so on itself and is excluded here. A HISTORICAL block
 * carries `deliveryPlacement: null`, which the schema defines as
 * "historical/unknown" and explicitly invites readers to resolve by position -
 * so for those, being the turn's first block is the only evidence there is, and
 * it is read as the turn-start form.
 *
 * The residual: a historical `in_turn` notification that landed on a turn which
 * had not streamed anything yet would be the first block and read as
 * autonomous. That costs an ordinary turn its account label (a refusal, never a
 * wrong name), and it cannot combine with the mislabel this module is about -
 * reaching that requires a fallback hop, and every hop-era row is stamped with
 * its own `turnProfile` and never consults the walk at all.
 */
function turnOpensWithAutonomousResume(
  blocks: readonly ContentBlock[],
): boolean {
  const first = blocks.at(0);
  if (first === undefined || first.type !== "autonomous_resume") return false;
  return first.deliveryPlacement !== "in_turn";
}

/**
 * The turns whose account the SESSION-ANCHOR WALK is not allowed to name.
 *
 * `TranscriptRowContext.sessionAnchor` exists for exactly one consumer: the
 * renderer's profile label. The anchor it carries is the one in effect at the
 * turn, taken from the running walk over user records - and that walk can be
 * wrong in a specific, known shape.
 *
 * A provider fallback hop re-dispatches ONE user message as a second attempt
 * and then REWRITES that user row's `sessionAnchor` to the replacement's. The
 * original attempt's row never changes, so walking to the anchor hands it the
 * account that did not produce it; a profile-only hop keeps `harnessId`
 * identical, so the renderer's harness-agreement gate does not catch it either.
 *
 * ## The rule
 *
 * The walk is provably correct when a user row has exactly ONE dispatch attempt
 * hanging off it: there is then a single account the anchor can mean, rewritten
 * or not. Two or more is what a fallback re-dispatch or a manual replay
 * produces, and that is the shape refused here.
 *
 * **An attempt is a turn the user row DISPATCHED.** Not every turn is one: an
 * autonomous/wake turn is started by the host with no user message
 * (`startProviderTurn` mints a fresh id as its anchor), so its records land in
 * the preceding user row's span without being a second dispatch of it. Counting
 * one would refuse the ordinary turn beside it - a label blanked on the great
 * majority of historical agent chats, which have wakes and have never fallen
 * back. So autonomous turns are excluded from the count. They are also never
 * WALKED themselves: no anchor is ever minted for them (an anchor whose message
 * id names no user row is dropped), so the anchor in effect belongs to someone
 * else's turn and may name a different account entirely.
 *
 * A turn whose own record carries `turnProfile` is never refused - the row
 * states its account directly, and the renderer prefers it over anything
 * derived.
 *
 * ## How the refusal travels
 *
 * `projectTranscriptRows` withholds `sessionAnchor` AND sets
 * `profileWalkUnprovable`. The flag is not redundant with the withholding: a
 * context left with nothing in it is never serialized at all, so the refusal
 * would reach a windowed client as silence - and silence is the renderer
 * falling back to its own walk, which against a span holding one of two
 * attempts reaches exactly the wrong answer being refused. See the field's own
 * comment in `row-context.ts`.
 *
 * This is the ONE implementation. The renderer imports it rather than counting
 * for itself, so the definition of an attempt cannot drift between the two.
 */
export function turnKeysWithUnprovableProfileWalk(
  messages: readonly Message[],
): ReadonlySet<string> {
  const recorded = new Set<string>();
  const autonomous = new Set<string>();
  const seenTurnKeys = new Set<string>();
  const unprovable = new Set<string>();
  // Distinct ATTEMPT turn keys since the last user record, in first-seen order.
  // A steered user record resets it, which is correct: the slices either side
  // of a steer share one turn key, so a steered turn still counts once.
  let attemptKeysSinceUserRow: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      attemptKeysSinceUserRow = [];
      continue;
    }
    const turnKey = assistantTurnKey(message);
    if (message.turnProfile !== undefined) {
      recorded.add(turnKey);
    }
    // A record carrying no blocks can neither classify its turn nor BE one of
    // its attempts, so it is skipped before both - but AFTER the snapshot read
    // above, since an empty record can still state its own account and that
    // exemption is about the row, not its blocks.
    //
    // `blocks` has no minimum in the schema, so a turn's first record can hold
    // none and the block that OPENS the turn then arrives on a later record of
    // the same `turnId`. Classifying off the first record regardless would shut
    // `seenTurnKeys` against that later record, so an `autonomous_resume`
    // arriving there is never seen: the wake reads as a dispatch, counts as an
    // attempt, and the ordinary turn beside it is refused along with it - the
    // exact over-refusal this function exists to prevent.
    if (message.blocks.length === 0) continue;
    if (!seenTurnKeys.has(turnKey)) {
      seenTurnKeys.add(turnKey);
      // Classified from the turn's first BLOCK-BEARING record - a turn's blocks
      // are concatenated across records in walk order, so that record's first
      // block is the turn's first block. A later record cannot make a turn
      // autonomous.
      if (turnOpensWithAutonomousResume(message.blocks)) {
        autonomous.add(turnKey);
      }
    }
    if (autonomous.has(turnKey)) continue;
    if (attemptKeysSinceUserRow.includes(turnKey)) continue;
    attemptKeysSinceUserRow.push(turnKey);
    if (attemptKeysSinceUserRow.length < 2) continue;
    // The whole span, not only the later attempts: the one that gets
    // mislabelled is the FIRST, whose anchor was rewritten out from under it.
    for (const key of attemptKeysSinceUserRow) unprovable.add(key);
  }
  for (const turnKey of autonomous) unprovable.add(turnKey);
  // Applied after the walk rather than inside it, because a turn's snapshot can
  // arrive on a continuation record read AFTER the sibling that marked the span.
  for (const turnKey of recorded) unprovable.delete(turnKey);
  return unprovable;
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
 * The only context a USER row ever carries - see `completedSteer` on the
 * schema.
 *
 * A module constant for `EMPTY_ROW_CONTEXT`'s reason, one value over: the
 * context is immutable and every steered user row of every chat wants the same
 * one, so allocating a fresh copy per row per rebuild would hand the skeleton's
 * fingerprint memo a new key for a value that has not changed.
 */
const COMPLETED_STEER_CONTEXT: TranscriptRowContext = { completedSteer: true };

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

export function isTurnDecoratingEvent(event: ChatEvent): boolean {
  return TURN_DECORATING_EVENT_TYPES.has(event.type);
}

/**
 * The pause lifecycle, which decorates a turn but cannot be keyed on `turnId`.
 *
 * `buildTurnPauseAccounting` subtracts the human's wait from a turn's elapsed
 * time by pairing a request with its resolution: the OPEN carries the turn, and
 * the CLOSE is matched back to it by `approvalId` / `blockId` rather than by a
 * turn of its own. These events materialize no row, so neither a range nor the
 * inline tail can supply them any other way.
 *
 * Keying them on `event.turnId` like the rest would ship the open WITHOUT its
 * close, because the host stamps a resolution with
 * `this.activeTurn?.turnId ?? null` and a resolution landing after its turn
 * settled therefore carries `null`. An unclosed request that is not
 * live-pending is then dropped by the fold entirely - leaving exactly the
 * overcounted elapsed the association exists to prevent. So a close is
 * attributed to the turn its OPEN named.
 */
const PAUSE_OPEN_EVENT_TYPES: ReadonlySet<ChatEvent["type"]> = new Set([
  "approval.requested",
  "interview.requested",
]);
const PAUSE_CLOSE_EVENT_TYPES: ReadonlySet<ChatEvent["type"]> = new Set([
  "approval.resolved",
  "approval.denied",
  "approval.abandoned",
  "interview.resolved",
  "interview.errored",
]);

/**
 * What a pause request and its resolution are paired on.
 *
 * The two families use different correlation fields, and an event carrying
 * neither is unpairable - `buildTurnPauseAccounting` skips those on both sides,
 * so associating them with a row would ship bytes the fold discards.
 */
function pauseCorrelationKey(event: ChatEvent): string | null {
  if (event.type.startsWith("interview.")) {
    return event.blockId === null ? null : `interview:${event.blockId}`;
  }
  return event.approvalId === null ? null : `approval:${event.approvalId}`;
}

/**
 * Turn keys whose checkpoint has a file a LATER checkpoint touches again.
 *
 * Computed here, over the whole event log, because the renderer cannot: it
 * derives this from the events it holds, and on the windowed line that is
 * whatever subset is hydrated. A span containing an old turn but none of the
 * later checkpoints concludes `false`, and the restore dialog drops its
 * warning that files modified in later turns will also be rewound - a missing
 * warning on an irreversible action, which is why
 * {@link TranscriptRowContext.hasLaterOverlappingChanges} was specified for it.
 *
 * Keyed by TURN, not by checkpoint id, because that is what the row carries;
 * the checkpoint id is an implementation detail of the overlap rule.
 *
 * Order is load-bearing - "later" means later in the event log - so this walks
 * `events` in its given order and never sorts.
 *
 * Only each turn's last checkpoint counts (`latestCheckpointPerTurn`). A turn
 * whose checkpoint was rewritten must not be flagged by its own rewrite.
 *
 * Keyed by turn all the way through: the rule runs over each turn's changed
 * paths (`overlappingCheckpointKeys`), not over checkpoint ids mapped back to
 * turns. Two turns whose checkpoints share an id are still two checkpoints, and
 * the mapping would flag both whenever either overlapped. This is also the
 * form the row fold can keep in a store - see `CheckpointOverlapLoads`.
 *
 * This is the whole-history rule. The row fold answers the same question from
 * the store's path table without loading every checkpoint, and its parity test
 * holds it to this function.
 */
export function turnKeysWithLaterOverlappingChanges(
  events: readonly ChatEvent[],
): ReadonlySet<string> {
  // Select the retained checkpoint per turn from the RAW events, then parse
  // only what survived - the order `restoreCumulative` and the two
  // revert-scope scans already use, and the one `latestCheckpointPerTurn`
  // documents. Parsing first would drop an unreadable rewrite before it could
  // supersede anything and leave this rule judging the turn on the manifest
  // that rewrite replaced.
  const retained = latestCheckpointPerTurn(
    events.filter((event) => event.type === "checkpoint.captured"),
    checkpointEventTurnKey,
  );
  const current = retained.flatMap((event) => {
    if (event.turnId === null) return [];
    const paths = retainedCheckpointChangePaths(event);
    return paths === null ? [] : [{ key: event.turnId, paths }];
  });
  if (current.length === 0) return EMPTY_TURN_KEYS;
  return overlappingCheckpointKeys(current);
}

/**
 * The changed paths of a turn's retained `checkpoint.captured`, or `null` when
 * the manifest cannot be judged: no metadata, or a manifest this reader cannot
 * parse.
 *
 * An unjudgeable manifest is DROPPED rather than read, the same answer the
 * restore path gives a version mismatch ("cannot restore"). It is still the
 * turn's retained checkpoint - it supersedes the turn's earlier ones - which is
 * why this runs after `latestCheckpointPerTurn` and never before.
 *
 * For the overlap answer, a dropped checkpoint and one that changed no path are
 * the same: neither is ever overlapped, and neither overlaps another. The row
 * fold relies on that when it records an unjudgeable checkpoint as changing no
 * path.
 */
function retainedCheckpointChangePaths(event: ChatEvent): string[] | null {
  if (event.metadata === null) return null;
  const manifest = turnCheckpointManifestSchema.safeParse(event.metadata);
  return manifest.success ? checkpointChangePaths(manifest.data) : null;
}

const EMPTY_TURN_KEYS: ReadonlySet<string> = new Set<string>();

/**
 * Decorating event ids per turn, in event order.
 *
 * Keyed on `turnId` because that is what the renderer's folds key on. An event
 * with no `turnId` decorates nothing and is skipped - it is chat-level state,
 * and chat-level state rides the snapshot rather than a row. The pause
 * lifecycle is the one exception, and it is correlated rather than keyed; see
 * {@link PAUSE_OPEN_EVENT_TYPES}.
 */
export function decoratingEventIdsByTurn(
  events: readonly ChatEvent[],
): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, string[]>();
  const turnByPauseKey = new Map<string, string>();
  const associate = (turnId: string, eventId: string): void => {
    const held = out.get(turnId);
    if (held === undefined) {
      out.set(turnId, [eventId]);
      return;
    }
    held.push(eventId);
  };
  for (const event of events) {
    if (PAUSE_OPEN_EVENT_TYPES.has(event.type)) {
      // The open is what carries the turn. Without one there is nothing to
      // subtract the wait from, so an orphaned close is left unassociated.
      const key = pauseCorrelationKey(event);
      if (key === null || event.turnId === null) continue;
      turnByPauseKey.set(key, event.turnId);
      associate(event.turnId, event.eventId);
      continue;
    }
    if (PAUSE_CLOSE_EVENT_TYPES.has(event.type)) {
      const key = pauseCorrelationKey(event);
      if (key === null) continue;
      const turnId = turnByPauseKey.get(key) ?? event.turnId;
      if (turnId === null) continue;
      associate(turnId, event.eventId);
      continue;
    }
    if (event.turnId === null) continue;
    if (!TURN_DECORATING_EVENT_TYPES.has(event.type)) continue;
    associate(event.turnId, event.eventId);
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

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

/**
 * Enumerates a chat's durable transcript rows, in the order they are drawn.
 *
 * The returned array's indices ARE the ordinals. The order is the renderer's:
 * its `baseRows` concatenation stably sorted by `createdAt`, setup cards woven
 * above their anchor, the imported-chat marker and the genesis card pinned
 * above everything. Every one of those decisions is expressed as a component of
 * the row's {@link TranscriptRowOrder}, so this is the {@link foldTranscriptRows}
 * fold run from the empty state over every record, sorted by that key - the
 * same code path a store runs incrementally, not a second implementation of it.
 */
export function projectTranscriptRows(
  input: TranscriptRowProjectionInput,
): readonly TranscriptRowDescriptor[] {
  const folded = foldTranscriptRowsInMemory({
    chatId: input.chatId,
    activeTurnId: input.activeTurnId,
    messages: input.messages.map((message, position) => ({
      position,
      message,
    })),
    events: input.events.map((event, position) => ({ position, event })),
  });
  return sortedTranscriptFoldRows(folded.units).map((row) => row.descriptor);
}

/** Every row of `units`, in ordinal order. */
export function sortedTranscriptFoldRows(
  units: readonly TranscriptFoldUnit[],
): readonly TranscriptFoldRow[] {
  const rows: TranscriptFoldRow[] = [];
  for (const unit of units) rows.push(...unit.rows);
  return rows.sort((a, b) => compareTranscriptRowOrder(a.order, b.order));
}

/** A whole chat's records, positioned - what a full fold runs over. */
export interface TranscriptFoldFullInput {
  readonly chatId: string;
  readonly activeTurnId: string | null;
  /** In position order. */
  readonly messages: readonly PositionedMessage[];
  /** In position order. */
  readonly events: readonly PositionedEvent[];
}

/**
 * The fold from the empty state over every record, driven in memory.
 *
 * Every record is part of the change, so the only loads the fold makes are
 * answered from the input itself: nothing was persisted before it, and no
 * index row exists yet. This is what `projectTranscriptRows` runs, and what a
 * store runs to backfill a chat or when an increment declines.
 */
export function foldTranscriptRowsInMemory(
  input: TranscriptFoldFullInput,
): Extract<TranscriptFoldResult, { readonly continued: true }> {
  const messagesByTurnKey = new Map<string, PositionedMessage[]>();
  const messagesById = new Map<string, PositionedMessage>();
  for (const positioned of input.messages) {
    messagesById.set(positioned.message.messageId, positioned);
    if (positioned.message.role !== "assistant") continue;
    const turnKey = assistantTurnKey(positioned.message);
    const held = messagesByTurnKey.get(turnKey);
    if (held === undefined) {
      messagesByTurnKey.set(turnKey, [positioned]);
      continue;
    }
    held.push(positioned);
  }
  const factsByPosition = new Map<number, PositionedMessageFacts>();
  const factsOf = (positioned: PositionedMessage): PositionedMessageFacts => {
    const held = factsByPosition.get(positioned.position);
    if (held !== undefined) return held;
    const facts: PositionedMessageFacts = {
      position: positioned.position,
      messageId: positioned.message.messageId,
      facts: transcriptMessageFoldFacts(positioned.message),
    };
    factsByPosition.set(positioned.position, facts);
    return facts;
  };
  const answer = (load: TranscriptFoldLoad): TranscriptFoldLoadResult => {
    switch (load.kind) {
      case "facts-from": {
        const from = load.position;
        return {
          kind: "facts",
          facts: input.messages.flatMap((positioned) =>
            from === null || positioned.position >= from
              ? [factsOf(positioned)]
              : [],
          ),
        };
      }
      case "facts-of-turns":
        return {
          kind: "facts",
          facts: load.turnKeys
            .flatMap((turnKey) => messagesByTurnKey.get(turnKey) ?? [])
            .sort((a, b) => a.position - b.position)
            .map(factsOf),
        };
      case "messages-of-turns":
        return {
          kind: "messages",
          messages: load.turnKeys
            .flatMap((turnKey) => messagesByTurnKey.get(turnKey) ?? [])
            .sort((a, b) => a.position - b.position),
        };
      case "messages-by-id":
        return {
          kind: "messages",
          messages: load.messageIds
            .flatMap((messageId) => {
              const positioned = messagesById.get(messageId);
              return positioned === undefined ? [] : [positioned];
            })
            .sort((a, b) => a.position - b.position),
        };
      case "events-of-turns":
        // Nothing was persisted before a change that holds every event.
        return { kind: "turn-events", events: [] };
      case "events-by-type": {
        const types = new Set(load.types);
        return {
          kind: "events",
          events: input.events.filter((positioned) =>
            types.has(positioned.event.type),
          ),
        };
      }
      case "pause-open":
        return { kind: "pause-open", turnId: null };
      // Nothing is stored before a change that holds every record: each turn's
      // checkpoint position and paths come from the change itself.
      case "checkpoint-turns":
        return { kind: "checkpoint-turns", turns: [] };
      case "checkpoint-last-changes":
        return { kind: "checkpoint-last-changes", changes: [] };
      case "unit-rows":
      case "rows-by-id":
        return { kind: "rows", rows: [] };
    }
  };

  const steps = foldTranscriptRows(EMPTY_TRANSCRIPT_FOLD_STATE, {
    chatId: input.chatId,
    activeTurnId: input.activeTurnId,
    upsertedMessages: input.messages.map((positioned) => ({
      position: positioned.position,
      message: positioned.message,
      previous: null,
    })),
    removedMessages: [],
    appendedEvents: input.events.map((positioned) => ({
      position: positioned.position,
      event: positioned.event,
      previous: null,
    })),
  });
  let step = steps.next();
  while (step.done !== true) {
    step = steps.next(answer(step.value));
  }
  const result = step.value;
  if (!result.continued) {
    // From the empty state with every record in hand there is nothing the
    // fold cannot see; declining here is a bug in the fold, not an input.
    throw new Error(
      `row-projection: the full fold declined (${result.reason})`,
    );
  }
  return result;
}

/**
 * The fold facts of one message - what the whole-history walk reads from it.
 * See {@link TranscriptMessageFoldFacts}.
 */
export function transcriptMessageFoldFacts(
  message: Message,
): TranscriptMessageFoldFacts {
  if (message.role === "user") {
    return {
      v: TRANSCRIPT_MESSAGE_FOLD_FACTS_VERSION,
      role: "user",
      timestamp: message.timestamp,
      sessionAnchor: message.sessionAnchor,
    };
  }
  return {
    v: TRANSCRIPT_MESSAGE_FOLD_FACTS_VERSION,
    role: "assistant",
    turnKey: assistantTurnKey(message),
    hasBlocks: message.blocks.length > 0,
    opensAutonomous: turnOpensWithAutonomousResume(message.blocks),
    hasTurnProfile: message.turnProfile !== undefined,
    steerTargets: message.blocks.flatMap((block) =>
      block.type === "steer" ? [block.messageId] : [],
    ),
  };
}

/**
 * The pause correlation key a pause event is paired on, or `null` when it has
 * none - see {@link decoratingEventIdsByTurn}. A store keeps it as a column so
 * the fold's "latest open with this key" is one indexed read.
 */
export function transcriptPauseCorrelationKey(event: ChatEvent): string | null {
  if (
    !PAUSE_OPEN_EVENT_TYPES.has(event.type) &&
    !PAUSE_CLOSE_EVENT_TYPES.has(event.type)
  ) {
    return null;
  }
  return pauseCorrelationKey(event);
}

export function isTranscriptPauseOpenEvent(event: ChatEvent): boolean {
  return PAUSE_OPEN_EVENT_TYPES.has(event.type);
}

const TERMINAL_TURN_EVENT_TYPES: ReadonlySet<ChatEvent["type"]> = new Set([
  "turn.completed",
  "turn.stopped",
  "turn.interrupted",
]);

/**
 * The events a setup card's window partition reads: the setup lifecycle, the
 * boundary between lifecycles, and the fork that decides whether window 0 is
 * the genesis card. `partitionSetupCardWindows` skips every other type, so it
 * returns the same windows over this subset as over the whole log.
 *
 * The partition's own list, not a copy of it: a setup type added there and
 * missing here would leave the fold reading a different event set than the
 * partition, and let a rewrite of that type slip past the in-place-rewrite
 * decline.
 */
export const SETUP_CARD_INPUT_EVENT_TYPES: readonly ChatEvent["type"][] =
  SETUP_DERIVATION_EVENT_TYPES;

const SETUP_CARD_INPUT_EVENT_TYPE_SET: ReadonlySet<ChatEvent["type"]> = new Set(
  SETUP_CARD_INPUT_EVENT_TYPES,
);

/**
 * Every event type any row, row context or row digest of the projection reads.
 * An event of any other type can be rewritten in place without moving a row.
 */
const ROW_RELEVANT_EVENT_TYPES: ReadonlySet<ChatEvent["type"]> = new Set([
  ...TURN_DECORATING_EVENT_TYPES,
  ...PAUSE_OPEN_EVENT_TYPES,
  ...PAUSE_CLOSE_EVENT_TYPES,
  ...STEER_LIFECYCLE_EVENT_TYPES,
  ...SETUP_CARD_INPUT_EVENT_TYPES,
  "send.failed",
  "chat.imported",
  // The auto-mode judge notice row (`autoJudgeNoticeRowSource`): a rewrite
  // that adds or drops its marker or its text adds or drops the row.
  "permission.blocked",
]);

/**
 * How many turns may start after a turn that never reached a terminal event
 * before it stops holding the walk region open. An abandoned turn must not pin
 * the region forever; releasing one only means a later record of it widens
 * one walk to the whole chat.
 */
const MAX_TURNS_AFTER_OPEN_TURN = 32;

/**
 * How many turns may start after the last user record for the region to still
 * reach back to it. A provider fallback re-dispatches the last user message and
 * then rewrites that record's session anchor, so the region covers it while the
 * chat is still answering it - but an agent chat whose last user message was
 * followed by many autonomous turns would otherwise re-walk all of them on
 * every change.
 */
const MAX_TURNS_AFTER_LAST_USER = 8;

/** What the walk reads of one turn, folded from its records' fold facts. */
interface FoldTurnFacts {
  readonly firstPosition: number;
  readonly lastPosition: number;
  /** Classified from the turn's first block-bearing record, as the profile walk does. */
  readonly autonomous: boolean;
  /** Whether any record of the turn states its own profile. */
  readonly recorded: boolean;
  /** Every user message a steer block of the turn names. */
  readonly steerTargets: ReadonlySet<string>;
}

function foldTurnFacts(
  records: readonly PositionedMessageFacts[],
): FoldTurnFacts | null {
  const ordered = [...records].sort((a, b) => a.position - b.position);
  let firstPosition: number | null = null;
  let lastPosition = 0;
  let autonomous: boolean | null = null;
  let recorded = false;
  const steerTargets = new Set<string>();
  for (const positioned of ordered) {
    const facts = positioned.facts;
    if (facts.role !== "assistant") continue;
    if (firstPosition === null) firstPosition = positioned.position;
    lastPosition = positioned.position;
    if (facts.hasTurnProfile) recorded = true;
    if (autonomous === null && facts.hasBlocks) {
      autonomous = facts.opensAutonomous;
    }
    for (const messageId of facts.steerTargets) steerTargets.add(messageId);
  }
  if (firstPosition === null) return null;
  return {
    firstPosition,
    lastPosition,
    autonomous: autonomous ?? false,
    recorded,
    steerTargets,
  };
}

function* loadMessages(
  load: TranscriptFoldLoad,
): Generator<
  TranscriptFoldLoad,
  readonly PositionedMessage[],
  TranscriptFoldLoadResult
> {
  const result = yield load;
  if (result.kind !== "messages") {
    throw new Error(`row fold: ${load.kind} answered with ${result.kind}`);
  }
  return result.messages;
}

function* loadFacts(
  load: TranscriptFoldLoad,
): Generator<
  TranscriptFoldLoad,
  readonly PositionedMessageFacts[],
  TranscriptFoldLoadResult
> {
  const result = yield load;
  if (result.kind !== "facts") {
    throw new Error(`row fold: ${load.kind} answered with ${result.kind}`);
  }
  return result.facts;
}

function* loadEvents(
  load: TranscriptFoldLoad,
): Generator<
  TranscriptFoldLoad,
  readonly PositionedEvent[],
  TranscriptFoldLoadResult
> {
  const result = yield load;
  if (result.kind !== "events") {
    throw new Error(`row fold: ${load.kind} answered with ${result.kind}`);
  }
  return result.events;
}

function* loadTurnEvents(
  turnKeys: readonly string[],
): Generator<
  TranscriptFoldLoad,
  readonly PositionedTurnEvent[],
  TranscriptFoldLoadResult
> {
  const result = yield { kind: "events-of-turns", turnKeys };
  if (result.kind !== "turn-events") {
    throw new Error(`row fold: events-of-turns answered with ${result.kind}`);
  }
  return result.events;
}

function* loadRows(
  load: TranscriptFoldLoad,
): Generator<
  TranscriptFoldLoad,
  readonly StoredTranscriptRow[],
  TranscriptFoldLoadResult
> {
  const result = yield load;
  if (result.kind !== "rows") {
    throw new Error(`row fold: ${load.kind} answered with ${result.kind}`);
  }
  return result.rows;
}

function* loadPauseOpen(
  pauseKey: string,
  beforePosition: number,
): Generator<TranscriptFoldLoad, string | null, TranscriptFoldLoadResult> {
  const result = yield { kind: "pause-open", pauseKey, beforePosition };
  if (result.kind !== "pause-open") {
    throw new Error(`row fold: pause-open answered with ${result.kind}`);
  }
  return result.turnId;
}

// ---------------------------------------------------------------------------
// Checkpoint overlap
// ---------------------------------------------------------------------------

/** A turn whose retained checkpoint this change replaced. */
interface ReplacedCheckpoint {
  /** The turn's first checkpoint position, which the replacement keeps. */
  readonly position: number;
  /** Its changed paths as the store held them before this change. */
  readonly before: readonly string[];
  /** Its changed paths after it. */
  readonly after: readonly string[];
}

type CheckpointWorld = "before" | "after";

/**
 * # Checkpoint overlap, judged from the store's path table
 *
 * `turnKeysWithLaterOverlappingChanges` is the whole-history rule, and it
 * needs every checkpoint in the chat. Running it at every turn end made each
 * one read and parse the chat's whole checkpoint history, and keeping its
 * answer in the fold state made that state grow with the turn count. So the
 * store keeps each turn's retained changed paths instead (the fold reports
 * them in `checkpointPaths`), and the fold judges only the turns it has to.
 * It judges them with `overlappingCheckpointKeys`, the same rule, over the
 * subset that rule's doc names as sufficient: the judged turns, plus the last
 * changer of each of their paths, in position order.
 *
 * ## Which turns can change their answer
 *
 * Suppose a change replaces turn U's retained checkpoint: old paths O, new
 * paths N, same position. Only a turn that is the LAST changer (U aside) of
 * some path in O Δ N can change its answer. A turn that changed such a path
 * before that last changer overlaps through it both before and after. A path
 * in O ∩ N moved nobody. So the candidates are U and one last changer per
 * path in the symmetric difference, and each is judged in both worlds.
 *
 * ## The loads
 *
 * Both loads are narrow. `checkpoint-turns` reads the named turns' stored
 * paths. `checkpoint-last-changes` reads one row per path, with the replaced
 * turns excluded because the fold holds their paths itself. Nothing reads
 * every checkpoint.
 */
class CheckpointOverlapLoads {
  readonly stored = new Map<string, StoredCheckpointTurn | null>();
  readonly lastChanges = new Map<string, CheckpointPathChange | null>();

  constructor(
    private readonly replaced: ReadonlyMap<string, ReplacedCheckpoint>,
    private readonly excluded: readonly string[],
  ) {}

  *loadTurns(
    turnKeys: Iterable<string>,
  ): Generator<TranscriptFoldLoad, void, TranscriptFoldLoadResult> {
    const missing = [...new Set(turnKeys)].filter(
      (turnKey) => !this.stored.has(turnKey),
    );
    if (missing.length === 0) return;
    const result = yield { kind: "checkpoint-turns", turnKeys: missing };
    if (result.kind !== "checkpoint-turns") {
      throw new Error(
        `row fold: checkpoint-turns answered with ${result.kind}`,
      );
    }
    for (const turnKey of missing) this.stored.set(turnKey, null);
    for (const turn of result.turns) this.stored.set(turn.turnKey, turn);
  }

  /** Loads the last changer of every path the named turns have in `world`. */
  *loadLastChangesOf(
    turnKeys: Iterable<string>,
    world: CheckpointWorld,
  ): Generator<TranscriptFoldLoad, void, TranscriptFoldLoadResult> {
    const paths = new Set<string>();
    for (const turnKey of turnKeys) {
      for (const path of this.pathsOf(turnKey, world)) paths.add(path);
    }
    yield* this.loadLastChanges(paths);
  }

  *loadLastChanges(
    paths: Iterable<string>,
  ): Generator<TranscriptFoldLoad, void, TranscriptFoldLoadResult> {
    const missing = [...new Set(paths)].filter(
      (path) => !this.lastChanges.has(path),
    );
    if (missing.length === 0) return;
    const result = yield {
      kind: "checkpoint-last-changes",
      filePaths: missing,
      excludeTurnKeys: this.excluded,
    };
    if (result.kind !== "checkpoint-last-changes") {
      throw new Error(
        `row fold: checkpoint-last-changes answered with ${result.kind}`,
      );
    }
    for (const path of missing) this.lastChanges.set(path, null);
    for (const change of result.changes) {
      this.lastChanges.set(change.filePath, change);
    }
  }

  /** A turn's changed paths in `world`; empty for a turn not yet loaded. */
  pathsOf(turnKey: string, world: CheckpointWorld): readonly string[] {
    const replaced = this.replaced.get(turnKey);
    if (replaced !== undefined) return replaced[world];
    return this.stored.get(turnKey)?.paths ?? [];
  }

  /**
   * Which of `turnKeys` overlap in `world`. Every non-replaced turn must have
   * been loaded, and the last changer of every path of every judged turn.
   */
  overlapping(
    turnKeys: Iterable<string>,
    world: CheckpointWorld,
  ): ReadonlySet<string> {
    const checkpoints = new Map<
      string,
      { readonly position: number; readonly paths: Set<string> }
    >();
    const note = (
      turnKey: string,
      position: number,
      paths: readonly string[],
    ): void => {
      const held = checkpoints.get(turnKey);
      if (held === undefined) {
        checkpoints.set(turnKey, { position, paths: new Set(paths) });
        return;
      }
      for (const path of paths) held.paths.add(path);
    };
    // Every replaced turn is a possible later changer of a judged path, and
    // `checkpoint-last-changes` excluded them, so they enter here, in the
    // world being judged.
    for (const [turnKey, replaced] of this.replaced) {
      note(turnKey, replaced.position, replaced[world]);
    }
    const judged: string[] = [];
    const judgedPaths = new Set<string>();
    for (const turnKey of new Set(turnKeys)) {
      const replaced = this.replaced.get(turnKey);
      if (replaced !== undefined) {
        judged.push(turnKey);
        for (const path of replaced[world]) judgedPaths.add(path);
        continue;
      }
      const stored = this.stored.get(turnKey);
      if (stored === undefined) {
        throw new Error("row fold: a checkpoint turn was judged unloaded");
      }
      // A turn with no checkpoint changed nothing and overlaps nothing.
      if (stored === null || stored.position === null) continue;
      note(turnKey, stored.position, stored.paths);
      judged.push(turnKey);
      for (const path of stored.paths) judgedPaths.add(path);
    }
    for (const path of judgedPaths) {
      const last = this.lastChanges.get(path);
      if (last === undefined) {
        throw new Error("row fold: a checkpoint path was judged unloaded");
      }
      if (last !== null) note(last.turnKey, last.position, [path]);
    }
    const overlapping = overlappingCheckpointKeys(
      [...checkpoints.entries()]
        .sort((a, b) => a[1].position - b[1].position)
        .map(([key, held]) => ({ key, paths: [...held.paths] })),
    );
    return new Set(judged.filter((turnKey) => overlapping.has(turnKey)));
  }
}

/** The changed paths `after` has and `before` lacks, and the reverse. */
function symmetricDifference(
  before: readonly string[],
  after: readonly string[],
): string[] {
  const inBefore = new Set(before);
  const inAfter = new Set(after);
  return [
    ...before.filter((path) => !inAfter.has(path)),
    ...after.filter((path) => !inBefore.has(path)),
  ];
}

function addToList(
  lists: Map<string, string[]>,
  key: string,
  value: string,
): void {
  const held = lists.get(key);
  if (held === undefined) {
    lists.set(key, [value]);
    return;
  }
  if (!held.includes(value)) held.push(value);
}

function removeFromList(
  lists: Map<string, string[]>,
  key: string,
  value: string,
): void {
  const held = lists.get(key);
  if (held === undefined) return;
  const next = held.filter((entry) => entry !== value);
  if (next.length === 0) {
    lists.delete(key);
    return;
  }
  lists.set(key, next);
}

function listsFrom(
  record: Readonly<Record<string, readonly string[]>>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [key, values] of Object.entries(record)) {
    if (values.length > 0) out.set(key, [...values]);
  }
  return out;
}

function recordFrom<T>(map: ReadonlyMap<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, value] of map) out[key] = value;
  return out;
}

function maxPosition(held: number | null, position: number): number {
  return held === null ? position : Math.max(held, position);
}

function wovenOrder(input: {
  readonly createdAt: number;
  readonly pass: number;
  readonly position: number;
  readonly entry: number;
}): TranscriptRowOrder {
  return {
    section: TRANSCRIPT_ROW_SECTION.woven,
    createdAt: input.createdAt,
    pass: input.pass,
    position: input.position,
    entry: input.entry,
    slot: TRANSCRIPT_ROW_SLOT.row,
    card: 0,
  };
}

function assistantTurnKeysOf(
  facts: readonly PositionedMessageFacts[],
): ReadonlySet<string> {
  const turnKeys = new Set<string>();
  for (const positioned of facts) {
    if (positioned.facts.role === "assistant") {
      turnKeys.add(positioned.facts.turnKey);
    }
  }
  return turnKeys;
}

interface WalkEntry {
  readonly sessionAnchor: ChatSessionAnchor | null;
  readonly lastUserTimestamp: number | null;
}

/**
 * The projection as a fold that can continue from a persisted state.
 *
 * Given the state the previous fold left and one change, it re-describes every
 * UNIT whose rows the change can move - and only those - and returns their new
 * rows with their order keys, plus the state to persist beside them. It never
 * guesses which rows a whole-history fold can reach: it re-runs each fold from
 * its persisted running value, so a `queue.fallback` retracting an old steer
 * badge reaches that row because the retracted set is state, not because
 * anything searched for it.
 *
 * The record walk - session anchor, legacy anchor timestamp, the profile
 * walk's attempt spans - runs over fold facts from the state's
 * {@link TranscriptWalkRegion}, and widens to the whole chat (facts only)
 * when a change reaches before it. Only the turns whose walked state then
 * differs from what their rows were projected with are re-described.
 *
 * Sans-IO: records it does not hold it asks for by yielding a
 * {@link TranscriptFoldLoad}, and the driver resumes it with the answer. The
 * in-memory driver ({@link foldTranscriptRowsInMemory}) answers from arrays; a
 * store answers from its tables.
 *
 * It DECLINES (`continued: false`) - and the caller runs the full fold - only
 * on what no running value can absorb: a record inserted below the positions
 * already folded or moved in place, a row-relevant event rewritten in place,
 * state or fold facts written by another version, and a turn with rows but no
 * stored walk state (a corrupt index).
 */
export function* foldTranscriptRows(
  prior: TranscriptFoldState,
  change: TranscriptFoldChange,
): Generator<
  TranscriptFoldLoad,
  TranscriptFoldResult,
  TranscriptFoldLoadResult
> {
  const notContinued = (reason: string): TranscriptFoldResult => ({
    continued: false,
    reason,
  });
  if (
    prior.version !== TRANSCRIPT_FOLD_STATE_VERSION ||
    prior.factsVersion !== TRANSCRIPT_MESSAGE_FOLD_FACTS_VERSION
  ) {
    return notContinued("fold state written by another version");
  }

  const region = prior.region;
  const regionFrom = region.from;
  const beforeRegion = (position: number): boolean =>
    regionFrom !== null && position < regionFrom;

  // Units whose rows this change re-describes.
  const touchedTurns = new Set<string>();
  const touchedUsers = new Set<string>();
  // Turns whose records this change wrote - live activity, which holds the
  // walk region open as `turn.started` does.
  const recordTouchedTurns = new Set<string>();
  let walkNeeded = false;
  // Whether the walk has to start before the region.
  let widen = false;
  let messagesThrough = prior.messagesThrough;

  const noteFacts = (
    facts: TranscriptMessageFoldFacts,
    messageId: string,
  ): void => {
    if (facts.role === "user") {
      touchedUsers.add(messageId);
      return;
    }
    touchedTurns.add(facts.turnKey);
    recordTouchedTurns.add(facts.turnKey);
  };

  for (const touch of change.upsertedMessages) {
    const facts = transcriptMessageFoldFacts(touch.message);
    if (touch.previous === null) {
      if (
        prior.messagesThrough !== null &&
        touch.position <= prior.messagesThrough
      ) {
        return notContinued(
          "a message was inserted below the folded positions",
        );
      }
      walkNeeded = true;
    } else {
      if (touch.previous.facts.v !== TRANSCRIPT_MESSAGE_FOLD_FACTS_VERSION) {
        return notContinued(
          "a message's stored fold facts are another version",
        );
      }
      if (touch.previous.position !== touch.position) {
        return notContinued("a message changed position in place");
      }
      if (!transcriptMessageFoldFactsEqual(touch.previous.facts, facts)) {
        walkNeeded = true;
        if (beforeRegion(touch.position)) widen = true;
        noteFacts(touch.previous.facts, touch.message.messageId);
      }
    }
    noteFacts(facts, touch.message.messageId);
    messagesThrough = maxPosition(messagesThrough, touch.position);
  }
  for (const removal of change.removedMessages) {
    if (removal.facts.v !== TRANSCRIPT_MESSAGE_FOLD_FACTS_VERSION) {
      return notContinued("a message's stored fold facts are another version");
    }
    walkNeeded = true;
    if (beforeRegion(removal.position)) widen = true;
    noteFacts(removal.facts, removal.messageId);
  }

  // --- Events: every event-side fold continues from its persisted value. ---
  const steerLifecycle: SteerLifecycleFold = {
    steeredMessageIds: new Set(prior.completedSteer.messageIds),
    steerRequestMessageIdsByQueueItemId: new Map(
      Object.entries(prior.completedSteer.requestMessageIdByQueueItemId),
    ),
  };
  const openTurns = new Set(prior.openTurnKeys);
  const stopTriggers = listsFrom(prior.stopTriggers);
  const pauseTurnsInChange = new Map<string, string>();
  const eventRowTurnKeys = new Map<string, string>();
  const changeEventsByTurn = new Map<string, PositionedEvent[]>();
  const eventUnits = new Map<string, PositionedEvent>();
  let eventsThrough = prior.eventsThrough;
  // Per turn, the first and the last checkpoint this change appended. An
  // event-keyed checkpoint (no `turnId`) never enters the overlap rule.
  const changedCheckpoints = new Map<
    string,
    { readonly firstPosition: number; readonly last: ChatEvent }
  >();
  let setupChanged = false;

  for (const touch of change.appendedEvents) {
    if (touch.previous !== null) {
      if (
        canonicalFoldJson(touch.previous) === canonicalFoldJson(touch.event)
      ) {
        continue;
      }
      if (
        !ROW_RELEVANT_EVENT_TYPES.has(touch.previous.type) &&
        !ROW_RELEVANT_EVENT_TYPES.has(touch.event.type)
      ) {
        continue;
      }
      return notContinued("a row-relevant event was rewritten in place");
    }
    if (prior.eventsThrough !== null && touch.position <= prior.eventsThrough) {
      return notContinued("an event was inserted below the folded positions");
    }
    eventsThrough = maxPosition(eventsThrough, touch.position);
    const event = touch.event;

    applySteerLifecycleEvent(steerLifecycle, event);

    if (event.turnId !== null) {
      if (event.type === "turn.started") {
        // Re-inserted so the set keeps start order.
        openTurns.delete(event.turnId);
        openTurns.add(event.turnId);
      } else if (TERMINAL_TURN_EVENT_TYPES.has(event.type)) {
        openTurns.delete(event.turnId);
      }
    }

    // The turn this event decorates - `decoratingEventIdsByTurn`, one event
    // at a time. A pause close is attributed to its OPEN's turn.
    let rowTurnKey: string | null = null;
    if (PAUSE_OPEN_EVENT_TYPES.has(event.type)) {
      const key = pauseCorrelationKey(event);
      if (key !== null && event.turnId !== null) {
        pauseTurnsInChange.set(key, event.turnId);
        rowTurnKey = event.turnId;
      }
    } else if (PAUSE_CLOSE_EVENT_TYPES.has(event.type)) {
      const key = pauseCorrelationKey(event);
      if (key !== null) {
        const openTurn =
          pauseTurnsInChange.get(key) ??
          (yield* loadPauseOpen(key, touch.position));
        rowTurnKey = openTurn ?? event.turnId;
      }
    } else if (
      event.turnId !== null &&
      TURN_DECORATING_EVENT_TYPES.has(event.type)
    ) {
      rowTurnKey = event.turnId;
    }
    if (rowTurnKey !== null) {
      touchedTurns.add(rowTurnKey);
      eventRowTurnKeys.set(event.eventId, rowTurnKey);
      const held = changeEventsByTurn.get(rowTurnKey);
      if (held === undefined) {
        changeEventsByTurn.set(rowTurnKey, [touch]);
      } else {
        held.push(touch);
      }
    }

    if (
      event.type === "turn.stopped" &&
      event.turnId !== null &&
      event.messageId !== null
    ) {
      addToList(stopTriggers, event.messageId, event.turnId);
    }
    if (event.type === "checkpoint.captured" && event.turnId !== null) {
      changedCheckpoints.set(event.turnId, {
        firstPosition:
          changedCheckpoints.get(event.turnId)?.firstPosition ?? touch.position,
        last: event,
      });
    }
    if (SETUP_CARD_INPUT_EVENT_TYPE_SET.has(event.type)) setupChanged = true;
    if (eventMaterializesTranscriptRow(event)) {
      eventUnits.set(event.eventId, touch);
    }
  }

  // A completed-steer badge that appeared or was retracted moves exactly the
  // user row it names.
  const priorSteered = new Set(prior.completedSteer.messageIds);
  for (const messageId of steerLifecycle.steeredMessageIds) {
    if (!priorSteered.has(messageId)) touchedUsers.add(messageId);
  }
  for (const messageId of priorSteered) {
    if (!steerLifecycle.steeredMessageIds.has(messageId)) {
      touchedUsers.add(messageId);
    }
  }

  // --- Checkpoint overlap: the turns whose answer this change moved. ---
  const replacedCheckpoints = new Map<string, ReplacedCheckpoint>();
  const checkpointLoads = new CheckpointOverlapLoads(replacedCheckpoints, [
    ...changedCheckpoints.keys(),
  ]);
  if (changedCheckpoints.size > 0) {
    yield* checkpointLoads.loadTurns(changedCheckpoints.keys());
    for (const [turnKey, changed] of changedCheckpoints) {
      const stored = checkpointLoads.stored.get(turnKey) ?? null;
      const storedPosition = stored?.position ?? null;
      replacedCheckpoints.set(turnKey, {
        position:
          storedPosition === null
            ? changed.firstPosition
            : Math.min(storedPosition, changed.firstPosition),
        before: stored?.paths ?? [],
        // Unjudgeable reads as changing no path: the same answer for every
        // turn, see `retainedCheckpointChangePaths`.
        after: retainedCheckpointChangePaths(changed.last) ?? [],
      });
    }
    const movedPaths = new Set<string>();
    for (const replaced of replacedCheckpoints.values()) {
      for (const path of symmetricDifference(replaced.before, replaced.after)) {
        movedPaths.add(path);
      }
    }
    yield* checkpointLoads.loadLastChanges(movedPaths);
    const candidates = new Set(replacedCheckpoints.keys());
    for (const path of movedPaths) {
      const last = checkpointLoads.lastChanges.get(path) ?? null;
      if (last !== null) candidates.add(last.turnKey);
    }
    yield* checkpointLoads.loadTurns(candidates);
    yield* checkpointLoads.loadLastChangesOf(candidates, "before");
    yield* checkpointLoads.loadLastChangesOf(candidates, "after");
    const before = checkpointLoads.overlapping(candidates, "before");
    const after = checkpointLoads.overlapping(candidates, "after");
    for (const turnKey of candidates) {
      if (before.has(turnKey) !== after.has(turnKey)) touchedTurns.add(turnKey);
    }
  }

  if (prior.activeTurnId !== change.activeTurnId) {
    if (prior.activeTurnId !== null) touchedTurns.add(prior.activeTurnId);
    if (change.activeTurnId !== null) touchedTurns.add(change.activeTurnId);
  }

  // --- Turn facts, and the steer targets they name. ---
  const turnFacts = new Map<string, FoldTurnFacts | null>();
  const loadTurnFacts = function* (
    turnKeys: Iterable<string>,
  ): Generator<TranscriptFoldLoad, void, TranscriptFoldLoadResult> {
    const missing = [...new Set(turnKeys)].filter(
      (turnKey) => !turnFacts.has(turnKey),
    );
    if (missing.length === 0) return;
    const byTurn = new Map<string, PositionedMessageFacts[]>();
    for (const turnKey of missing) byTurn.set(turnKey, []);
    const loaded = yield* loadFacts({
      kind: "facts-of-turns",
      turnKeys: missing,
    });
    for (const positioned of loaded) {
      if (positioned.facts.role !== "assistant") continue;
      byTurn.get(positioned.facts.turnKey)?.push(positioned);
    }
    for (const [turnKey, records] of byTurn) {
      turnFacts.set(turnKey, foldTurnFacts(records));
    }
  };

  // Steer targets move with the turns whose records moved, and every turn a
  // touched user is steered into or stopped by is re-described with it -
  // those rows render the user record. Expanding one can expand the other, so
  // run to a fixpoint. A turn whose records did not move keeps its targets.
  const steerTargets = listsFrom(prior.steerTargets);
  const targetsByTurn = new Map<string, ReadonlySet<string>>();
  for (const [messageId, turnKeys] of steerTargets) {
    for (const turnKey of turnKeys) {
      targetsByTurn.set(
        turnKey,
        new Set([...(targetsByTurn.get(turnKey) ?? []), messageId]),
      );
    }
  }
  const isNested = (messageId: string): boolean =>
    (steerTargets.get(messageId)?.length ?? 0) > 0;
  const wasNested = (messageId: string): boolean =>
    (prior.steerTargets[messageId]?.length ?? 0) > 0;
  const retargeted = new Set<string>();
  const nestingCandidates = new Set<string>();
  const expandedUsers = new Set<string>();
  for (;;) {
    yield* loadTurnFacts(touchedTurns);
    for (const turnKey of touchedTurns) {
      if (retargeted.has(turnKey)) continue;
      retargeted.add(turnKey);
      const next = turnFacts.get(turnKey)?.steerTargets ?? new Set<string>();
      const before = targetsByTurn.get(turnKey) ?? new Set<string>();
      for (const messageId of before) {
        if (next.has(messageId)) continue;
        removeFromList(steerTargets, messageId, turnKey);
        nestingCandidates.add(messageId);
      }
      for (const messageId of next) {
        if (before.has(messageId)) continue;
        addToList(steerTargets, messageId, turnKey);
        nestingCandidates.add(messageId);
      }
      targetsByTurn.set(turnKey, next);
    }
    // A user record that became, or stopped being, a nested steer gains or
    // loses its own row.
    for (const messageId of nestingCandidates) {
      if (wasNested(messageId) !== isNested(messageId)) {
        touchedUsers.add(messageId);
      }
    }
    let grew = false;
    for (const messageId of touchedUsers) {
      if (expandedUsers.has(messageId)) continue;
      expandedUsers.add(messageId);
      const related = [
        ...(prior.steerTargets[messageId] ?? []),
        ...(steerTargets.get(messageId) ?? []),
        ...(stopTriggers.get(messageId) ?? []),
      ];
      for (const turnKey of related) {
        if (touchedTurns.has(turnKey)) continue;
        touchedTurns.add(turnKey);
        grew = true;
      }
    }
    if (!grew) break;
  }

  // --- User records. ---
  const liveUsers = new Map<string, PositionedMessage>();
  const absentUsers = new Set<string>();
  const loadUsers = function* (
    messageIds: Iterable<string>,
  ): Generator<TranscriptFoldLoad, void, TranscriptFoldLoadResult> {
    const missing = [...new Set(messageIds)].filter(
      (messageId) => !liveUsers.has(messageId) && !absentUsers.has(messageId),
    );
    if (missing.length === 0) return;
    const loaded = yield* loadMessages({
      kind: "messages-by-id",
      messageIds: missing,
    });
    for (const positioned of loaded) {
      if (positioned.message.role !== "user") continue;
      liveUsers.set(positioned.message.messageId, positioned);
    }
    for (const messageId of missing) {
      if (!liveUsers.has(messageId)) absentUsers.add(messageId);
    }
  };
  yield* loadUsers(touchedUsers);

  // A user record whose nesting flipped moves the running `lastUserTimestamp`
  // from its position on.
  for (const messageId of nestingCandidates) {
    if (wasNested(messageId) === isNested(messageId)) continue;
    const record = liveUsers.get(messageId);
    if (record === undefined) continue;
    walkNeeded = true;
    if (beforeRegion(record.position)) widen = true;
  }

  // --- The walk, over fold facts. ---
  const walkedEntries = new Map<string, WalkEntry>();
  const walkedUnprovable = new Map<string, boolean>();
  let nextRegion: TranscriptWalkRegion = region;
  let nextOpenTurns: readonly string[] = [...openTurns];
  if (walkNeeded) {
    let walkRegion: TranscriptWalkRegion = widen
      ? EMPTY_TRANSCRIPT_FOLD_STATE.region
      : region;
    let walkFacts = yield* loadFacts({
      kind: "facts-from",
      position: walkRegion.from,
    });
    let walkTurnKeys = assistantTurnKeysOf(walkFacts);
    yield* loadTurnFacts([
      ...walkTurnKeys,
      ...walkRegion.spanKeysBefore,
      ...openTurns,
    ]);
    const walkFrom = walkRegion.from;
    if (
      walkFrom !== null &&
      [...walkTurnKeys].some(
        (turnKey) =>
          (turnFacts.get(turnKey)?.firstPosition ?? walkFrom) < walkFrom,
      )
    ) {
      // A turn that started before the region gained a record there.
      walkRegion = EMPTY_TRANSCRIPT_FOLD_STATE.region;
      walkFacts = yield* loadFacts({ kind: "facts-from", position: null });
      walkTurnKeys = assistantTurnKeysOf(walkFacts);
      yield* loadTurnFacts(walkTurnKeys);
    }

    // Where the next region starts: as late as the tail allows, and never
    // inside a turn.
    const turnsByFirst = [...walkTurnKeys]
      .flatMap((turnKey) => {
        const folded = turnFacts.get(turnKey) ?? null;
        return folded === null ? [] : [{ turnKey, folded }];
      })
      .sort((a, b) => a.folded.firstPosition - b.folded.firstPosition);
    const turnsStartingAfter = (position: number): number =>
      turnsByFirst.filter((turn) => turn.folded.firstPosition > position)
        .length;
    let seat = Number.POSITIVE_INFINITY;
    // The last two turns, so a retry or a late record of either stays inside.
    const keptTurn = turnsByFirst.at(-2) ?? turnsByFirst.at(-1);
    if (keptTurn !== undefined) {
      seat = Math.min(seat, keptTurn.folded.firstPosition);
    }
    let lastUserPosition: number | null = null;
    for (const positioned of walkFacts) {
      if (positioned.facts.role === "user") {
        lastUserPosition = positioned.position;
      }
    }
    if (
      lastUserPosition !== null &&
      turnsStartingAfter(lastUserPosition) <= MAX_TURNS_AFTER_LAST_USER
    ) {
      seat = Math.min(seat, lastUserPosition);
    }
    const releasedTurns = new Set<string>();
    for (const turnKey of new Set([...openTurns, ...recordTouchedTurns])) {
      const folded = turnFacts.get(turnKey) ?? null;
      if (folded === null || !walkTurnKeys.has(turnKey)) continue;
      if (
        openTurns.has(turnKey) &&
        turnsStartingAfter(folded.firstPosition) > MAX_TURNS_AFTER_OPEN_TURN
      ) {
        releasedTurns.add(turnKey);
        continue;
      }
      seat = Math.min(seat, folded.firstPosition);
    }
    for (let moved = true; moved;) {
      moved = false;
      for (const { folded } of turnsByFirst) {
        if (folded.firstPosition < seat && folded.lastPosition >= seat) {
          seat = folded.firstPosition;
          moved = true;
        }
      }
    }

    let sessionAnchor = walkRegion.anchorBefore;
    let lastUserTimestamp = walkRegion.lastUserTimestampBefore;
    // Attempt turn keys per span; the first continues the region's span.
    const spans: string[][] = [[...walkRegion.spanKeysBefore]];
    let seated: {
      readonly entry: WalkEntry;
      readonly spanIndex: number;
      readonly keysBefore: number;
    } | null = null;
    for (const positioned of walkFacts) {
      const facts = positioned.facts;
      const span = spans[spans.length - 1];
      if (positioned.position === seat) {
        seated = {
          entry: { sessionAnchor, lastUserTimestamp },
          spanIndex: spans.length - 1,
          keysBefore: span.length,
        };
      }
      if (facts.role === "user") {
        if (facts.sessionAnchor !== null) sessionAnchor = facts.sessionAnchor;
        // A nested steer does not move the legacy anchor - see the renderer
        // walk in `turnKeysWithUnprovableProfileWalk`'s callers.
        if (!isNested(positioned.messageId)) {
          lastUserTimestamp = facts.timestamp;
        }
        // Every user record closes a span, nested or not.
        spans.push([]);
        continue;
      }
      const folded = turnFacts.get(facts.turnKey) ?? null;
      if (folded === null) continue;
      if (folded.firstPosition === positioned.position) {
        walkedEntries.set(facts.turnKey, { sessionAnchor, lastUserTimestamp });
      }
      if (!facts.hasBlocks || folded.autonomous) continue;
      if (!span.includes(facts.turnKey)) span.push(facts.turnKey);
    }

    const markingSpans = new Map<string, number[]>();
    spans.forEach((keys, index) => {
      if (keys.length < 2) return;
      for (const turnKey of keys) {
        markingSpans.set(turnKey, [
          ...(markingSpans.get(turnKey) ?? []),
          index,
        ]);
      }
    });
    const markedElsewhere = new Set(walkRegion.spanKeysMarkedElsewhere);
    for (const turnKey of walkTurnKeys) {
      const folded = turnFacts.get(turnKey) ?? null;
      if (folded === null) continue;
      walkedUnprovable.set(
        turnKey,
        (folded.autonomous || markingSpans.has(turnKey)) && !folded.recorded,
      );
    }
    // The turns before the region in the span it continues: only that span's
    // mark can have moved for them.
    for (const turnKey of walkRegion.spanKeysBefore) {
      const folded = turnFacts.get(turnKey) ?? null;
      if (folded === null) continue;
      walkedUnprovable.set(
        turnKey,
        (markingSpans.has(turnKey) || markedElsewhere.has(turnKey)) &&
          !folded.recorded,
      );
    }

    nextRegion = walkRegion;
    if (
      seated !== null &&
      (walkRegion.from === null || seat > walkRegion.from)
    ) {
      const spanIndex = seated.spanIndex;
      const keysBefore = spans[spanIndex].slice(0, seated.keysBefore);
      nextRegion = {
        from: seat,
        anchorBefore: seated.entry.sessionAnchor,
        lastUserTimestampBefore: seated.entry.lastUserTimestamp,
        spanKeysBefore: keysBefore,
        spanKeysMarkedElsewhere: keysBefore.filter(
          (turnKey) =>
            markedElsewhere.has(turnKey) ||
            (markingSpans.get(turnKey) ?? []).some(
              (index) => index !== spanIndex,
            ),
        ),
      };
    }
    // A turn the region no longer covers cannot hold it open. One with no
    // record yet is kept: its first record lands after every seat.
    const nextFrom = nextRegion.from;
    nextOpenTurns = [...openTurns].filter((turnKey) => {
      if (releasedTurns.has(turnKey)) return false;
      const folded = turnFacts.get(turnKey) ?? null;
      return (
        folded === null || nextFrom === null || folded.firstPosition >= nextFrom
      );
    });
  }

  // --- Stored rows of every unit that may be re-described. ---
  const storedRows = new Map<string, StoredTranscriptRow[]>();
  const unitStates = new Map<string, TranscriptTurnUnitState>();
  {
    const turnByUnitKey = new Map<string, string>();
    for (const turnKey of [...touchedTurns, ...walkedUnprovable.keys()]) {
      turnByUnitKey.set(turnRowUnitKey(turnKey), turnKey);
    }
    const unitKeys = [
      ...turnByUnitKey.keys(),
      ...[...touchedUsers].map(userRowUnitKey),
      ...[...eventUnits.keys()].map(eventRowUnitKey),
    ];
    if (unitKeys.length > 0) {
      for (const row of yield* loadRows({ kind: "unit-rows", unitKeys })) {
        const held = storedRows.get(row.unitKey);
        if (held === undefined) {
          storedRows.set(row.unitKey, [row]);
        } else {
          held.push(row);
        }
        const turnKey = turnByUnitKey.get(row.unitKey);
        if (turnKey !== undefined && row.unitState !== null) {
          unitStates.set(turnKey, row.unitState);
        }
      }
    }
  }
  const unitStateOf = (turnKey: string): TranscriptTurnUnitState | null => {
    const stored = unitStates.get(turnKey);
    const entry = walkedEntries.get(turnKey) ?? stored;
    const profileWalkUnprovable =
      walkedUnprovable.get(turnKey) ?? stored?.profileWalkUnprovable;
    if (entry === undefined || profileWalkUnprovable === undefined) {
      return null;
    }
    return {
      lastUserTimestamp: entry.lastUserTimestamp,
      sessionAnchor: entry.sessionAnchor,
      profileWalkUnprovable,
    };
  };
  // A walked turn whose state moved is re-described with it.
  for (const turnKey of walkedUnprovable.keys()) {
    const stored = unitStates.get(turnKey);
    const next = unitStateOf(turnKey);
    if (
      stored === undefined ||
      next === null ||
      canonicalFoldJson(stored) !== canonicalFoldJson(next)
    ) {
      touchedTurns.add(turnKey);
    }
  }

  // Every re-described turn carries its overlap answer. The turns this change
  // could move were judged above; any other is judged the same way, from its
  // stored paths and their last changers.
  yield* checkpointLoads.loadTurns(touchedTurns);
  yield* checkpointLoads.loadLastChangesOf(touchedTurns, "after");
  const overlapping = checkpointLoads.overlapping(touchedTurns, "after");

  // --- Bodies of what is re-described. ---
  const turnBodies = new Map<string, PositionedMessage[]>();
  if (touchedTurns.size > 0) {
    for (const turnKey of touchedTurns) turnBodies.set(turnKey, []);
    const loaded = yield* loadMessages({
      kind: "messages-of-turns",
      turnKeys: [...touchedTurns],
    });
    for (const positioned of loaded) {
      if (positioned.message.role !== "assistant") continue;
      turnBodies.get(assistantTurnKey(positioned.message))?.push(positioned);
    }
  }

  // The events decorating every re-described turn: those persisted before
  // this change, under the turn the store recorded them as decorating, plus
  // the ones this change appended, in event order.
  const decoratingByTurn = new Map<string, PositionedEvent[]>();
  if (touchedTurns.size > 0) {
    const placed = new Set<string>();
    const place = (turnKey: string, positioned: PositionedEvent): void => {
      const identity = `${turnKey}\u0000${positioned.event.eventId}`;
      if (placed.has(identity)) return;
      placed.add(identity);
      const held = decoratingByTurn.get(turnKey);
      if (held === undefined) {
        decoratingByTurn.set(turnKey, [positioned]);
        return;
      }
      held.push(positioned);
    };
    // The change's own events first, and a stored row for an event the change
    // rewrote is skipped whatever turn it names: a store may answer with the
    // row as it stood before this change or as it was just written, and the
    // change's copy is the current one either way.
    const changedEventIds = new Set(
      change.appendedEvents.map((touch) => touch.event.eventId),
    );
    for (const [turnKey, events] of changeEventsByTurn) {
      for (const positioned of events) place(turnKey, positioned);
    }
    for (const stored of yield* loadTurnEvents([...touchedTurns])) {
      if (changedEventIds.has(stored.event.eventId)) continue;
      place(stored.rowTurnKey, {
        position: stored.position,
        event: stored.event,
      });
    }
    for (const events of decoratingByTurn.values()) {
      events.sort((a, b) => a.position - b.position);
    }
  }
  const stopsOf = (turnKey: string): readonly PositionedEvent[] =>
    (decoratingByTurn.get(turnKey) ?? []).filter(
      (positioned) => positioned.event.type === "turn.stopped",
    );

  // Every other user record a re-described row reads: the targets of
  // re-described turns' steer blocks, and the message their last stop names.
  {
    const neededUsers: string[] = [];
    for (const turnKey of touchedTurns) {
      neededUsers.push(...(targetsByTurn.get(turnKey) ?? []));
      const lastStop = stopsOf(turnKey).at(-1);
      if (lastStop !== undefined && lastStop.event.messageId !== null) {
        neededUsers.push(lastStop.event.messageId);
      }
    }
    yield* loadUsers(neededUsers);
  }

  // --- Re-describe every touched unit. ---
  const units: TranscriptFoldUnit[] = [];
  for (const turnKey of touchedTurns) {
    const unitKey = turnRowUnitKey(turnKey);
    const records = turnBodies.get(turnKey) ?? [];
    const decorating = decoratingByTurn.get(turnKey) ?? [];
    const stops = stopsOf(turnKey);
    const firstStop = stops.at(0);
    const lastStop = stops.at(-1);
    const stopped: TurnStoppedInfo | null =
      lastStop === undefined
        ? null
        : {
            stoppedAt: lastStop.event.timestamp,
            reason: lastStop.event.message,
            messageId: lastStop.event.messageId,
            eventId: lastStop.event.eventId,
          };
    const assistants: AssistantMessage[] = [];
    for (const positioned of records) {
      if (positioned.message.role === "assistant") {
        assistants.push(positioned.message);
      }
    }
    const turn = accumulateDurableTurns(assistants).get(turnKey);
    const firstRecord = records.at(0);
    if (turn !== undefined && firstRecord !== undefined) {
      const unitState = unitStateOf(turnKey);
      if (unitState === null) {
        return notContinued("an assistant turn has no stored walk state");
      }
      const usersById = new Map<string, UserMessage>();
      for (const messageId of targetsByTurn.get(turnKey) ?? []) {
        const record = liveUsers.get(messageId);
        if (record !== undefined && record.message.role === "user") {
          usersById.set(messageId, record.message);
        }
      }
      const descriptors = describeTurnRows({
        turn,
        usersById,
        lastUserTimestamp: unitState.lastUserTimestamp,
        activeTurnId: change.activeTurnId,
        stopped,
        decoratingEventIdsByTurnKey: new Map([
          [turnKey, decorating.map((positioned) => positioned.event.eventId)],
        ]),
        profileWalkUnprovable: unitState.profileWalkUnprovable,
        sessionAnchor: unitState.profileWalkUnprovable
          ? null
          : unitState.sessionAnchor,
        hasLaterOverlappingChanges: overlapping.has(turnKey),
      });
      units.push({
        unitKey,
        rows: descriptors.map((descriptor, index) => ({
          order: wovenOrder({
            createdAt: descriptor.createdAt,
            pass: TRANSCRIPT_ROW_PASS.walk,
            position: firstRecord.position,
            entry: index,
          }),
          descriptor,
          unitState,
        })),
        messages: [...assistants, ...usersById.values()],
        events: decorating.map((positioned) => positioned.event),
      });
      continue;
    }
    const trigger =
      stopped === null || stopped.messageId === null
        ? undefined
        : liveUsers.get(stopped.messageId);
    if (
      stopped !== null &&
      lastStop !== undefined &&
      firstStop !== undefined &&
      trigger !== undefined &&
      turnKey !== change.activeTurnId
    ) {
      units.push({
        unitKey,
        rows: [
          {
            order: wovenOrder({
              createdAt: stopped.stoppedAt,
              pass: TRANSCRIPT_ROW_PASS.stoppedTurn,
              position: firstStop.position,
              entry: 0,
            }),
            descriptor: {
              rowId: assistantRowId(turnKey),
              createdAt: stopped.stoppedAt,
              source: {
                kind: "stopped-turn",
                turnKey,
                eventId: stopped.eventId,
                triggeringMessageId: trigger.message.messageId,
              },
              context: EMPTY_ROW_CONTEXT,
            },
            unitState: null,
          },
        ],
        messages: [trigger.message],
        events: [lastStop.event],
      });
      continue;
    }
    units.push({ unitKey, rows: [], messages: [], events: [] });
  }

  for (const messageId of touchedUsers) {
    const unitKey = userRowUnitKey(messageId);
    const record = liveUsers.get(messageId);
    if (
      record === undefined ||
      record.message.role !== "user" ||
      isNested(messageId)
    ) {
      units.push({ unitKey, rows: [], messages: [], events: [] });
      continue;
    }
    units.push({
      unitKey,
      rows: [
        {
          order: wovenOrder({
            createdAt: record.message.timestamp,
            pass: TRANSCRIPT_ROW_PASS.walk,
            position: record.position,
            entry: 0,
          }),
          descriptor: {
            rowId: messageId,
            createdAt: record.message.timestamp,
            source: { kind: "user", messageId },
            context: steerLifecycle.steeredMessageIds.has(messageId)
              ? COMPLETED_STEER_CONTEXT
              : EMPTY_ROW_CONTEXT,
          },
          unitState: null,
        },
      ],
      messages: [record.message],
      events: [],
    });
  }

  for (const [eventId, positioned] of eventUnits) {
    const row = eventUnitRow(positioned);
    units.push({
      unitKey: eventRowUnitKey(eventId),
      rows: row === null ? [] : [row],
      messages: [],
      events: [positioned.event],
    });
  }

  const previousRows: StoredTranscriptRow[] = [];
  for (const unit of units) {
    previousRows.push(...(storedRows.get(unit.unitKey) ?? []));
  }

  // --- Setup cards. ---
  const cardAnchors = new Set(prior.setup.cardAnchors);
  if (!setupChanged && cardAnchors.size > 0) {
    // A card is woven above its anchor row BY ID, so any re-described row
    // that is, or was, an anchor moves its card.
    setupChanged =
      previousRows.some((row) => cardAnchors.has(row.rowId)) ||
      units.some((unit) =>
        unit.rows.some((row) => cardAnchors.has(row.descriptor.rowId)),
      );
  }
  let setupState = prior.setup;
  if (setupChanged) {
    const setupEvents = yield* loadEvents({
      kind: "events-by-type",
      types: SETUP_CARD_INPUT_EVENT_TYPES,
    });
    const windows = partitionSetupCardWindows(
      setupEvents.map((positioned) => positioned.event),
    );
    const cardUnitKeys: string[] = [];
    for (
      let index = 0;
      index < Math.max(windows.length, prior.setup.windowCount);
      index += 1
    ) {
      cardUnitKeys.push(setupCardUnitKey(index));
    }
    if (cardUnitKeys.length > 0) {
      previousRows.push(
        ...(yield* loadRows({ kind: "unit-rows", unitKeys: cardUnitKeys })),
      );
    }
    const pinGenesis = windows.at(0)?.isGenesisPin ?? false;
    const anchorIds = [
      ...new Set(
        windows.flatMap((window, windowIndex) =>
          (pinGenesis && windowIndex === 0) ||
          window.triggeringMessageId === null
            ? []
            : [window.triggeringMessageId],
        ),
      ),
    ];
    // The anchor rows: base rows (never a card, never a pinned row) with that
    // id - this change's own, then the store's rows of units it did not touch.
    const anchorOrders = new Map<string, TranscriptRowOrder[]>();
    const noteAnchor = (rowId: string, order: TranscriptRowOrder): void => {
      const held = anchorOrders.get(rowId);
      if (held === undefined) {
        anchorOrders.set(rowId, [order]);
        return;
      }
      held.push(order);
    };
    if (anchorIds.length > 0) {
      const wanted = new Set(anchorIds);
      const describedUnitKeys = new Set(units.map((unit) => unit.unitKey));
      for (const unit of units) {
        for (const row of unit.rows) {
          if (
            wanted.has(row.descriptor.rowId) &&
            row.order.section === TRANSCRIPT_ROW_SECTION.woven
          ) {
            noteAnchor(row.descriptor.rowId, row.order);
          }
        }
      }
      const stored = yield* loadRows({ kind: "rows-by-id", rowIds: anchorIds });
      for (const row of stored) {
        if (
          describedUnitKeys.has(row.unitKey) ||
          isSetupCardUnitKey(row.unitKey) ||
          row.order.section !== TRANSCRIPT_ROW_SECTION.woven ||
          !wanted.has(row.rowId)
        ) {
          continue;
        }
        noteAnchor(row.rowId, row.order);
      }
      for (const orders of anchorOrders.values()) {
        orders.sort(compareTranscriptRowOrder);
      }
    }
    windows.forEach((window, windowIndex) => {
      const descriptor: TranscriptRowDescriptor = {
        rowId: setupCardRowId(change.chatId, windowIndex, window.createdAt),
        createdAt: window.createdAt,
        source: {
          kind: "setup-card",
          windowIndex,
          eventIds: window.events.map((event) => event.eventId),
        },
        // Both facts come from a partition over the WHOLE log. A client
        // re-running it on this window's events alone renumbers the card to 0
        // - which changes its generated row id, so the skeleton stops matching
        // and the ordinal is suppressed - and can revive a closed window as
        // active.
        context: {
          setupWindowIndex: windowIndex,
          setupWindowIsActive: window.isActive,
        },
      };
      const anchored =
        window.triggeringMessageId === null
          ? undefined
          : anchorOrders.get(window.triggeringMessageId);
      const orders: readonly TranscriptRowOrder[] =
        pinGenesis && windowIndex === 0
          ? [
              {
                section: TRANSCRIPT_ROW_SECTION.genesisCard,
                createdAt: 0,
                pass: 0,
                position: 0,
                entry: 0,
                slot: TRANSCRIPT_ROW_SLOT.row,
                card: 0,
              },
            ]
          : anchored !== undefined && anchored.length > 0
            ? anchored.map((order) => ({
                ...order,
                slot: TRANSCRIPT_ROW_SLOT.anchoredCard,
                card: windowIndex,
              }))
            : [
                wovenOrder({
                  createdAt: window.createdAt,
                  pass: TRANSCRIPT_ROW_PASS.floatingSetupCard,
                  position: windowIndex,
                  entry: 0,
                }),
              ];
      units.push({
        unitKey: setupCardUnitKey(windowIndex),
        rows: orders.map((order) => ({ order, descriptor, unitState: null })),
        messages: [],
        events: window.events,
      });
    });
    for (
      let index = windows.length;
      index < prior.setup.windowCount;
      index += 1
    ) {
      units.push({
        unitKey: setupCardUnitKey(index),
        rows: [],
        messages: [],
        events: [],
      });
    }
    setupState = {
      windowCount: windows.length,
      openWindow: windows.at(-1)?.isActive ?? false,
      cardAnchors: anchorIds,
    };
  }

  return {
    continued: true,
    state: {
      version: TRANSCRIPT_FOLD_STATE_VERSION,
      factsVersion: TRANSCRIPT_MESSAGE_FOLD_FACTS_VERSION,
      activeTurnId: change.activeTurnId,
      messagesThrough,
      eventsThrough,
      region: nextRegion,
      openTurnKeys: [...nextOpenTurns],
      steerTargets: recordFrom(steerTargets),
      completedSteer: {
        messageIds: [...steerLifecycle.steeredMessageIds],
        requestMessageIdByQueueItemId: recordFrom(
          steerLifecycle.steerRequestMessageIdsByQueueItemId,
        ),
      },
      stopTriggers: recordFrom(stopTriggers),
      setup: setupState,
    },
    units,
    previousRows,
    eventRowTurnKeys,
    checkpointPaths: new Map<string, CheckpointTurnPaths>(
      [...replacedCheckpoints].map(([turnKey, replaced]) => [
        turnKey,
        { position: replaced.position, paths: replaced.after },
      ]),
    ),
  };
}

/** The row a row-materializing event draws, or `null` when it draws none. */
function eventUnitRow(positioned: PositionedEvent): TranscriptFoldRow | null {
  const { event, position } = positioned;
  if (forkedChatLinkRowSource(event) !== null) {
    return {
      order: wovenOrder({
        createdAt: event.timestamp,
        pass: TRANSCRIPT_ROW_PASS.forkedChatLink,
        position,
        entry: 0,
      }),
      descriptor: {
        rowId: forkedChatLinkRowId(event.eventId),
        createdAt: event.timestamp,
        source: { kind: "forked-chat-link", eventId: event.eventId },
        context: EMPTY_ROW_CONTEXT,
      },
      unitState: null,
    };
  }
  if (notificationAnchorRowSource(event) !== null) {
    return {
      order: wovenOrder({
        createdAt: event.timestamp,
        pass: TRANSCRIPT_ROW_PASS.notificationAnchor,
        position,
        entry: 0,
      }),
      descriptor: {
        rowId: chatTranscriptEventRowId(event.eventId),
        createdAt: event.timestamp,
        source: { kind: "notification-anchor", eventId: event.eventId },
        context: EMPTY_ROW_CONTEXT,
      },
      unitState: null,
    };
  }
  if (autoJudgeUnattendedDenialRowSource(event) !== null) {
    return {
      order: wovenOrder({
        createdAt: event.timestamp,
        pass: TRANSCRIPT_ROW_PASS.autoJudgeUnattendedDenial,
        position,
        entry: 0,
      }),
      descriptor: {
        rowId: autoJudgeUnattendedDenialRowId(event.eventId),
        createdAt: event.timestamp,
        source: {
          kind: "auto-judge-unattended-denial",
          eventId: event.eventId,
        },
        context: EMPTY_ROW_CONTEXT,
      },
      unitState: null,
    };
  }
  if (autoJudgeNoticeRowSource(event) !== null) {
    return {
      order: wovenOrder({
        createdAt: event.timestamp,
        pass: TRANSCRIPT_ROW_PASS.autoJudgeNotice,
        position,
        entry: 0,
      }),
      descriptor: {
        rowId: autoJudgeNoticeRowId(event.eventId),
        createdAt: event.timestamp,
        source: { kind: "auto-judge-notice", eventId: event.eventId },
        context: EMPTY_ROW_CONTEXT,
      },
      unitState: null,
    };
  }
  if (importedChatMarkerRowSource(event) !== null) {
    // The provenance marker sits above EVERYTHING, the pinned genesis setup
    // card included. Its timestamp is the import time - later than every
    // message it introduces, so a `createdAt` sort would file it at the
    // bottom - and what it says ("Imported from Claude Code") is about the
    // whole chat's origin. Event-log order between two markers.
    return {
      order: {
        section: TRANSCRIPT_ROW_SECTION.importedMarker,
        createdAt: 0,
        pass: 0,
        position,
        entry: 0,
        slot: TRANSCRIPT_ROW_SLOT.row,
        card: 0,
      },
      descriptor: {
        rowId: importedChatMarkerRowId(event.eventId),
        createdAt: event.timestamp,
        source: { kind: "imported-chat-marker", eventId: event.eventId },
        context: EMPTY_ROW_CONTEXT,
      },
      unitState: null,
    };
  }
  return null;
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
  /** The anchor in effect at this turn - see {@link TranscriptRowContext}. */
  readonly sessionAnchor: ChatSessionAnchor | null;
  /** Whole-history refusal - see {@link turnKeysWithUnprovableProfileWalk}. */
  readonly profileWalkUnprovable: boolean;
  /** Whole-history overlap - see {@link turnKeysWithLaterOverlappingChanges}. */
  readonly hasLaterOverlappingChanges: boolean;
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
  // One object shared by every row of the turn: they all render with the same
  // anchor and the same elapsed counter, and sharing it keeps a split turn from
  // allocating a fresh copy per slice.
  //
  // `legacyRowAnchorAt` is carried ONLY when `startedAt` did not supply the
  // anchor. For a modern turn the renderer reads `startedAt` off the record it
  // already has and cannot get it wrong, so speaking would be noise on every
  // row of every chat.
  //
  // `hasLaterOverlappingChanges` is carried only when TRUE, for the reason the
  // schema gives: an absent field is the projection declining to speak, and the
  // renderer falls back to its own derivation. `false` is what that derivation
  // already produces from an isolated span, so speaking it would be bytes
  // asserting the answer the reader would have reached anyway.
  //
  // `profileWalkUnprovable` is the one flag here whose `true` is NOT an
  // optimisation over what the reader would conclude anyway - it is the
  // opposite of what an unaided reader concludes, and it is what keeps this
  // object non-empty so the refusal is serialized at all. See the field.
  const turnContext: TranscriptRowContext = {
    ...(turn.startedAt === null ? { legacyRowAnchorAt: rowAnchorAt } : {}),
    ...(input.sessionAnchor === null
      ? {}
      : { sessionAnchor: input.sessionAnchor }),
    ...(input.profileWalkUnprovable ? { profileWalkUnprovable: true } : {}),
    ...(input.hasLaterOverlappingChanges
      ? { hasLaterOverlappingChanges: true }
      : {}),
  };
  // A turn with nothing to say gets the SHARED empty context, not a fresh empty
  // object. Every consumer already treats the two identically - "nothing to
  // say" is tested with `Object.keys(context).length > 0` - so this changes no
  // output. What it changes is identity, which is what a fingerprint memo keys
  // on: an ordinary modern turn (its own `startedAt`, no session anchor, no
  // later overlapping checkpoint) is most of a transcript, and without this
  // every one of them hands the skeleton a brand-new object on every rebuild
  // and is re-fingerprinted for a context that has never differed from empty.
  const context =
    Object.keys(turnContext).length === 0 ? EMPTY_ROW_CONTEXT : turnContext;

  // The turn's surviving steered user records, in block order. Computed once
  // for the whole turn because every row of it names the same set - see
  // `steeredMessageIds` on the source variants.
  const steeredMessageIds: readonly string[] = blocks.flatMap((block) =>
    block.type === "steer" && input.usersById.has(block.messageId)
      ? [block.messageId]
      : [],
  );

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
          steeredMessageIds,
          blockId: block.blockId,
          queueItemId: block.queueItemId,
        },
        context,
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
        steeredMessageIds,
      },
      context,
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
        steeredMessageIds,
      },
      context,
    });
  }
  return rows;
}
