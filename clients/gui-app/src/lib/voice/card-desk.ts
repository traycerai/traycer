import type { BotConversationSendDelivery } from "@traycer/protocol/host/bot/conversation-schemas";
import type {
  BotSurfaceActionRefusalCode,
  BotSurfaceActionState,
} from "@traycer/protocol/host/bot/schemas";
import type {
  BotSurfaceAction,
  BotSurfaceActResponse,
} from "@traycer/protocol/host/bot/surface-schemas";
import type { StoreApi } from "zustand";
import { surfaceAnswerOf } from "@/components/bots/bot-surface-card-view";
import { QUESTION_SKIPPED_TEXT } from "@/components/chat/question-card-view";
import { choicesSentence } from "@/lib/voice/focused-replies";
import { confirmationAnswer } from "@/lib/voice/say-loop";
import {
  confirmationWords,
  repeatedWords,
  type ConfirmWord,
  type SpeechPriority,
  type SpeechScheduler,
} from "@/lib/voice/scheduler";
import type {
  ActiveCard,
  ActiveCardIds,
  CardChoice,
  CardFamily,
  CardKey,
  RoutedCardAnswer,
  RouterCard,
  VoiceCardDriver,
  VoiceSessionState,
} from "@/stores/voice/voice-session-store";

/**
 * Cards by voice (Tracy Bots voice, VT5): the one active card, read back as
 * an explicit list, answered by the person, confirmed by their yes, and
 * settled through the card's own API.
 *
 * The rules, in order:
 *  - `open` (or `read` on a card) appends the question and its choices, or
 *    the approval's summary and Allow and Deny, as a short list under its
 *    own append (a paraphrase drops choices). Nothing the person
 *    says counts until that list was confirmed spoken by its content.
 *  - The person names a choice (here, matched exactly; else by the router,
 *    which sees the card). The choice becomes the candidate and is read back
 *    alone; only a yes said after that read-back was heard sends it. A list
 *    of one choice is its own candidate read-back.
 *  - The candidate is offered again when the person moves or another item is
 *    interjected, so a yes never binds to something they did not just hear;
 *    words routed elsewhere drop it.
 *  - A bot's question answers through `bot.conversation.send`; an agent's
 *    question or approval through `bot.surface.act`, never the send. A
 *    `forwarded` act keeps the draft until the task's machine answers.
 *  - Settled by someone else, before or as the act lands, is said with who
 *    settled it, and the voice offers to post the answer in the thread
 *    instead. A card no longer there is said, never sent.
 *
 * The decision is always the person's: the voice reads, the person chooses,
 * the person confirms. Every tier the person may decide on the card is
 * allowed.
 */

/** One question of a card, as its records give it. */
export interface CardQuestion {
  readonly text: string;
  readonly options: ReadonlyArray<string>;
  /** Whether the person may answer in their own words. */
  readonly takesText: boolean;
  /** The task's own id for the question; `null` for a bot's. */
  readonly questionId: string | null;
}

/** What the card says, read from its row and, for a surfaced card, the task's open surface. */
export interface CardContent {
  readonly family: CardFamily;
  readonly botTitle: string;
  /** Where the card is, as said: `in the thread about "…"`, `in its channel`. */
  readonly place: string;
  /**
   * A bot's question: the one open question. An agent's: every question,
   * answered together. An approval: none.
   */
  readonly questions: ReadonlyArray<CardQuestion>;
  /** A bot's question: the row's index of the open question; otherwise 0. */
  readonly questionIndex: number;
  /** The approval's tool and summary, in the card's words; `null` otherwise. */
  readonly approval: { readonly tool: string; readonly summary: string } | null;
  /** The bot's post, said when the task's surface cannot be read. */
  readonly postText: string;
  /** Whether an answer can be sent from here: the task and the host take it. */
  readonly actable: boolean;
}

/** What the records say about the active card now; fed in by whoever watches them. */
export interface CardFacts {
  /** The card as its records show it while it waits; `null` while they have not loaded or it no longer waits. */
  readonly content: CardContent | null;
  /**
   * Who settled the question at `questionIndex` (any index for a surfaced
   * card), as the voice names them ("you", a teammate's name, the bot's
   * name, "someone"); `null` while it waits.
   */
  readonly settledBy: (questionIndex: number) => string | null;
  /**
   * The card no longer waits and nobody settled it: the task's wait ended
   * with its turn, or the row no longer asks anything.
   */
  readonly gone: boolean;
  /** The serving host's word on an act of this window's forwarded to the task's machine. */
  readonly forwarded: (actionId: string) => BotSurfaceActionState | null;
}

/** A bot's question answered through the send: sent, or refused or failed (the send does not say which). */
export type BotAnswerOutcome =
  | { readonly kind: "sent"; readonly delivery: BotConversationSendDelivery }
  | { readonly kind: "failed" };

/** A surfaced card acted on: the host's answer, or none (the call failed unanswered). */
export type SurfaceActOutcome =
  | { readonly kind: "answered"; readonly response: BotSurfaceActResponse }
  | { readonly kind: "failed" };

/** The card's three APIs, bound to its ids by whoever watches its records. */
export interface CardApi {
  readonly answerBotQuestion: (input: {
    readonly text: string;
    readonly questionIndex: number;
    readonly skipped: boolean;
  }) => Promise<BotAnswerOutcome>;
  readonly actSurface: (
    action: BotSurfaceAction,
    actionId: string,
  ) => Promise<SurfaceActOutcome>;
  /** Posts the person's answer in the card's thread (or the channel), as a message. */
  readonly postInThread: (text: string) => Promise<boolean>;
}

/** A queued prompt the desk can open, by its family. */
export interface CardTarget {
  readonly family: CardFamily;
  readonly ids: ActiveCardIds;
}

export interface CardDeskDeps {
  readonly store: StoreApi<VoiceSessionState>;
  readonly speech: Pick<
    SpeechScheduler,
    "enqueue" | "withdraw" | "activity" | "subscribe"
  >;
  /** Runs `fn` after `ms`; the returned function cancels it. */
  readonly schedule: (fn: () => void, ms: number) => () => void;
  /** The queued prompt behind an item id; `null` for none, or an item that asks nothing. */
  readonly target: (itemId: string) => CardTarget | null;
  /** A fresh id for one surfaced act. */
  readonly newActionId: () => string;
}

