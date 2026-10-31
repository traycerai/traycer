/**
 * The speech scheduler: the one owner of every utterance the app asks the
 * voice to make. The model's own speech (its acknowledgements, its small
 * talk) is the vendor's and is tracked here, never controlled.
 *
 * It tracks three independent facts, not one phase, because the session is
 * full duplex and any two can overlap:
 *
 *  - input activity: the person is speaking (an input transcript delta landed
 *    within {@link INPUT_ACTIVE_WINDOW_MS});
 *  - output playback: the voice is speaking (the remote track carries sound,
 *    or an output transcript delta landed within {@link OUTPUT_HANGOVER_MS});
 *  - a pending acknowledgement: a delegation was created and the model's
 *    automatic acknowledgement has not yet been spoken through.
 *
 * An item is appended only when all three are clear (probe P1: an append
 * while the person speaks is backchannelled and never spoken). Delivery is
 * confirmed by CONTENT: the output transcript after the append must contain
 * a word of the item's own (the bot's name, the thread's title, a key noun);
 * a bare "Mm-hmm" is not delivery. An unconfirmed item is retried at the next
 * clear moment up to {@link MAX_DELIVERY_ATTEMPTS}, then left for the bell.
 *
 * Priorities, highest first: an `ask` (the voice has a question for the
 * person), the `focused` reply they are waiting on, a reply `elsewhere`, the
 * `briefing`. The queue and the interjections that fill the lower tiers are a
 * later ticket's; the interface admits them now.
 */

export type SpeechPriority = "ask" | "focused" | "elsewhere" | "briefing";

const PRIORITY_ORDER: ReadonlyArray<SpeechPriority> = [
  "ask",
  "focused",
  "elsewhere",
  "briefing",
];

export interface SpeechItem {
  readonly id: string;
  readonly priority: SpeechPriority;
  /** What the voice is given to say; prose it paraphrases. */
  readonly text: string;
  /** The request this answers, or `null` for an interjection. */
  readonly delegationId: string | null;
  /**
   * Words whose appearance in the output transcript prove the item was
   * spoken. Compared case-insensitively on word boundaries; see
   * {@link confirmationWords}.
   */
  readonly confirmWords: ReadonlyArray<string>;
  /** Runs once, when delivery is confirmed. */
  readonly onDelivered: (() => void) | null;
}

/** The three facts, as the strip and the store read them. */
export interface SpeechActivity {
  /** Until when the person counts as speaking; `null` when they are not. */
  readonly inputActiveUntil: number | null;
  readonly outputPlaying: boolean;
  readonly ackPending: boolean;
}

export interface SpeechSchedulerDeps {
  readonly append: (text: string, delegationId: string | null) => void;
  readonly now: () => number;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
}

export interface SpeechScheduler {
  enqueue(item: SpeechItem): void;
  /** Drops a queued item that has not been appended; a no-op otherwise. */
  remove(itemId: string): void;
  noteInputTranscript(): void;
  noteOutputTranscript(text: string): void;
  /** The remote track's sound level crossed the speaking threshold, or fell under it. */
  noteOutputLevel(playing: boolean): void;
  noteDelegationCreated(): void;
  activity(): SpeechActivity;
  /** Whether nothing holds an append back right now. */
  isClear(): boolean;
  /** Items waiting or in flight. */
  pendingCount(): number;
  subscribe(listener: (activity: SpeechActivity) => void): () => void;
  /**
   * A session ended: forgets every item and timer and clears the facts, and
   * stays usable for the next session. Listeners stay subscribed.
   */
  reset(): void;
  /** `reset`, and refuses every later item: the scheduler is gone for good. */
  dispose(): void;
}

/** Input transcript deltas this close together are one stretch of speech. */
export const INPUT_ACTIVE_WINDOW_MS = 1_200;
/** An output transcript delta means the voice is still speaking this long after it. */
export const OUTPUT_HANGOVER_MS = 700;
/**
 * The model's automatic acknowledgement starts about half a second after a
 * delegation and is a few words long. One that never comes (a request the
 * model answered itself) must not hold the queue forever.
 */
export const ACK_TIMEOUT_MS = 4_000;
/** How long after an append its words are awaited in the output transcript. */
export const CONFIRM_WINDOW_MS = 8_000;
export const MAX_DELIVERY_ATTEMPTS = 3;
/**
 * Appends are chunked at about 500 tokens (probe P5 found one chunk of that
 * size listenable); four characters a token is the usual estimate.
 */
export const CHUNK_MAX_CHARS = 2_000;

interface QueuedItem {
  readonly item: SpeechItem;
  attempts: number;
}

interface InFlight {
  readonly queued: QueuedItem;
  transcript: string;
  timer: unknown;
}

