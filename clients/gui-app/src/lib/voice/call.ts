import type { BotConversationRecord } from "@traycer/protocol/host/bot/conversation-schemas";

/**
 * A call's fixed facts (Call Tracy, VC3): when the voice holds the floor,
 * what it says when it does, and what ends a call by voice. The lines are
 * app copy the voice says word for word; the persona says nothing else of
 * its own beyond its acknowledgement.
 */

/**
 * How long the bot's turn runs, from when it starts replying (or from its
 * last reply landing while it still replies), before the voice says one hold
 * line. A product choice, not a measurement: the silence probe (VC0) bounds
 * it only below, at the ~1 s it takes an appended line to start playing. The
 * device pass (VC5) tunes it.
 */
export const CALL_HOLD_DELAY_MS = 4_000;

/** The one line the voice says while the bot's turn runs past the hold delay. */
export const CALL_HOLD_LINE = "Still working on it.";

/** What the voice says when the bot's turn failed or parked; the call stays open. */
export function callFailureLine(botTitle: string): string {
  return `${botTitle} couldn't finish that. The call is still open.`;
}

/**
 * What the voice says when a send was queued because no host can reach the
 * bot now; the call then ends, and the message stays queued.
 */
export function callUnreachableLine(botTitle: string): string {
  return `${botTitle} can't hear right now. What you said is saved.`;
}

/**
 * What ends a call by voice: an utterance that is only one of these, whatever
 * its case and punctuation. It is never sent.
 */
export const CALL_END_PHRASES: ReadonlyArray<string> = [
  "end call",
  "end the call",
  "hang up",
  "goodbye",
  "bye",
];

/** Whether an utterance is only an end phrase. */
export function isCallEndPhrase(said: string): boolean {
  return CALL_END_PHRASES.includes(spokenWords(said));
}

/** A line's words, lowercased and without punctuation, one space apart. */
function spokenWords(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .join(" ");
}

/**
 * The sentence of the voice's output transcript being heard, as the deltas
 * that brought its letters: each with how much the person had said (an input
 * position) when it came. The vendor marks no turn, so what the voice says is
 * told sentence by sentence, against the acknowledgement lines the mint named.
 */
export interface OutputSentence {
  readonly parts: ReadonlyArray<SentencePart>;
}

interface SentencePart {
  readonly letters: string;
  readonly began: number;
}

export const NO_OUTPUT_SENTENCE: OutputSentence = { parts: [] };

/**
 * Hears one output transcript delta, `said` being how much the person has
 * said so far (an input position), `lines` the acknowledgement lines the
 * mint named. Returns the sentence after it, and, for each acknowledgement the
 * delta ends, the input position it began at: the person's words before it are
 * one utterance, and words that came while it was said belong to the next.
 *
 * A sentence ends at a terminal mark and may span deltas. It is an
 * acknowledgement when, from the start of the sentence or of one of its
 * deltas, its letters and digits are one of the lines': a reading the person
 * cut short, which ends without a mark, runs into the acknowledgement that
 * follows it. Every other sentence (a reading of a reply, or noise) closes
 * nothing.
 */
export function hearOutput(
  sentence: OutputSentence,
  lines: ReadonlyArray<string>,
  delta: string,
  said: number,
): {
  readonly sentence: OutputSentence;
  readonly closes: ReadonlyArray<number>;
} {
  const closes: number[] = [];
  let parts = sentence.parts;
  for (const piece of delta.match(/[^.!?]*[.!?]+|[^.!?]+/g) ?? []) {
    const letters = spokenLetters(piece);
    if (letters.length > 0) parts = [...parts, { letters, began: said }];
    if (!/[.!?]$/.test(piece)) continue;
    const began = acknowledgementStart(parts, lines);
    if (began !== null) closes.push(began);
    parts = [];
  }
  return { sentence: { parts }, closes };
}

/**
 * Where the acknowledgement that ends a sentence began: the earliest of its
 * parts from which the rest is one of the lines. `null` for none.
 */
function acknowledgementStart(
  parts: ReadonlyArray<SentencePart>,
  lines: ReadonlyArray<string>,
): number | null {
  const known = lines.map(spokenLetters);
  const start = parts.findIndex((_part, index) =>
    known.includes(
      parts
        .slice(index)
        .map((part) => part.letters)
        .join(""),
    ),
  );
  return parts[start]?.began ?? null;
}

/** A text's letters and digits, lowercased: how a sentence is held to a line. */
function spokenLetters(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * The re-mint threshold on the vendor's context usage ratio. The probe
 * (2026-10-30) measured the window filling at about 0.0094 a minute on
 * near-silence, reaching the vendor's own 0.9 engine replacement near
 * minute 95; re-minting at 0.8 (about minute 85) keeps the replacement the
 * app's.
 */
export const REMINT_CONTEXT_USAGE_RATIO = 0.8;

/** The latest a re-mint happens before the session's expiry, whatever the usage says. */
export const REMINT_BEFORE_EXPIRY_MS = 60_000;

/**
 * A started session that ends within this is short-lived: it did not outlive
 * the ceiling the engine gives its own handshake (10 s), so nobody got a word
 * in or out of it.
 */
export const SHORT_SESSION_MS = 10_000;

/**
 * Consecutive short-lived sessions before the re-mint stops and the call
 * ends with "connection": the scheduler's own retry budget. Each re-mint is
 * a billed server row and a vendor connect.
 */
export const MAX_SHORT_SESSIONS = 3;

/**
 * The channel conversation among a bot's conversations: the one the bot
 * record names, else the earliest. Mirrors the channel view's own rule. A
 * call's sends name it: a new call thread hangs off the channel.
 */
export function channelConversation(
  rows: ReadonlyArray<BotConversationRecord>,
  appConversationChatId: string | null,
): BotConversationRecord | null {
  if (appConversationChatId !== null) {
    return (
      rows.find((row) => row.conversationId === appConversationChatId) ?? null
    );
  }
  let first: BotConversationRecord | null = null;
  for (const row of rows) {
    if (first === null || row.createdAt < first.createdAt) first = row;
  }
  return first;
}

/** Who said a caption line: the person, or the bot the call is with. */
export function captionSpeaker(
  direction: "input" | "output",
  botTitle: string,
): string {
  return direction === "input" ? "You: " : `${botTitle}: `;
}
