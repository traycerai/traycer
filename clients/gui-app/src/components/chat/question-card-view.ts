import type { BotQuestionSettlement } from "@traycer/protocol/persistence/epic/messages";

/**
 * How a question was settled: a person's answer or Skip, by the name the
 * card shows for them and whether they are the person viewing it, or the
 * asker's own answer when nobody gave one.
 */
export interface QuestionCardSettlement {
  /** The answer; `null` for a Skip. */
  readonly answer: string | null;
  readonly skipped: boolean;
  readonly by:
    | {
        readonly kind: "person";
        readonly name: string;
        readonly viewer: boolean;
      }
    | { readonly kind: "asker" };
  /** When it was settled. */
  readonly at: number;
  /**
   * The set of answers that settled it with the card's other open questions
   * at once (T167), by its request; `null` for an answer given alone.
   */
  readonly setId: string | null;
}

/**
 * The person's own answer to a question as they are making it - the options
 * they picked, in the question's order, and what they typed - and the answer
 * they sent, which the card holds until the question shows settled.
 */
export interface QuestionCardDraft {
  readonly chosen: ReadonlyArray<string>;
  readonly typed: string;
  readonly sent: {
    readonly text: string;
    readonly skipped: boolean;
  } | null;
}

/** A bot's question's settlement as the card names it; `null` while it is open. */
export function botQuestionCardSettlement(
  settlement: BotQuestionSettlement | null,
  memberName: (userId: string) => string,
  viewerUserId: string | null,
): QuestionCardSettlement | null {
  if (settlement === null) return null;
  return {
    answer: settlement.answer,
    skipped: settlement.skipped,
    by:
      settlement.by.kind === "bot"
        ? { kind: "asker" }
        : {
            kind: "person",
            name: memberName(settlement.by.userId),
            viewer: settlement.by.userId === viewerUserId,
          },
    at: settlement.at,
    setId: settlement.requestId ?? null,
  };
}

/** A question nobody has answered here yet. */
export const EMPTY_QUESTION_CARD_DRAFT: QuestionCardDraft = {
  chosen: [],
  typed: "",
  sent: null,
};

/**
 * What one question shows: open; sent, the person's answer on its way to
 * the asker and the question not settled yet; settled; or settled by someone
 * else while this person had an answer of their own (`draft`), which moves to
 * their box and the question shows settled.
 */
export type QuestionCardView =
  | { readonly kind: "open" }
  | { readonly kind: "sent" }
  | { readonly kind: "settled"; readonly settlement: QuestionCardSettlement }
  | {
      readonly kind: "overtaken";
      readonly settlement: QuestionCardSettlement;
      readonly draft: string;
    };

/**
 * The person's own answer, as Submit would send it. Where a question takes
 * several options: each one picked, then what they typed. Otherwise what they
 * typed, else the option they picked.
 */
export function draftText(
  draft: QuestionCardDraft,
  several: boolean,
): string | null {
  const typed = draft.typed.trim();
  if (!several) return typed.length > 0 ? typed : (draft.chosen[0] ?? null);
  const parts = typed.length > 0 ? [...draft.chosen, typed] : draft.chosen;
  return parts.length > 0 ? parts.join(", ") : null;
}

/** The options picked once `option` is pressed: toggled among them, or the only one. */
export function chosenAfterPress(
  options: ReadonlyArray<string>,
  chosen: ReadonlyArray<string>,
  option: string,
  several: boolean,
): ReadonlyArray<string> {
  const picked = chosen.includes(option);
  if (!several) return picked ? [] : [option];
  return options.filter((item) =>
    item === option ? !picked : chosen.includes(item),
  );
}

/**
 * The draft once the person picks `option`. A question that takes one answer
 * takes a choice or their own words, not both: a choice clears what they
 * typed.
 */
export function draftAfterPress(
  options: ReadonlyArray<string>,
  draft: QuestionCardDraft,
  option: string,
  several: boolean,
): QuestionCardDraft {
  const chosen = chosenAfterPress(options, draft.chosen, option, several);
  return {
    ...draft,
    chosen,
    typed: several || chosen.length === 0 ? draft.typed : "",
  };
}

/** The draft once the person types `typed`: on a question that takes one answer, their words clear the choice. */
export function draftAfterTyping(
  draft: QuestionCardDraft,
  typed: string,
  several: boolean,
): QuestionCardDraft {
  return {
    ...draft,
    typed,
    chosen: several || typed.trim().length === 0 ? draft.chosen : [],
  };
}

/**
 * One question's part of a card's answers sent together (T167), as
 * `bot.conversation.send@1.5` takes it: a Skip, or the options picked, in
 * the question's order, and the words typed.
 */
export interface QuestionCardEntry {
  readonly questionIndex: number;
  readonly skipped: boolean;
  readonly selected: ReadonlyArray<string>;
  readonly text: string | null;
}

/**
 * A question's answer as the card's Submit sends it: the options picked and
 * the words typed; `null` while it has neither, and Submit sends it skipped
 * (`questionCardSkippedEntry`).
 */
export function questionCardEntry(
  questionIndex: number,
  draft: QuestionCardDraft,
): QuestionCardEntry | null {
  const typed = draft.typed.trim();
  if (draft.chosen.length === 0 && typed.length === 0) return null;
  return {
    questionIndex,
    skipped: false,
    selected: draft.chosen,
    text: typed.length > 0 ? typed : null,
  };
}