export function createSpeechScheduler(
  deps: SpeechSchedulerDeps,
): SpeechScheduler {
  const queue: QueuedItem[] = [];
  const listeners = new Set<(activity: SpeechActivity) => void>();
  let inputActiveUntil: number | null = null;
  let inputTimer: unknown = null;
  let outputLevelPlaying = false;
  let outputTranscriptUntil: number | null = null;
  let outputTimer: unknown = null;
  let ackPending = false;
  let ackHeardSpeech = false;
  let ackTimer: unknown = null;
  let inFlight: InFlight | null = null;
  let disposed = false;

  const outputPlaying = (): boolean =>
    outputLevelPlaying ||
    (outputTranscriptUntil !== null && outputTranscriptUntil > deps.now());

  const activity = (): SpeechActivity => ({
    inputActiveUntil:
      inputActiveUntil !== null && inputActiveUntil > deps.now()
        ? inputActiveUntil
        : null,
    outputPlaying: outputPlaying(),
    ackPending,
  });

  const isClear = (): boolean => {
    const current = activity();
    return (
      current.inputActiveUntil === null &&
      !current.outputPlaying &&
      !current.ackPending
    );
  };

  const notify = (): void => {
    const current = activity();
    for (const listener of listeners) listener(current);
  };

  const clearAck = (): void => {
    if (!ackPending) return;
    ackPending = false;
    ackHeardSpeech = false;
    if (ackTimer !== null) {
      deps.clearTimer(ackTimer);
      ackTimer = null;
    }
  };

  const takeNext = (): QueuedItem | null => {
    for (const priority of PRIORITY_ORDER) {
      const index = queue.findIndex(
        (entry) => entry.item.priority === priority,
      );
      if (index !== -1) {
        const [entry] = queue.splice(index, 1);
        return entry;
      }
    }
    return null;
  };

  const settleInFlight = (delivered: boolean): void => {
    const current = inFlight;
    if (current === null) return;
    inFlight = null;
    if (current.timer !== null) deps.clearTimer(current.timer);
    if (delivered) {
      current.queued.item.onDelivered?.();
      return;
    }
    current.queued.attempts += 1;
    if (current.queued.attempts < MAX_DELIVERY_ATTEMPTS) {
      queue.unshift(current.queued);
    }
  };

  const dispatch = (): void => {
    if (disposed || inFlight !== null || !isClear()) return;
    const next = takeNext();
    if (next === null) return;
    for (const chunk of chunkText(next.item.text, CHUNK_MAX_CHARS)) {
      deps.append(chunk, next.item.delegationId);
    }
    inFlight = {
      queued: next,
      transcript: "",
      timer: deps.setTimer(() => {
        if (inFlight?.queued !== next) return;
        inFlight.timer = null;
        settleInFlight(false);
        onFactsChanged();
      }, CONFIRM_WINDOW_MS),
    };
  };

  const onFactsChanged = (): void => {
    notify();
    dispatch();
  };

  return {
    enqueue(item) {
      if (disposed) return;
      queue.push({ item, attempts: 0 });
      dispatch();
    },
    remove(itemId) {
      const index = queue.findIndex((entry) => entry.item.id === itemId);
      if (index !== -1) queue.splice(index, 1);
    },
    noteInputTranscript() {
      inputActiveUntil = deps.now() + INPUT_ACTIVE_WINDOW_MS;
      if (inputTimer !== null) deps.clearTimer(inputTimer);
      inputTimer = deps.setTimer(() => {
        inputTimer = null;
        onFactsChanged();
      }, INPUT_ACTIVE_WINDOW_MS);
      notify();
    },
    noteOutputTranscript(text) {
      if (inFlight !== null) {
        inFlight.transcript += text;
        if (containsConfirmWord(inFlight.transcript, inFlight.queued.item)) {
          settleInFlight(true);
        }
      }
      if (ackPending) ackHeardSpeech = true;
      outputTranscriptUntil = deps.now() + OUTPUT_HANGOVER_MS;
      if (outputTimer !== null) deps.clearTimer(outputTimer);
      outputTimer = deps.setTimer(() => {
        outputTimer = null;
        // The acknowledgement has been spoken through once the voice falls
        // quiet after speaking.
        if (ackPending && ackHeardSpeech && !outputLevelPlaying) clearAck();
        onFactsChanged();
      }, OUTPUT_HANGOVER_MS);
      notify();
    },
    noteOutputLevel(playing) {
      if (outputLevelPlaying === playing) return;
      outputLevelPlaying = playing;
      if (playing && ackPending) ackHeardSpeech = true;
      if (!playing && ackPending && ackHeardSpeech) clearAck();
      onFactsChanged();
    },
    noteDelegationCreated() {
      ackPending = true;
      ackHeardSpeech = false;
      if (ackTimer !== null) deps.clearTimer(ackTimer);
      ackTimer = deps.setTimer(() => {
        ackTimer = null;
        clearAck();
        onFactsChanged();
      }, ACK_TIMEOUT_MS);
      notify();
    },
    activity,
    isClear,
    pendingCount: () => queue.length + (inFlight === null ? 0 : 1),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset,
    dispose() {
      reset();
      disposed = true;
      listeners.clear();
    },
  };

  function reset(): void {
    queue.length = 0;
    if (inFlight !== null) {
      if (inFlight.timer !== null) deps.clearTimer(inFlight.timer);
      inFlight = null;
    }
    for (const timer of [inputTimer, outputTimer, ackTimer]) {
      if (timer !== null) deps.clearTimer(timer);
    }
    inputTimer = null;
    outputTimer = null;
    ackTimer = null;
    inputActiveUntil = null;
    outputTranscriptUntil = null;
    outputLevelPlaying = false;
    ackPending = false;
    ackHeardSpeech = false;
    notify();
  }
}

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

