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
    ref,
    ...rest
  } = props;
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
      className="max-w-[min(50cqw,18rem)] min-w-0 justify-start disabled:cursor-not-allowed disabled:opacity-50 @max-lg:size-8 @max-lg:justify-center @max-lg:px-0"
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
      <span className="min-w-0 truncate whitespace-nowrap @max-lg:hidden">
        {label}
      </span>
      {reasoningLabel === null ? null : (
        <>
          <span
            aria-hidden="true"
            className="shrink-0 text-muted-foreground/70 @max-lg:hidden"
          >
            ·
          </span>
          <span className="shrink-0 whitespace-nowrap text-muted-foreground @max-lg:hidden">
            {reasoningLabel}
          </span>
        </>
      )}
      <ChevronDown className="size-3.5 shrink-0 text-muted-foreground @max-lg:hidden" />
    </ToolbarPillButton>
  );
}
