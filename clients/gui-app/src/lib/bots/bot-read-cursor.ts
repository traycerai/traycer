import type {
  BotNotificationLevel,
  BotReadCursorReadResponse,
  BotReadPosition,
} from "@traycer/protocol/host/bot/schemas";

/** `record[key]`, or `null` where it holds none. */
function positionOf(
  record: Readonly<Record<string, BotReadPosition>>,
  key: string,
): BotReadPosition | null {
  return Object.hasOwn(record, key) ? record[key] : null;
}

/**
 * Whether a conversation has a row past the person's cursor: its newest
 * row's `seq` is above the cursor's, or it has a row and no cursor. A `seq`
 * is the row's timestamp in milliseconds, so a second row written in the
 * same millisecond as the one the cursor sits on does not count as past it
 * (decision 139, accepted).
 */
function pastCursor(
  newestSeq: number | null,
  cursor: BotReadPosition | null,
): boolean {
  if (newestSeq === null) return false;
  return cursor === null || newestSeq > cursor.seq;
}

/**
 * Whether a bot's channel is bold: a row has landed past the person's read
 * cursor, and they did not set the channel to Nothing, which never bolds
 * (decision 138). Bold says nothing of the count: new posts at Mentions
 * level bold the channel with no count.
 */
export function channelBold(
  read: BotReadCursorReadResponse,
  channelId: string,
  levels: Readonly<Record<string, BotNotificationLevel>> | undefined,
): boolean {
  if (levels !== undefined && levels[channelId] === "off") return false;
  return pastCursor(
    positionOf(read.latest, channelId)?.seq ?? null,
    positionOf(read.cursors, channelId),
  );
}

/**
 * Whether a thread has new replies for the person: they follow it, and its
 * newest reply is past their cursor. The newest reply is the later of what
 * the host says and the thread list's `lastReplyAt`, which is the same
 * row's time. An unfollowed thread never has new replies.
 */
export function threadHasNewReplies(
  read: BotReadCursorReadResponse | undefined,
  threadId: string,
  lastReplyAt: number | null,
  following: boolean,
): boolean {
  if (!following || read === undefined) return false;
  const latest = positionOf(read.latest, threadId)?.seq ?? null;
  const newest =
    latest === null || lastReplyAt === null
      ? (latest ?? lastReplyAt)
      : Math.max(latest, lastReplyAt);
  return pastCursor(newest, positionOf(read.cursors, threadId));
}

/**
 * The conversation's newest row when the person's cursor is behind it: what
 * presenting it, or Mark as read, advances the cursor to. `null` when there
 * is nothing to advance.
 */
export function advanceTarget(
  read: BotReadCursorReadResponse,
  conversationId: string,
): BotReadPosition | null {
  const latest = positionOf(read.latest, conversationId);
  if (latest === null) return null;
  const cursor = positionOf(read.cursors, conversationId);
  return cursor !== null && cursor.seq >= latest.seq ? null : latest;
}
