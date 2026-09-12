import {
  Check,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleHelp,
  Pencil,
} from "lucide-react";
import { useId, type ReactNode } from "react";
import type {
  InterviewQuestion,
  InterviewQuestionOption,
} from "@traycer/protocol/persistence/epic/schemas";
import { questionAllowsCustomAnswer } from "@/components/chat/segments/interview-custom-answer";
import {
  useInterviewOptionDetailsDisclosure,
  type InterviewOptionDetailsDisclosure,
} from "@/components/chat/segments/use-interview-option-details-disclosure";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";

interface DetailItem {
  readonly kind: "description" | "preview";
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

/**
 * Decorative selection glyph. Listed rows stay buttons (`aria-pressed`)
 * because a single-choice pick continues — that is not radio semantics.
 */
export function InterviewChoiceGlyph(props: {
  readonly multiSelect: boolean;
  readonly selected: boolean;
}) {
  const kind = props.multiSelect ? "checkbox" : "radio";
  let fill = "border-input bg-background/60";
  let indicator: ReactNode = null;
  if (props.selected && props.multiSelect) {
    fill = "border-primary bg-primary text-primary-foreground";
    indicator = <Check className="size-3.5" aria-hidden />;
  } else if (props.selected) {
    fill = "border-primary bg-background/60";
    indicator = (
      <Circle className="size-2 fill-primary text-primary" aria-hidden />
    );
  }
  return (
    <span
      aria-hidden
      data-interview-choice-glyph={kind}
      data-selected={props.selected ? "true" : "false"}
      className={cn(
        "pointer-events-none relative z-10 inline-flex size-4 shrink-0 items-center justify-center border shadow-xs",
        props.multiSelect ? "rounded-sm" : "rounded-full",
        fill,
      )}
    >
      {indicator}
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
    ...(description === null
      ? []
      : [
          {
            kind: "description" as const,
            label: "Details",
            value: description,
          },
        ]),
    ...(preview === null
      ? []
      : [{ kind: "preview" as const, label: "Preview", value: preview }]),
  ];
}

export function InterviewQuestionHeader(props: {
  readonly header: string | null;
  readonly questionText: string;
  readonly headerFindUnitId: string | null;
  readonly questionFindUnitId: string | null;
  readonly modeHint: string | null;
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
      {props.modeHint === null ? null : (
        <p
          data-testid="interview-choice-mode-hint"
          className="m-0 text-ui-xs text-muted-foreground"
        >
          {props.modeHint}
        </p>
      )}
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

// Hit-slop only - the `?` stays visually 20px while its tap target grows to
// 32px. Deliberately short of the 44px guideline: the row's own select target
// is underneath and the next option is 6px away, so a 44px box would steal
// taps from the two things a finger is far more likely to be aiming at.
const DETAILS_BUTTON_CLASS =
  "relative inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors after:absolute after:-inset-1.5 after:content-[''] hover:bg-foreground/8 hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40";

export function InterviewOptionDetailsButton(props: {
  readonly label: string;
  readonly option: InterviewQuestionOption;
  readonly className: string | null;
  /** Inline search-pinned detail owns the accessible description. */
  readonly pinnedDetailRegionId: string | null;
  readonly disclosure: InterviewOptionDetailsDisclosure;
}) {
  const details = optionDetails(props.option);
  if (details.length === 0) return null;
  // Search pinned the detail open above us: it is already on screen and owns
  // the accessible description, so there is nothing here to disclose.
  if (props.pinnedDetailRegionId !== null) {
    return (
      <button
        type="button"
        aria-label={`${props.label} details`}
        aria-describedby={props.pinnedDetailRegionId}
        className={cn(DETAILS_BUTTON_CLASS, props.className)}
      >
        <CircleHelp className="size-3.5" aria-hidden />
      </button>
    );
  }
  return (
    <TooltipWrapper
      label={<OptionDetailsTooltip details={details} />}
      side="top"
      sideOffset={6}
      align="center"
    >
      <button
        type="button"
        aria-label={`${props.label} details`}
        aria-expanded={props.disclosure.expanded}
        aria-controls={
          props.disclosure.expanded ? props.disclosure.regionId : undefined
        }
        onClick={props.disclosure.toggle}
        className={cn(DETAILS_BUTTON_CLASS, props.className)}
      >
        <CircleHelp className="size-3.5" aria-hidden />
      </button>
    </TooltipWrapper>
  );
}

/**
 * The disclosed half of the `?`, rendered by the row UNDER its own row box so
 * the text wraps at full width instead of inside the row's flex line.
 */
export function InterviewOptionDetailsRegion(props: {
  readonly option: InterviewQuestionOption;
  readonly disclosure: InterviewOptionDetailsDisclosure;
}) {
  const details = optionDetails(props.option);
  if (!props.disclosure.expanded || details.length === 0) return null;
  return (
    <InlineOptionDetails
      details={details}
      descriptionFindUnitId={null}
      previewFindUnitId={null}
      regionId={props.disclosure.regionId}
    />
  );
}

function OptionDetailsTooltip(props: {
  readonly details: ReadonlyArray<DetailItem>;
}) {
  return (
    <div className="flex max-w-[80vw] flex-col gap-2 text-ui-xs">
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
              detail.kind === "description"
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
  if (props.custom) {
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
        <Pencil className="size-3" aria-hidden />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-border/70 bg-background/60 text-[0.625rem] font-semibold tabular-nums text-muted-foreground/70"
    >
      {props.index}
    </span>
  );
}

function StaticOptionRow(props: {
  readonly label: string;
  readonly option: InterviewQuestionOption | null;
  readonly index: number;
  readonly selected: boolean;
  readonly custom: boolean;
  readonly choiceKind: "single" | "multi" | null;
  readonly labelFindUnitId: string | null;
  readonly pinnedDetailRegionId: string | null;
  readonly children: ReactNode;
}) {
  const disclosure = useInterviewOptionDetailsDisclosure();
  return (
    <div className="flex w-full flex-col gap-1.5">
      <div
        className={cn(
          "flex w-full items-center gap-2 rounded-md border border-transparent bg-foreground/3 px-2 py-1.5",
          props.selected
            ? "border-border bg-foreground/6 text-foreground shadow-sm"
            : "text-muted-foreground",
        )}
      >
        {props.choiceKind === null ? null : (
          <InterviewChoiceGlyph
            multiSelect={props.choiceKind === "multi"}
            selected={props.selected}
          />
        )}
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
            disclosure={disclosure}
          />
        )}
        {props.children}
        <OptionBadge
          index={props.index}
          selected={props.selected}
          custom={props.custom}
        />
      </div>
      {/* Search pins this option's details open in the parent, and the pinned
          button has no toggle - so a region the user expanded first must
          yield to it, or both render. It returns when the pin clears. */}
      {props.option === null || props.pinnedDetailRegionId !== null ? null : (
        <InterviewOptionDetailsRegion
          option={props.option}
          disclosure={disclosure}
        />
      )}
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
  // The historical card must not offer a choice the live card refused. A
  // question that withdrew free text never rendered an Other row while it was
  // pending, and the digit it would carry here (`options.length + 1`) is
  // exactly the one `selectByDigit` declines - so appending an unselected
  // "Other" to the transcript invents an option the user was never allowed to
  // pick, and misnumbers nothing else only by luck.
  //
  // `customText !== null` keeps it for legacy rows that DO carry a custom
  // answer: those were answered under the old contract, and hiding the row
  // would hide the user's own words. Withdrawal governs what is offered, not
  // what was already said.
  const showsCustomRow =
    questionAllowsCustomAnswer(props.question) || props.customText !== null;
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
              choiceKind={props.question.multiSelect ? "multi" : "single"}
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
      {showsCustomRow ? (
        <li>
          <StaticOptionRow
            label={props.customText === null ? "Other" : props.customText}
            option={null}
            index={props.question.options.length + 1}
            selected={props.customText !== null}
            custom
            choiceKind={null}
            labelFindUnitId={props.customFindUnitId}
            pinnedDetailRegionId={null}
          >
            {props.customText === null ? null : (
              <span className="sr-only">Selected custom answer</span>
            )}
          </StaticOptionRow>
        </li>
      ) : null}
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
    return prefix;
  }
  return `${prefix}-interview-option-detail-${encodeURIComponent(unitId)}`;
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