export interface CardDesk extends VoiceCardDriver {
  /** The watcher's reading of the active card's records, and its APIs; `null` APIs while the host cannot take them. */
  observe(itemId: string, facts: CardFacts, api: CardApi | null): void;
  /**
   * The person set the item aside (`later`): an opening of it still waiting
   * for their answer closes, its read-back and candidate taken back, so a
   * later yes sends nothing. An act already out on it is not taken back.
   */
  dismiss(itemId: string): void;
  /** The session ended: everything is forgotten, nothing more is said. */
  reset(): void;
}

/** How long a card waits for its records before the voice gives up reading it. */
export const CARD_LOAD_TIMEOUT_MS = 8_000;
/** How long the person has to answer once the list, or a candidate, was heard. */
export const CARD_ANSWER_WINDOW_MS = 30_000;
/** How long a refusal waits for the records to say who settled the card first. */
export const CARD_SETTLER_WAIT_MS = 3_000;

const APPROVAL_CHOICES: ReadonlyArray<string> = ["Allow", "Deny"];
const SKIP_CHOICE = "Skip";

export const CARD_UNREADABLE_TEXT =
  "I could not read that card just now. Nothing was sent.";
export const CARD_GONE_TEXT = "That is no longer waiting, so nothing was sent.";
export const CARD_DECLINED_TEXT = "Okay, I did not send it.";
export const CARD_WHICH_TEXT = "Which one? Say the choice.";
export const CARD_FAILED_TEXT =
  "I could not tell whether that was sent. The card in the channel shows where it stands.";
export const CARD_NO_POST_TEXT = "Okay, nothing was posted.";
export const CARD_STALE_ANSWER_TEXT =
  "Nothing was chosen: that answer was for a card that is no longer open.";
const ON_ITS_WAY_TEXT = "Your answer to that is already on its way.";
export const CARD_CANNOT_SEND_TEXT =
  "I cannot send that from here, so nothing was sent. The card in the channel can take it.";
const OFFER_TEXT =
  "Want me to post your answer in the thread instead? Say yes or no.";
const IN_TASK_TEXT =
  "This one has to be answered in the task, so I cannot send an answer from here.";
const ON_CARD_TEXT =
  "I cannot send an answer to this one from here; it can be answered on its card in the channel.";

const REFUSAL_TEXT: Readonly<
  Record<Exclude<BotSurfaceActionRefusalCode, "ALREADY_SETTLED">, string>
> = {
  ACCESS_DENIED: "You do not have access to that task, so nothing was sent.",
  NOT_SUPPORTED:
    "That one has to be answered in the task, so nothing was sent from here.",
  NOT_FOUND: CARD_GONE_TEXT,
  NOT_REACHABLE:
    "The task's machine could not be reached, so nothing was sent.",
};

/** The choices a card's list names, in order: a question's options and Skip, or Allow and Deny. */
function choicesOf(
  content: CardContent,
  question: CardQuestion | null,
): ReadonlyArray<string> {
  if (content.family === "approval") return APPROVAL_CHOICES;
  return question === null ? [] : question.options;
}

/** Whether the person can skip: every question can be. */
function skippable(family: CardFamily): boolean {
  return family !== "approval";
}

