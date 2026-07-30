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
  settings: (a, b) => a.settings === b.settings,
  createdAt: (a, b) => a.createdAt === b.createdAt,
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
