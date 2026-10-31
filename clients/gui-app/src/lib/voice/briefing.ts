import { botThreadAnchorExcerptOf } from "@traycer/protocol/host/bot/conversation-schemas";
import { choicesSentence } from "@/lib/voice/focused-replies";
import type { AttentionPrompts, ReplyRef } from "@/lib/voice/queue-sources";
import type { QueueItem } from "@/stores/voice/voice-session-store";

/**
 * What the voice is given to say about the queue (Tracy Bots voice, VT4):
 * the one-line offer of an item, its line in a briefing, the read of it, and
 * the briefing itself. Prose the voice paraphrases, composed from ids and
 * the records; nothing is read out of notification copy.
 */

/**
 * The most the mint's `input` carries. The server keeps at most 4,000
 * characters of it and cuts the rest (VT1's mint route); no client-side
 * constant says so, so the briefing is bounded here to the same figure, and
 * a cut never falls mid-sentence.
 */
export const VOICE_SESSION_INPUT_MAX_CHARS = 4_000;

/**
 * What an item is about, from its own content: its first sentence, cut to a
 * few words, as a thread's anchor excerpt is. The thread's opening post is
 * not in the thread's records, and the notification's excerpt is copy, so
 * the row's own words name it.
 */
export function itemTitleOf(content: string): string {
  return botThreadAnchorExcerptOf(content) ?? "";
}

/** Where an item is, for its line: a thread, or the bot's channel. */
function placeOf(item: Pick<QueueItem, "threadId">): string {
  return item.threadId === null ? "in its channel" : "in a thread";
}

/**
 * The item's one line, as the briefing, the re-mint summary and the
 * Waiting control say it: which bot, which thread, the gist.
 */
export function itemLineOf(
  item: Pick<QueueItem, "kind" | "threadId" | "title" | "author">,
  botTitle: string,
): string {
  switch (item.kind) {
    case "message":
      return `${item.author ?? "A teammate"} wrote ${placeOf(item)} with ${botTitle}: "${item.title}"`;
    case "reply":
      return `${botTitle} answered ${placeOf(item)}: "${item.title}"`;
    case "question":
      return `${botTitle} has a question for you ${placeOf(item)}: "${item.title}"`;
    case "surface":
      return `${botTitle} says a task is waiting on you: "${item.title}"`;
    case "failed":
      return `${botTitle} stopped before answering ${placeOf(item)}`;
    case "announcement":
      return `${botTitle} posted in its channel: "${item.title}"`;
  }
}

/** The interjection: the item's line and the offer ("want it?"). */
export function offerTextOf(
  item: Pick<QueueItem, "kind" | "threadId" | "title" | "author">,
  botTitle: string,
): string {
  return `${itemLineOf(item, botTitle)}. Want it?`;
}

/**
 * The read: the words, quoted by who said them (the bot, or the teammate
 * who wrote a message), and an open question's choices as an explicit list,
 * so none is lost to a paraphrase.
 */
export function readTextOf(input: {
  readonly speaker: string;
  readonly content: string;
  readonly options: ReadonlyArray<string>;
}): string {
  const said = `${input.speaker} said: ${input.content.trim()}`;
  const choices = choicesSentence(input.options);
  return choices.length === 0 ? said : `${said} ${choices}`;
}

export const NOTHING_WAITING_TEXT = "Nothing needs your attention right now.";

/**
 * The briefing: what needs the person, bounded to `maxChars` at a
 * sentence's end, in V3's order so what blocks the person survives the cap:
 * first what waits on them (the approvals and questions the attention tier
 * counts, the bot questions and surfaced prompts the queue names, the
 * answers a bot stopped on), then unread answers and messages by bot and
 * thread (the waiting items' own lines where they are hydrated, the tier's
 * counts where they are not yet), then announcements; newest first within
 * each. With nothing, one line saying so.
 */