/** Lowercase words, punctuation gone: how a spoken choice is compared with a label. */
function normalized(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const ORDINALS: ReadonlyArray<ReadonlyArray<string>> = [
  ["1", "one", "first"],
  ["2", "two", "second"],
  ["3", "three", "third"],
  ["4", "four", "fourth"],
  ["5", "five", "fifth"],
  ["6", "six", "sixth"],
  ["7", "seven", "seventh"],
  ["8", "eight", "eighth"],
  ["9", "nine", "ninth"],
];
const ORDINAL_PADDING = new Set([
  "the",
  "option",
  "number",
  "choice",
  "one",
  "please",
  "pick",
  "go",
  "with",
  "i",
  "choose",
  "want",
  "take",
]);
const ALLOW_WORDS = new Set(["allow", "approve", "accept", "permit"]);
const DENY_WORDS = new Set(["deny", "reject", "decline", "refuse"]);
const VERB_PADDING = new Set([
  "it",
  "that",
  "this",
  "please",
  "the",
  "request",
]);
const SKIP_FORMS = new Set(["skip", "skip it", "skip that", "skip this one"]);

/**
 * The person's words as a choice of the list, matched exactly: a label said
 * whole, its number ("the second one", "option 2"), Skip, or for an approval
 * its verbs ("approve", "deny it"). `null` when the words are none of them;
 * the router, which sees the card, then decides.
 */
export function matchCardChoice(
  text: string,
  family: CardFamily,
  choices: ReadonlyArray<string>,
): CardChoice | null {
  const said = normalized(text);
  if (said.length === 0) return null;
  if (skippable(family) && SKIP_FORMS.has(said)) return { kind: "skip" };
  const byLabel = choices.findIndex((label) => normalized(label) === said);
  if (byLabel >= 0) {
    return { kind: "option", index: byLabel, label: choices[byLabel] };
  }
  const words = said.split(" ");
  if (family === "approval") {
    const core = words.filter((word) => !VERB_PADDING.has(word));
    if (core.length === 1 && ALLOW_WORDS.has(core[0])) {
      return { kind: "option", index: 0, label: choices[0] };
    }
    if (core.length === 1 && DENY_WORDS.has(core[0])) {
      return { kind: "option", index: 1, label: choices[1] };
    }
  }
  const numbered = words.filter((word) => !ORDINAL_PADDING.has(word));
  // "the first one": the padding takes "one" too, so the ordinal is what is
  // left; "option one" leaves nothing but the "one" the padding took.
  let ordinalWord: string | null = null;
  if (numbered.length === 1) ordinalWord = numbered[0];
  else if (numbered.length === 0 && words.includes("one")) ordinalWord = "one";
  if (ordinalWord === null) return null;
  const index = ORDINALS.findIndex((forms) => forms.includes(ordinalWord));
  if (index < 0 || index >= choices.length) return null;
  return { kind: "option", index, label: choices[index] };
}

function sameChoice(a: CardChoice, b: CardChoice): boolean {
  if (a.kind === "option" && b.kind === "option") return a.index === b.index;
  if (a.kind === "text" && b.kind === "text") return a.text === b.text;
  return a.kind === "skip" && b.kind === "skip";
}

/** A choice as the card would send it: the label, the person's words, or the Skip line. */
function choiceText(choice: CardChoice): string {
  switch (choice.kind) {
    case "option":
      return choice.label;
    case "text":
      return choice.text;
    case "skip":
      return QUESTION_SKIPPED_TEXT;
  }
}

/** A sentence with its first letter capitalized ("someone" opens one too). */
function capitalized(sentence: string): string {
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** The read-back of the card: who asks and where, the question, its choices as a list, and what to say. */
export function cardListText(
  content: CardContent,
  questionIndex: number,
): string {
  if (!content.actable) {
    const said = content.postText.trim();
    const why = content.family === "bot-question" ? ON_CARD_TEXT : IN_TASK_TEXT;
    return `${content.botTitle} says ${content.place}: ${said.length > 0 ? said : "a task is waiting on you."} ${why}`;
  }
  if (content.family === "approval" && content.approval !== null) {
    const summary = content.approval.summary.trim();
    const what =
      summary.length > 0
        ? `${content.approval.tool}: ${summary}`
        : content.approval.tool;
    return `${content.botTitle} says a task's agent wants to use ${what}, ${content.place}. ${choicesSentence(APPROVAL_CHOICES)} Say allow or deny.`;
  }
  const question = content.questions.at(questionIndex) ?? null;
  if (question === null) return "";
  const count = content.questions.length;
  const who =
    content.family === "bot-question"
      ? `${content.botTitle} asks ${content.place}`
      : `${content.botTitle} says a task's agent asks ${content.place}`;
  const position =
    count > 1 ? ` Question ${questionIndex + 1} of ${count}:` : "";
  const choices = choicesSentence(question.options);
  const tail = answerTail(question);
  return [`${who}:${position} ${question.text.trim()}`, choices, tail]
    .filter((part) => part.length > 0)
    .join(" ");
}

/** What the person can say to a question: one of the choices, their own words, or skip. */
function answerTail(question: CardQuestion): string {
  if (question.options.length === 1 && !question.takesText) {
    return "Say yes to send it, or skip.";
  }
  if (question.options.length === 0) return "Say your answer, or skip.";
  return question.takesText
    ? "Say one of them, your own answer, or skip."
    : "Say one of them, or skip.";
}

/** The candidate read back alone, before a yes sends it. */
export function cardCandidateText(
  content: CardContent,
  choice: CardChoice,
): string {
  if (content.family === "approval" && content.approval !== null) {
    const summary = content.approval.summary.trim();
    const what =
      summary.length > 0
        ? `${content.approval.tool}: ${summary}`
        : content.approval.tool;
    return `${choiceText(choice)} ${what}. Say yes to send it, or no.`;
  }
  const whose =
    content.family === "bot-question"
      ? `${content.botTitle}'s question`
      : "the agent's question";
  if (choice.kind === "skip") {
    return `Skip ${whose}. Say yes to send it, or no.`;
  }
  return `"${choiceText(choice)}" as your answer to ${whose}. Say yes to send it, or no.`;
}

/** Settled first by someone else: who, and how. */
function settledText(family: CardFamily, by: string, offered: boolean): string {
  const verb = family === "approval" ? "decided" : "answered";
  const settled = `${capitalized(by)} already ${verb} it, so yours was not sent.`;
  return offered
    ? `${settled} ${OFFER_TEXT}`
    : `${capitalized(by)} already ${verb} it, so there is nothing to send.`;
}

/** What was sent, said once the card's host recorded it. */
function sentText(content: CardContent, choice: CardChoice): string {
  if (content.family === "approval") {
    return choice.kind === "option" && choice.index === 0
      ? "Sent: allowed."
      : "Sent: denied.";
  }
  return choice.kind === "skip" ? "Sent: skipped." : "Sent your answer.";
}

/** The content words of a text, as the scheduler proves a saying of it by. */
function wordsOfText(text: string): ReadonlyArray<string> {
  return confirmationWords({ botTitle: null, threadTitle: null, text });
}

/**
 * What proves a card's list was read to its end: the words of its last part
 * (the final choice and the "or skip" of a question, Allow and Deny of an
 * approval), each to be said more often than the part before it (the bot,
 * the place, the question, or the tool and summary) says it. A word only
 * the end says needs one saying; one the question says too must be said
 * again, so the question alone, however its words repeat the choices,
 * proves nothing. Not every word of every choice: a paraphrase may drop
 * some, and the end is enough.
 */
function listEndWords(
  content: CardContent,
  question: CardQuestion | null,
): ReadonlyArray<ConfirmWord> {
  const approval = content.family === "approval" ? content.approval : null;
  if (approval === null) {
    return repeatedWords(
      `${question?.options.at(-1) ?? ""} skip`,
      `${content.botTitle} ${content.place} ${question?.text ?? ""}`,
    );
  }
  return repeatedWords(
    APPROVAL_CHOICES.join(" "),
    `${content.botTitle} ${content.place} ${approval.tool} ${approval.summary}`,
  );
}

/**
 * What proves a candidate was read back: its own label's words. A label too
 * short to prove anything by its words alone ("No", "Go") is proven by the
 * read-back's words instead.
 */
function candidateWords(
  choice: CardChoice,
  readBack: string,
): ReadonlyArray<string> {
  const label = wordsOfText(choiceText(choice));
  return label.some((word) => word.length >= 4) ? label : wordsOfText(readBack);
}

/** One speech item's say, kept for its withdrawal and its heard mark. */
interface Spoken {
  readonly id: string;
  heard: boolean;
  /** The newest segment when it was heard: only later words answer it. */
  heardAfterSeq: number;
}

/** One thing the voice is given to say about the card. */
interface Line {
  readonly text: string;
  readonly priority: SpeechPriority;
  /** The words whose saying proves it was heard (see `confirmationWords`). */
  readonly confirmWords: ReadonlyArray<ConfirmWord>;
  readonly onHeard: ((spoken: Spoken) => void) | null;
  readonly onGivenUp: (() => void) | null;
}

/** What the desk holds for the active card, beyond the store's `activeCard`. */
interface Desk {
  /** Distinguishes one opening from the next; a late result of an earlier one changes nothing. */
  readonly serial: number;
  readonly sessionToken: number;
  delegationId: string | null;
  content: CardContent | null;
  facts: CardFacts | null;
  api: CardApi | null;
  list: Spoken | null;
  candidateSay: Spoken | null;
  /** The answer window, while one runs. */
  cancelWindow: () => void;
  cancelLoad: () => void;
  cancelSettlerWait: () => void;
  /** The surfaced act out, by id. */
  actionId: string | null;
  /** The answer the voice offers to post, once settled by someone else. */
  offer: { readonly text: string; say: Spoken } | null;
  /** A refusal waiting for the records to name who settled the card. */
  awaitingSettler: boolean;
  /** Waits for a confirmed item's playback to end; stopped when the card closes. */
  readonly waits: Set<() => void>;
}

/**
 * A card's act that has not settled, kept by the item it acts on whatever
 * card is active since: a card opened again while its act is out shows that
 * act, and never sends a second one. A forwarded act is only kept while
 * another card is open: its records are not watched meanwhile, and it is
 * reconciled with them when its card is opened again. An answer that comes
 * back while another card is open is not said.
 */
interface ActOut {
  readonly family: CardFamily;
  readonly ids: ActiveCardIds;
  readonly content: CardContent;
  readonly questionIndex: number;
  readonly draft: ReadonlyArray<CardChoice>;
  state: "sending" | "forwarded";
  /** The surfaced act's id; `null` for a bot's answer. */
  readonly actionId: string | null;
  /** The user session the act was sent in: a later session's card is never this act's. */
  readonly sessionToken: number;
  /** The utterance whose yes sent it, and the engine that delegation belongs to. */
  readonly delegationId: string | null;
  readonly engineGeneration: number;
}

export function createCardDesk(deps: CardDeskDeps): CardDesk {
  const { store, speech } = deps;
  let desk: Desk | null = null;
  let serial = 0;
  let speechSeq = 0;
  /** Acts out, by item id, across every opening. */
  const acts = new Map<string, ActOut>();

  const card = (): ActiveCard | null => store.getState().activeCard;
  const setCard = (patch: Partial<ActiveCard>): void => {
    const current = card();
    if (current === null) return;
    store.getState().setActiveCard({ ...current, ...patch });
  };
  const lastSeq = (): number =>
    store.getState().segments.at(-1)?.seq ?? Number.NEGATIVE_INFINITY;

  const say = (held: Desk, line: Line): Spoken => {
    const { text, priority, confirmWords, onHeard, onGivenUp } = line;
    speechSeq += 1;
    const spoken: Spoken = {
      id: `card:${held.serial}:${speechSeq}`,
      heard: false,
      heardAfterSeq: Number.POSITIVE_INFINITY,
    };
    speech.enqueue({
      id: spoken.id,
      priority,
      text,
      delegationId: held.delegationId,
      confirmWords,
      // Confirmed by its content, which can be its first words: it counts as
      // heard, and the fence for what answers it is set, only once its
      // playback is over, so a yes answers what was heard whole.
      onDelivered: () => {
        if (desk !== held) return;
        afterPlayback(held, () => {
          spoken.heard = true;
          spoken.heardAfterSeq = lastSeq();
          onHeard?.(spoken);
        });
      },
      onGivenUp: () => {
        if (desk !== held) return;
        onGivenUp?.();
      },
    });
    // Only the first thing said answers the request; the rest is the voice's own.
    held.delegationId = null;
    return spoken;
  };
  /**
   * Runs `fn` once the voice's output is quiet, while the card is still
   * `held`. Called from `onDelivered`, which the scheduler runs while it
   * handles the output delta that confirmed the item, before it holds the
   * output as playing for that delta (the transcript can arrive before the
   * sound): the quiet is read once that handling is over, never from the
   * moment before it.
   */
  const afterPlayback = (held: Desk, fn: () => void): void => {
    void Promise.resolve().then(() => {
      if (desk !== held) return;
      if (!speech.activity().outputPlaying) {
        fn();
        return;
      }
      const stop = speech.subscribe((activity) => {
        if (activity.outputPlaying) return;
        stop();
        held.waits.delete(stop);
        if (desk === held) fn();
      });
      held.waits.add(stop);
    });
  };
  const notify = (held: Desk, text: string): void => {
    say(held, {
      text,
      priority: "focused",
      confirmWords: wordsOfText(text),
      onHeard: null,
      onGivenUp: null,
    });
  };
  /** A question the voice asks about the card: heard, it opens the answer window. */
  const ask = (held: Desk, text: string): Spoken =>
    say(held, {
      text,
      priority: "ask",
      confirmWords: wordsOfText(text),
      onHeard: () => startWindow(held),
      onGivenUp: () => close(held),
    });

  /** The card is over: whatever it had out is taken back, and the store forgets it. */
  const close = (held: Desk): void => {
    held.delegationId = null;
    held.cancelWindow();
    held.cancelLoad();
    held.cancelSettlerWait();
    for (const stop of held.waits) stop();
    held.waits.clear();
    if (held.list !== null && !held.list.heard) speech.withdraw(held.list.id);
    if (held.candidateSay !== null && !held.candidateSay.heard) {
      speech.withdraw(held.candidateSay.id);
    }
    if (held.offer !== null && !held.offer.say.heard) {
      speech.withdraw(held.offer.say.id);
    }
    if (desk === held) {
      desk = null;
      store.getState().setActiveCard(null);
    }
  };

  /** The person has this long to answer what they just heard; nothing is sent when it lapses. */
  const startWindow = (held: Desk): void => {
    held.cancelWindow();
    held.cancelWindow = deps.schedule(() => {
      if (desk === held) close(held);
    }, CARD_ANSWER_WINDOW_MS);
  };

  const currentQuestion = (held: Desk): CardQuestion | null => {
    const active = card();
    if (held.content === null || active === null) return null;
    if (held.content.family === "bot-question") {
      return held.content.questions.at(0) ?? null;
    }
    return held.content.questions.at(active.questionIndex) ?? null;
  };

  /** The index of the question being answered in the content's list. */
  const listIndex = (held: Desk): number => {
    const active = card();
    if (active === null || held.content?.family !== "agent-question") return 0;
    return active.questionIndex;
  };

  const readList = (held: Desk): void => {
    const content = held.content;
    if (content === null) return;
    const index = listIndex(held);
    const question = currentQuestion(held);
    const text = cardListText(content, index);
    // A single choice that takes no words of its own is its own candidate.
    const single =
      content.actable &&
      question !== null &&
      question.options.length === 1 &&
      !question.takesText
        ? ({
            kind: "option",
            index: 0,
            label: question.options[0],
          } satisfies CardChoice)
        : null;
    setCard({ candidate: single, state: "proposed" });
    held.list = say(held, {
      text,
      priority: "ask",
      // Only the list's end proves it was read whole: a read-back cut off
      // after its question, or with its choices left out, arms nothing.
      confirmWords: content.actable
        ? listEndWords(content, question)
        : wordsOfText(text),
      onHeard: (spoken) => {
        if (!content.actable) {
          close(held);
          return;
        }
        if (single !== null) held.candidateSay = spoken;
        startWindow(held);
      },
      onGivenUp: () => close(held),
    });
  };

  const readCandidate = (
    held: Desk,
    choice: CardChoice,
    prefix: string,
  ): void => {
    const content = held.content;
    if (content === null) return;
    if (held.candidateSay !== null && !held.candidateSay.heard) {
      speech.withdraw(held.candidateSay.id);
    }
    held.cancelWindow();
    setCard({ candidate: choice, state: "proposed" });
    const text = cardCandidateText(content, choice);
    held.candidateSay = say(held, {
      text: prefix.length > 0 ? `${prefix} ${text}` : text,
      priority: "ask",
      confirmWords: candidateWords(choice, text),
      onHeard: () => startWindow(held),
      onGivenUp: () => {
        held.candidateSay = null;
        setCard({ candidate: null });
      },
    });
  };

  /**
   * A refusal for a card someone else settled first: said with who, the
   * answer offered as a post. The refusal can arrive before the records say
   * who: they are given a moment, then the voice says it without a name.
   * `unsettled` is what a failure the records never explain is said as:
   * settled by someone unnamed, or not sent at all (a bot's send says no
   * more than that it failed, so only the records tell the two apart).
   */
  const settledFirst = (
    held: Desk,
    choice: CardChoice | null,
    unsettled: "someone" | "failed",
  ): void => {
    const content = held.content;
    if (content === null) {
      close(held);
      return;
    }
    const questionIndex = card()?.questionIndex ?? 0;
    const by = held.facts?.settledBy(questionIndex) ?? null;
    if (by === null && !held.awaitingSettler) {
      held.awaitingSettler = true;
      held.cancelSettlerWait = deps.schedule(() => {
        if (desk !== held || !held.awaitingSettler) return;
        held.awaitingSettler = false;
        if (unsettled === "someone") {
          speakSettled(held, choice, "someone");
          return;
        }
        notify(held, CARD_FAILED_TEXT);
        close(held);
      }, CARD_SETTLER_WAIT_MS);
      return;
    }
    held.awaitingSettler = false;
    held.cancelSettlerWait();
    speakSettled(held, choice, by ?? "someone");
  };

  const speakSettled = (
    held: Desk,
    choice: CardChoice | null,
    by: string,
  ): void => {
    const content = held.content;
    if (content === null) return;
    setCard({ state: "settled" });
    const offered =
      choice !== null && choice.kind !== "skip" && held.api !== null;
    const text = settledText(content.family, by, offered);
    if (!offered) {
      notify(held, text);
      close(held);
      return;
    }
    held.cancelWindow();
    held.offer = { text: choiceText(choice), say: ask(held, text) };
  };

  const refused = (
    held: Desk,
    code: BotSurfaceActionRefusalCode,
    choice: CardChoice,
  ): void => {
    setCard({ state: "refused" });
    if (code === "ALREADY_SETTLED") {
      settledFirst(held, choice, "someone");
      return;
    }
    notify(held, REFUSAL_TEXT[code]);
    close(held);
  };

  const sendBotAnswer = async (
    held: Desk,
    api: CardApi,
    content: CardContent,
    choice: CardChoice,
  ): Promise<void> => {
    const out = holdOut(held, content, [choice], null);
    if (out === null) return;
    const outcome = await api.answerBotQuestion({
      text: choiceText(choice),
      questionIndex: content.questionIndex,
      skipped: choice.kind === "skip",
    });
    if (!stillOut(out)) return;
    acts.delete(out.ids.itemId);
    // Said on whichever opening of the card holds it now: the person may
    // have opened another card meanwhile, and this one again.
    const current = holderOf(out);
    if (current === null) return;
    answerUnder(current, out);
    switch (outcome.kind) {
      case "sent":
        setCard({ state: "settled" });
        notify(
          current,
          outcome.delivery === "queued"
            ? `${sentText(content, choice)} It is queued until ${content.botTitle}'s machine takes it.`
            : sentText(content, choice),
        );
        close(current);
        return;
      case "failed":
        // Refused because someone answered first, as the records will show,
        // or not sent at all.
        setCard({ state: "refused" });
        settledFirst(current, choice, "failed");
        return;
    }
  };

  /** The open card, while it is an opening of this item in the session that sent the act. */
  const holderOf = (out: ActOut): Desk | null =>
    desk !== null &&
    card()?.ids.itemId === out.ids.itemId &&
    desk.sessionToken === out.sessionToken
      ? desk
      : null;

  /**
   * Whether an act's answer still belongs to the desk: the item still holds
   * that act, in the session it was sent in. A session ended since (the
   * acts were forgotten), or another act on the item, makes it stale.
   */
  const stillOut = (out: ActOut): boolean =>
    acts.get(out.ids.itemId) === out &&
    store.getState().sessionToken === out.sessionToken;

  /** The act's answer is said under the yes that sent it, while its engine lives. */
  const answerUnder = (current: Desk, out: ActOut): void => {
    current.delegationId =
      store.getState().engineGeneration === out.engineGeneration
        ? out.delegationId
        : null;
  };

  /** The act leaves: the card shows it sending, and the item holds it until it settles. */
  const holdOut = (
    held: Desk,
    content: CardContent,
    draft: ReadonlyArray<CardChoice>,
    actionId: string | null,
  ): ActOut | null => {
    const active = card();
    if (active === null) return null;
    held.actionId = actionId;
    const state = store.getState();
    const out: ActOut = {
      family: active.family,
      ids: active.ids,
      content,
      questionIndex: active.questionIndex,
      draft,
      state: "sending",
      actionId,
      sessionToken: held.sessionToken,
      delegationId: held.delegationId,
      engineGeneration: state.engineGeneration,
    };
    acts.set(active.ids.itemId, out);
    setCard({ state: "sending", draft });
    return out;
  };

  const actOnSurface = async (
    held: Desk,
    api: CardApi,
    content: CardContent,
    draft: ReadonlyArray<CardChoice>,
  ): Promise<void> => {
    const action = surfaceActionOf(content, draft);
    const last = draft.at(-1);
    if (last === undefined) return;
    const actionId = deps.newActionId();
    const out = holdOut(held, content, draft, actionId);
    if (out === null) return;
    const outcome = await api.actSurface(action, actionId);
    if (!stillOut(out)) return;
    const forwarded =
      outcome.kind === "answered" && outcome.response.outcome === "forwarded";
    // Not settled when forwarded: the draft is kept until the task's machine
    // records it (the post shows the resolution) or refuses it.
    if (forwarded) out.state = "forwarded";
    else acts.delete(out.ids.itemId);
    const current = holderOf(out);
    if (current === null) return;
    answerUnder(current, out);
    if (outcome.kind === "failed") {
      setCard({ state: "refused" });
      notify(current, CARD_FAILED_TEXT);
      close(current);
      return;
    }
    const { response } = outcome;
    switch (response.outcome) {
      case "settled":
        setCard({ state: "settled" });
        notify(current, sentText(content, last));
        close(current);
        return;
      case "forwarded": {
        setCard({ state: "forwarded" });
        notify(current, "Sent. It is on its way to the task's machine.");
        reconcileForwarded(current);
        return;
      }
      case "refused":
        refused(current, response.code ?? "NOT_FOUND", last);
        return;
    }
  };

  /** The yes came: the candidate is confirmed and sent, or the next question is read. */
  const confirm = (held: Desk): void => {
    const active = card();
    const content = held.content;
    const api = held.api;
    if (active === null || content === null || active.candidate === null) {
      return;
    }
    held.cancelWindow();
    const choice = active.candidate;
    setCard({ state: "confirmed" });
    if (api === null) {
      notify(held, CARD_CANNOT_SEND_TEXT);
      close(held);
      return;
    }
    if (content.family === "bot-question") {
      void sendBotAnswer(held, api, content, choice);
      return;
    }
    const draft = [...active.draft, choice];
    // An agent's questions go together: a Skip skips them all, an answer
    // waits for the rest.
    if (
      content.family === "agent-question" &&
      choice.kind !== "skip" &&
      active.questionIndex + 1 < content.questions.length
    ) {
      setCard({
        draft,
        candidate: null,
        state: "proposed",
        questionIndex: active.questionIndex + 1,
      });
      held.candidateSay = null;
      readList(held);
      return;
    }
    void actOnSurface(held, api, content, draft);
  };

  /**
   * Whether the card takes the person's words: from its opening while it is
   * read and waits for a choice or a yes, and while an offer to post is out.
   * Words that answer it before it could be answered (the list not heard
   * yet, the offer still being said) are spent by it, never routed as a
   * request of their own.
   */
  const listening = (held: Desk | null): held is Desk => {
    const active = card();
    if (held === null || active === null) return false;
    return held.offer !== null || active.state === "proposed";
  };

  /** Whether the card can be answered now: read back whole and answerable from here. */
  const answerable = (held: Desk): boolean =>
    held.content !== null &&
    held.content.actable &&
    held.list !== null &&
    held.list.heard;

  /** The card's opening and question, as a route was made against it. */
  const keyOf = (active: ActiveCard): CardKey => ({
    opening: active.opening,
    questionIndex: active.questionIndex,
  });
  const sameKey = (active: ActiveCard, key: CardKey): boolean =>
    active.opening === key.opening &&
    active.questionIndex === key.questionIndex;

  /** A boundary's words while an offer to post waits: yes posts, anything else lets it go. */
  const answerOffer = (
    held: Desk,
    offer: NonNullable<Desk["offer"]>,
    words: { readonly text: string; readonly seqs: ReadonlyArray<number> },
  ): "handled" | "route" => {
    const verdict = confirmationAnswer(words.text);
    if (verdict === "not-an-answer") {
      close(held);
      return "route";
    }
    if (
      !offer.say.heard ||
      words.seqs.some((seq) => seq <= offer.say.heardAfterSeq)
    ) {
      return "handled";
    }
    const api = held.api;
    if (verdict === "no" || api === null) {
      notify(held, CARD_NO_POST_TEXT);
      close(held);
      return "handled";
    }
    held.offer = null;
    held.cancelWindow();
    void api.postInThread(offer.text).then((posted) => {
      if (desk !== held) return;
      notify(
        held,
        posted
          ? "Posted your answer in the thread."
          : "The post did not go through. Nothing was posted.",
      );
      close(held);
    });
    return "handled";
  };

  /** The records while the card is read or waits for the person: it is read back once, or settled elsewhere. */
  const observeWaiting = (
    held: Desk,
    active: ActiveCard,
    facts: CardFacts,
    by: string | null,
  ): void => {
    if (held.offer !== null) return;
    if (facts.gone && by === null) {
      notify(held, CARD_GONE_TEXT);
      close(held);
      return;
    }
    if (held.list === null) {
      // First reading: settled already, or open and read back.
      if (facts.content !== null) {
        held.content = facts.content;
        held.cancelLoad();
        setCard({
          questionIndex:
            facts.content.family === "bot-question"
              ? facts.content.questionIndex
              : 0,
        });
        readList(held);
      } else if (by !== null) {
        notify(held, settledText(active.family, by, false));
        close(held);
      }
      return;
    }
    if (by === null) {
      if (facts.content !== null) held.content = facts.content;
      return;
    }
    // Settled elsewhere while the voice read it or waited for a yes.
    if (held.candidateSay !== null && !held.candidateSay.heard) {
      speech.withdraw(held.candidateSay.id);
    }
    speakSettled(held, active.candidate, by);
  };

  /**
   * The records may already say how a forwarded act ended (its refusal, or
   * the post's resolution) from while the call was out: nothing re-reads
   * them for a change of state alone, so they are read as it turns
   * forwarded.
   */
  const reconcileForwarded = (held: Desk): void => {
    const now = card();
    const facts = held.facts;
    if (now === null || facts === null) return;
    observeForwarded(held, now, facts, facts.settledBy(now.questionIndex));
  };

  /** The records while a forwarded act waits for the task's machine: recorded, refused, or gone. */
  const observeForwarded = (
    held: Desk,
    active: ActiveCard,
    facts: CardFacts,
    by: string | null,
  ): void => {
    // This act's own word first: a snapshot can carry another member's
    // resolution together with this act refused as settled first.
    const state =
      held.actionId === null ? null : facts.forwarded(held.actionId);
    if (state?.state === "refused" && state.code !== null) {
      acts.delete(active.ids.itemId);
      const last = active.draft.at(-1);
      if (last === undefined) {
        close(held);
        return;
      }
      refused(held, state.code, last);
      return;
    }
    if (by !== null) {
      // The task's machine recorded it: the act is done.
      acts.delete(active.ids.itemId);
      setCard({ state: "settled" });
      close(held);
      return;
    }
    if (facts.gone) {
      acts.delete(active.ids.itemId);
      setCard({ state: "refused" });
      notify(held, CARD_GONE_TEXT);
      close(held);
    }
  };

  /**
   * Words that are a yes or a no, said after what they answer was heard:
   * the candidate's read-back, or the list while there is no candidate.
   */
  const answerYesNo = (
    held: Desk,
    verdict: "yes" | "no",
    seqs: ReadonlyArray<number>,
  ): void => {
    const active = card();
    if (active === null) return;
    const anchor = active.candidate === null ? held.list : held.candidateSay;
    if (
      anchor === null ||
      !anchor.heard ||
      seqs.some((seq) => seq <= anchor.heardAfterSeq)
    ) {
      return;
    }
    if (verdict === "no") {
      notify(held, CARD_DECLINED_TEXT);
      close(held);
      return;
    }
    if (active.candidate === null) {
      notify(held, CARD_WHICH_TEXT);
      return;
    }
    confirm(held);
  };

  const open: CardDesk["open"] = (itemId, delegationId) => {
    const target = deps.target(itemId);
    if (target === null) return "nothing";
    const existing = desk;
    const out = acts.get(itemId);
    if (existing !== null && out !== undefined && holderOf(out) !== null) {
      existing.delegationId = delegationId;
      notify(existing, ON_ITS_WAY_TEXT);
      return "appended";
    }
    if (existing !== null) close(existing);
    serial += 1;
    const held: Desk = {
      serial,
      sessionToken: store.getState().sessionToken,
      delegationId,
      content: null,
      facts: null,
      api: null,
      list: null,
      candidateSay: null,
      cancelWindow: () => undefined,
      cancelLoad: () => undefined,
      cancelSettlerWait: () => undefined,
      actionId: null,
      offer: null,
      awaitingSettler: false,
      waits: new Set(),
    };
    desk = held;
    if (out !== undefined) {
      // Its act is still out from an earlier opening: the card shows that
      // act, and is not read or answered again.
      held.content = out.content;
      held.actionId = out.actionId;
      store.getState().setActiveCard({
        opening: serial,
        family: out.family,
        ids: out.ids,
        questionIndex: out.questionIndex,
        candidate: null,
        state: out.state,
        draft: out.draft,
      });
      notify(held, ON_ITS_WAY_TEXT);
      return "appended";
    }
    store.getState().setActiveCard({
      opening: serial,
      family: target.family,
      ids: target.ids,
      questionIndex: 0,
      candidate: null,
      state: "proposed",
      draft: [],
    });
    // The records are read by a watcher the card mounts; with none in time,
    // the voice says so and nothing is sent.
    held.cancelLoad = deps.schedule(() => {
      if (desk !== held || held.list !== null) return;
      notify(held, CARD_UNREADABLE_TEXT);
      close(held);
    }, CARD_LOAD_TIMEOUT_MS);
    return "appended";
  };

  /** The router's answer to the card that listens; `true` when the card took it. */
  const answerRoutedWith = (
    held: Desk,
    active: ActiveCard,
    routed: RoutedCardAnswer,
  ): boolean => {
    const { choice, text, key } = routed;
    // Routed against another card, or another of its questions: the
    // answer is not this one's.
    if (!sameKey(active, key)) {
      notify(held, CARD_STALE_ANSWER_TEXT);
      return true;
    }
    const content = held.content;
    // Said before the card could be answered, judged by when the words were
    // said, not by when the route came back: spent, choosing nothing, as an
    // exact choice said then is.
    const list = held.list;
    if (
      content === null ||
      list === null ||
      !answerable(held) ||
      routed.seqs.some((seq) => seq <= list.heardAfterSeq)
    ) {
      return true;
    }
    const question = currentQuestion(held);
    const choices = choicesOf(content, question);
    if (choice === null) {
      const words = text.trim();
      if (question?.takesText !== true || words.length === 0) {
        notify(held, CARD_WHICH_TEXT);
        return true;
      }
      readCandidate(held, { kind: "text", text: words }, "");
      return true;
    }
    if (choice >= 0 && choice < choices.length) {
      readCandidate(
        held,
        { kind: "option", index: choice, label: choices[choice] },
        "",
      );
      return true;
    }
    if (choice === choices.length && skippable(content.family)) {
      readCandidate(held, { kind: "skip" }, "");
      return true;
    }
    notify(held, CARD_WHICH_TEXT);
    return true;
  };

  /** A boundary's words while the card listens: spent by it, or a request of their own. */
  const answerWords = (
    held: Desk,
    words: { readonly text: string; readonly seqs: ReadonlyArray<number> },
  ): "handled" | "route" => {
    if (held.offer !== null) return answerOffer(held, held.offer, words);
    const active = card();
    const content = held.content;
    const list = held.list;
    if (active === null) return "route";
    if (content === null || list === null || !answerable(held)) {
      return prematureAnswer(active, content, words.text);
    }
    const choices = choicesOf(content, currentQuestion(held));
    const choice = matchCardChoice(words.text, content.family, choices);
    // A choice of the list wins over a yes: a question's option may be "Yes".
    // A choice the candidate already is, said again, is a yes to it.
    const sameAsCandidate =
      choice !== null &&
      active.candidate !== null &&
      sameChoice(choice, active.candidate);
    if (choice !== null && !sameAsCandidate) {
      // A choice said before the list was heard chooses nothing.
      if (words.seqs.some((seq) => seq <= list.heardAfterSeq)) {
        return "handled";
      }
      readCandidate(held, choice, "");
      return "handled";
    }
    const verdict = sameAsCandidate ? "yes" : confirmationAnswer(words.text);
    if (verdict === "not-an-answer") return "route";
    answerYesNo(held, verdict, words.seqs);
    return "handled";
  };

  return {
    open,

    observe(itemId, facts, api) {
      const held = desk;
      const active = card();
      if (held === null || active === null || active.ids.itemId !== itemId) {
        return;
      }
      if (store.getState().sessionToken !== held.sessionToken) return;
      held.facts = facts;
      held.api = api;
      const by = facts.settledBy(active.questionIndex);
      switch (active.state) {
        case "proposed":
        case "confirmed":
          observeWaiting(held, active, facts, by);
          return;
        case "sending":
          // The act's own answer settles it; a settlement seen meanwhile is
          // most likely that act's.
          return;
        case "forwarded":
          observeForwarded(held, active, facts, by);
          return;
        case "settled":
        case "refused":
          if (held.awaitingSettler && by !== null) {
            held.awaitingSettler = false;
            held.cancelSettlerWait();
            speakSettled(held, active.draft.at(-1) ?? null, by);
          }
          return;
      }
    },

    awaitsAnswer: () => listening(desk),

    answer(words, delegationId) {
      const held = desk;
      if (!listening(held)) return "route";
      // The utterance's delegation covers what is said in answer to it, now,
      // and nothing said later.
      held.delegationId = delegationId;
      try {
        return answerWords(held, words);
      } finally {
        held.delegationId = null;
      }
    },

    answerRouted(routed, delegationId) {
      const held = desk;
      const active = card();
      if (!listening(held) || held.offer !== null || active === null) {
        return false;
      }
      held.delegationId = delegationId;
      try {
        return answerRoutedWith(held, active, routed);
      } finally {
        held.delegationId = null;
      }
    },

    routerCard(): RouterCard | null {
      const held = desk;
      const active = card();
      if (!listening(held) || held.offer !== null || active === null) {
        return null;
      }
      const content = held.content;
      if (content === null || !content.actable) return null;
      const question = currentQuestion(held);
      const choices = choicesOf(content, question);
      return {
        key: keyOf(active),
        question:
          content.family === "approval"
            ? `Allow or deny ${content.approval?.tool ?? "the request"}?`
            : (question?.text ?? ""),
        choices: skippable(content.family)
          ? [...choices, SKIP_CHOICE]
          : choices,
        takesText: question?.takesText === true,
      };
    },

    dropCandidate(key) {
      const held = desk;
      const active = card();
      // A route made against another card drops nothing of this one.
      if (held === null || active === null || !sameKey(active, key)) return;
      if (held.offer !== null) {
        close(held);
        return;
      }
      if (active.state !== "proposed" || active.candidate === null) return;
      if (held.candidateSay !== null && !held.candidateSay.heard) {
        speech.withdraw(held.candidateSay.id);
      }
      held.candidateSay = null;
      setCard({ candidate: null });
    },

    invalidate(reason) {
      const held = desk;
      const active = card();
      if (held === null || active === null) return;
      const prefix =
        reason === "focus" ? "You moved, so I did not send it." : "Still open:";
      if (held.offer !== null) {
        const offer = held.offer;
        if (!offer.say.heard) return;
        // Asked again, so a yes answers only the offer heard last.
        speech.withdraw(offer.say.id);
        const again =
          reason === "focus" ? "You moved, so nothing was posted." : prefix;
        const text = `${again} ${OFFER_TEXT}`;
        offer.say = ask(held, text);
        return;
      }
      if (active.state !== "proposed" || active.candidate === null) return;
      readCandidate(held, active.candidate, prefix);
    },

    dismiss(itemId) {
      const held = desk;
      const active = card();
      if (held === null || active === null || active.ids.itemId !== itemId) {
        return;
      }
      if (held.offer === null && active.state !== "proposed") return;
      close(held);
    },

    reset() {
      const held = desk;
      if (held !== null) close(held);
      desk = null;
      acts.clear();
    },
  };
}

/**
 * Words said to a card before it could be answered: an exact choice, a
 * yes or a no is spent by it (`"handled"`) and chooses nothing; anything
 * else is a request of its own.
 */
function prematureAnswer(
  active: ActiveCard,
  content: CardContent | null,
  text: string,
): "handled" | "route" {
  const choices = prematureChoices(active, content);
  if (matchCardChoice(text, active.family, choices) !== null) return "handled";
  return confirmationAnswer(text) === "not-an-answer" ? "route" : "handled";
}

/** The choices a card has before it is read: its list once known, Allow and Deny for an approval. */
function prematureChoices(
  active: ActiveCard,
  content: CardContent | null,
): ReadonlyArray<string> {
  if (content === null) {
    return active.family === "approval" ? APPROVAL_CHOICES : [];
  }
  const index = content.family === "agent-question" ? active.questionIndex : 0;
  return choicesOf(content, content.questions.at(index) ?? null);
}

/** The surfaced act the confirmed draft is: the approval's decision, the agent's answers, or a Skip of them all. */
function surfaceActionOf(
  content: CardContent,
  draft: ReadonlyArray<CardChoice>,
): BotSurfaceAction {
  if (content.family === "approval") {
    const last = draft.at(-1);
    return {
      kind: "decide",
      decision: { approved: last?.kind === "option" && last.index === 0 },
    };
  }
  if (draft.some((choice) => choice.kind === "skip")) {
    return { kind: "skip", draftAnswers: [] };
  }
  return surfaceAnswerOf(
    content.questions,
    content.questions.map((_, index) => {
      const choice = draft.at(index);
      return choice === undefined
        ? null
        : { text: choiceText(choice), skipped: false };
    }),
  );
}
