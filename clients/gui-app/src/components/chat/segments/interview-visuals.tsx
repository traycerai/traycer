import {
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Pencil,
} from "lucide-react";
import { useId, type ReactNode } from "react";
import type {
  InterviewQuestion,
  InterviewQuestionOption,
} from "@traycer/protocol/persistence/epic/schemas";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";

interface DetailItem {
  readonly label: string;
  readonly value: string;
}

/** Shared history-only treatment for saved answers that were never delivered. */
export const INTERVIEW_DRAFT_EVIDENCE_CLASS =
  "border-warning/30 bg-warning/10 text-warning-foreground";

export function InterviewDraftStatus() {
  return (
    <span className="text-ui-xs font-medium text-warning-foreground">
      Draft — not sent to agent
    </span>
  );
}

function meaningfulText(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function optionDetails(
  option: InterviewQuestionOption,
): ReadonlyArray<DetailItem> {
  const description = meaningfulText(option.description);
  const preview = meaningfulText(option.preview);
  return [
    ...(description === null ? [] : [{ label: "Details", value: description }]),
    ...(preview === null ? [] : [{ label: "Preview", value: preview }]),
  ];
}

export function InterviewFraming(props: {
  readonly title: string | null;
  readonly description: string | null;
  readonly titleFindUnitId: string | null;
  readonly descriptionFindUnitId: string | null;
}) {
  if (props.title === null && props.description === null) return null;
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      {props.title === null ? null : (
        <div
          data-chat-find-unit={props.titleFindUnitId ?? undefined}
          className="min-w-0 text-ui font-medium text-foreground"
        >
          {props.title}
        </div>
      )}
      {props.description === null ? null : (
        <p
          data-chat-find-unit={props.descriptionFindUnitId ?? undefined}
          className="m-0 min-w-0 text-ui-sm text-muted-foreground"
        >
          {props.description}
        </p>
      )}
    </div>
  );
}

export function InterviewQuestionHeader(props: {
  readonly header: string | null;
  readonly questionText: string;
  readonly headerFindUnitId: string | null;
  readonly questionFindUnitId: string | null;
}) {
  const header = meaningfulText(props.header);
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      {header === null ? null : (
        <div
          data-chat-find-unit={props.headerFindUnitId ?? undefined}
          className="text-ui-xs font-medium text-muted-foreground"
        >
          {header}
        </div>
      )}
      <p
        data-chat-find-unit={props.questionFindUnitId ?? undefined}
        className="m-0 min-w-0 text-ui font-medium leading-6 text-foreground"
      >
        {props.questionText}
      </p>
    </div>
  );
}

export function InterviewQuestionPager(props: {
  readonly current: number;
  readonly total: number;
  readonly disabled: boolean;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
}) {
  if (props.total <= 1) return null;
  return (
    <div className="flex shrink-0 items-center gap-1 text-ui-sm text-muted-foreground">
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        disabled={props.disabled || props.current <= 1}
        onClick={props.onPrevious}
        aria-label="Previous question"
      >
        <ChevronLeft className="size-3.5" aria-hidden />
      </Button>
      <span className="min-w-12 text-center tabular-nums" aria-live="polite">
        {props.current} of {props.total}
      </span>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        disabled={props.disabled || props.current >= props.total}
        onClick={props.onNext}
        aria-label="Next question"
      >
        <ChevronRight className="size-3.5" aria-hidden />
      </Button>
    </div>
  );
}

export function InterviewOptionDetailsButton(props: {
  readonly label: string;
  readonly option: InterviewQuestionOption;
  readonly className: string | null;
  /** Inline search-pinned detail owns the accessible description. */
  readonly pinnedDetailRegionId: string | null;
}) {
  const details = optionDetails(props.option);
  if (details.length === 0) return null;
  const button = (
    <button
      type="button"
      aria-label={`${props.label} details`}
      aria-describedby={props.pinnedDetailRegionId ?? undefined}
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-foreground/8 hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40",
        props.className,
      )}
    >
      <CircleHelp className="size-3.5" aria-hidden />
    </button>
  );
  if (props.pinnedDetailRegionId !== null) return button;
  return (
    <TooltipWrapper
      label={<OptionDetailsTooltip details={details} />}
      side="top"
      sideOffset={6}
      align="center"
    >
      {button}
    </TooltipWrapper>
  );
}

function OptionDetailsTooltip(props: {
  readonly details: ReadonlyArray<DetailItem>;
}) {
  return (
    <div className="flex max-w-[min(80vw,20rem)] flex-col gap-2 text-ui-xs">
      {props.details.map((detail) => (
        <div key={detail.label} className="flex flex-col gap-0.5">
          <span className="font-medium text-background/70">{detail.label}</span>
          <span className="text-background">{detail.value}</span>
        </div>
      ))}
    </div>
  );
}

function InlineOptionDetails(props: {
  readonly details: ReadonlyArray<DetailItem>;
  readonly descriptionFindUnitId: string | null;
  readonly previewFindUnitId: string | null;
  readonly regionId: string;
}) {
  return (
    <div
      id={props.regionId}
      role="note"
      aria-label="Option details"
      className="flex min-w-0 flex-col gap-1 rounded-sm border border-border/45 bg-foreground/3 px-2 py-1.5 text-ui-xs text-muted-foreground"
    >
      {props.details.map((detail) => (
        <div key={detail.label} className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium text-foreground/75">{detail.label}</span>
          <span
            data-chat-find-unit={
              detail.label === "Details"
                ? (props.descriptionFindUnitId ?? undefined)
                : (props.previewFindUnitId ?? undefined)
            }
            className="min-w-0 break-words text-foreground"
          >
            {detail.value}
          </span>
        </div>
      ))}
    </div>
  );
}

