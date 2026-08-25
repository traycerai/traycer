import { ChevronRight, MessageSquareText } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { deriveInterviewCollapsibleKey } from "@/components/chat/chat-collapsible-key";
import { queryMountedChatFindUnit } from "@/components/chat/chat-find-highlighter";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import type { ChatMessageForkAction } from "@/components/chat/chat-message";
import type { InterviewDeliveryRetryAction } from "@/components/chat/segments/interview-delivery-retry-action";
import { InterviewForkActions } from "@/components/chat/segments/interview-fork-actions";
import {
  type InterviewReviewFallbackAnswer,
  type InterviewReviewDelivery,
  type InterviewReviewFieldKind,
  type InterviewReviewInput,
  type InterviewReviewModel,
  type InterviewReviewPage,
  type InterviewReviewSearchField,
  deriveInterviewReviewModel,
} from "@/components/chat/segments/interview-review-model";
import {
  InterviewFraming,
  InterviewDraftStatus,
  InterviewQuestionHeader,
  InterviewQuestionPager,
  INTERVIEW_DRAFT_EVIDENCE_CLASS,
  StaticInterviewOptions,
} from "@/components/chat/segments/interview-visuals";
import { cn } from "@/lib/utils";
import {
  useChatCollapsibleTileInstanceId,
  useChatFindActiveTargetUnitId,
  useChatFindForcedOpen,
  useClearChatFindActiveTarget,
  useSetChatFindForcedOpen,
} from "@/stores/chats/chat-find-force-store-context";

interface ResolvedInterviewCardProps {
  readonly blockId: string;
  readonly reviewInput: InterviewReviewInput;
  readonly forkAction: ChatMessageForkAction | null;
  readonly interviewDeliveryRetry: InterviewDeliveryRetryAction | null;
}

/**
 * Historical interview disclosure and read-only pager. It never shares the
 * pending card's form controls: selection rows are static and only pager,
 * details, disclosure, and eligible fork actions remain interactive.
 */
