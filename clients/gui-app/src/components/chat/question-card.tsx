import { useId, type ReactElement, type ReactNode } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import {
  QUESTION_SKIPPED_TEXT,
  draftText,
  questionCardView,
  questionSettledLine,
  type QuestionCardDraft,
  type QuestionCardSettlement,
} from "@/components/chat/question-card-view";

/** One question of the card, how it was settled, and the person's own answer to it. */
export interface QuestionCardQuestion {
  /** Its place among the asker's questions, which is how an answer names it. */
  readonly index: number;
  readonly text: string;
  readonly options: ReadonlyArray<string>;
  readonly allowFreeText: boolean;
  /** `null` while the question is open. */
  readonly settlement: QuestionCardSettlement | null;
  readonly draft: QuestionCardDraft;
}

/** What a person submits for one question: an answer, or a Skip. */
export interface QuestionCardAnswer {
  readonly questionIndex: number;
  /** The chosen option or the typed answer; the Skip's line for a Skip. */
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
 */
export function QuestionCard(props: {
  /** Who asks, by the name the card shows. */
  readonly asker: string;
  readonly questions: ReadonlyArray<QuestionCardQuestion>;
  readonly onDraft:
    | ((questionIndex: number, draft: QuestionCardDraft) => void)
    | null;
  readonly onAnswer: (answer: QuestionCardAnswer) => void;
  /** Opens the question's discussion with `draft` in its box, unsent; `null` where there is none. */
  readonly onDiscuss: ((questionIndex: number, draft: string) => void) | null;
}): ReactElement {
  const { asker, questions, onDraft, onAnswer, onDiscuss } = props;
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
    </div>
  );
}

function QuestionCardItem(props: {
  readonly asker: string;
  readonly question: QuestionCardQuestion;
  readonly onDraft: ((draft: QuestionCardDraft) => void) | null;
  readonly onAnswer: (answer: QuestionCardAnswer) => void;
  readonly onDiscuss: ((draft: string) => void) | null;
}): ReactElement {
  const { asker, question, onDraft, onAnswer, onDiscuss } = props;
  const { draft } = question;
  const view = questionCardView(question.settlement, draft);
  const submit = (text: string, skipped: boolean): void => {
    if (onDraft === null) return;
    onDraft({ ...draft, sent: { text, skipped } });
    onAnswer({ questionIndex: question.index, text, skipped });
  };

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
      {view.kind === "settled" ? (
        <p
          data-testid="question-card-settlement"
          className="text-ui-xs break-words whitespace-pre-wrap text-muted-foreground"
        >
          {questionSettledLine(view.settlement, asker)}
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
            // A sent answer waits as it was sent; an overtaken one stays the
            // person's to change before they copy it or discuss it.
            editable={view.kind !== "sent" && onDraft !== null}
            onChange={(next) => onDraft?.({ ...draft, ...next })}
          />
          {view.kind === "overtaken" ? (
            <OvertakenActions draft={view.draft} onDiscuss={onDiscuss} />
          ) : (
            <OpenActions
              draft={draftText(draft)}
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

/** The person's answer as they are making it: the option they picked, and what they typed. */
function QuestionDraft(props: {
  readonly question: QuestionCardQuestion;
  readonly editable: boolean;
  readonly onChange: (
    next: Pick<QuestionCardDraft, "chosen"> | Pick<QuestionCardDraft, "typed">,
  ) => void;
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
              aria-pressed={chosen === option}
              disabled={!editable}
              data-testid="question-card-option"
              onClick={() =>
                onChange({ chosen: chosen === option ? null : option })
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
            onChange={(event) => onChange({ typed: event.target.value })}
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
