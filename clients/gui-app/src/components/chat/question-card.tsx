import { useId, type ReactElement, type ReactNode } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { useMessageTime } from "@/lib/relative-time";
import {
  QUESTION_SKIPPED_TEXT,
  draftAfterPress,
  draftAfterTyping,
  draftText,
  questionCardAnsweredBy,
  questionCardEntry,
  questionCardTallyLine,
  questionCardView,
  questionSettledLine,
  type QuestionCardDraft,
  type QuestionCardEntry,
  type QuestionCardSettlement,
} from "@/components/chat/question-card-view";

/** One question of the card, how it was settled, and the person's own answer to it. */
export interface QuestionCardQuestion {
  /** Its place among the asker's questions, which is how an answer names it. */
  readonly index: number;
  readonly text: string;
  readonly options: ReadonlyArray<string>;
  readonly allowFreeText: boolean;
  /** Whether several options may be picked; Submit sends them joined. */
  readonly several: boolean;
  /** `null` while the question is open. */
  readonly settlement: QuestionCardSettlement | null;
  readonly draft: QuestionCardDraft;
}

/** What a person submits for one question: an answer, or a Skip. */
export interface QuestionCardAnswer {
  readonly questionIndex: number;
  /** The chosen options and the typed answer; the Skip's line for a Skip. */
  readonly text: string;
  readonly skipped: boolean;
}

/**
 * The card under a question asked without waiting for its answer (Tracy
 * Bots, decision 121): each question with its options as buttons, a field
 * for an answer in the person's own words where the asker takes one, Submit
 * and Skip; a settled question says what it was settled with and by whom,
 * and offers nothing. Every member sees the same card, and the first answer
 * to land settles a question for all of them (decision 122). An answer sent
 * stays on the card, waiting, until the question shows settled: by this
 * person, and the card says so; or by someone else first, and this person
 * keeps their answer in place, is told who answered while they were
 * answering, loses Submit, and can copy what they had or take it to the
 * question's discussion.
 *
 * The card keeps nothing itself: each question's draft is the caller's, so
 * it outlives the view (`onDraft`), as do where an answer goes (`onAnswer`)
 * and where the discussion is (`onDiscuss`). `onDraft: null` draws the card
 * without actions.
 *
 * Where the answers go together (`onAnswerAll`, T167), the card has one
 * Submit at its foot in place of each question's own, sending an answer or a
 * Skip for every open question as one message; each question has its own
 * Skip, and the foot counts the open questions answered. A question settled
 * already, by the asker or anyone, shows how and is not counted. Once one set
 * settled them all, the card shows each answer and who sent them, once,
 * whichever way this viewer's own answers would go.
 */
export function QuestionCard(props: {
  /** Who asks, by the name the card shows. */
  readonly asker: string;
  readonly questions: ReadonlyArray<QuestionCardQuestion>;
  readonly onDraft:
    | ((questionIndex: number, draft: QuestionCardDraft) => void)
    | null;
  readonly onAnswer: (answer: QuestionCardAnswer) => void;
  /**
   * Sends the person's answer or Skip for every open question at once;
   * `null` answers each question on its own.
   */
  readonly onAnswerAll:
    | ((entries: ReadonlyArray<QuestionCardEntry>) => void)
    | null;
  /** Opens the question's discussion with `draft` in its box, unsent; `null` where there is none. */
  readonly onDiscuss: ((questionIndex: number, draft: string) => void) | null;
}): ReactElement {
  const { asker, questions, onDraft, onAnswer, onAnswerAll, onDiscuss } = props;
  const answeredBy = questionCardAnsweredBy(
    questions.map((item) => item.settlement),
  );
  return (
    <div
      data-testid="question-card"
      className="mt-0.5 flex min-w-0 flex-col gap-2 border-l-4 border-l-chart-2 py-0.5 pl-3"
    >
      <span className="text-ui-sm font-semibold text-foreground">
        {`${asker} asks`}
      </span>
      {questions.map((question) => (
        <QuestionCardItem
          key={question.index}
          asker={asker}
          question={question}
          together={onAnswerAll !== null}
          answerOnly={answeredBy !== null}
          onDraft={
            onDraft === null ? null : (draft) => onDraft(question.index, draft)
          }
          onAnswer={onAnswer}
          onDiscuss={
            onDiscuss === null
              ? null
              : (draft) => onDiscuss(question.index, draft)
          }
        />
      ))}
      {answeredBy === null ? null : (
        <AnsweredBy name={answeredBy.name} at={answeredBy.at} />
      )}
      {answeredBy !== null || onAnswerAll === null ? null : (
        <SubmitAll
          questions={questions}
          disabled={onDraft === null}
          onSubmit={(entries) => {
            if (onDraft === null) return;
            for (const question of questions) {
              if (question.settlement !== null) continue;
              const { draft } = question;
              onDraft(question.index, {
                ...draft,
                sent: draft.skip
                  ? { text: QUESTION_SKIPPED_TEXT, skipped: true }
                  : {
                      text: draftText(draft, question.several) ?? "",
                      skipped: false,
                    },
              });
            }
            onAnswerAll(entries);
          }}
        />
      )}
    </div>
  );
}