export function ResolvedInterviewCard(props: ResolvedInterviewCardProps) {
  const model = deriveInterviewReviewModel(props.reviewInput);
  const tileInstanceId = useChatCollapsibleTileInstanceId();
  const collapsibleKey = deriveInterviewCollapsibleKey(
    tileInstanceId,
    props.blockId,
  );
  const findForcedOpen = useChatFindForcedOpen(collapsibleKey);
  const activeTargetUnitId = useChatFindActiveTargetUnitId(collapsibleKey);
  const clearActiveTarget = useClearChatFindActiveTarget();
  const setFindForcedOpen = useSetChatFindForcedOpen();
  const activeFindField = findSearchField(model, activeTargetUnitId);
  const cardRootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(model.outcome === "carried");
  const [manualPageIndex, setManualPageIndex] = useState(0);
  const forkAction = model.outcome === "carried" ? null : props.forkAction;

  // Find is a transient override, but only a mounted/revealable field may
  // become a real local disclosure choice before the controller releases the
  // force key. Forced content is mounted first to break the disclosure/find
  // catch-22; stale or absent targets therefore leave no local open residue.
  useLayoutEffect(() => {
    if (!findForcedOpen || activeFindField === null || open) {
      return undefined;
    }
    const frame = window.requestAnimationFrame(() => {
      const cardRoot = cardRootRef.current;
      if (
        cardRoot === null ||
        queryMountedChatFindUnit(cardRoot, activeFindField.unitId) === null
      ) {
        return;
      }
      setOpen(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeFindField, findForcedOpen, open]);

  const pageIndex = activeFindField?.target.questionIndex ?? manualPageIndex;
  const onManualPageIndexChange = (nextPageIndex: number): void => {
    setManualPageIndex(nextPageIndex);
    clearActiveTarget(collapsibleKey);
  };
  const onOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen) {
      setFindForcedOpen(collapsibleKey, false);
      clearActiveTarget(collapsibleKey);
    }
    setOpen(nextOpen);
  };
  const summaryFindUnitId = findUnitIdFor(model.searchableFields, {
    fieldKind: "summary",
    questionIndex: null,
    optionIndex: null,
    valueIndex: null,
  });

  return (
    <div ref={cardRootRef}>
      <Collapsible
        open={open || findForcedOpen}
        onOpenChange={onOpenChange}
        className="text-ui-sm text-muted-foreground"
      >
        <div className="flex max-w-full items-center gap-1">
          <CollapsibleTrigger
            data-find-include="true"
            className={cn(
              "group/interview flex min-w-0 items-center gap-2 rounded-sm py-1 pr-1 text-left transition-colors",
              "hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              model.outcome === "failed" &&
                "text-destructive/85 hover:text-destructive",
            )}
          >
            <MessageSquareText
              className="size-3.5 shrink-0 text-muted-foreground/75"
              aria-hidden
            />
            <span className="min-w-0 truncate">
              <span data-chat-find-unit={summaryFindUnitId ?? undefined}>
                {model.summary}
              </span>
              {model.framing.title === null ? null : " · "}
              {model.framing.title === null ? null : (
                <span>{model.framing.title}</span>
              )}
            </span>
            <ChevronRight
              className="size-3.5 shrink-0 text-muted-foreground/65 transition-transform group-data-[state=open]/interview:rotate-90"
              aria-hidden
            />
          </CollapsibleTrigger>
          {forkAction === null ? null : (
            <ReviewForkActions
              action={forkAction}
              blockId={props.blockId}
              display="icons"
            />
          )}
        </div>
        <CollapsibleContent>
          <ResolvedInterviewContent
            blockId={props.blockId}
            model={model}
            pageIndex={pageIndex}
            activeFindField={activeFindField}
            onPageIndexChange={onManualPageIndexChange}
            forkAction={forkAction}
            interviewDeliveryRetry={props.interviewDeliveryRetry}
          />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function ResolvedInterviewContent(props: {
  readonly blockId: string;
  readonly model: InterviewReviewModel;
  readonly pageIndex: number;
  readonly activeFindField: InterviewReviewSearchField | null;
  readonly onPageIndexChange: (index: number) => void;
  readonly forkAction: ChatMessageForkAction | null;
  readonly interviewDeliveryRetry: InterviewDeliveryRetryAction | null;
}) {
  const pageIndex = Math.min(
    Math.max(props.pageIndex, 0),
    Math.max(props.model.pages.length - 1, 0),
  );
  const page = props.model.pages.at(pageIndex) ?? null;
  const hasSupportingEvidence =
    page !== null ||
    props.model.fallbackAnswers.length > 0 ||
    props.model.reason !== null ||
    props.model.delivery !== null;

  return (
    <section
      aria-label="Interview review"
      className="mt-1 ml-5 flex min-w-0 flex-col gap-3 rounded-md border border-border/70 bg-card/70 p-3 text-ui-sm shadow-sm"
    >
      <InterviewFraming
        title={props.model.framing.title}
        description={props.model.framing.description}
        titleFindUnitId={findUnitIdFor(props.model.searchableFields, {
          fieldKind: "title",
          questionIndex: null,
          optionIndex: null,
          valueIndex: null,
        })}
        descriptionFindUnitId={findUnitIdFor(props.model.searchableFields, {
          fieldKind: "description",
          questionIndex: null,
          optionIndex: null,
          valueIndex: null,
        })}
      />
      {props.model.outcome === "carried" ? <CarriedNotice /> : null}
      {page === null ? null : (
        <ReviewPage
          model={props.model}
          page={page}
          pageIndex={pageIndex}
          activeFindField={props.activeFindField}
        />
      )}
      {props.model.fallbackAnswers.length === 0 ? null : (
        <ReviewFallbackAnswers
          answers={props.model.fallbackAnswers}
          fields={props.model.searchableFields}
        />
      )}
      {hasSupportingEvidence ? null : (
        <ReviewSummary summary={props.model.summary} />
      )}
      {props.model.reason === null ? null : (
        <ReviewReason
          reason={props.model.reason}
          failed={props.model.outcome === "failed"}
          findUnitId={findUnitIdFor(props.model.searchableFields, {
            fieldKind: "reason",
            questionIndex: null,
            optionIndex: null,
            valueIndex: null,
          })}
        />
      )}
      {props.model.delivery === null ? null : (
        <DeliveryStatus
          delivery={props.model.delivery}
          blockId={props.blockId}
          retryAction={props.interviewDeliveryRetry}
        />
      )}
      {page === null ? null : (
        <ReviewFooter
          model={props.model}
          pageIndex={pageIndex}
          onPageIndexChange={props.onPageIndexChange}
          forkAction={props.forkAction}
          blockId={props.blockId}
        />
      )}
    </section>
  );
}

function CarriedNotice() {
  return (
    <div className="text-ui-xs text-muted-foreground">
      This question was carried from the original agent and was not answered in
      this chat.
    </div>
  );
}

function ReviewSummary(props: { readonly summary: string }) {
  return (
    <div className="text-ui-xs text-muted-foreground">{props.summary}</div>
  );
}

function ReviewReason(props: {
  readonly reason: string;
  readonly failed: boolean;
  readonly findUnitId: string | null;
}) {
  return (
    <div
      data-chat-find-unit={props.findUnitId ?? undefined}
      className={cn(
        "rounded-md border border-border/50 bg-foreground/3 px-2.5 py-2 text-ui-xs",
        props.failed ? "text-destructive" : "text-muted-foreground",
      )}
    >
      <span className="font-medium">Reason: </span>
      {props.reason}
    </div>
  );
}

function ReviewFooter(props: {
  readonly model: InterviewReviewModel;
  readonly pageIndex: number;
  readonly onPageIndexChange: (index: number) => void;
  readonly forkAction: ChatMessageForkAction | null;
  readonly blockId: string;
}) {
  return (
    <footer className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border/45 pt-2">
      <InterviewQuestionPager
        current={props.pageIndex + 1}
        total={props.model.pages.length}
        disabled={false}
        onPrevious={() =>
          props.onPageIndexChange(Math.max(props.pageIndex - 1, 0))
        }
        onNext={() =>
          props.onPageIndexChange(
            props.model.pages.at(props.pageIndex + 1) === undefined
              ? props.pageIndex
              : props.pageIndex + 1,
          )
        }
      />
      <ReviewProgress model={props.model} />
      {props.forkAction === null ? null : (
        <div className="ml-auto">
          <ReviewForkActions
            action={props.forkAction}
            blockId={props.blockId}
            display="labels"
          />
        </div>
      )}
    </footer>
  );
}

function ReviewForkActions(props: {
  readonly action: ChatMessageForkAction;
  readonly blockId: string;
  readonly display: "icons" | "labels";
}) {
  return (
    <InterviewForkActions
      onFork={(mode) => props.action.onFork(mode, props.blockId)}
      disabled={!props.action.enabled || props.action.pending}
      display={props.display}
    />
  );
}

function ReviewPage(props: {
  readonly model: InterviewReviewModel;
  readonly page: InterviewReviewPage;
  readonly pageIndex: number;
  readonly activeFindField: InterviewReviewSearchField | null;
}) {
  const { page } = props;
  const showsOptions = page.question.options.length > 0;
  const presentation = page.fidelity;
  const pinnedDetailOptionIndex =
    props.activeFindField?.target.questionIndex === props.pageIndex &&
    (props.activeFindField.target.fieldKind === "option-description" ||
      props.activeFindField.target.fieldKind === "option-preview")
      ? props.activeFindField.target.optionIndex
      : null;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <InterviewQuestionHeader
        header={page.question.header}
        questionText={page.question.question}
        headerFindUnitId={findUnitIdFor(props.model.searchableFields, {
          fieldKind: "question-header",
          questionIndex: props.pageIndex,
          optionIndex: null,
          valueIndex: null,
        })}
        questionFindUnitId={findUnitIdFor(props.model.searchableFields, {
          fieldKind: "question-text",
          questionIndex: props.pageIndex,
          optionIndex: null,
          valueIndex: null,
        })}
      />
      {showsOptions ? (
        <StaticInterviewOptions
          question={page.question}
          selectedOptionIndices={page.selectedOptionIndices}
          customText={page.customText}
          optionFindUnitIds={page.question.options.map((_, optionIndex) => ({
            label: findUnitIdFor(props.model.searchableFields, {
              fieldKind: "option-label",
              questionIndex: props.pageIndex,
              optionIndex,
              valueIndex: null,
            }),
            description: findUnitIdFor(props.model.searchableFields, {
              fieldKind: "option-description",
              questionIndex: props.pageIndex,
              optionIndex,
              valueIndex: null,
            }),
            preview: findUnitIdFor(props.model.searchableFields, {
              fieldKind: "option-preview",
              questionIndex: props.pageIndex,
              optionIndex,
              valueIndex: null,
            }),
          }))}
          customFindUnitId={findUnitIdFor(props.model.searchableFields, {
            fieldKind: "custom",
            questionIndex: props.pageIndex,
            optionIndex: null,
            valueIndex: null,
          })}
          pinnedDetailOptionIndex={pinnedDetailOptionIndex}
        />
      ) : null}
      {presentation === "no-answer" ? <NoAnswer /> : null}
      {presentation === "draft" ? (
        <AnswerEvidence
          values={page.values}
          draft
          findUnitIds={page.values.map((_, valueIndex) =>
            findUnitIdFor(props.model.searchableFields, {
              fieldKind: "draft",
              questionIndex: props.pageIndex,
              optionIndex: null,
              valueIndex,
            }),
          )}
        />
      ) : null}
      {presentation === "neutral" ? (
        <AnswerEvidence
          values={page.values}
          draft={false}
          findUnitIds={page.values.map((_, valueIndex) =>
            findUnitIdFor(props.model.searchableFields, {
              fieldKind: "answer",
              questionIndex: props.pageIndex,
              optionIndex: null,
              valueIndex,
            }),
          )}
        />
      ) : null}
      {!showsOptions &&
      (presentation === "exact" || presentation === "inferred") ? (
        <AnswerEvidence
          values={page.values}
          draft={false}
          findUnitIds={page.values.map((_, valueIndex) =>
            findUnitIdFor(props.model.searchableFields, {
              fieldKind: "answer",
              questionIndex: props.pageIndex,
              optionIndex: null,
              valueIndex,
            }),
          )}
        />
      ) : null}
      {page.notes.map((note, index) => (
        <div
          key={stringOccurrenceKey(page.notes, note, index)}
          data-chat-find-unit={
            findUnitIdFor(props.model.searchableFields, {
              fieldKind: "note",
              questionIndex: props.pageIndex,
              optionIndex: null,
              valueIndex: index,
            }) ?? undefined
          }
          className="text-ui-xs italic text-muted-foreground/80"
        >
          {note}
        </div>
      ))}
    </div>
  );
}

function NoAnswer() {
  return (
    <div className="text-ui-xs italic text-muted-foreground/75">No answer</div>
  );
}

function AnswerEvidence(props: {
  readonly values: ReadonlyArray<string>;
  readonly draft: boolean;
  readonly findUnitIds: ReadonlyArray<string | null>;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-0.5 rounded-md border px-2.5 py-2 text-ui-sm",
        props.draft
          ? INTERVIEW_DRAFT_EVIDENCE_CLASS
          : "border-border/50 bg-foreground/3 text-foreground",
      )}
    >
      {props.draft ? (
        <InterviewDraftStatus />
      ) : (
        <span className="text-ui-xs font-medium text-muted-foreground">
          Submitted answer
        </span>
      )}
      <span className="min-w-0 break-words">
        {props.values.map((value, index) => (
          <span
            key={stringOccurrenceKey(props.values, value, index)}
            data-chat-find-unit={props.findUnitIds[index] ?? undefined}
          >
            {index === 0 ? "" : ", "}
            {value}
          </span>
        ))}
      </span>
    </div>
  );
}

