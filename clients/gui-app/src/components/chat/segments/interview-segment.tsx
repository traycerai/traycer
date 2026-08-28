import type {
  InterviewAnswer,
  InterviewDeliveryProjection,
  InterviewOutcome,
  InterviewQuestion,
  InterviewSettlementAuthority,
} from "@traycer/protocol/persistence/epic/schemas";
import type { ChatMessageForkAction } from "@/components/chat/chat-message";
import type { InterviewDeliveryRetryAction } from "@/components/chat/segments/interview-delivery-retry-action";
import { ResolvedInterviewCard } from "@/components/chat/segments/resolved-interview-card";

interface InterviewSegmentProps {
  readonly blockId: string;
  readonly status: "streaming" | "completed" | "errored";
  readonly toolName: string | null;
  readonly title: string | null;
  readonly description: string | null;
  readonly questions: ReadonlyArray<InterviewQuestion>;
  readonly answers: ReadonlyArray<InterviewAnswer>;
  readonly draftAnswers: ReadonlyArray<InterviewAnswer>;
  readonly outcome: InterviewOutcome | null;
  readonly settlement: InterviewSettlementAuthority | null;
  readonly error: string | null;
  readonly delivery: InterviewDeliveryProjection | null;
  // The question was carried into a Cross Question fork without being
  // answered. It renders as an open, inert reference with no fork actions.
  readonly forkedWithoutAnswer: boolean;
  readonly forkAction: ChatMessageForkAction | null;
  readonly interviewDeliveryRetry: InterviewDeliveryRetryAction | null;
}

/**
 * Pending interviews render in the composer slot. Terminal interviews stay in
 * their original assistant turn and delegate all history-only behavior to the
 * resolved card.
 */
export function InterviewSegment(props: InterviewSegmentProps) {
  if (props.status === "streaming") return null;
  return (
    <ResolvedInterviewCard
      blockId={props.blockId}
      reviewInput={{
        blockId: props.blockId,
        status: props.status,
        toolName: props.toolName,
        title: props.title,
        description: props.description,
        questions: props.questions,
        answers: props.answers,
        draftAnswers: props.draftAnswers,
        outcome: props.outcome,
        settlement: props.settlement,
        error: props.error,
        delivery: props.delivery,
        forkedWithoutAnswer: props.forkedWithoutAnswer,
      }}
      forkAction={props.forkAction}
      interviewDeliveryRetry={props.interviewDeliveryRetry}
    />
  );
}
