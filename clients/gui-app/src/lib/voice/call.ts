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
 * The voice says two kinds of thing: a line of its own (an acknowledgement:
 * after every utterance, one line ending in terminal punctuation), and the
 * texts the app gave it, which it reads verbatim. The app knows the texts it
 * gave and has not heard said yet, in order. Only a line of the voice's own
 * closes an utterance; a reading never does.
 */
export interface OutputTurns {
  /** Texts given to the voice and not heard said yet, oldest first. */
  readonly given: ReadonlyArray<string>;
  /**
   * The current turn: `none` before any (or after one that ended with no
   * letters); `undecided` while all it said is the start of the given texts;
   * `reading` once it reached the end of the first of them; `own` once it
   * left them.
   */
  readonly kind: "none" | "undecided" | "reading" | "own";
  /** The transcript of the current turn. */
  readonly turn: string;
  /** The letters of an undecided or reading turn past the given texts heard whole. */
  readonly heard: string;
  /** The reading heard every text it was given: over, though more is given after it. */
  readonly read: boolean;
  /** How much the person had said (an input position) when the turn began. */
  readonly began: number;
}

export const NO_OUTPUT_TURNS: OutputTurns = {
  given: [],
  kind: "none",
  turn: "",
  heard: "",
  read: false,
  began: 0,
};

/** A text given to the voice to say. */
export function giveOutputText(turns: OutputTurns, text: string): OutputTurns {
  return { ...turns, given: [...turns.given, text] };
}

/**
 * Hears one output transcript delta, `said` being how much the person has
 * said so far (an input position). Returns the turns after it, and, for each
 * line of the voice's own that the delta ends, the input position its turn
 * began at: the person's words before it are one utterance, and words that
 * came while it was said belong to the next.
 *
 * A delta is heard in pieces, each ending after a terminal mark: a line of
 * the voice's own ends at its first mark, and what follows in the same delta
 * begins the next turn. A turn that is the start of the given texts is
 * undecided, and closes nothing, until it reaches the end of the first of
 * them (a reading, in which punctuation closes nothing) or leaves them. One
 * that leaves them with a word that goes on with its sentence was a line of
 * the voice's own from its start; one that leaves them with a new sentence
 * was a reading cut short, as is a reading that leaves them: the texts it did
 * not reach are dropped and the new sentence begins the next turn.
 */
export function hearOutput(
  turns: OutputTurns,
  delta: string,
  said: number,
): { readonly turns: OutputTurns; readonly closes: ReadonlyArray<number> } {
  const closes: number[] = [];
  let current = turns;
  for (const piece of delta.match(/[^.!?]*[.!?]+|[^.!?]+/g) ?? []) {
    current = hearPiece(current, piece, said);
    if (current.kind === "own" && endsLine(current.turn)) {
      closes.push(current.began);
      current = { ...current, kind: "none", turn: "" };
    }
  }
  return { turns: current, closes };
}

function hearPiece(
  turns: OutputTurns,
  piece: string,
  said: number,
): OutputTurns {
  switch (turns.kind) {
    case "none":
      return beginTurn(turns.given, piece, said);
    case "own":
      return { ...turns, turn: turns.turn + piece };
    case "reading":
      if (turns.read) return beginTurn(turns.given, piece, said);
      return goOnReading(turns, piece) ?? beginTurn([], piece, said);
    case "undecided": {
      const read = goOnReading(turns, piece);
      if (read !== null) return read;
      if (startsSentence(piece)) return beginTurn([], piece, said);
      return { ...turns, kind: "own", turn: turns.turn + piece };
    }
  }
}

function beginTurn(
  given: ReadonlyArray<string>,
  piece: string,
  said: number,
): OutputTurns {
  const letters = spokenLetters(piece);
  if (letters.length === 0) return { ...NO_OUTPUT_TURNS, given };
  const turns: OutputTurns = {
    given,
    kind: "undecided",
    turn: "",
    heard: "",
    read: false,
    began: said,
  };
  return goOnReading(turns, piece) ?? { ...turns, kind: "own", turn: piece };
}

/**
 * The turn after `piece`, when it goes on with the given texts: undecided
 * until it reaches the end of the first, then reading, with the texts heard
 * whole taken off the front. `null` when it leaves them.
 */
function goOnReading(turns: OutputTurns, piece: string): OutputTurns | null {
  const heard = turns.heard + spokenLetters(piece);
  if (!spokenLetters(turns.given.join("")).startsWith(heard)) return null;
  const turn = turns.turn + piece;
  const first = turns.given.at(0);
  const reached =
    turns.kind === "reading" ||
    (first !== undefined && heard.length >= spokenLetters(first).length);
  if (!reached) return { ...turns, kind: "undecided", turn, heard };
  return settleReading({ ...turns, kind: "reading", turn, heard });
}

/**
 * Takes the given texts heard whole off the front. A closing mark that comes
 * on its own after them has no letters, so it begins no turn.
 */
function settleReading(turns: OutputTurns): OutputTurns {
  let given = turns.given;
  let heard = turns.heard;
  let first = given.at(0);
  while (first !== undefined && heard.startsWith(spokenLetters(first))) {
    heard = heard.slice(spokenLetters(first).length);
    given = given.slice(1);
    first = given.at(0);
  }
  return { ...turns, given, heard, read: given.length === 0 };
}

function endsLine(text: string): boolean {
  return /[.!?]$/.test(text.trim());
}

/** Whether a piece opens a new sentence: its first letter is a capital. */
function startsSentence(piece: string): boolean {
  const first = /[\p{L}\p{N}]/u.exec(piece)?.[0] ?? "";
  return /\p{Lu}/u.test(first);
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