function ReviewFallbackAnswers(props: {
  readonly answers: ReadonlyArray<InterviewReviewFallbackAnswer>;
  readonly fields: ReadonlyArray<InterviewReviewSearchField>;
}) {
  const entries = props.answers.map((answer, index) => ({ answer, index }));
  const labelled = entries.filter(({ answer }) => answer.question !== null);
  const unlabelled = entries.filter(({ answer }) => answer.question === null);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {labelled.map(({ answer, index }) => (
        <FallbackAnswer
          key={fallbackAnswerKey(props.answers, answer, index)}
          answer={answer}
          questionFindUnitId={findFallbackUnitIdFor(props.fields, {
            fieldKind: "fallback-question",
            fallbackIndex: index,
            valueIndex: null,
          })}
          valueFindUnitIds={answer.values.map((_, valueIndex) =>
            findFallbackUnitIdFor(props.fields, {
              fieldKind: "fallback-answer",
              fallbackIndex: index,
              valueIndex,
            }),
          )}
          noteFindUnitIds={answer.notes.map((_, noteIndex) =>
            findFallbackUnitIdFor(props.fields, {
              fieldKind: "note",
              fallbackIndex: index,
              valueIndex: noteIndex,
            }),
          )}
        />
      ))}
      {unlabelled.length === 0 ? null : (
        <div className="flex min-w-0 flex-col gap-1">
          <div className="text-ui-xs font-medium text-muted-foreground">
            Submitted answers
          </div>
          {unlabelled.map(({ answer, index }) => (
            <FallbackAnswer
              key={fallbackAnswerKey(props.answers, answer, index)}
              answer={answer}
              questionFindUnitId={null}
              valueFindUnitIds={answer.values.map((_, valueIndex) =>
                findFallbackUnitIdFor(props.fields, {
                  fieldKind: "fallback-answer",
                  fallbackIndex: index,
                  valueIndex,
                }),
              )}
              noteFindUnitIds={answer.notes.map((_, noteIndex) =>
                findFallbackUnitIdFor(props.fields, {
                  fieldKind: "note",
                  fallbackIndex: index,
                  valueIndex: noteIndex,
                }),
              )}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FallbackAnswer(props: {
  readonly answer: InterviewReviewFallbackAnswer;
  readonly questionFindUnitId: string | null;
  readonly valueFindUnitIds: ReadonlyArray<string | null>;
  readonly noteFindUnitIds: ReadonlyArray<string | null>;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-0.5 rounded-md border border-border/50 bg-foreground/3 px-2.5 py-2",
        props.answer.draft && INTERVIEW_DRAFT_EVIDENCE_CLASS,
      )}
    >
      {props.answer.question === null ? null : (
        <div
          data-chat-find-unit={props.questionFindUnitId ?? undefined}
          className="text-ui-xs font-medium text-muted-foreground"
        >
          {props.answer.question}
        </div>
      )}
      {props.answer.draft ? <InterviewDraftStatus /> : null}
      <div className="min-w-0 break-words text-ui-sm text-foreground">
        {props.answer.values.map((value, index) => (
          <span
            key={stringOccurrenceKey(props.answer.values, value, index)}
            data-chat-find-unit={props.valueFindUnitIds[index] ?? undefined}
          >
            {index === 0 ? "" : ", "}
            {value}
          </span>
        ))}
      </div>
      {props.answer.notes.map((note, index) => (
        <div
          key={stringOccurrenceKey(props.answer.notes, note, index)}
          data-chat-find-unit={props.noteFindUnitIds[index] ?? undefined}
          className="text-ui-xs italic text-muted-foreground/80"
        >
          {note}
        </div>
      ))}
    </div>
  );
}

function DeliveryStatus(props: {
  readonly delivery: InterviewReviewDelivery;
  readonly blockId: string;
  readonly retryAction: InterviewDeliveryRetryAction | null;
}) {
  const retryInput =
    props.delivery.state === "failed" &&
    props.delivery.retryable &&
    props.delivery.settlementId !== null &&
    props.retryAction !== null
      ? {
          blockId: props.blockId,
          settlementId: props.delivery.settlementId,
          deliveryId: props.delivery.deliveryId,
          generation: props.delivery.generation,
        }
      : null;
  const retryPending =
    retryInput === null
      ? false
      : props.retryAction?.isPending(retryInput) === true;
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-2 text-ui-xs",
        props.delivery.state === "failed"
          ? "border-destructive/35 bg-foreground/3 text-destructive"
          : "border-border/50 bg-foreground/3 text-muted-foreground",
      )}
    >
      <span>Delivery {props.delivery.state}</span>
      {retryInput === null ? null : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={retryPending}
          onClick={() => props.retryAction?.onRetry(retryInput)}
        >
          Retry
          {retryPending ? (
            <AgentSpinningDots
              className="ml-1"
              testId={undefined}
              variant={undefined}
            />
          ) : null}
        </Button>
      )}
    </div>
  );
}

