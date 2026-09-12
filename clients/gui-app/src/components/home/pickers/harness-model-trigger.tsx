import type { ButtonHTMLAttributes, Ref } from "react";
import { ChevronDown, Zap } from "lucide-react";
import { ToolbarPillButton } from "@/components/home/toolbar/toolbar-buttons";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { AccentDot } from "@/components/providers/accent-dot";
import type { HarnessModelSelection } from "@/components/home/data/landing-options";
import {
  formatReasoningPosition,
  type ReasoningStep,
} from "@/components/home/pickers/harness-model-picker-presentation";
import { ReasoningBarsGlyph } from "@/components/home/pickers/reasoning-bars-glyph";
import type { ProfileAccentDotInput } from "@/components/providers/provider-profile-model";
import type { ComposerReasoningIndicator } from "@/stores/settings/layout-store";
import { cn } from "@/lib/utils";

interface HarnessModelTriggerProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children"
> {
  selection: HarnessModelSelection;
  label: string;
  reasoningLabel: string | null;
  /** The current level's position on the model's ladder, for the bars glyph.
   *  `null` when there is no ladder to draw, which falls back to the name. */
  reasoningStep: ReasoningStep | null;
  /**
   * Layout ▸ Composer ▸ Reasoning level. `text` is the level's name after the
   * model, `bars` the signal glyph in its place, `bars-text` both. A position
   * the glyph cannot draw (the value names none of the model's levels) shows
   * the name in every mode, so the chip never reads as "no effort".
   */
  reasoningIndicator: ComposerReasoningIndicator;
  serviceTierLabel: string | null;
  serviceTierActive: boolean;
  profileLabel: string | null;
  /** Bottom-right corner dot on the harness icon (`AccentDot`).
   *  `null` unless the provider has multiple profiles and the selection's
   *  profileId matches a known profile. */
  profileAccentDot: ProfileAccentDotInput | null;
  isLoading: boolean;
  disabled: boolean;
  /**
   * `"responsive"` is the desktop toolbar: the full pill (model, thinking
   * effort, chevron), collapsing to the harness glyph alone in a narrow
   * container. `"model-only"` is the phone toolbar: the model name and nothing
   * else, at any width - the thinking effort is noise on a row that narrow, and
   * an unlabelled glyph would be worse. Both keep the same accessible name, so
   * the effort is still announced either way.
   */
  labelDisplay: "responsive" | "model-only";
  ref?: Ref<HTMLButtonElement>;
}

export function HarnessModelTrigger(props: HarnessModelTriggerProps) {
  const {
    selection,
    label,
    reasoningLabel,
    reasoningStep,
    reasoningIndicator,
    serviceTierLabel,
    serviceTierActive,
    profileLabel,
    profileAccentDot,
    isLoading,
    disabled,
    labelDisplay,
    ref,
    ...rest
  } = props;
  // Applied to the label and the chevron together: the pill either shows its
  // content or shrinks to the harness glyph.
  const collapseWhenNarrow = labelDisplay === "responsive";
  const narrowHidden = cn(collapseWhenNarrow && "@max-lg:hidden");
  const showsReasoning = collapseWhenNarrow && reasoningLabel !== null;
  const reasoningParts = reasoningChipParts(
    showsReasoning,
    reasoningIndicator,
    reasoningLabel,
    reasoningStep,
  );
  const serviceTierSummary =
    serviceTierLabel === null || !serviceTierActive
      ? null
      : `${serviceTierLabel} on`;
  const summary = [
    label,
    reasoningLabel === null ? null : `Thinking ${reasoningLabel}`,
    serviceTierSummary,
    profileLabel,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");

  return (
    <ToolbarPillButton
      ref={ref}
      aria-label={summary}
      disabled={disabled}
      className={cn(
        "max-w-[min(50cqw,18rem)] min-w-0 justify-start disabled:cursor-not-allowed disabled:opacity-50",
        collapseWhenNarrow &&
          "@max-lg:size-8 @max-lg:justify-center @max-lg:px-0",
      )}
      {...rest}
    >
      {serviceTierLabel === null ? null : (
        <Zap
          aria-label={serviceTierLabel}
          className={cn(
            "size-4 shrink-0 text-muted-foreground",
            serviceTierActive && "fill-current text-amber-500",
          )}
          strokeWidth={2}
        />
      )}
      <span className="relative shrink-0">
        {isLoading ? (
          <MutedAgentSpinner />
        ) : (
          <HarnessIcon harnessId={selection.harnessId} />
        )}
        {profileAccentDot === null ? null : (
          <AccentDot
            profileId={profileAccentDot.profileId}
            accentColor={profileAccentDot.accentColor}
            label={profileAccentDot.label}
            variant="corner"
            size="compact"
            className={undefined}
          />
        )}
      </span>
      <span className={cn("min-w-0 truncate whitespace-nowrap", narrowHidden)}>
        {label}
      </span>
      {!showsReasoning ? null : (
        <span
          aria-hidden="true"
          className={cn("shrink-0 text-muted-foreground/70", narrowHidden)}
        >
          ·
        </span>
      )}
      {reasoningParts.glyph === null ? null : (
        <ReasoningBarsGlyph
          count={reasoningParts.glyph.count}
          filled={reasoningParts.glyph.filled}
          label={reasoningParts.glyph.label}
          className={narrowHidden}
        />
      )}
      {!reasoningParts.text ? null : (
        <span
          className={cn(
            "shrink-0 whitespace-nowrap text-muted-foreground",
            narrowHidden,
          )}
        >
          {reasoningLabel}
        </span>
      )}
      <ChevronDown
        className={cn("size-3.5 shrink-0 text-muted-foreground", narrowHidden)}
      />
    </ToolbarPillButton>
  );
}

interface ReasoningGlyphInput {
  readonly count: number;
  readonly filled: number;
  readonly label: string;
}

interface ReasoningChipParts {
  readonly glyph: ReasoningGlyphInput | null;
  /** Whether the level's name is written out after the model. */
  readonly text: boolean;
}

/**
 * What the pill shows for the thinking effort under each indicator mode. An
 * unknown position (`index` null) still draws in the bars modes - every bar
 * empty, named without a position - and keeps the name beside it, so the chip
 * never reads as "no effort" over a glyph that says nothing.
 */
function reasoningChipParts(
  showsReasoning: boolean,
  reasoningIndicator: ComposerReasoningIndicator,
  reasoningLabel: string | null,
  reasoningStep: ReasoningStep | null,
): ReasoningChipParts {
  if (!showsReasoning || reasoningLabel === null) {
    return { glyph: null, text: false };
  }
  if (reasoningIndicator === "text" || reasoningStep === null) {
    return { glyph: null, text: true };
  }
  const position = formatReasoningPosition(reasoningStep);
  const glyph: ReasoningGlyphInput = {
    count: reasoningStep.count,
    filled: reasoningStep.index === null ? 0 : reasoningStep.index + 1,
    label:
      position === null
        ? `Thinking: ${reasoningLabel}`
        : `Thinking: ${reasoningLabel} (${position})`,
  };
  return {
    glyph,
    text: reasoningIndicator === "bars-text" || position === null,
  };
}
