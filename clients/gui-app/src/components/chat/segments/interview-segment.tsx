import type {
  InterviewAnswer,
  InterviewQuestion,
} from "@traycer/protocol/persistence/epic/schemas";
import { ChevronRight, MessageSquareText } from "lucide-react";
import { useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useChatMeasuredOpenChange } from "@/components/chat/chat-measured-item-change-context";
import { answeredQuestionsSummaryFromCounts } from "@/components/chat/chat-activity-groups";
import { cn } from "@/lib/utils";

interface InterviewSegmentProps {
  findUnitId: string | null;
  status: "streaming" | "completed" | "errored";
  toolName: string | null;
  title: string | null;
  description: string | null;
  questions: ReadonlyArray<InterviewQuestion>;
  answers: ReadonlyArray<InterviewAnswer>;
  error: string | null;
}

/**
 * Pending interviews (`status === "streaming"`) are rendered in the
 * composer slot, see `chat-tile.tsx`. Suppress the inline card here so
 * the question doesn't appear twice.
 */
export function InterviewSegment(props: InterviewSegmentProps) {
  const { findUnitId, status, questions, answers, error } = props;
  const [open, setOpen] = useState(false);
  const measuredOpenChange = useChatMeasuredOpenChange(setOpen);

  if (status === "streaming") return null;

  const summary =
    status === "completed"
      ? answeredQuestionsSummaryFromCounts(questions, answers)
      : "Question failed";

  return (
    <Collapsible
      open={open}
      onOpenChange={measuredOpenChange}
      className="text-ui-sm text-muted-foreground"
    >
      <CollapsibleTrigger
        data-find-include="true"
        data-chat-find-unit={findUnitId ?? undefined}
        className={cn(
          "group/interview flex max-w-full items-center gap-2 rounded-sm py-1 pr-1 text-left transition-colors",
          "hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          status === "errored" && "text-destructive/85 hover:text-destructive",
        )}
      >
        <MessageSquareText
          className="size-3.5 shrink-0 text-muted-foreground/75"
          aria-hidden
        />
        <span className="min-w-0 truncate">{summary}</span>
        <ChevronRight
          className="size-3.5 shrink-0 text-muted-foreground/65 transition-transform group-data-[state=open]/interview:rotate-90"
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-0.5 ml-5 border-l border-border/35 pl-3">
          <ResolvedInterviewView
            questions={questions}
            answers={answers}
            error={error}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

interface ResolvedInterviewViewProps {
  questions: ReadonlyArray<InterviewQuestion>;
  answers: ReadonlyArray<InterviewAnswer>;
  error: string | null;
}

/**
 * Answers from `AskUserQuestion` arrive with `questionId === null`
 * (keyed by question text), so match on `questionId` first and fall
 * back to question text.
 */
function ResolvedInterviewView(props: ResolvedInterviewViewProps) {
  const { questions, answers, error } = props;
  const byId = new Map<string, InterviewAnswer>();
  const byQuestion = new Map<string, InterviewAnswer>();
  for (const answer of answers) {
    if (answer.questionId !== null) byId.set(answer.questionId, answer);
    if (answer.question !== null) byQuestion.set(answer.question, answer);
  }
  const pairs =
    questions.length > 0
      ? questions.map((question) => ({
          key: question.questionId ?? question.question,
          question: question.question,
          answer:
            (question.questionId !== null
              ? byId.get(question.questionId)
              : undefined) ?? byQuestion.get(question.question),
        }))
      : answers.map((answer, index) => ({
          key: answer.questionId ?? answer.question ?? `answer-${index}`,
          question: answer.question ?? "",
          answer,
        }));
  return (
    <div className="flex flex-col gap-2 py-1 text-ui-sm">
      <div className="flex flex-col gap-2">
        {pairs.map((pair) => (
          <div key={pair.key} className="flex flex-col gap-0.5">
            {pair.question.length > 0 ? (
              <div className="text-muted-foreground">{pair.question}</div>
            ) : null}
            <AnswerLine answer={pair.answer} />
            {pair.answer?.notes !== undefined &&
            pair.answer.notes !== null &&
            pair.answer.notes.length > 0 ? (
              <div className="italic text-muted-foreground/80">
                {pair.answer.notes}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {error !== null && error.length > 0 ? (
        <div className="mt-1 text-ui-xs text-destructive">{error}</div>
      ) : null}
    </div>
  );
}

function AnswerLine({ answer }: { answer: InterviewAnswer | undefined }) {
  const values = answer?.values ?? [];
  if (values.length === 0) {
    return <div className="italic text-muted-foreground/70">No answer</div>;
  }
  return <div className="text-foreground">{values.join(", ")}</div>;
}
