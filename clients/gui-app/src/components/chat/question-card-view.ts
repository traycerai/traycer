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
}

/**
 * The person's own answer to a question as they are making it - the option
 * they picked and what they typed - and the answer they sent, which the card
 * holds until the question shows settled.
 */
export interface QuestionCardDraft {
  readonly chosen: string | null;
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
  };
}

/** A question nobody has answered here yet. */
export const EMPTY_QUESTION_CARD_DRAFT: QuestionCardDraft = {
  chosen: null,
  typed: "",
  sent: null,
};

/**
 * What one question shows: open; sent, the person's answer on its way to
 * the asker and the question not settled yet; settled; or settled by someone
 * else while this person had an answer of their own, which they keep.
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

/** The person's own answer, as Submit would send it: what they typed, else the option they picked. */
export function draftText(draft: QuestionCardDraft): string | null {
  const typed = draft.typed.trim();
  return typed.length > 0 ? typed : draft.chosen;
}

/** What one question shows, from how it was settled and the person's own answer to it. */
export function questionCardView(
  settlement: QuestionCardSettlement | null,
  draft: QuestionCardDraft,
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
  const own = draftText(draft);
  if (theirs || own === null) return { kind: "settled", settlement };
  return { kind: "overtaken", settlement, draft: own };
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
