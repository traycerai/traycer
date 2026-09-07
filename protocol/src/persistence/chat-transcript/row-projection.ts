import type { ContentBlock } from "@traycer/protocol/persistence/epic/content-blocks";
import type { ChatEvent } from "@traycer/protocol/persistence/epic/chat-events";
import type {
  Message,
  UserMessage,
} from "@traycer/protocol/persistence/epic/messages";
import type { ChatSessionAnchor } from "@traycer/protocol/persistence/epic/senders";

import {
  EMPTY_ROW_CONTEXT,
  type TranscriptRowContext,
} from "@traycer/protocol/persistence/chat-transcript/row-context";

import {
  overlappingCheckpointIds,
  turnCheckpointManifestSchema,
} from "@traycer/protocol/persistence/epic/checkpoint-manifests";

import { assistantTurnKey } from "@traycer/protocol/persistence/chat-transcript/fork-boundary";
import {
  compareCanonicalRowOrder,
  forkedChatLinkRowSource,
  importedChatMarkerRowSource,
  notificationAnchorRowSource,
} from "@traycer/protocol/persistence/chat-transcript/row-order";
import { partitionSetupCardWindows } from "@traycer/protocol/persistence/chat-transcript/setup-card-windows";
import { steeredMessageIdsFromEvents } from "@traycer/protocol/persistence/chat-transcript/steer-lifecycle";

/**
 * The one enumeration of "which rows does this chat have, in what order" - shared by the host (which numbers ordinals from it) and the renderer (which draws them).
 * That is sound because all three sort into the TAIL, and the tail is pinned hydrated - so the client interleaves them at render time and the host never has to name them.
 */

/** What produced a row - enough for a range read to know what to hydrate. */
export type TranscriptRowSource =
  | { readonly kind: "user"; readonly messageId: string }
  | {
      readonly kind: "assistant-slice";
      readonly turnKey: string;
      /** Every record contributing to the turn, in walk order. */
      readonly messageIds: readonly string[];
      /** The blocks THIS slice renders, in order. */
      readonly blockIds: readonly string[];
      readonly chunkIndex: number;
      readonly split: boolean;
      /** True for a row synthesized to carry a stopped turn's boundary. */
      readonly synthesizedBoundary: boolean;
      /** The turn's events that DECORATE this row rather than produce it. */
      readonly decoratingEventIds: readonly string[];
      /** Every surviving steered user record of this turn - see the same field on the `steer` variant. */
      readonly steeredMessageIds: readonly string[];
    }
  | {
      readonly kind: "steer";
      readonly turnKey: string;
      readonly messageIds: readonly string[];
      /** The steered user record, when one survives. */
      readonly steeredMessageId: string | null;
      /** EVERY surviving steered user record of the turn, not just this row's. */
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
       * Never null: the row is synthesized only for a stop whose `messageId` is both set and retained (see `stoppedTurnsWithoutRecords`), which is the same condition the renderer re-checks.
       */
      readonly triggeringMessageId: string;
    }
  | { readonly kind: "forked-chat-link"; readonly eventId: string }
  | { readonly kind: "notification-anchor"; readonly eventId: string }
  | { readonly kind: "imported-chat-marker"; readonly eventId: string }
  | {
      readonly kind: "setup-card";
      readonly windowIndex: number;
      readonly eventIds: readonly string[];
    };

