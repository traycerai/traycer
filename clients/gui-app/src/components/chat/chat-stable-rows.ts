import type { ChatMessage } from "@/stores/composer/chat-store";

/**
 * Structural-sharing state for the chat timeline: the last row array handed
 * to LegendList plus a lookup from message id to the row object it produced.
 * Kept separate from the component so row-reference stability is explicit
 * and unit-testable.
 */
export interface StableChatTimelineRowsState {
  readonly byId: ReadonlyMap<string, ChatMessage>;
  readonly result: ReadonlyArray<ChatMessage>;
}

export const EMPTY_STABLE_CHAT_TIMELINE_ROWS_STATE: StableChatTimelineRowsState =
  {
    byId: new Map(),
    result: [],
  };

/** The row keys in order, as the list will see them. */
export function chatTimelineKeySequence(
  rows: ReadonlyArray<ChatMessage>,
): ReadonlyArray<string> {
  return rows.map((row) => row.id);
}

/**
 * Whether `rows` presents a different sequence of row KEYS than `committed` -
 * a row inserted, removed, or moved, as opposed to a row whose content changed
 * in place. A streaming reply produces a continuous run of the latter, and
 * `ChatTimeline` reads this to decide whether that commit needs MVCP's data
 * channel.
 *
 * `committed` must be the sequence the list last actually RENDERED, never one
 * a render merely computed: React discards renders, and a baseline advanced by
 * a discarded one makes a real insertion that follows it look like settled
 * content. `undefined` is a first population, which no reader is positioned
 * within and so cannot have shifted.
 */
export function didChatTimelineKeySequenceChange(
  committed: ReadonlyArray<string> | undefined,
  rows: ReadonlyArray<ChatMessage>,
): boolean {
  if (committed === undefined || committed.length === 0) return false;
  if (committed.length !== rows.length) return true;
  // By INDEX, so a reorder counts even when the set of ids is identical - the
  // timeline moves rows as well as adding and dropping them.
  return rows.some((row, index) => committed[index] !== row.id);
}

/**
 * Reuses the previous message object reference wherever a message is
 * unchanged, so `ChatMessage`'s `memo` boundary (and LegendList's own item
 * diffing) can skip re-rendering rows a given store update didn't touch -
 * the store rebuilds the `messages` array wholesale on every change, so
 * without this every row would otherwise see a fresh object identity on
 * every keystroke of a streaming reply.
 */
export function computeStableChatTimelineRows(
  rows: ReadonlyArray<ChatMessage>,
  previous: StableChatTimelineRowsState,
): StableChatTimelineRowsState {
  const next = new Map<string, ChatMessage>();
  let anyChanged = rows.length !== previous.byId.size;

  const result = rows.map((row, index) => {
    const prevRow = previous.byId.get(row.id);
    const nextRow =
      prevRow !== undefined && isChatMessageUnchanged(prevRow, row)
        ? prevRow
        : row;
    next.set(row.id, nextRow);
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true;
    }
    return nextRow;
  });

  return anyChanged ? { byId: next, result } : previous;
}

type ChatMessageComparableField = Exclude<keyof ChatMessage, "id">;

/**
 * One `===` check per `ChatMessage` field except `id` (the dedup key, which
 * the caller has already matched via the `byId` lookup before this runs).
 * Keyed as a mapped-type record - not a bare array - so the compiler
 * enforces coverage: adding, removing, or renaming a `ChatMessage` field
 * fails this file's build until the table is updated. Mirrors the
 * `Record<U, true>` idiom `makeLiteralGuard` uses in `lib/type-guard.ts`,
 * adapted to comparators so `Object.values` below stays fully typed with no
 * cast (`Object.keys` widens to `string[]` and would need one).
 *
 * Deliberate audit disposition: keep this table because this codebase's
 * giant, heterogeneous assistant rows need per-field row-reference
 * stability. The compile-time
 * exhaustiveness this table buys (a field add/remove/rename fails the build
 * until this table is updated) is worth the upkeep, since silently missing a
 * field here would make an actually-changed row look unchanged to LegendList
 * and freeze a row's rendered content mid-stream.
 */
const CHAT_MESSAGE_FIELD_UNCHANGED: {
  readonly [K in ChatMessageComparableField]: (
    a: ChatMessage,
    b: ChatMessage,
  ) => boolean;
} = {
  role: (a, b) => a.role === b.role,
  content: (a, b) => a.content === b.content,
  segments: (a, b) => a.segments === b.segments,
  structuredContent: (a, b) => a.structuredContent === b.structuredContent,
  attachments: (a, b) => a.attachments === b.attachments,
  browserAnnotations: (a, b) => a.browserAnnotations === b.browserAnnotations,
  settings: (a, b) => a.settings === b.settings,
  createdAt: (a, b) => a.createdAt === b.createdAt,
  elapsedStartedAt: (a, b) => a.elapsedStartedAt === b.elapsedStartedAt,
  turnHasOnlyAutonomousResumeSegments: (a, b) =>
    a.turnHasOnlyAutonomousResumeSegments ===
    b.turnHasOnlyAutonomousResumeSegments,
  showCompletionFooter: (a, b) =>
    a.showCompletionFooter === b.showCompletionFooter,
  completedAt: (a, b) => a.completedAt === b.completedAt,
  stopped: (a, b) => a.stopped === b.stopped,
  pausedDurationMs: (a, b) => a.pausedDurationMs === b.pausedDurationMs,
  pausedSinceMs: (a, b) => a.pausedSinceMs === b.pausedSinceMs,
  persistentMessageId: (a, b) =>
    a.persistentMessageId === b.persistentMessageId,
  senderLabel: (a, b) => a.senderLabel === b.senderLabel,
  assistantMeta: (a, b) => a.assistantMeta === b.assistantMeta,
  statusLabel: (a, b) => a.statusLabel === b.statusLabel,
  agentSenderInfo: (a, b) => a.agentSenderInfo === b.agentSenderInfo,
  agentMessage: (a, b) => a.agentMessage === b.agentMessage,
  runState: (a, b) => a.runState === b.runState,
  sessionAnchor: (a, b) => a.sessionAnchor === b.sessionAnchor,
  steerBadge: (a, b) => a.steerBadge === b.steerBadge,
};

const CHAT_MESSAGE_FIELD_CHECKS = Object.values(CHAT_MESSAGE_FIELD_UNCHANGED);

/** Shallow field comparison - avoids the cost of a deep equality check. */
function isChatMessageUnchanged(a: ChatMessage, b: ChatMessage): boolean {
  if (a === b) return true;
  return CHAT_MESSAGE_FIELD_CHECKS.every((isFieldUnchanged) =>
    isFieldUnchanged(a, b),
  );
}