function QuestionCardItem(props: {
  readonly asker: string;
  readonly question: QuestionCardQuestion;
  /** Whether the card's answers go together, sent by its one Submit. */
  readonly together: boolean;
  /** Whether one set settled every question, which the card's foot names once. */
  readonly answerOnly: boolean;
  readonly onDraft: ((draft: QuestionCardDraft) => void) | null;
  readonly onAnswer: (answer: QuestionCardAnswer) => void;
  readonly onDiscuss: ((draft: string) => void) | null;
}): ReactElement {
  const {
    asker,
    question,
    together,
    answerOnly,
    onDraft,
    onAnswer,
    onDiscuss,
  } = props;
  const { draft } = question;
  const view = questionCardView(question.settlement, draft, question.several);
  const submit = (text: string, skipped: boolean): void => {
    if (onDraft === null) return;
    onDraft({ ...draft, sent: { text, skipped } });
    onAnswer({ questionIndex: question.index, text, skipped });
  };
  const editable = view.kind !== "sent" && onDraft !== null;
  // A sent answer waits as it was sent; an overtaken one stays the person's
  // to change before they copy it or discuss it. A question skipped on a
  // card sent together takes no answer.
  const draftEditable = editable && !(together && draft.skip);

  return (
    <section
      data-testid="question-card-item"
      data-state={view.kind}
      aria-label={question.text}
      className="flex min-w-0 flex-col gap-1.5"
    >
      <p className="text-ui-sm break-words whitespace-pre-wrap text-foreground">
        {question.text}
      </p>
      {question.several && view.kind !== "settled" ? (
        <p className="text-ui-xs text-muted-foreground">Choose any.</p>
      ) : null}
      {view.kind === "settled" ? (
        <p
          data-testid="question-card-settlement"
          className="text-ui-xs break-words whitespace-pre-wrap text-muted-foreground"
        >
          {settledText(view.settlement, asker, answerOnly)}
        </p>
      ) : (
        <>
          {view.kind === "overtaken" ? (
            <p
              data-testid="question-card-overtaken"
              role="status"
              className="text-ui-xs break-words whitespace-pre-wrap text-warning-foreground"
            >
              {overtakenLine(view.settlement, asker)}
            </p>
          ) : null}
          <QuestionDraft
            question={question}
            editable={draftEditable}
            onChange={(next) => onDraft?.(next)}
          />
          {view.kind === "overtaken" ? (
            <OvertakenActions draft={view.draft} onDiscuss={onDiscuss} />
          ) : null}
          {view.kind !== "overtaken" && together ? (
            <SkipToggle
              skip={draft.skip}
              disabled={!editable}
              onToggle={() => onDraft?.({ ...draft, skip: !draft.skip })}
            />
          ) : null}
          {view.kind === "overtaken" || together ? null : (
            <OpenActions
              draft={draftText(draft, question.several)}
              disabled={onDraft === null || view.kind === "sent"}
              sending={view.kind === "sent"}
              onSubmit={(text) => submit(text, false)}
              onSkip={() => submit(QUESTION_SKIPPED_TEXT, true)}
            />
          )}
        </>
      )}
    </section>
  );
}

/** What a settled question says: its answer alone where the card's foot names who sent it. */
function settledText(
  settlement: QuestionCardSettlement,
  asker: string,
  answerOnly: boolean,
): string {
  if (!answerOnly) return questionSettledLine(settlement, asker);
  return settlement.answer ?? QUESTION_SKIPPED_TEXT;
}

/**
 * A question's Skip on a card whose answers go together: pressed again, it is
 * answered after all. One name; `aria-pressed` says whether it is skipped.
 */
function SkipToggle(props: {
  readonly skip: boolean;
  readonly disabled: boolean;
  readonly onToggle: () => void;
}): ReactElement {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="self-start"
      aria-pressed={props.skip}
      disabled={props.disabled}
      data-testid="question-card-skip"
      onClick={props.onToggle}
    >
      Skip this question
    </Button>
  );
}

/**
 * The person's answer as they are making it: the options they picked, and
 * what they typed. A question that takes one answer takes a choice or words,
 * so either clears the other.
 */
