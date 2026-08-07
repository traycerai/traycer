import type { ButtonHTMLAttributes, Ref } from "react";
import { ChevronDown, Zap } from "lucide-react";
import { ToolbarPillButton } from "@/components/home/toolbar/toolbar-buttons";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { AccentDot } from "@/components/providers/accent-dot";
import type { HarnessModelSelection } from "@/components/home/data/landing-options";
import type { ProfileAccentDotInput } from "@/components/providers/provider-profile-model";
import { cn } from "@/lib/utils";

interface HarnessModelTriggerProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children"
> {
  selection: HarnessModelSelection;
  label: string;
  reasoningLabel: string | null;
  serviceTierLabel: string | null;
  serviceTierActive: boolean;
  profileLabel: string | null;
  /** Bottom-right corner dot on the harness icon (T3's `AccentDot` primitive).
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
        <>
          <span
            aria-hidden="true"
            className={cn("shrink-0 text-muted-foreground/70", narrowHidden)}
          >
            ·
          </span>
          <span
            className={cn(
              "shrink-0 whitespace-nowrap text-muted-foreground",
              narrowHidden,
            )}
          >
            {reasoningLabel}
          </span>
        </>
      )}
      <ChevronDown
        className={cn("size-3.5 shrink-0 text-muted-foreground", narrowHidden)}
      />
    </ToolbarPillButton>
  );
}