/** A row's identity, order and provenance - never its content. */
export interface TranscriptRowDescriptor {
  /** The renderer's row id, verbatim. This is the `(kind, id)` identity echo. */
  readonly rowId: string;
  /** The placement key. */
  readonly createdAt: number;
  readonly source: TranscriptRowSource;
  /**
   * What this row renders WITH - see {@link TranscriptRowContext}.
   * Always an object, never absent, so a consumer reads fields rather than branching on the container first.
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

// Row ids.
// Exported because the renderer must build the same strings; a second template literal that agreed by inspection is the drift this module prevents.

export function assistantRowId(turnKey: string): string {
  return `assistant:${turnKey}`;
}

/** A slice's row id. */
export function assistantSliceRowId(
  turnKey: string,
  chunkIndex: number,
  split: boolean,
): string {
  if (!split) return assistantRowId(turnKey);
  return `${assistantRowId(turnKey)}:part:${chunkIndex}`;
}

/** The turn key an assistant row id names, or `null` for any other row id. */
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

export function setupCardRowId(
  chatId: string,
  windowIndex: number,
  createdAt: number,
): string {
  return `setup-card:${chatId}:${windowIndex}:${createdAt}`;
}


/**
 * The durable subset of the renderer's turn accumulator - the fields that decide row COUNT and row ORDER.
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
 * Folds every assistant record sharing a turn key into one accumulator, keyed in first-appearance order.
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

/** The one field {@link nestedSteeredMessageIds} reads off a turn. */
export interface BlockBearingTurn {
  readonly blocks: readonly ContentBlock[];
}

/** The persisted user records rendered NESTED inside an assistant turn rather than at top level. */
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


/** One row of a turn, as an index into the turn's block array. */
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
 * Plans a turn's rows: maximal runs of non-steer blocks become slices, each steer block becomes its own row between them.
 * A turn with no blocks and no steer still plans ONE slice - an empty assistant row is what a turn that produced nothing renders as, and it must occupy an ordinal like any other.
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

export function assistantTurnNeedsTrailingRow(input: {
  readonly plan: AssistantTurnRowPlan;
  readonly turnComplete: boolean;
  readonly stopped: boolean;
  /** Whether the turn carries a live run indicator. */
  readonly hasRunState: boolean;
}): boolean {
  const needs = input.hasRunState || (input.turnComplete && input.stopped);
  if (!needs) return false;
  const last = input.plan.entries.at(-1);
  // Already ends on an assistant row: the marker (or run state) attaches to it
  // in place and no row is added.
  return last !== undefined && last.kind === "steer";
}


export interface TurnStoppedInfo {
  readonly stoppedAt: number;
  readonly reason: string | null;
  readonly messageId: string | null;
  /** The `turn.stopped` event itself - what a synthesized row hydrates from. */
  readonly eventId: string;
}

const EMPTY_EVENT_IDS: readonly string[] = [];

/** Event types a turn's rows RENDER WITH but are not built from. */
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

/** The pause lifecycle, which decorates a turn but cannot be keyed on `turnId`. */
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

/** What a pause request and its resolution are paired on. */
function pauseCorrelationKey(event: ChatEvent): string | null {
  if (event.type.startsWith("interview.")) {
    return event.blockId === null ? null : `interview:${event.blockId}`;
  }
  return event.approvalId === null ? null : `approval:${event.approvalId}`;
}

/**
 * Turn keys whose checkpoint has a file a LATER checkpoint touches again.
 * Order is load-bearing - "later" means later in the event log - so this walks `events` in its given order and never sorts.
 */
export function turnKeysWithLaterOverlappingChanges(
  events: readonly ChatEvent[],
): ReadonlySet<string> {
  const parsed = events.flatMap((event) => {
    if (event.type !== "checkpoint.captured") return [];
    if (event.turnId === null || event.metadata === null) return [];
    const manifest = turnCheckpointManifestSchema.safeParse(event.metadata);
    // A manifest this reader cannot parse is one whose overlap it cannot judge.
    // Dropping it is the same answer the restore path gives a version mismatch ("cannot restore"), and it keeps an unreadable entry from silently reading as "touches nothing" and clearing a warning it should have kept.
    if (!manifest.success) return [];
    return [{ turnId: event.turnId, manifest: manifest.data }];
  });
  if (parsed.length === 0) return EMPTY_TURN_KEYS;
  const overlapping = overlappingCheckpointIds(
    parsed.map((entry) => entry.manifest),
  );
  return new Set(
    parsed.flatMap((entry) =>
      overlapping.has(entry.manifest.checkpointId) ? [entry.turnId] : [],
    ),
  );
}

const EMPTY_TURN_KEYS: ReadonlySet<string> = new Set<string>();

/** Decorating event ids per turn, in event order. */
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

/** `turn.stopped` events keyed by `turnId`, in event order. */
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
 * Turn keys whose Stop landed before any assistant record existed, and which therefore render as a synthesized completed row.
 * The guard is retention-based: a turn whose records were branched away stops producing a folded row and starts producing a synthetic one, and both must land on the same ordinal count.
 */
function stoppedTurnsWithoutRecords(input: {
  readonly stoppedByTurnKey: ReadonlyMap<string, TurnStoppedInfo>;
  readonly retainedTurnKeys: ReadonlySet<string>;
  readonly retainedUserMessageIds: ReadonlySet<string>;
  readonly activeTurnId: string | null;
}): readonly {
  readonly turnKey: string;
  readonly stopped: TurnStoppedInfo;
  /** `stopped.messageId`, narrowed by the guards below. */
  readonly triggeringMessageId: string;
}[] {
  const out: {
    turnKey: string;
    stopped: TurnStoppedInfo;
    triggeringMessageId: string;
  }[] = [];
  for (const [turnKey, stopped] of input.stoppedByTurnKey) {
    if (turnKey === input.activeTurnId) continue;
    if (input.retainedTurnKeys.has(turnKey)) continue;
    const triggeringMessageId = stopped.messageId;
    if (triggeringMessageId === null) continue;
    if (!input.retainedUserMessageIds.has(triggeringMessageId)) continue;
    out.push({ turnKey, stopped, triggeringMessageId });
  }
  return out;
}


/** Enumerates a chat's durable transcript rows, in the order they are drawn. */
export function projectTranscriptRows(
  input: TranscriptRowProjectionInput,
): readonly TranscriptRowDescriptor[] {
  const turns = accumulateDurableTurns(input.messages);
  const usersById = userMessagesById(input.messages);
  const nestedSteered = nestedSteeredMessageIds(turns.values(), usersById);
  const stoppedByTurnKey = turnStoppedInfoByTurnKey(input.events);
  const decoratingEventIdsByTurnKey = decoratingEventIdsByTurn(input.events);
  const overlappingTurnKeys = turnKeysWithLaterOverlappingChanges(input.events);
  // Whole-history fold: a `queue.fallback` arbitrarily later than the request retracts the badge, so this cannot be re-derived from a row's own records.
  const completedSteerMessageIds = steeredMessageIdsFromEvents(input.events);

  const base: TranscriptRowDescriptor[] = [];
  const emittedTurns = new Set<string>();
  let lastUserTimestamp: number | null = null;
  // The session anchor in effect at this point of the walk.
  let currentSessionAnchor: ChatSessionAnchor | null = null;

  for (const message of input.messages) {
    if (message.role === "user") {
      if (message.sessionAnchor !== null) {
        currentSessionAnchor = message.sessionAnchor;
      }
      // A steered user record is a mid-turn interjection rendered inside its turn.
      if (nestedSteered.has(message.messageId)) continue;
      lastUserTimestamp = message.timestamp;
      base.push({
        rowId: message.messageId,
        createdAt: message.timestamp,
        source: { kind: "user", messageId: message.messageId },
        context: completedSteerMessageIds.has(message.messageId)
          ? { completedSteer: true }
          : EMPTY_ROW_CONTEXT,
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
        sessionAnchor: currentSessionAnchor,
        hasLaterOverlappingChanges: overlappingTurnKeys.has(turnKey),
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
        triggeringMessageId: entry.triggeringMessageId,
      },
      context: EMPTY_ROW_CONTEXT,
    });
  }

  // Event rows are appended in two passes, all fork links before all notification anchors, because that is the renderer's `baseRows` order.
  for (const event of input.events) {
    if (forkedChatLinkRowSource(event) === null) continue;
    base.push({
      rowId: forkedChatLinkRowId(event.eventId),
      createdAt: event.timestamp,
      source: { kind: "forked-chat-link", eventId: event.eventId },
      context: EMPTY_ROW_CONTEXT,
    });
  }
  for (const event of input.events) {
    if (notificationAnchorRowSource(event) === null) continue;
    base.push({
      rowId: chatTranscriptEventRowId(event.eventId),
      createdAt: event.timestamp,
      source: { kind: "notification-anchor", eventId: event.eventId },
      context: EMPTY_ROW_CONTEXT,
    });
  }

  // The provenance marker sits above EVERYTHING, the pinned genesis setup card included.
  const markers: TranscriptRowDescriptor[] = [];
  for (const event of input.events) {
    if (importedChatMarkerRowSource(event) === null) continue;
    markers.push({
      rowId: importedChatMarkerRowId(event.eventId),
      createdAt: event.timestamp,
      source: { kind: "imported-chat-marker", eventId: event.eventId },
      context: EMPTY_ROW_CONTEXT,
    });
  }
  return [...markers, ...placeSetupCards(base, input)];
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
  /** Whole-history overlap - see {@link turnKeysWithLaterOverlappingChanges}. */
  readonly hasLaterOverlappingChanges: boolean;
}): readonly TranscriptRowDescriptor[] {
  const { turn } = input;
  // Every branch of the renderer's timing derivation returns this same anchor; the autonomous-resume lifecycle window it also computes moves the ELAPSED counter, never the row's position.
  const rowAnchorAt =
    turn.startedAt ?? input.lastUserTimestamp ?? turn.timestamp;
  const turnComplete = input.activeTurnId !== turn.turnKey;
  const blocks = turn.blocks;
  const plan = planAssistantTurnRows(blocks);
  const decoratingEventIds =
    input.decoratingEventIdsByTurnKey.get(turn.turnKey) ?? EMPTY_EVENT_IDS;
  // One object shared by every row of the turn: they all render with the same anchor and the same elapsed counter, and sharing it keeps a split turn from allocating a fresh copy per slice.
  // For a modern turn the renderer reads `startedAt` off the record it already has and cannot get it wrong, so speaking would be noise on every row of every chat.
  const context: TranscriptRowContext = {
    ...(turn.startedAt === null ? { legacyRowAnchorAt: rowAnchorAt } : {}),
    ...(input.sessionAnchor === null
      ? {}
      : { sessionAnchor: input.sessionAnchor }),
    ...(input.hasLaterOverlappingChanges
      ? { hasLaterOverlappingChanges: true }
      : {}),
  };

  // The turn's surviving steered user records, in block order.
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
      // Reuses the turn anchor exactly: every other row of the turn does, and position here rests on push order under the stable sort, not on a numerically later value.
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

/**
 * Sorts the base rows and weaves the setup cards in.
 * This is the structural reason a shared comparator was never going to be enough.
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
      // Both facts come from a partition over the WHOLE log.
      context: {
        setupWindowIndex: windowIndex,
        setupWindowIsActive: window.isActive,
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
