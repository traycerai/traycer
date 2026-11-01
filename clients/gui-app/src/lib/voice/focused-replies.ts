import type { OpenMessage } from "@traycer/protocol/host/agent/gui/open-harness-wire";

/**
 * The hear loop's focused source (Tracy Bots voice, VT2): a new row of the
 * bot on the focused thread's (or channel's) chat store. The store is the
 * one source and the message id the one dedupe key; nothing is read out of
 * notification copy.
 */

/** A bot's reply as the voice is given it: the row, and its prose. */
export interface FocusedReply {
  readonly messageId: string;
  /** The row's text blocks joined; provider notices are not the bot's words. */
  readonly text: string;
}

type AssistantRow = Extract<OpenMessage, { readonly role: "assistant" }>;
type UserRow = Extract<OpenMessage, { readonly role: "user" }>;

/**
 * What the watch reads of a chat row: who wrote it, its id, a bot row's
 * blocks and a member row's request (which names the bot row that answered
 * it). Every `OpenMessage` is one; a test builds the slice alone.
 */
export type ReplyRow =
  | Pick<UserRow, "role" | "messageId" | "timestamp" | "conversationRequest">
  | Pick<
      AssistantRow,
      | "role"
      | "messageId"
      | "timestamp"
      | "blocks"
      | "repliesTo"
      | "question"
      | "surface"
    >;

/**
 * What a watch remembers about one chat for the user session: the rows it
 * has seen, and the newest row of its baseline, so a row the store hydrates
 * later from before the baseline (a window scrolled back) is history, not
 * an arrival. Outlives the component that watches, so a remount across a
 * replacement speaks what landed in the gap and nothing older.
 */
export interface ReplyWatchMemory {
  readonly seen: Set<string>;
  /** Rows handed to the scheduler, so a reconciliation never speaks one twice. */
  readonly scheduled: Set<string>;
  /**
   * Rows taken for announcements as they landed, still open to
   * reconsideration (an answer that landed before its post's request named
   * it): kept with the chat's memory, so a feed remounted later still
   * reads one once its request resolves.
   */
  readonly provisional: Set<string>;
  /** The newest baseline row's timestamp; `0` before a baseline, or for an empty chat. */
  since: number;
  baselined: boolean;
}

export function createReplyWatchMemory(): ReplyWatchMemory {
  return {
    seen: new Set<string>(),
    scheduled: new Set<string>(),
    provisional: new Set<string>(),
    since: 0,
    baselined: false,
  };
}

/** Takes the loaded snapshot as history: every row seen, none spoken. */
export function baselineReplyWatch(
  memory: ReplyWatchMemory,
  rows: ReadonlyArray<ReplyRow>,
): void {
  for (const row of rows) {
    memory.seen.add(row.messageId);
    if (row.timestamp > memory.since) memory.since = row.timestamp;
  }
  memory.baselined = true;
}

/**
 * The request a bot row answers, as the records say: the member row whose
 * request resolved to it names its id. For a thread's first reply that row
 * is the post on the CHANNEL (the host opens a post's thread with no row of
 * its own and resolves the opening request on the channel, after the reply
 * exists); for a follow-up it is a row of the thread. `null` when no loaded
 * row says so yet: the reply may have arrived before the channel's
 * resolution, or it answers no request.
 */
export function requestIdAnsweredBy(
  rows: ReadonlyArray<ReplyRow>,
  replyMessageId: string,
): string | null {
  for (const row of rows) {
    if (row.role !== "user") continue;
    const request = row.conversationRequest;
    if (
      request !== undefined &&
      request.resolvedByMessageId === replyMessageId
    ) {
      return request.requestId;
    }
  }
  return null;
}

/** The records of a focused thread and of the channel it hangs off; the channel alone at the top level. */
export interface ReplyRecords {
  readonly threadRows: ReadonlyArray<ReplyRow>;
  readonly channelRows: ReadonlyArray<ReplyRow>;
}