/** An open question the person left untouched, as Submit sends it: skipped (T186). */
export function questionCardSkippedEntry(
  questionIndex: number,
): QuestionCardEntry {
  return { questionIndex, skipped: true, selected: [], text: null };
}

/**
 * What the foot of a card whose answers go together says: how many of its
 * open questions the person has answered, and what Submit does with the
 * rest - nothing until one is answered, then sends them skipped. A question
 * settled already, by the asker or anyone, is not counted.
 */
export function questionCardTallyLine(answered: number, open: number): string {
  const tally = `${String(answered)} of ${String(open)} answered.`;
  const left = open - answered;
  if (left === 0) return tally;
  if (answered === 0) return `${tally} Answer at least one to submit.`;
  return left === 1
    ? `${tally} The last one will be sent as skipped.`
    : `${tally} The other ${String(left)} will be sent as skipped.`;
}

/**
 * Who settled every question of the card with one set of answers, and when;
 * `null` while any is open, or where they were settled otherwise.
 */
export function questionCardAnsweredBy(
  settlements: ReadonlyArray<QuestionCardSettlement | null>,
): { readonly name: string; readonly at: number } | null {
  const first = settlements[0] ?? null;
  if (first === null || first.setId === null || first.by.kind !== "person") {
    return null;
  }
  return settlements.every((item) => item?.setId === first.setId)
    ? { name: first.by.name, at: first.at }
    : null;
}

/** What one question shows, from how it was settled and the person's own answer to it. */
export function questionCardView(
  settlement: QuestionCardSettlement | null,
  draft: QuestionCardDraft,
  several: boolean,
): QuestionCardView {
  if (settlement === null) {
    return draft.sent === null ? { kind: "open" } : { kind: "sent" };
  }
  // The person's own answer landing is what settled it: by them, and with
  // what this card sent. The same person answering otherwise first, from
  // another window, overtook it as anyone else would.
  const { sent } = draft;
  const theirs =
    sent !== null &&
    settlement.by.kind === "person" &&
    settlement.by.viewer &&
    settlement.skipped === sent.skipped &&
    (sent.skipped || settlement.answer === sent.text);
  const own = draftText(draft, several);
  if (theirs || own === null) return { kind: "settled", settlement };
  return { kind: "overtaken", settlement, draft: own };
}

/**
 * The lines a member's answers take into their box once someone else
 * settled the questions first (T186): on a card of one question, the answer
 * alone, as Submit would have sent it; on a card of several, one line per
 * question in the card's order, the question then the answer, with a colon
 * between unless the question ends in a question mark.
 */
export function questionCardMovedBlock(
  answers: ReadonlyArray<{
    readonly question: string;
    readonly answer: string;
  }>,
  severalQuestions: boolean,
): string {
  return answers
    .map((item) => {
      if (!severalQuestions) return item.answer;
      const question = item.question.trimEnd();
      return question.endsWith("?")
        ? `${question} ${item.answer}`
        : `${question}: ${item.answer}`;
    })
    .join("\n");
}

/**
 * How the questions whose answers moved were settled: answered; skipped,
 * each on its own; or left out of an answer to the card, which settles them
 * skipped though nobody chose to skip them.
 */
export type QuestionCardMovedHow = "answered" | "skipped" | "card";

/**
 * How the questions whose answers moved were settled: answered where any of
 * them was. A question a teammate's answer to the card left out is settled
 * skipped though nobody chose to skip it, so all skipped with any by a set
 * reads as the card answered.
 */
export function questionCardMovedHow(
  settlements: ReadonlyArray<QuestionCardSettlement>,
): QuestionCardMovedHow {
  if (!settlements.every((item) => item.skipped)) return "answered";
  return settlements.some((item) => item.setId !== null) ? "card" : "skipped";
}

/** What the person who settled the questions first did, for the box's line. */
function movedDid(how: QuestionCardMovedHow, them: string): string {
  if (how === "card") return "answered the card";
  if (how === "skipped") return `skipped ${them}`;
  return "answered";
}

/**
 * What the box says under it once `moved` of the member's answers went
 * there: who settled the questions first, said once, and that the answers
 * are in the box, unsent.
 */
export function questionCardMovedLine(
  by: QuestionCardSettlement["by"],
  how: QuestionCardMovedHow,
  asker: string,
  moved: number,
): string {
  const them = moved === 1 ? "it" : "them";
  const did = movedDid(how, them);
  if (by.kind === "person" && by.viewer) {
    const what = moved === 1 ? "This answer is" : "These answers are";
    return `You ${did} in another window first. ${what} in the box, not sent.`;
  }
  const yours =
    moved === 1
      ? "Your answer is in the box, not sent."
      : "Your answers are in the box, not sent.";
  if (by.kind === "asker") return `${asker} settled ${them} first. ${yours}`;
  return `${by.name} ${did} first. ${yours}`;
}

/** The line a Skip sends as the person's message. */
export const QUESTION_SKIPPED_TEXT = "Skipped";

/** What a settled question says: what it was settled with, and by whom. */
export function questionSettledLine(
  settlement: QuestionCardSettlement,
  asker: string,
): string {
  if (settlement.by.kind === "asker") {
    return `Settled by ${asker}: ${settlement.answer ?? QUESTION_SKIPPED_TEXT}`;
  }
  return settlement.skipped || settlement.answer === null
    ? QUESTION_SKIPPED_TEXT
    : `Answered by ${settlement.by.name}: ${settlement.answer}`;
}
