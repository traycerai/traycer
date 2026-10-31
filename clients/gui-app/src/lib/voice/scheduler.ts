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
  /** The transcript fell quiet while trusted playback went on: the completion check waits for it. */
  let completionPending = false;
  /** When the last output transcript delta arrived; the quiet deadline is measured from it. */
  let lastOutputTranscriptAt: number | null = null;
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

  /**
   * Arms the quiet deadline: the hangover in force, measured from the last
   * transcript delta. Re-armed when the rule changes with the detector's
   * health, so a deadline is never judged early under the shorter rule.
   */
  function armOutputQuiet(): void {
    if (lastOutputTranscriptAt === null) return;
    completionPending = false;
    const deadline = lastOutputTranscriptAt + outputHangoverMs();
    outputTranscriptUntil = deadline;
    if (outputTimer !== null) deps.clearTimer(outputTimer);
    outputTimer = deps.setTimer(
      onOutputQuiet,
      Math.max(0, deadline - deps.now()),
    );
  }

  /** The transcript has been quiet for the hangover in force. */
  function onOutputQuiet(): void {
    outputTimer = null;
    // The utterance is complete once the transcript has fallen quiet AND
    // trusted playback has stopped: a healthy detector still hearing speech
    // says the utterance goes on, whatever the transcript's gap.
    if (levelDetection && outputLevelPlaying) {
      completionPending = true;
    } else {
      completeUtterance();
    }
    // The acknowledgement has been spoken through once the voice falls quiet
    // after speaking.
    if (ackPending && ackHeardSpeech && !outputLevelPlaying) clearAck();
    onFactsChanged();
  }

  /**
   * The utterance is complete: a short answer is proven now, by the complete
   * output being exactly the answer (or repetitions of it), or holding a
   * complete number of it; nothing read from a streaming prefix.
   */
  function completeUtterance(): void {
    if (inFlight === null) return;
    if (confirmedAtCompletion(inFlight.transcript, inFlight.queued.item)) {
      settleInFlight(true);
    }
  }

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
        // Ordinary content, once said, stays said; a short answer (a number,
        // a word of acknowledgement) is judged only once the utterance is
        // complete, since "42" may go on to ",000".
        if (confirmedByContent(inFlight.transcript, inFlight.queued.item)) {
          settleInFlight(true);
        }
      }
      if (ackPending) ackHeardSpeech = true;
      lastOutputTranscriptAt = deps.now();
      armOutputQuiet();
      notify();
    },
    noteOutputLevel(playing) {
      if (outputLevelPlaying === playing) return;
      outputLevelPlaying = playing;
      if (playing && ackPending) ackHeardSpeech = true;
      if (!playing && ackPending && ackHeardSpeech) clearAck();
      // The transcript fell quiet first; playback stopping completes the
      // utterance now.
      if (!playing && completionPending && outputTimer === null) {
        completionPending = false;
        completeUtterance();
      }
      onFactsChanged();
    },
    setLevelDetection(available) {
      if (levelDetection === available) return;
      levelDetection = available;
      if (!available) outputLevelPlaying = false;
      // The quiet deadline follows the rule in force: lost health moves it
      // to the longer hangover from the last delta (never a judgement now,
      // and no level event to wait for); regained health moves it back to
      // the shorter one, with playback quiet still required.
      if (outputTimer !== null || completionPending) armOutputQuiet();
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
    completionPending = false;
    lastOutputTranscriptAt = null;
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
 * What proves an item was spoken, each entry a phrase the output transcript
 * must hold whole: the bot's name and the thread's title, and the item's own
 * content words of four letters or more, none of them filler or
 * acknowledgement vocabulary. Numbers count: a paraphrase keeps a version or
 * a count. An answer whose content has no such word (a short one: "42",
 * "-5", "3.5") is proven by its complete value instead: the numeral as
 * written, sign and decimal kept, and its spoken forms ("forty-two" or
 * "forty two", "minus five" or "negative five", "three point five"), never a
 * part of it; 0 to 99 and their decimals are spoken, a larger value only by
 * its digits (a "100" said as "one hundred" is not confirmed and is given up
 * on).
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
  const content = wordsOf(input.text);
  const before = words.size;
  for (const word of content) {
    if (words.size >= MAX_CONFIRM_WORDS) break;
    if (word.length >= 4 && isDiscriminative(word)) words.add(word);
  }
  if (words.size === before) {
    for (const phrase of shortAnswerPhrases(input.text, content)) {
      if (words.size >= MAX_CONFIRM_WORDS) break;
      words.add(phrase);
    }
  }
  return Array.from(words);
}

/**
 * What proves a short answer. A reply with a number in it: each number as a
 * complete value, as written and as said, and its other short words that
 * are not filler; never the reply's words whole, which would lose the sign
 * and the decimal ("-5" read as the word "5"). A reply of one or two words
 * with no number: the reply whole, as written but for case and the
 * punctuation around it, since a "Yes." or an "OK." is all acknowledgement
 * vocabulary and would otherwise have no proof at all; it is proven only by
 * an output that is exactly it (see `isWholeAnswerSaid`).
 */
