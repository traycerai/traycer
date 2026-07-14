import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import type { ChatForkMode } from "@/components/chat/chat-message";
import { AnimatePresence, useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import type {
  InterviewAnswer,
  InterviewQuestion,
} from "@traycer/protocol/persistence/epic/schemas";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { modLabel } from "@/lib/keybindings/platform";
import { InterviewForkActions } from "@/components/chat/segments/interview-fork-actions";
import { QuestionPage } from "./question-page";
import { QUESTION_TRANSITION, useInterviewCard } from "./use-interview-card";

interface PendingInterviewCardProps {
  blockId: string;
  toolName: string | null;
  title: string | null;
  description: string | null;
  questions: ReadonlyArray<InterviewQuestion>;
  // Whether this card's chat tab is the active one in its pane - gates focus
  // for multi-pane layouts (see useInterviewCard).
  isActive: boolean;
  /**
   * `null` disables the Submit/Skip affordances while the chat cannot send.
   * The card still paginates so the pending question remains readable.
   */
  onSubmit:
    | ((
        blockId: string,
        answers: ReadonlyArray<InterviewAnswer>,
      ) => string | null)
    | null;
  onSkip: ((blockId: string, reason: string) => string | null) | null;
  /**
   * Opens the fork dialog to branch the chat at this question:
   * `"cross-question"` forks on this chat's own workspace with the question
   * carried as reference (interrogate the assistant), `"ab-worktree"` forks
   * into new worktrees carrying the working tree with the question re-opened
   * (proceed with different answers in parallel). `null` hides both
   * affordances (the chat cannot act, or the owning message is not a stable
   * fork boundary). The original chat stays paused with this question still
   * pending either way.
   */
  onFork: ((mode: ChatForkMode) => void) | null;
}

export function PendingInterviewCard(props: PendingInterviewCardProps) {
  const shouldReduceMotion = useReducedMotion();
  const {
    containerRef,
    total,
    safeIndex,
    question,
    draft,
    direction,
    pendingLabel,
    dispatched,
    isLast,
    answeredCount,
    canAdvance,
    canSubmit,
    canSkip,
    goNext,
    goPrevious,
    skip,
    submit,
    toggleOption,
    toggleOther,
    setOtherText,
    setFreeText,
  } = useInterviewCard({
    blockId: props.blockId,
    questions: props.questions,
    isActive: props.isActive,
    onSubmit: props.onSubmit,
    onSkip: props.onSkip,
  });

  return (
    <section
      ref={containerRef}
      aria-label="Interview"
      data-testid="interview-card"
      tabIndex={-1}
      className="flex flex-col gap-3 rounded-md border border-border/70 bg-card/70 p-3 text-ui-sm shadow-sm outline-none"
    >
      {question === null ? (
        <InterviewQuestionHeader questionText="Input needed" />
      ) : (
        <AnimatePresence mode="wait" initial={false}>
          <m.div
            key={safeIndex}
            initial={
              shouldReduceMotion ? false : { opacity: 0, x: direction * 10 }
            }
            animate={{ opacity: 1, x: 0 }}
            exit={
              shouldReduceMotion
                ? { opacity: 0 }
                : { opacity: 0, x: direction * -10 }
            }
            transition={
              shouldReduceMotion ? { duration: 0 } : QUESTION_TRANSITION
            }
            className="flex flex-col gap-3"
          >
            <InterviewQuestionHeader questionText={question.question} />
            <QuestionPage
              question={question}
              draft={draft}
              isActive={props.isActive}
              pendingLabel={pendingLabel}
              onToggleOption={toggleOption}
              onToggleOther={toggleOther}
              onOtherTextChange={setOtherText}
              onFreeTextChange={setFreeText}
            />
          </m.div>
        </AnimatePresence>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <QuestionPager
            current={safeIndex + 1}
            total={total}
            disabled={dispatched}
            onPrevious={goPrevious}
            onNext={goNext}
          />
          <InterviewProgress answeredCount={answeredCount} total={total} />
          {props.onFork !== null ? (
            <InterviewForkActions
              onFork={props.onFork}
              disabled={dispatched}
              display="labels"
            />
          ) : null}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!canSkip}
            onClick={skip}
          >
            Skip
            <Kbd>Esc</Kbd>
          </Button>
          {isLast ? (
            <Button
              type="button"
              size="sm"
              variant="default"
              disabled={!canSubmit}
              onClick={submit}
            >
              <Check className="size-3.5" aria-hidden />
              Submit
              <KbdGroup>
                <Kbd>{modLabel()}</Kbd>
                <Kbd>↵</Kbd>
              </KbdGroup>
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="default"
              disabled={!canAdvance}
              onClick={goNext}
            >
              Next
              <KbdGroup>
                <Kbd>{modLabel()}</Kbd>
                <Kbd>↵</Kbd>
              </KbdGroup>
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

interface InterviewQuestionHeaderProps {
  readonly questionText: string;
}

function InterviewQuestionHeader(props: InterviewQuestionHeaderProps) {
  return (
    <p className="m-0 min-w-0 text-ui font-medium leading-6 text-foreground">
      {props.questionText}
    </p>
  );
}

interface InterviewProgressProps {
  readonly answeredCount: number;
  readonly total: number;
}

function InterviewProgress(props: InterviewProgressProps) {
  if (props.total === 0) return null;
  return (
    <div className="text-ui-xs text-muted-foreground">
      Answered {props.answeredCount}/{props.total}
    </div>
  );
}

interface QuestionPagerProps {
  readonly current: number;
  readonly total: number;
  readonly disabled: boolean;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
}

function QuestionPager(props: QuestionPagerProps) {
  if (props.total <= 1) return null;
  return (
    <div className="flex shrink-0 items-center gap-1 text-ui-sm text-muted-foreground">
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        disabled={props.current <= 1 || props.disabled}
        onClick={props.onPrevious}
        aria-label="Previous question"
      >
        <ChevronLeft className="size-3.5" aria-hidden />
      </Button>
      <span className="min-w-12 text-center tabular-nums">
        {props.current} of {props.total}
      </span>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        disabled={props.current >= props.total || props.disabled}
        onClick={props.onNext}
        aria-label="Next question"
      >
        <ChevronRight className="size-3.5" aria-hidden />
      </Button>
    </div>
  );
}