/** {@link requestIdAnsweredBy} over the thread's rows, then the channel's. */
export function requestIdAnsweredIn(
  records: ReplyRecords,
  replyMessageId: string,
): string | null {
  return (
    requestIdAnsweredBy(records.threadRows, replyMessageId) ??
    requestIdAnsweredBy(records.channelRows, replyMessageId)
  );
}

/**
 * Takes the loaded snapshot as history, except the rows that answer what
 * this session is waiting for: a post accepted moments ago whose thread's
 * first snapshot already holds the bot's answer is an arrival, not history.
 * Those rows are returned, to be spoken; everything else is seen, and the
 * newest of it bounds what later hydration may add.
 */
export function baselineReplyWatchExcept(
  memory: ReplyWatchMemory,
  rows: ReadonlyArray<ReplyRow>,
  isAwaited: (row: ReplyRow) => boolean,
): ReadonlyArray<FocusedReply> {
  const awaited: FocusedReply[] = [];
  for (const row of rows) {
    memory.seen.add(row.messageId);
    if (row.role === "assistant" && isAwaited(row)) {
      const text = spokenReplyOf(row);
      if (text.length > 0) awaited.push({ messageId: row.messageId, text });
      continue;
    }
    if (row.timestamp > memory.since) memory.since = row.timestamp;
  }
  memory.baselined = true;
  return awaited;
}

/**
 * The bot's rows that arrived since the baseline, oldest first; marks them
 * seen. Rows of the baseline, and rows older than its newest (hydrated later
 * from history), are never spoken: the person asked for what comes next. A
 * row with no prose (a tool call alone, a notice) is seen and not spoken.
 */
export function takeNewBotReplies(
  messages: ReadonlyArray<ReplyRow>,
  memory: ReplyWatchMemory,
): ReadonlyArray<FocusedReply> {
  const fresh: FocusedReply[] = [];
  for (const message of messages) {
    if (memory.seen.has(message.messageId)) continue;
    memory.seen.add(message.messageId);
    if (message.role !== "assistant") continue;
    if (message.timestamp <= memory.since) continue;
    const text = spokenReplyOf(message);
    if (text.length === 0) continue;
    fresh.push({ messageId: message.messageId, text });
  }
  return fresh;
}

/**
 * The choices of a bot row's first open question, `null` when none of its
 * questions is open. The one reading of a row's question the voice makes.
 */
export function openQuestionOf(
  row: Pick<AssistantRow, "question">,
): { readonly options: ReadonlyArray<string> } | null {
  const open = row.question?.questions.find(
    (question) => question.settlement === null,
  );
  return open === undefined ? null : { options: open.options };
}

/** An open question's choices, said as an explicit list (VT5's rule); `""` with none. */
export function choicesSentence(options: ReadonlyArray<string>): string {
  if (options.length === 0) return "";
  const list = options
    .map((option, index) => `${index + 1}. ${option}`)
    .join("; ");
  return `The choices are: ${list}.`;
}

/**
 * What the voice is given of a bot row on the focused chat: its prose, and
 * an open question's choices as a list, so none is lost to a paraphrase.
 */
export function spokenReplyOf(
  row: Pick<AssistantRow, "blocks" | "question">,
): string {
  const text = replyTextOf(row);
  if (text.length === 0) return text;
  const choices = choicesSentence(openQuestionOf(row)?.options ?? []);
  return choices.length === 0 ? text : `${text} ${choices}`;
}

/** The prose of an assistant row: its text blocks, less the provider notices. */
export function replyTextOf(message: Pick<AssistantRow, "blocks">): string {
  return message.blocks
    .flatMap((block) =>
      block.type === "text" && block.providerNotice === null
        ? [block.text]
        : [],
    )
    .join("\n\n")
    .trim();
}

/**
 * What the voice is given for a reply: the bot's words, quoted by the bot's
 * name when the focus is on another bot than the one whose voice this is
 * (V1), and bare when it is that bot's own channel.
 */
export function replySpeechText(input: {
  readonly botTitle: string;
  readonly speaksAsThisBot: boolean;
  readonly content: string;
}): string {
  const content = input.content.trim();
  return input.speaksAsThisBot
    ? content
    : `${input.botTitle} answered: ${content}`;
}