function shortAnswerPhrases(
  text: string,
  content: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const numerals = numeralsOf(text);
  const phrases: string[] = [];
  for (const numeral of numerals) {
    phrases.push(numeral, ...spokenNumeral(numeral));
  }
  for (const word of content) {
    if (!NUMERAL_RE.test(word) && isDiscriminative(word)) phrases.push(word);
  }
  if (
    numerals.length === 0 &&
    content.length >= 1 &&
    content.length <= WHOLE_REPLY_MAX_WORDS
  ) {
    phrases.push(wholeReplyOf(text));
  }
  return phrases;
}

/** The reply as written, lowercased, the punctuation around it gone. */
function wholeReplyOf(text: string): string {
  return text.toLowerCase().replace(/^[\s"'“‘]+|[\s.!?,;:"'”’]+$/gu, "");
}

/** A reply this short is proven by being said whole; longer ones by their words. */
const WHOLE_REPLY_MAX_WORDS = 2;

/** A number as written: an optional sign, digits, an optional decimal part. */
const NUMERAL_RE = /^-?\d+(?:\.\d+)?$/u;
const NUMERALS_IN_TEXT_RE =
  /(?<![\p{L}\p{N}.,\-$€£¥])-?\d+(?:\.\d+)?(?![\p{L}\p{N}])(?![.,]\d)(?!\s*(?:[%‰°$€£¥]|(?:percent|hundred|thousand|million|billion|trillion|point)\b))/giu;

/** Symbols glued to a number that make it a different value: said, a magnitude word. */
const MAGNITUDE_SYMBOL_RE = /[%‰°]/gu;

/** The output as said: a magnitude symbol is the word it stands for, so it bounds a number. */
function spokenOf(said: string): string {
  return said.replace(MAGNITUDE_SYMBOL_RE, " percent ");
}

/**
 * The numbers written in `text`, sign and decimal kept, as they stand: a
 * complete numeral, never the prefix of a grouped ("42,000"), decimal
 * ("42.000") or magnified ("42 thousand", "42%") one.
 */
function numeralsOf(text: string): ReadonlyArray<string> {
  return Array.from(text.matchAll(NUMERALS_IN_TEXT_RE), (match) => match[0]);
}

const ONES = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = [
  "",
  "",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
];

/** The spellings of a whole number from 0 to 99: hyphenated and spaced. */
function spokenInteger(value: number): ReadonlyArray<string> {
  if (value < 20) return [ONES[value]];
  const tens = TENS[Math.floor(value / 10)];
  const one = value % 10;
  if (one === 0) return [tens];
  return [`${tens}-${ONES[one]}`, `${tens} ${ONES[one]}`];
}

/**
 * How a numeral is said, as complete phrases: the sign as "minus" or
 * "negative", a decimal part digit by digit after "point". Empty for a whole
 * part beyond 99, which has only its digits.
 */
function spokenNumeral(numeral: string): ReadonlyArray<string> {
  if (!NUMERAL_RE.test(numeral)) return [];
  const negative = numeral.startsWith("-");
  const digits = negative ? numeral.slice(1) : numeral;
  const dot = digits.indexOf(".");
  const whole = dot === -1 ? digits : digits.slice(0, dot);
  const fraction = dot === -1 ? "" : digits.slice(dot + 1);
  if (whole.length > 2) return [];
  const integers = spokenInteger(Number(whole));
  const decimals =
    fraction.length === 0
      ? [""]
      : [
          ` point ${Array.from(fraction, (digit) => ONES[Number(digit)]).join(" ")}`,
        ];
  const signs = negative ? ["minus ", "negative "] : [""];
  const phrases: string[] = [];
  for (const prefix of signs) {
    for (const integer of integers) {
      for (const decimal of decimals)
        phrases.push(`${prefix}${integer}${decimal}`);
    }
  }
  return phrases;
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

/**
 * Whether the output so far proves the item by ordinary content: it says one
 * of the item's content phrases whole, and is more than acknowledgement.
 * Read on every delta: such content, once said, stays said. A number and a
 * phrase of acknowledgement vocabulary are not read here: a number may still
 * grow ("42" into "42,000"), and acknowledgement proves nothing by being
 * contained ("yes, give me a moment" is not the reply "Yes.").
 */
function confirmedByContent(transcript: string, item: SpeechItem): boolean {
  if (item.confirmWords.length === 0) return false;
  if (isBackchannelOnly(transcript)) return false;
  const said = transcript.toLowerCase();
  return item.confirmWords.some(
    (phrase) =>
      !isBackchannelOnly(phrase) &&
      !isNumberPhrase(phrase) &&
      holdsPhrase(said, phrase),
  );
}

/**
 * Whether the complete output proves a short answer: it IS the expected
 * answer and nothing else, or only repetitions of it ("Yes. Yes."), which
 * proves it even where the same words alone would be acknowledgement ("One."
 * for the answer 1; the reply itself ends the item's text, so a seeded
 * acknowledgement word that is not the reply never confirms); or it holds a
 * complete number of the item, whole ("It is 42.", not "42,000" or "42%").
 * Read only once the utterance is complete: a prefix proves nothing.
 */
function confirmedAtCompletion(transcript: string, item: SpeechItem): boolean {
  if (item.confirmWords.length === 0) return false;
  const said = transcript.toLowerCase();
  if (
    item.confirmWords.some(
      (phrase) => isWholeAnswer(item, phrase) && isOnly(said, phrase),
    )
  ) {
    return true;
  }
  if (isBackchannelOnly(transcript)) return false;
  return item.confirmWords.some(
    (phrase) => isNumberPhrase(phrase) && holdsPhrase(said, phrase),
  );
}

/**
 * A phrase an output must be exactly to prove the item: a complete number,
 * or the item's own reply when that reply is acknowledgement vocabulary
 * ("Yes.", "OK."), which the item's text ends with.
 */
function isWholeAnswer(item: SpeechItem, phrase: string): boolean {
  if (isNumberPhrase(phrase)) return true;
  if (!isBackchannelOnly(phrase)) return false;
  const text = wordsOf(item.text).map(canonicalWord);
  const reply = wordsOf(phrase).map(canonicalWord);
  return (
    reply.length > 0 &&
    reply.length <= text.length &&
    reply.every(
      (word, index) => text[text.length - reply.length + index] === word,
    )
  );
}

/** Spellings the transcriber chooses between for one word. */
const WORD_ALIASES: ReadonlyMap<string, string> = new Map([["ok", "okay"]]);

function canonicalWord(word: string): string {
  return WORD_ALIASES.get(word) ?? word;
}

const NUMBER_WORDS: ReadonlySet<string> = new Set([
  ...ONES,
  ...TENS.filter((word) => word.length > 0),
  "minus",
  "negative",
  "point",
]);

/** A complete number, as written or as said, and nothing else. */
function isNumberPhrase(phrase: string): boolean {
  const expected = phrase.toLowerCase();
  if (NUMERAL_RE.test(expected)) return true;
  const words = wordsOf(expected).flatMap((word) => word.split("-"));
  return words.length > 0 && words.every((word) => NUMBER_WORDS.has(word));
}

/**
 * The lowercased output is the phrase and nothing else, or repetitions of
 * it with punctuation between ("Yes. Yes."), each said whole.
 */
function isOnly(said: string, phrase: string): boolean {
  const expected = phrase.toLowerCase();
  const parts = spokenOf(said)
    .split(REPEAT_SPLIT_RE)
    .map((part) => part.replace(/^[\s"'“‘]+|[\s"'”’]+$/gu, ""))
    .filter((part) => part.length > 0);
  if (parts.length === 0) return false;
  if (NUMERAL_RE.test(expected)) {
    return parts.every((part) => part === expected);
  }
  const words = wordsOf(expected).map(canonicalWord).join(" ");
  return parts.every(
    (part) => wordsOf(part).map(canonicalWord).join(" ") === words,
  );
}

/** Punctuation between repetitions; a dot or comma inside a number is not. */
const REPEAT_SPLIT_RE = /[!?;:]+|\.(?!\d)|,(?!\d)/u;

/**
 * The lowercased output holds the phrase whole: a numeral as written, words
 * adjacent within one sentence. A spoken number is whole only with no number
 * word beside it in its sentence: not "forty two" inside "forty two
 * thousand", nor "five" inside "minus five" or "three point five".
 */
function holdsPhrase(said: string, phrase: string): boolean {
  const expected = phrase.toLowerCase();
  if (NUMERAL_RE.test(expected)) {
    for (const numeral of numeralsOf(said)) {
      if (numeral === expected) return true;
    }
    return false;
  }
  const needle = wordsOf(expected);
  if (needle.length === 0) return false;
  const bounded = isNumberPhrase(expected);
  return spokenOf(said)
    .split(SENTENCE_END_RE)
    .some((sentence) => holdsWords(wordsOf(sentence), needle, bounded));
}

const SENTENCE_END_RE = /[.!?;:]+/u;

/** `needle` stands in `spoken` as adjacent words; `bounded`: with no number word beside it. */
function holdsWords(
  spoken: ReadonlyArray<string>,
  needle: ReadonlyArray<string>,
  bounded: boolean,
): boolean {
  outer: for (let start = 0; start + needle.length <= spoken.length; start++) {
    for (let offset = 0; offset < needle.length; offset++) {
      if (spoken[start + offset] !== needle[offset]) continue outer;
    }
    if (!bounded) return true;
    const before = spoken[start - 1];
    const after = spoken[start + needle.length];
    if (!continuesNumber(before) && !continuesNumber(after)) return true;
  }
  return false;
}

/** Words that make a number beside them part of a different, larger one. */
const NUMBER_CONTEXT_WORDS: ReadonlySet<string> = new Set([
  "hundred",
  "thousand",
  "million",
  "billion",
  "trillion",
  "percent",
  "and",
]);

/** Whether `word` (or any word, `undefined` for none) continues a number it stands beside. */
function continuesNumber(word: string | undefined): boolean {
  if (word === undefined) return false;
  if (NUMBER_CONTEXT_WORDS.has(word)) return true;
  return word.split("-").every((part) => NUMBER_WORDS.has(part));
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