function ReviewProgress(props: { readonly model: InterviewReviewModel }) {
  if (props.model.pages.length === 0) return null;
  return (
    <div className="text-ui-xs text-muted-foreground">
      {props.model.progress}
    </div>
  );
}

function findSearchField(
  model: InterviewReviewModel,
  unitId: string | null,
): InterviewReviewSearchField | null {
  if (unitId === null) return null;
  return (
    model.searchableFields.find((field) => field.unitId === unitId) ?? null
  );
}

function findUnitIdFor(
  fields: ReadonlyArray<InterviewReviewSearchField>,
  target: {
    readonly fieldKind: InterviewReviewFieldKind;
    readonly questionIndex: number | null;
    readonly optionIndex: number | null;
    readonly valueIndex: number | null;
  },
): string | null {
  return (
    fields.find(
      (field) =>
        field.target.fieldKind === target.fieldKind &&
        field.target.questionIndex === target.questionIndex &&
        field.target.optionIndex === target.optionIndex &&
        field.target.fallbackIndex === null &&
        field.target.valueIndex === target.valueIndex,
    )?.unitId ?? null
  );
}

function findFallbackUnitIdFor(
  fields: ReadonlyArray<InterviewReviewSearchField>,
  target: {
    readonly fieldKind: InterviewReviewFieldKind;
    readonly fallbackIndex: number;
    readonly valueIndex: number | null;
  },
): string | null {
  return (
    fields.find(
      (field) =>
        field.target.fieldKind === target.fieldKind &&
        field.target.questionIndex === null &&
        field.target.optionIndex === null &&
        field.target.fallbackIndex === target.fallbackIndex &&
        field.target.valueIndex === target.valueIndex,
    )?.unitId ?? null
  );
}

function stringOccurrenceKey(
  values: ReadonlyArray<string>,
  value: string,
  index: number,
): string {
  const occurrence = values
    .slice(0, index)
    .filter((candidate) => candidate === value).length;
  return `${value}\u0000${occurrence}`;
}

function fallbackAnswerKey(
  answers: ReadonlyArray<InterviewReviewFallbackAnswer>,
  answer: InterviewReviewFallbackAnswer,
  index: number,
): string {
  const fingerprint = [
    answer.question ?? "",
    answer.values.join("\u0000"),
    answer.notes.join("\u0000"),
    String(answer.draft),
  ].join("\u0001");
  const occurrence = answers.slice(0, index).filter((candidate) => {
    const candidateFingerprint = [
      candidate.question ?? "",
      candidate.values.join("\u0000"),
      candidate.notes.join("\u0000"),
      String(candidate.draft),
    ].join("\u0001");
    return candidateFingerprint === fingerprint;
  }).length;
  return `${fingerprint}\u0000${occurrence}`;
}