function OptionBadge(props: {
  readonly index: number;
  readonly selected: boolean;
  readonly custom: boolean;
}) {
  let content: ReactNode = props.index;
  if (props.selected) {
    content = <Check className="size-3" aria-hidden />;
  } else if (props.custom) {
    content = <Pencil className="size-3" aria-hidden />;
  }
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-full border text-[0.625rem] font-semibold tabular-nums",
        props.selected
          ? "border-primary/70 bg-primary/90 text-primary-foreground"
          : "border-border/70 bg-background/60 text-muted-foreground/70",
      )}
    >
      {content}
    </span>
  );
}

function StaticOptionRow(props: {
  readonly label: string;
  readonly option: InterviewQuestionOption | null;
  readonly index: number;
  readonly selected: boolean;
  readonly custom: boolean;
  readonly labelFindUnitId: string | null;
  readonly pinnedDetailRegionId: string | null;
  readonly children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex w-full items-center gap-2 rounded-md border border-transparent bg-foreground/3 px-2 py-1.5",
        props.selected
          ? "border-border bg-foreground/6 text-foreground shadow-sm"
          : "text-muted-foreground",
      )}
    >
      {/* Historical option labels intentionally wrap while live rows truncate for review readability. */}
      <span
        data-chat-find-unit={props.labelFindUnitId ?? undefined}
        className="min-w-0 flex-1 break-words font-medium text-foreground/90"
      >
        {props.label}
      </span>
      {props.option === null ? null : (
        <InterviewOptionDetailsButton
          label={props.label}
          option={props.option}
          className={null}
          pinnedDetailRegionId={props.pinnedDetailRegionId}
        />
      )}
      {props.children}
      <OptionBadge
        index={props.index}
        selected={props.selected}
        custom={props.custom}
      />
    </div>
  );
}

/**
 * Read-only option rows deliberately use list/static semantics. The only
 * buttons inside are the keyboard-reachable detail affordances; historical
 * rows never expose checked, pressed, or disabled form controls.
 */
export function StaticInterviewOptions(props: {
  readonly question: InterviewQuestion;
  readonly selectedOptionIndices: ReadonlyArray<number>;
  readonly customText: string | null;
  readonly optionFindUnitIds: ReadonlyArray<InterviewOptionFindUnitIds>;
  readonly customFindUnitId: string | null;
  readonly pinnedDetailOptionIndex: number | null;
}) {
  const selected = new Set(props.selectedOptionIndices);
  const detailRegionIdPrefix = useId();
  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 pl-0">
      {props.question.options.map((option, index) => {
        const isSelected = selected.has(index);
        const findUnitIds = props.optionFindUnitIds[index];
        const details = optionDetails(option);
        const detailPinned = props.pinnedDetailOptionIndex === index;
        const detailRegionId =
          detailPinned && details.length > 0
            ? optionDetailRegionId(detailRegionIdPrefix, findUnitIds)
            : null;
        return (
          <li key={optionKey(props.question.options, option, index)}>
            <StaticOptionRow
              label={option.label}
              option={option}
              index={index + 1}
              selected={isSelected}
              custom={false}
              labelFindUnitId={findUnitIds.label}
              pinnedDetailRegionId={detailRegionId}
            >
              {isSelected ? (
                <span className="sr-only">Selected answer</span>
              ) : null}
            </StaticOptionRow>
            {detailRegionId === null ? null : (
              <InlineOptionDetails
                details={details}
                descriptionFindUnitId={findUnitIds.description}
                previewFindUnitId={findUnitIds.preview}
                regionId={detailRegionId}
              />
            )}
          </li>
        );
      })}
      <li>
        <StaticOptionRow
          label={props.customText === null ? "Other" : props.customText}
          option={null}
          index={props.question.options.length + 1}
          selected={props.customText !== null}
          custom
          labelFindUnitId={props.customFindUnitId}
          pinnedDetailRegionId={null}
        >
          {props.customText === null ? null : (
            <span className="sr-only">Selected custom answer</span>
          )}
        </StaticOptionRow>
      </li>
    </ul>
  );
}

export interface InterviewOptionFindUnitIds {
  readonly label: string | null;
  readonly description: string | null;
  readonly preview: string | null;
}

function optionDetailRegionId(
  prefix: string,
  props: InterviewOptionFindUnitIds,
): string {
  const unitId = props.description ?? props.preview;
  if (unitId === null) {
    throw new Error("pinned interview option detail is missing a find unit id");
  }
  return `${prefix}-interview-option-detail-${unitId}`;
}

function optionKey(
  options: ReadonlyArray<InterviewQuestionOption>,
  option: InterviewQuestionOption,
  index: number,
): string {
  const fingerprint = `${option.label}\u0000${option.description ?? ""}\u0000${option.preview ?? ""}`;
  const duplicateOrdinal = options
    .slice(0, index)
    .filter(
      (previous) =>
        `${previous.label}\u0000${previous.description ?? ""}\u0000${previous.preview ?? ""}` ===
        fingerprint,
    ).length;
  return `${fingerprint}\u0000${duplicateOrdinal}`;
}