export function composeBriefing(input: {
  /** Unread rows in the attention tier, as references. */
  readonly answers: ReadonlyArray<ReplyRef>;
  readonly prompts: AttentionPrompts;
  /**
   * The queue as it stands. Only waiting items get a line; every item, heard
   * and dismissed included, keeps what it names out of the attention tier's
   * counts, since `later` leaves the notification unread on purpose.
   */
  readonly items: ReadonlyArray<QueueItem>;
  readonly botTitle: (botId: string) => string;
  /**
   * Prompts settled by someone else since they were queued (their message
   * and surface ids): no longer waiting on the person, even while their
   * notification is still in the attention tier.
   */
  readonly settledIds: ReadonlySet<string>;
  readonly maxChars: number;
}): string {
  const waiting = input.items
    .filter((item) => item.state === "queued" || item.state === "offered")
    .sort((a, b) => b.at - a.at);
  const known = new Set([
    ...input.settledIds,
    ...input.items.flatMap((item) =>
      [item.messageId, item.surfaceId].filter(
        (id): id is string => id !== null,
      ),
    ),
  ]);
  const lineOf = (item: QueueItem): string =>
    `${itemLineOf(item, input.botTitle(item.botId))}.`;

  const blocking: string[] = [];
  const prompts = promptSentence({
    approvals: input.prompts.approvals.filter((id) => !known.has(id)),
    questions: input.prompts.questions.filter((id) => !known.has(id)),
  });
  if (prompts !== null) blocking.push(prompts);
  blocking.push(
    ...waiting.filter((item) => isBlockingKind(item.kind)).map(lineOf),
  );

  const answers: Array<{ readonly at: number; readonly text: string }> = [];
  for (const item of waiting) {
    if (item.kind === "reply" || item.kind === "message") {
      answers.push({ at: item.at, text: lineOf(item) });
    }
  }
  for (const group of answerGroups(
    input.answers.filter((ref) => !ref.blocking && !known.has(ref.messageId)),
  )) {
    answers.push({
      at: group.at,
      text: `${input.botTitle(group.botId)} answered ${groupPlace(group)}.`,
    });
  }
  answers.sort((a, b) => b.at - a.at);

  const announcements = waiting
    .filter((item) => item.kind === "announcement")
    .map(lineOf);

  const sentences = [
    ...blocking,
    ...answers.map((entry) => entry.text),
    ...announcements,
  ];
  if (sentences.length === 0) return NOTHING_WAITING_TEXT;
  return boundedSentences(
    "Here is what needs your attention.",
    sentences.map(capitalized),
    input.maxChars,
  );
}

/** What waits on the person rather than for them. */
function isBlockingKind(kind: QueueItem["kind"]): boolean {
  return kind === "question" || kind === "surface" || kind === "failed";
}

/** A sentence that opens with a bot's fallback name ("the bot") still opens with a capital. */
function capitalized(sentence: string): string {
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

interface AnswerGroup {
  readonly botId: string;
  readonly threads: number;
  readonly inChannel: boolean;
  readonly at: number;
}

/** Unread answers by bot: how many threads, whether the channel, the newest. */
function answerGroups(
  answers: ReadonlyArray<ReplyRef>,
): ReadonlyArray<AnswerGroup> {
  const byBot = new Map<
    string,
    { threads: Set<string>; inChannel: boolean; at: number }
  >();
  for (const ref of answers) {
    const group = byBot.get(ref.botId) ?? {
      threads: new Set<string>(),
      inChannel: false,
      at: 0,
    };
    if (ref.threadId === null) group.inChannel = true;
    else group.threads.add(ref.threadId);
    group.at = Math.max(group.at, ref.at);
    byBot.set(ref.botId, group);
  }
  return Array.from(byBot, ([botId, group]) => ({
    botId,
    threads: group.threads.size,
    inChannel: group.inChannel,
    at: group.at,
  }));
}

function groupPlace(group: AnswerGroup): string {
  const parts: string[] = [];
  if (group.threads === 1) parts.push("in a thread");
  if (group.threads > 1) parts.push(`in ${group.threads} threads`);
  if (group.inChannel) parts.push("in its channel");
  return parts.join(" and ");
}

function promptSentence(prompts: AttentionPrompts): string | null {
  const approvals = prompts.approvals.length;
  const questions = prompts.questions.length;
  const parts: string[] = [];
  if (approvals > 0) parts.push(plural(approvals, "approval", "approvals"));
  if (questions > 0) parts.push(plural(questions, "question", "questions"));
  if (parts.length === 0) return null;
  const total = approvals + questions;
  return `${parts.join(" and ")} ${total === 1 ? "is" : "are"} waiting on you.`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The opening and as many sentences, in order, as fit `maxChars` with room
 * for a closing count of the rest; a sentence is never cut.
 */
function boundedSentences(
  opening: string,
  sentences: ReadonlyArray<string>,
  maxChars: number,
): string {
  let text = opening;
  for (let index = 0; index < sentences.length; index += 1) {
    const rest = sentences.length - index - 1;
    const next = `${text} ${sentences[index]}`;
    const tail = rest === 0 ? "" : ` And ${rest} more.`;
    if (next.length + tail.length > maxChars) {
      const left = sentences.length - index;
      const closing = ` And ${left} more.`;
      return text.length + closing.length <= maxChars
        ? `${text}${closing}`
        : text.slice(0, maxChars);
    }
    text = next;
  }
  return text;
}
