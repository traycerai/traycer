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
  /**
   * Runs once if the item is given up on: its attempts are spent without a
   * confirmed delivery, or a replacement takes the engine with none left.
   * Never after `onDelivered`, and not when the session ends.
   */
  readonly onGivenUp: (() => void) | null;
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
  /**
   * Re-labels a queued item's delegation before it is appended (its request
   * was placed after it was scheduled). A no-op once the item is in flight
   * or gone.
   */
  relabel(itemId: string, delegationId: string | null): void;
  noteInputTranscript(): void;
  noteOutputTranscript(text: string): void;
  /** The remote track's sound level crossed the speaking threshold, or fell under it. */
  noteOutputLevel(playing: boolean): void;
  /**
   * Whether a sound-level detector watches the voice's track. Without one,
   * "quiet" is inferred from the output transcript alone, which runs ahead
   * of the sound, so the hangover after a delta is the conservative
   * {@link OUTPUT_HANGOVER_WITHOUT_LEVEL_MS} rather than {@link OUTPUT_HANGOVER_MS}.
   */
  setLevelDetection(available: boolean): void;
  noteDelegationCreated(): void;
  /**
   * Whether the engine can take appends. Nothing is appended while `false`:
   * before the first session starts, during a replacement, after an end.
   */
  setReady(ready: boolean): void;
  /**
   * The vendor session is being replaced under the same person: every fact
   * the old engine produced is retired (its playback, its acknowledgement,
   * its in-flight append and the detector it was heard through), while the
   * items themselves stay queued, now under no delegation (the old session's
   * ids mean nothing to the new one). Appends wait for `setReady(true)`.
   */
  handoff(): void;
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
/**
 * An output transcript delta means the voice is still speaking this long
 * after it, when a sound-level detector will say when it actually stops.
 */
export const OUTPUT_HANGOVER_MS = 700;
/**
 * The same hangover with no detector: the transcript runs ahead of the
 * sound (probe P5: text 0.64 s after the append, speech 0.94 s, nine seconds
 * of it for 33 words), so a short item's whole audio fits inside this wait.
 */
export const OUTPUT_HANGOVER_WITHOUT_LEVEL_MS = 4_000;
/**
 * How long an appended item is taken to be playing when no trusted detector
 * can say: a lead for the model to begin, then a budget per word. The probe
 * (P5) heard 33 words in about nine seconds; this allows eleven. Until it
 * has run, nothing else is appended: an append during that audio is the one
 * the probe says is never spoken.
 */
export const SPEECH_LEAD_MS = 1_000;
export const SPEECH_MS_PER_WORD = 300;