function QuestionDraft(props: {
  readonly question: QuestionCardQuestion;
  readonly editable: boolean;
  readonly onChange: (next: QuestionCardDraft) => void;
}): ReactNode {
  const { question, editable, onChange } = props;
  const { chosen, typed } = question.draft;
  const fieldId = useId();
  return (
    <>
      {question.options.length === 0 ? null : (
        <div
          className="flex flex-wrap gap-1.5"
          role="group"
          aria-label="Choices"
        >
          {question.options.map((option) => (
            <Button
              key={option}
              type="button"
              variant="outline"
              size="xs"
              aria-pressed={chosen.includes(option)}
              disabled={!editable}
              data-testid="question-card-option"
              onClick={() =>
                onChange(
                  draftAfterPress(
                    question.options,
                    question.draft,
                    option,
                    question.several,
                  ),
                )
              }
            >
              {option}
            </Button>
          ))}
        </div>
      )}
      {question.allowFreeText ? (
        <>
          <label htmlFor={fieldId} className="sr-only">
            Your answer
          </label>
          <Textarea
            id={fieldId}
            value={typed}
            size="xs"
            rows={1}
            placeholder="Your answer"
            disabled={!editable}
            className="max-h-40 min-h-8"
            data-testid="question-card-input"
            onChange={(event) =>
              onChange(
                draftAfterTyping(
                  question.draft,
                  event.target.value,
                  question.several,
                ),
              )
            }
          />
        </>
      ) : null}
    </>
  );
}

/** Submit for the person's answer, and Skip; both held while a sent answer waits. */
function OpenActions(props: {
  /** The answer Submit sends; `null` while there is none. */
  readonly draft: string | null;
  readonly disabled: boolean;
  readonly sending: boolean;
  readonly onSubmit: (text: string) => void;
  readonly onSkip: () => void;
}): ReactElement {
  const { draft, disabled, sending, onSubmit, onSkip } = props;
  return (
    <div className="flex items-center gap-1.5">
      <Button
        type="button"
        size="xs"
        disabled={disabled || draft === null}
        data-testid="question-card-submit"
        onClick={() => {
          if (draft !== null) onSubmit(draft);
        }}
      >
        Submit
        {sending ? (
          <AgentSpinningDots
            className={undefined}
            testId="question-card-sending"
            variant={undefined}
          />
        ) : null}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={disabled}
        data-testid="question-card-skip"
        onClick={onSkip}
      >
        Skip
      </Button>
    </div>
  );
}

/**
 * The foot of a card whose answers go together: how many open questions the
 * person has answered or skipped, and Submit, which sends them all once
 * every one has an answer or a Skip; held, spinning, while they are sent.
 */
function SubmitAll(props: {
  readonly questions: ReadonlyArray<QuestionCardQuestion>;
  readonly disabled: boolean;
  readonly onSubmit: (entries: ReadonlyArray<QuestionCardEntry>) => void;
}): ReactNode {
  const { questions, disabled, onSubmit } = props;
  const open = questions.filter((item) => item.settlement === null);
  if (open.length === 0) return null;
  const entries = open.flatMap((item) => {
    const entry = questionCardEntry(item.index, item.draft);
    return entry === null ? [] : [entry];
  });
  const sending = open.some((item) => item.draft.sent !== null);
  return (
    <div className="flex items-center justify-between gap-2 border-t border-border pt-2">
      <p
        data-testid="question-card-tally"
        className="text-ui-xs text-muted-foreground"
      >
        {questionCardTallyLine(entries.length, open.length)}
      </p>
      <Button
        type="button"
        size="xs"
        disabled={disabled || sending || entries.length < open.length}
        data-testid="question-card-submit"
        onClick={() => onSubmit(entries)}
      >
        Submit
        {sending ? (
          <AgentSpinningDots
            className={undefined}
            testId="question-card-sending"
            variant={undefined}
          />
        ) : null}
      </Button>
    </div>
  );
}

/** Who sent the one set of answers that settled the card, and when. */
function AnsweredBy(props: {
  readonly name: string;
  readonly at: number;
}): ReactElement {
  const time = useMessageTime(props.at);
  return (
    <p
      data-testid="question-card-answered-by"
      className="text-ui-xs text-muted-foreground"
    >
      {`Answered by ${props.name} · ${time}`}
    </p>
  );
}

/** What a member whose answer was overtaken can do with it: copy it, or discuss it. */
function OvertakenActions(props: {
  readonly draft: string;
  readonly onDiscuss: ((draft: string) => void) | null;
}): ReactNode {
  const { draft, onDiscuss } = props;
  const { copied, copy } = useClipboardCopy({
    resetMs: 1500,
    onSuccess: null,
    onError: null,
  });
  return (
    <div className="flex items-center gap-1.5">
      <Button
        type="button"
        variant="outline"
        size="xs"
        data-testid="question-card-copy"
        onClick={() => copy(draft)}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
      {onDiscuss === null ? null : (
        <Button
          type="button"
          variant="outline"
          size="xs"
          data-testid="question-card-discuss"
          onClick={() => onDiscuss(draft)}
        >
          Discuss
        </Button>
      )}
    </div>
  );
}

function overtakenLine(
  settlement: QuestionCardSettlement,
  asker: string,
): string {
  if (settlement.by.kind === "asker") {
    return `Settled by ${asker} while you were answering: ${settlement.answer ?? QUESTION_SKIPPED_TEXT}`;
  }
  return settlement.skipped || settlement.answer === null
    ? `Skipped by ${settlement.by.name} while you were answering`
    : `Answered by ${settlement.by.name} while you were answering: ${settlement.answer}`;
}