/** The words of a text, lowercased, apostrophes and dashes kept inside them. */
function wordsOf(text: string): string[] {
  return Array.from(text.toLowerCase().matchAll(WORD_RE), (match) => match[0]);
}

/**
 * Words too common to prove anything was said: a paraphrase that mentions
 * none of an item's content still uses these.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  "about",
  "after",
  "again",
  "answer",
  "answered",
  "asked",
  "because",
  "before",
  "being",
  "between",
  "could",
  "doing",
  "every",
  "first",
  "found",
  "going",
  "great",
  "having",
  "here",
  "into",
  "just",
  "know",
  "later",
  "like",
  "looks",
  "maybe",
  "might",
  "more",
  "much",
  "need",
  "needs",
  "next",
  "okay",
  "only",
  "other",
  "over",
  "please",
  "really",
  "replied",
  "reply",
  "right",
  "said",
  "says",
  "should",
  "since",
  "some",
  "something",
  "still",
  "sure",
  "take",
  "than",
  "that",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "thing",
  "things",
  "think",
  "this",
  "those",
  "thread",
  "through",
  "time",
  "want",
  "wants",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "will",
  "with",
  "would",
  "your",
]);

/** How many content words an item keeps as its proof of delivery. */
const MAX_CONFIRM_WORDS = 40;

/**
 * The words that prove an item was spoken: the bot's name and the thread's
 * title whole, and the item's own content words of four letters or more that
 * are not filler. Numbers count: a paraphrase keeps a version or a count.
 */
export function confirmationWords(input: {
  readonly botTitle: string | null;
  readonly threadTitle: string | null;
  readonly text: string;
}): ReadonlyArray<string> {
  const words = new Set<string>();
  for (const source of [input.botTitle, input.threadTitle]) {
    if (source === null) continue;
    for (const word of wordsOf(source)) {
      if (word.length >= 3) words.add(word);
    }
  }
  for (const word of wordsOf(input.text)) {
    if (words.size >= MAX_CONFIRM_WORDS) break;
    if (word.length >= 4 && !STOP_WORDS.has(word)) words.add(word);
  }
  return Array.from(words);
}

function containsConfirmWord(transcript: string, item: SpeechItem): boolean {
  if (item.confirmWords.length === 0) return false;
  const spoken = new Set(wordsOf(transcript));
  return item.confirmWords.some((word) => spoken.has(word.toLowerCase()));
}

/**
 * Splits a long item at sentence ends into chunks of at most `maxChars`,
 * each appended on its own; a single sentence longer than that is split at a
 * word boundary.
 */
export function chunkText(
  text: string,
  maxChars: number,
): ReadonlyArray<string> {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed.length === 0 ? [] : [trimmed];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of trimmed.split(/(?<=[.!?])\s+/)) {
    for (const piece of splitLongSentence(sentence, maxChars)) {
      if (current.length === 0) {
        current = piece;
      } else if (current.length + 1 + piece.length <= maxChars) {
        current = `${current} ${piece}`;
      } else {
        chunks.push(current);
        current = piece;
      }
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function splitLongSentence(
  sentence: string,
  maxChars: number,
): ReadonlyArray<string> {
  if (sentence.length <= maxChars) return [sentence];
  const pieces: string[] = [];
  let current = "";
  for (const word of sentence.split(/\s+/)) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= maxChars) {
      current = `${current} ${word}`;
    } else {
      pieces.push(current);
      current = word;
    }
  }
  if (current.length > 0) pieces.push(current);
  return pieces;
}