/** The time the voice is held to need for `text`, without a detector. */
export function estimateSpeechMs(text: string): number {
  return SPEECH_LEAD_MS + wordsOf(text).length * SPEECH_MS_PER_WORD;
}
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
  /** Re-labelled at a handoff: the delegation id belongs to one session. */
  item: SpeechItem;
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
  let ready = false;
  let levelDetection = false;
  /**
   * The playback floor: until when the last appended item's own audio is
   * taken to be playing, lacking a trusted detector. Independent of delivery
   * confirmation, which only settles the item: the words may be confirmed
   * 640 ms in while the sound runs for nine seconds more, and an append in
   * that time is never spoken.
   */
  let floorUntil: number | null = null;
  let floorTimer: unknown = null;

  const outputHangoverMs = (): number =>
    levelDetection ? OUTPUT_HANGOVER_MS : OUTPUT_HANGOVER_WITHOUT_LEVEL_MS;

  const outputPlaying = (): boolean =>
    outputLevelPlaying ||
    (outputTranscriptUntil !== null && outputTranscriptUntil > deps.now()) ||
    (!levelDetection && floorUntil !== null && floorUntil > deps.now());

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
    if (current.queued.attempts < MAX_DELIVERY_ATTEMPTS) {
      queue.unshift(current.queued);
    } else {
      current.queued.item.onGivenUp?.();
    }
  };

  const dispatch = (): void => {
    if (disposed || !ready || inFlight !== null || !isClear()) return;
    const next = takeNext();
    if (next === null) return;
    for (const chunk of chunkText(next.item.text, CHUNK_MAX_CHARS)) {
      deps.append(chunk, next.item.delegationId);
    }
    // Every append spends one of the item's attempts, whatever becomes of it.
    next.attempts += 1;
    const holdMs = estimateSpeechMs(next.item.text);
    inFlight = {
      queued: next,
      transcript: "",
      timer: deps.setTimer(
        () => {
          if (inFlight?.queued !== next) return;
          inFlight.timer = null;
          settleInFlight(false);
          onFactsChanged();
        },
        Math.max(CONFIRM_WINDOW_MS, holdMs),
      ),
    };
    holdFloor(holdMs);
  };

  /** Holds the floor for `ms`; its end is a fact change the next item waits on. */
  const holdFloor = (ms: number): void => {
    floorUntil = deps.now() + ms;
    if (floorTimer !== null) deps.clearTimer(floorTimer);
    floorTimer = deps.setTimer(() => {
      floorTimer = null;
      onFactsChanged();
    }, ms);
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
    relabel(itemId, delegationId) {
      const entry = queue.find((candidate) => candidate.item.id === itemId);
      if (entry === undefined) return;
      entry.item = { ...entry.item, delegationId };
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
      const hangover = outputHangoverMs();
      outputTranscriptUntil = deps.now() + hangover;
      if (outputTimer !== null) deps.clearTimer(outputTimer);
      outputTimer = deps.setTimer(() => {
        outputTimer = null;
        // The acknowledgement has been spoken through once the voice falls
        // quiet after speaking.
        if (ackPending && ackHeardSpeech && !outputLevelPlaying) clearAck();
        onFactsChanged();
      }, hangover);
      notify();
    },
    noteOutputLevel(playing) {
      if (outputLevelPlaying === playing) return;
      outputLevelPlaying = playing;
      if (playing && ackPending) ackHeardSpeech = true;
      if (!playing && ackPending && ackHeardSpeech) clearAck();
      onFactsChanged();
    },
    setLevelDetection(available) {
      levelDetection = available;
      if (!available) outputLevelPlaying = false;
    },
    setReady(next) {
      ready = next;
      if (ready) dispatch();
    },
    handoff() {
      const carried = retireFacts();
      ready = false;
      for (const entry of carried) {
        entry.item = { ...entry.item, delegationId: null };
      }
      notify();
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
    retireFacts();
    queue.length = 0;
    ready = false;
    notify();
  }

  /**
   * Forgets every fact and timer of the engine that produced them. An item
   * whose append was in flight goes back to the front of its queue with its
   * attempts unchanged: its words were never confirmed heard. Returns the
   * queue's entries for the caller to re-label.
   */
  function retireFacts(): QueuedItem[] {
    if (inFlight !== null) {
      if (inFlight.timer !== null) deps.clearTimer(inFlight.timer);
      // Its append was spent on the engine that is going; the item keeps
      // what is left of its budget, and is given up with none left.
      if (inFlight.queued.attempts < MAX_DELIVERY_ATTEMPTS) {
        queue.unshift(inFlight.queued);
      } else if (!disposed) {
        inFlight.queued.item.onGivenUp?.();
      }
      inFlight = null;
    }
    for (const timer of [inputTimer, outputTimer, ackTimer, floorTimer]) {
      if (timer !== null) deps.clearTimer(timer);
    }
    inputTimer = null;
    outputTimer = null;
    ackTimer = null;
    floorTimer = null;
    floorUntil = null;
    inputActiveUntil = null;
    outputTranscriptUntil = null;
    outputLevelPlaying = false;
    levelDetection = false;
    ackPending = false;
    ackHeardSpeech = false;
    return queue;
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

/**
 * What the voice says to hold the floor or acknowledge without saying
 * anything: never proof that an item was spoken, and never a confirmation
 * word of one, however the item's own text begins (probe P1: "Mm-hmm" was
 * the whole output of an append that was never spoken).
 */
const BACKCHANNEL_WORDS: ReadonlySet<string> = new Set([
  "mm",
  "mmm",
  "mhm",
  "mm-hmm",
  "mmhmm",
  "mhmm",
  "uh-huh",
  "uhuh",
  "uh",
  "um",
  "hmm",
  "hm",
  "ah",
  "oh",
  "ok",
  "okay",
  "yes",
  "yeah",
  "yep",
  "yup",
  "sure",
  "right",
  "alright",
  "got",
  "it",
  "one",
  "moment",
  "second",
  "checking",
  "noted",
  "understood",
  "absolutely",
  "certainly",
]);

/** How many content words an item keeps as its proof of delivery. */
const MAX_CONFIRM_WORDS = 40;

/** Whether a word can stand as proof: neither filler nor a backchannel. */
function isDiscriminative(word: string): boolean {
  return !STOP_WORDS.has(word) && !BACKCHANNEL_WORDS.has(word);
}

/**
 * The words that prove an item was spoken: the bot's name and the thread's
 * title whole, and the item's own content words of four letters or more,
 * none of them filler or acknowledgement vocabulary. Numbers count: a
 * paraphrase keeps a version or a count.
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
      if (word.length >= 3 && isDiscriminative(word)) words.add(word);
    }
  }
  for (const word of wordsOf(input.text)) {
    if (words.size >= MAX_CONFIRM_WORDS) break;
    if (word.length >= 4 && isDiscriminative(word)) words.add(word);
  }
  return Array.from(words);
}

/**
 * Whether an output transcript is nothing but acknowledgement: every word a
 * backchannel or filler. Such output proves no item was spoken.
 */
export function isBackchannelOnly(transcript: string): boolean {
  const words = wordsOf(transcript);
  return words.every(
    (word) => BACKCHANNEL_WORDS.has(word) || STOP_WORDS.has(word),
  );
}

function containsConfirmWord(transcript: string, item: SpeechItem): boolean {
  if (item.confirmWords.length === 0) return false;
  if (isBackchannelOnly(transcript)) return false;
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
