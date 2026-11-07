import type { OpenMessage } from "@traycer/protocol/host/agent/gui/open-harness-wire";

/**
 * The call's reply watch (Call Tracy, VC3, from VT2): a new row of the bot on
 * the call's thread. The thread's chat store is the one source and the message
 * id the one dedupe key; nothing is read out of notification copy.
 */

/** A bot's reply as the voice is given it: the row, and its prose. */
export interface FocusedReply {
  readonly messageId: string;
  /** The row's text blocks joined, with an open question's choices; provider notices are not the bot's words. */
  readonly text: string;
}

type AssistantRow = Extract<OpenMessage, { readonly role: "assistant" }>;
type UserRow = Extract<OpenMessage, { readonly role: "user" }>;

/**
 * What the watch reads of a chat row: who wrote it, its id and time, and a
 * bot row's blocks and question. Every `OpenMessage` is one; a test builds
 * the slice alone.
 */
export type ReplyRow =
  | Pick<UserRow, "role" | "messageId" | "timestamp">
  | Pick<
      AssistantRow,
      "role" | "messageId" | "timestamp" | "blocks" | "question"
    >;

/**
 * What a watch remembers about its thread: the rows it has seen, and the
 * newest row of its baseline, so a row the store hydrates later from before
 * the baseline (a window scrolled back) is history, not an arrival.
 */
export interface ReplyWatchMemory {
  readonly seen: Set<string>;
  /** The newest baseline row's timestamp; `0` before a baseline, or for an empty chat. */
  since: number;
  baselined: boolean;
}

export function createReplyWatchMemory(): ReplyWatchMemory {
  return { seen: new Set<string>(), since: 0, baselined: false };
}

/**
 * Takes the loaded snapshot as history, except the rows that are arrivals
 * all the same: in a thread the call itself opened, the first snapshot can
 * already hold the bot's answer. Those rows are returned, to be spoken;
 * everything else is seen, and the newest of it bounds what later hydration
 * may add.
 */
export function baselineReplyWatchExcept(
  memory: ReplyWatchMemory,
  rows: ReadonlyArray<ReplyRow>,
  isArrival: (row: ReplyRow) => boolean,
): ReadonlyArray<FocusedReply> {
  const arrived: FocusedReply[] = [];
  for (const row of rows) {
    memory.seen.add(row.messageId);
    if (row.role === "assistant" && isArrival(row)) {
      const text = spokenReplyOf(row);
      if (text.length > 0) arrived.push({ messageId: row.messageId, text });
      continue;
    }
    if (row.timestamp > memory.since) memory.since = row.timestamp;
  }
  memory.baselined = true;
  return arrived;
}

/**
 * The bot's rows that arrived since the baseline, oldest first; marks them
 * seen. Rows of the baseline, and rows older than its newest (hydrated later
 * from history), are never spoken. A row with no prose (a tool call alone, a
 * notice) is seen and not spoken.
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
 * questions is open.
 */
function openQuestionOf(
  row: Pick<AssistantRow, "question">,
): { readonly options: ReadonlyArray<string> } | null {
  const open = row.question?.questions.find(
    (question) => question.settlement === null,
  );
  return open === undefined ? null : { options: open.options };
}

/** An open question's choices, said as an explicit list; `""` with none. */
function choicesSentence(options: ReadonlyArray<string>): string {
  if (options.length === 0) return "";
  const list = options
    .map((option, index) => `${index + 1}. ${option}`)
    .join("; ");
  return `The choices are: ${list}.`;
}

/**
 * What the voice is given of a bot row: its prose, and an open question's
 * choices as a list, so none is lost. The person answers by saying it: the
 * next thing said is an ordinary message (P10).
 */
function spokenReplyOf(row: Pick<AssistantRow, "blocks" | "question">): string {
  const text = replyTextOf(row);
  if (text.length === 0) return text;
  const choices = choicesSentence(openQuestionOf(row)?.options ?? []);
  return choices.length === 0 ? text : `${text} ${choices}`;
}

/** The prose of an assistant row: its text blocks, less the provider notices. */
function replyTextOf(message: Pick<AssistantRow, "blocks">): string {
  return message.blocks
    .flatMap((block) =>
      block.type === "text" && block.providerNotice === null
        ? [block.text]
        : [],
    )
    .join("\n\n")
    .trim();
}
