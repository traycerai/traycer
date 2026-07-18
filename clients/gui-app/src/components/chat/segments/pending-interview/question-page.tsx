import { useCallback, type ReactNode } from "react";
import { CircleHelp, Pencil } from "lucide-react";
import { useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import type {
  InterviewQuestion,
  InterviewQuestionOption,
} from "@traycer/protocol/persistence/epic/schemas";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";
import type { DraftAnswer } from "./interview-draft";
import { QUESTION_TRANSITION } from "./use-interview-card";

const OTHER_LABEL = "Other";

const ANSWER_TEXTAREA_CLASS =
  "w-full resize-none rounded-md border border-input bg-background/70 px-2.5 py-2 text-ui-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60";

interface DetailItem {
  readonly label: string;
  readonly value: string;
}

function normalizedText(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function detailItem(label: string, value: string | null): DetailItem | null {
  const text = normalizedText(value);
  return text === null ? null : { label, value: text };
}

function compactDetails(items: ReadonlyArray<DetailItem | null>) {
  return items.filter((item): item is DetailItem => item !== null);
}

function optionDetails(
  option: InterviewQuestionOption,
): ReadonlyArray<DetailItem> {
  return compactDetails([
    detailItem("Details", option.description),
    detailItem("Preview", option.preview),
  ]);
}

interface QuestionPageProps {
  question: InterviewQuestion;
  draft: DraftAnswer;
  // Gates auto-focus so a background pane's field never steals focus.
  isActive: boolean;
  // True while a Submit/Skip this card sent is in flight or accepted but
  // unresolved. Natively disables every option button and text field so they
  // are neither focusable, typeable, nor exposed as actionable to assistive
  // tech - callbacks already reject while busy, but the controls must also
  // look and behave disabled.
  disabled: boolean;
  pendingLabel: string | null;
  onToggleOption: (label: string) => void;
  onToggleOther: () => void;
  onOtherTextChange: (text: string) => void;
  onFreeTextChange: (text: string) => void;
}

export function QuestionPage(props: QuestionPageProps) {
  const {
    question,
    draft,
    isActive,
    disabled,
    pendingLabel,
    onToggleOption,
    onToggleOther,
    onOtherTextChange,
    onFreeTextChange,
  } = props;

  // Callback ref for the free-text inputs: they appear exactly when the user
  // chose to type, so focus belongs in them - but only when this tab is active.
  // Memoized on isActive so the same node re-focuses when the tab becomes active
  // (the ref re-runs) and never steals focus while inactive. The focus is
  // deferred one frame for the same reason as the card itself: a pane is
  // activated on pointerdown, and the trailing mousedown's native focus would
  // otherwise steal focus before this runs (see useInterviewCard).
  const focusFieldIfActive = useCallback(
    (node: HTMLInputElement | HTMLTextAreaElement | null) => {
      if (!isActive || disabled || node === null) return;
      const frame = window.requestAnimationFrame(() => {
        node.focus({ preventScroll: true });
      });
      return () => window.cancelAnimationFrame(frame);
    },
    // `disabled` is a dependency (not just a guard) so the ref re-runs and
    // restores focus when a rejected action clears the busy gate: a disabled
    // field cannot take focus, and a callback ref only re-fires when its
    // identity changes, not merely when the prop it reads changes.
    [disabled, isActive],
  );

  // A question with no options is pure free-text: a single textarea that
  // focuses itself so the user can type right away.
  if (question.options.length === 0) {
    return (
      <textarea
        ref={focusFieldIfActive}
        value={draft.otherText}
        onChange={(e) => onFreeTextChange(e.target.value)}
        placeholder="Type your answer…"
        className={ANSWER_TEXTAREA_CLASS}
        rows={2}
        aria-label="Interview answer"
        disabled={disabled}
      />
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <ul className="m-0 flex list-none flex-col gap-1.5 pl-0">
        {question.options.map((option, index) => {
          const selected = draft.selected.has(option.label);
          return (
            <li key={option.label}>
              <OptionRow
                label={option.label}
                ariaLabel={`${index + 1}. ${option.label}`}
                details={optionDetails(option)}
                selected={selected}
                pending={pendingLabel === option.label}
                disabled={disabled}
                badge={
                  <OptionNumberBadge index={index + 1} selected={selected} />
                }
                onToggle={() => onToggleOption(option.label)}
              />
            </li>
          );
        })}
      </ul>
      <OtherRow
        selected={draft.otherSelected}
        value={draft.otherText}
        disabled={disabled}
        inputRef={focusFieldIfActive}
        onSelect={onToggleOther}
        onValueChange={onOtherTextChange}
      />
    </div>
  );
}

interface OtherRowProps {
  selected: boolean;
  value: string;
  disabled: boolean;
  inputRef: (node: HTMLTextAreaElement | null) => void;
  onSelect: () => void;
  onValueChange: (text: string) => void;
}

// The "write your own answer" affordance. Unselected it is a pickable row with
// a pencil badge; selecting it (click or the N+1 key) morphs the row in place
// into a focused multi-line answer field.
function OtherRow(props: OtherRowProps) {
  const { selected, value, disabled, inputRef, onSelect, onValueChange } =
    props;
  if (selected) {
    return (
      <div className="relative flex w-full items-start gap-2 rounded-md border border-input bg-background/70 px-2 py-1.5 transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/40">
        <OtherIconBadge selected />
        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          placeholder="Type your answer…"
          aria-label={`${OTHER_LABEL} answer`}
          rows={1}
          className="field-sizing-content max-h-[3lh] min-w-0 flex-1 resize-none overflow-y-auto bg-transparent text-ui-sm text-foreground outline-none placeholder:text-muted-foreground chat-scrollbar-native-thin disabled:cursor-not-allowed disabled:opacity-60"
          disabled={disabled}
        />
      </div>
    );
  }
  return (
    <OptionRow
      label={OTHER_LABEL}
      ariaLabel={OTHER_LABEL}
      details={[]}
      selected={false}
      pending={false}
      disabled={disabled}
      badge={<OtherIconBadge selected={false} />}
      onToggle={onSelect}
    />
  );
}

// Circular pencil badge for the "Other" affordance - filled once it is the
// active custom answer, mirroring the option number badges.
function OtherIconBadge(props: { selected: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none relative z-10 inline-flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors",
        props.selected
          ? "border-primary/70 bg-primary/90 text-primary-foreground"
          : "border-border/70 bg-background/60 text-muted-foreground/70",
      )}
    >
      <Pencil className="size-3" aria-hidden />
    </span>
  );
}

interface OptionRowProps {
  label: string;
  ariaLabel: string;
  details: ReadonlyArray<DetailItem>;
  selected: boolean;
  pending: boolean;
  disabled: boolean;
  badge: ReactNode;
  onToggle: () => void;
}

function OptionRow(props: OptionRowProps) {
  const {
    label,
    ariaLabel,
    details,
    selected,
    pending,
    disabled,
    badge,
    onToggle,
  } = props;
  const shouldReduceMotion = useReducedMotion();
  return (
    <m.div
      animate={
        pending && !shouldReduceMotion ? { scale: [1, 1.015, 1] } : { scale: 1 }
      }
      transition={QUESTION_TRANSITION}
      className="w-full"
    >
      <div
        className={cn(
          "relative flex w-full items-center gap-2 rounded-md border border-transparent bg-muted/25 px-2 py-1.5 transition-colors",
          selected
            ? "border-border bg-muted/70 text-foreground shadow-sm"
            : "text-muted-foreground",
          // `hover:*` matches an ancestor whenever ANY hit-tested descendant
          // is hovered - including through this row's own `pointer-events:
          // none` state, since `InfoHint` deliberately keeps `pointer-events-
          // auto` so its tooltip stays usable. So hovering the info icon
          // alone would still light up the row unless these classes are
          // omitted outright while disabled; `pointer-events-none` here
          // can't suppress that.
          !disabled &&
            !selected &&
            "hover:border-border/70 hover:bg-muted/40 hover:text-foreground",
          // The overlay button below is transparent (no visible pixels of
          // its own), so a `disabled:` class on it has nothing to dim. Apply
          // the disabled look to this visible container instead.
          disabled && "opacity-60",
        )}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={selected}
          aria-label={ariaLabel}
          disabled={disabled}
          className="absolute inset-0 z-0 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
        />
        <span className="pointer-events-none relative z-10 min-w-0 truncate font-medium text-foreground/90">
          {label}
        </span>
        <InfoHint
          ariaLabel={`${label} details`}
          details={details}
          className="pointer-events-auto relative z-20 self-center"
        />
        <span aria-hidden className="pointer-events-none min-w-0 flex-1" />
        {badge}
      </div>
    </m.div>
  );
}

// The right-side circular badge doubles as the keyboard hint (its number) and
// the selection indicator (filled when selected).
function OptionNumberBadge(props: { index: number; selected: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none relative z-10 inline-flex size-5 shrink-0 items-center justify-center rounded-full border text-[0.625rem] font-semibold tabular-nums transition-colors",
        props.selected
          ? "border-primary/70 bg-primary/90 text-primary-foreground"
          : "border-border/70 bg-background/60 text-muted-foreground/70",
      )}
    >
      {props.index}
    </span>
  );
}

interface InfoHintProps {
  readonly ariaLabel: string;
  readonly details: ReadonlyArray<DetailItem>;
  readonly className: string | null;
}

function InfoHint(props: InfoHintProps) {
  if (props.details.length === 0) return null;
  return (
    <TooltipWrapper
      label={<DetailsTooltip details={props.details} />}
      side="top"
      sideOffset={6}
      align="center"
    >
      <button
        type="button"
        aria-label={props.ariaLabel}
        className={cn(
          "inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40",
          props.className,
        )}
      >
        <CircleHelp className="size-3.5" aria-hidden />
      </button>
    </TooltipWrapper>
  );
}

function DetailsTooltip(props: {
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
