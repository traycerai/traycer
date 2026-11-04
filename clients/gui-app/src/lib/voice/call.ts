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
 * What the voice is saying, told by text alone (the vendor marks no turn).
 * The voice says two kinds of thing: a line of its own (an acknowledgement,
 * always one line ending in terminal punctuation), and the texts the app gave
 * it, which it reads verbatim. The app knows the texts it gave and has not
 * heard said yet, in order.
 */
export interface OutputTurns {
  /** Texts given to the voice and not heard said yet, oldest first. */
  readonly given: ReadonlyArray<string>;
  /** The transcript of the voice's current turn. */
  readonly turn: string;
  /** Whether the current turn is the voice reading the given texts. */
  readonly reading: boolean;
  /** The letters of the reading turn past the given texts already heard. */
  readonly heard: string;
  /**
   * The reading heard every text it was given: it is over, though more text
   * is given after it.
   */
  readonly read: boolean;
}

export const NO_OUTPUT_TURNS: OutputTurns = {
  given: [],
  turn: "",
  reading: false,
  heard: "",
  read: false,
};

/** A text given to the voice to say. */
export function giveOutputText(turns: OutputTurns, text: string): OutputTurns {
  return { ...turns, given: [...turns.given, text] };
}

/**
 * Hears one output transcript delta: the turns after it, and whether it
 * begins a new turn (the utterance boundary). A turn is over once it is
 * complete: a line of the voice's own once it ends in terminal punctuation,
 * a reading once every given text is heard whole, closing mark included
 * (punctuation inside a reading closes nothing). A reading the person spoke
 * over is cut short: a delta that does not go on with the given text begins
 * the next turn, and the texts it did not reach are dropped.
 */
export function hearOutput(
  turns: OutputTurns,
  delta: string,
): { readonly turns: OutputTurns; readonly newTurn: boolean } {
  const complete =
    turns.turn.trim().length === 0 ||
    (turns.reading ? turns.read : endsLine(turns.turn));
  if (complete) {
    return { turns: beginTurn(turns.given, delta), newTurn: true };
  }
  if (!turns.reading) {
    return { turns: { ...turns, turn: turns.turn + delta }, newTurn: false };
  }
  const heard = turns.heard + spokenLetters(delta);
  if (spokenLetters(turns.given.join("")).startsWith(heard)) {
    return {
      turns: settleReading({ ...turns, turn: turns.turn + delta, heard }),
      newTurn: false,
    };
  }
  return { turns: beginTurn([], delta), newTurn: true };
}

function beginTurn(given: ReadonlyArray<string>, delta: string): OutputTurns {
  const letters = spokenLetters(delta);
  const reading =
    letters.length > 0 && spokenLetters(given.join("")).startsWith(letters);
  const turns = {
    given,
    turn: delta,
    reading,
    heard: reading ? letters : "",
    read: false,
  };
  return reading ? settleReading(turns) : turns;
}

/**
 * Takes the given texts heard whole off the front. The last letters of a
 * text that ends a sentence are not enough while its closing mark has not
 * come: it may yet arrive on its own.
 */
function settleReading(turns: OutputTurns): OutputTurns {
  let given = turns.given;
  let heard = turns.heard;
  let first = given.at(0);
  while (first !== undefined && heardWhole(first, heard, turns.turn)) {
    heard = heard.slice(spokenLetters(first).length);
    given = given.slice(1);
    first = given.at(0);
  }
  return { ...turns, given, heard, read: given.length === 0 };
}

/** Whether `heard` holds all of `text`, its closing mark too when it has one. */
function heardWhole(text: string, heard: string, turn: string): boolean {
  const letters = spokenLetters(text);
  if (!heard.startsWith(letters)) return false;
  return heard.length > letters.length || !endsLine(text) || endsLine(turn);
}

function endsLine(text: string): boolean {
  return /[.!?]$/.test(text.trim());
}

/** A text's letters and digits, lowercased: how a transcript is held to a given text. */
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
