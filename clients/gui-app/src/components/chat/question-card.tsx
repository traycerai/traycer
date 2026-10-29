import { useId, useState, type ReactElement, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";

/** One question of the card, and how it was settled; `null` while open. */
export interface QuestionCardQuestion {
  /** Its place among the asker's questions, which is how an answer names it. */
  readonly index: number;
  readonly text: string;
  readonly options: ReadonlyArray<string>;
  readonly allowFreeText: boolean;
  readonly settlement: QuestionCardSettlement | null;
}

/**
 * How a question was settled: a person's answer or Skip, by the name the
 * card shows for them, or the asker's own answer when nobody gave one.
 */
export interface QuestionCardSettlement {
  /** The answer; `null` for a Skip. */
  readonly answer: string | null;
  readonly skipped: boolean;
  readonly by:
    | { readonly kind: "person"; readonly name: string }
    | { readonly kind: "asker" };
}

/** What a person submits for one question: an answer, or a Skip. */
export interface QuestionCardAnswer {
  readonly questionIndex: number;
  /** The chosen option or the typed answer; the Skip's line for a Skip. */
  readonly text: string;
  readonly skipped: boolean;
}

/** The line a Skip sends as the person's message. */
export const QUESTION_SKIPPED_TEXT = "Skipped";

/**
 * The card under a question asked without waiting for its answer (Tracy
 * Bots, decision 121): each question with its options as buttons, a field
 * for an answer in the person's own words where the asker takes one, Submit
 * and Skip; a settled question says what it was settled with and by whom,
 * and offers nothing. Every member sees the same card, and the first answer
 * to land settles a question for all of them (decision 122): a member who
 * had picked or typed an answer of their own keeps it in place, is told who
 * answered while they were answering, loses Submit, and can copy what they
 * had or take it to the question's discussion.
 *
 * Who asks, where an answer goes and where the discussion is are the
 * caller's: `onAnswer` resolves once the answer is taken and rejects when it
 * is not, keeping the person's draft; `null` draws the card without actions.
 */
export function QuestionCard(props: {
  /** Who asks, by the name the card shows. */
  readonly asker: string;
  readonly questions: ReadonlyArray<QuestionCardQuestion>;
  readonly onAnswer: ((answer: QuestionCardAnswer) => Promise<void>) | null;
  /** Opens the question's discussion with `draft` in its box, unsent; `null` where there is none. */
  readonly onDiscuss: ((draft: string) => void) | null;
}): ReactElement {
  const { asker, questions, onAnswer, onDiscuss } = props;
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
          onAnswer={onAnswer}
          onDiscuss={onDiscuss}
        />
      ))}
    </div>
  );
}

/**
 * What one question shows: open; settled; or settled by someone else while
 * this person had an answer of their own, which they keep.
 */
type QuestionView =
  | { readonly kind: "open" }
  | { readonly kind: "settled"; readonly settlement: QuestionCardSettlement }
  | {
      readonly kind: "overtaken";
      readonly settlement: QuestionCardSettlement;
      readonly draft: string;
    };

function questionView(
  settlement: QuestionCardSettlement | null,
  draft: string | null,
  sending: boolean,
): QuestionView {
  if (settlement === null) return { kind: "open" };
  // The person's own answer, still on its way, is what settled it.
  if (draft === null || sending) return { kind: "settled", settlement };
  return { kind: "overtaken", settlement, draft };
}

function QuestionCardItem(props: {
  readonly asker: string;
  readonly question: QuestionCardQuestion;
  readonly onAnswer: ((answer: QuestionCardAnswer) => Promise<void>) | null;
  readonly onDiscuss: ((draft: string) => void) | null;
}): ReactElement {
  const { asker, question, onAnswer, onDiscuss } = props;
  const [chosen, setChosen] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [sending, setSending] = useState(false);
  // The person's own answer: what they typed, else the option they picked.
  const trimmed = typed.trim();
  const draft = trimmed.length > 0 ? trimmed : chosen;
  const view = questionView(question.settlement, draft, sending);

  const submit = (text: string, skipped: boolean): void => {
    if (onAnswer === null) return;
    setSending(true);
    onAnswer({ questionIndex: question.index, text, skipped }).then(
      () => {
        setSending(false);
        setChosen(null);
        setTyped("");
      },
      // Refused or failed: the draft stays, as the person left it.
      () => setSending(false),
    );
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
          {settledLine(view.settlement, asker)}
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
            chosen={chosen}
            typed={typed}
            // An overtaken draft stays the person's to change before they
            // copy it or take it to the discussion.
            editable={
              !sending && (view.kind === "overtaken" || onAnswer !== null)
            }
            onChoose={(option) =>
              setChosen((current) => (current === option ? null : option))
            }
            onType={setTyped}
          />
          {view.kind === "overtaken" ? (
            <OvertakenActions draft={view.draft} onDiscuss={onDiscuss} />
          ) : (
            <OpenActions
              draft={draft}
              disabled={onAnswer === null || sending}
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
  readonly chosen: string | null;
  readonly typed: string;
  readonly editable: boolean;
  readonly onChoose: (option: string) => void;
  readonly onType: (text: string) => void;
}): ReactNode {
  const { question, chosen, typed, editable, onChoose, onType } = props;
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
              onClick={() => onChoose(option)}
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
            onChange={(event) => onType(event.target.value)}
          />
        </>
      ) : null}
    </>
  );
}

/** Submit for the person's answer, and Skip. */
function OpenActions(props: {
  /** The answer Submit sends; `null` while there is none. */
  readonly draft: string | null;
  readonly disabled: boolean;
  readonly onSubmit: (text: string) => void;
  readonly onSkip: () => void;
}): ReactElement {
  const { draft, disabled, onSubmit, onSkip } = props;
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

function settledLine(
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
