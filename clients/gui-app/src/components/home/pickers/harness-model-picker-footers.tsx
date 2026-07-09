import {
  findUpgradeServiceTierForModel,
  type ModelOption,
  type ReasoningLevel,
  type ReasoningLevelOption,
  type ServiceTier,
} from "@/components/home/data/landing-options";
import { cn } from "@/lib/utils";
import { Zap } from "lucide-react";
import {
  singleDigitLeaderDigitFor,
  usePickerReasoningLeaderForIndex,
} from "@/providers/keybinding-context";
import { PickerLeaderBadge } from "@/components/home/pickers/harness-model-picker-leader-badge";

export interface ReasoningFooterConfig {
  readonly value: ReasoningLevel;
  readonly options: ReadonlyArray<ReasoningLevelOption>;
  readonly disabled: boolean;
  readonly onChange: (next: ReasoningLevel) => void;
}

export interface ServiceTierFooterConfig {
  readonly selectedModel: ModelOption | null;
  readonly value: ServiceTier;
  readonly onChange: (next: ServiceTier) => void;
}

interface HarnessModelPickerModelSettingsFooterProps {
  readonly reasoning: ReasoningFooterConfig | null;
  readonly serviceTier: ServiceTierFooterConfig | null;
}

export function HarnessModelPickerModelSettingsFooter(
  props: HarnessModelPickerModelSettingsFooterProps,
) {
  const { reasoning, serviceTier } = props;
  if (reasoning === null && serviceTier === null) return null;
  return (
    <ModelSettingsFooter reasoning={reasoning} serviceTier={serviceTier} />
  );
}

interface ModelSettingsFooterProps {
  readonly reasoning: ReasoningFooterConfig | null;
  readonly serviceTier: ServiceTierFooterConfig | null;
}

function ModelSettingsFooter(props: ModelSettingsFooterProps) {
  const { reasoning, serviceTier } = props;
  const upgradeServiceTier =
    serviceTier === null
      ? null
      : findUpgradeServiceTierForModel(serviceTier.selectedModel);
  const hasReasoningOptions =
    reasoning !== null && reasoning.options.length > 0;
  if (upgradeServiceTier === null && !hasReasoningOptions) return null;
  const showGroupSeparator = upgradeServiceTier !== null && hasReasoningOptions;

  const serviceTierActive =
    serviceTier !== null &&
    upgradeServiceTier !== null &&
    serviceTier.value === upgradeServiceTier.id;

  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-t bg-muted/20 px-2 py-1.5">
      {upgradeServiceTier === null || serviceTier === null ? null : (
        <button
          type="button"
          aria-label={`${upgradeServiceTier.label} mode`}
          aria-pressed={serviceTierActive}
          className={cn(
            "flex max-w-[min(34vw,8rem)] items-center gap-1.5 truncate rounded-md px-2 py-1 text-ui-xs text-muted-foreground transition-colors aria-[pressed=false]:hover:bg-accent/30 aria-[pressed=false]:hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60",
            serviceTierActive && "bg-accent/70 text-foreground",
          )}
          onClick={() =>
            serviceTier.onChange(serviceTierActive ? "" : upgradeServiceTier.id)
          }
        >
          <Zap
            className={cn(
              "size-3.5 shrink-0",
              serviceTierActive && "fill-current text-amber-500",
            )}
            strokeWidth={2}
          />
          <span className="truncate">{upgradeServiceTier.label}</span>
        </button>
      )}
      {showGroupSeparator ? (
        <div className="h-5 w-px shrink-0 bg-border" aria-hidden="true" />
      ) : null}
      {reasoning === null ? null : <ReasoningFooterGroup config={reasoning} />}
    </div>
  );
}

interface ReasoningFooterGroupProps {
  readonly config: ReasoningFooterConfig;
}

function ReasoningFooterGroup(props: ReasoningFooterGroupProps) {
  const { value, options, disabled, onChange } = props.config;
  const hasOptions = options.length > 0;

  if (!hasOptions) return null;

  return (
    <fieldset
      aria-label="Thinking effort"
      className="m-0 flex min-w-0 flex-1 items-center justify-around gap-1 border-0 p-0"
    >
      {options.map((option, index) => (
        <ReasoningLevelButton
          key={option.id}
          option={option}
          index={index}
          selected={option.id === value}
          disabled={disabled}
          onChange={onChange}
        />
      ))}
    </fieldset>
  );
}

interface ReasoningLevelButtonProps {
  readonly option: ReasoningLevelOption;
  readonly index: number;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onChange: (next: ReasoningLevel) => void;
}

// One thinking-level pill. Split out so each can call the leader hook. The
// ⌥-digit badge floats just past the label (absolute, out of flow) so revealing
// it never reflows the footer; changing the level is pure state, so the search
// box keeps focus.
function ReasoningLevelButton(props: ReasoningLevelButtonProps) {
  const { option, index, selected, disabled, onChange } = props;
  const leaderModifier = usePickerReasoningLeaderForIndex(index);
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      className={cn(
        "inline-flex max-w-[min(22vw,6.5rem)] items-center rounded-md px-2 py-1 text-ui-xs text-muted-foreground transition-colors aria-[pressed=false]:hover:bg-accent/30 aria-[pressed=false]:hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-muted-foreground",
        selected && "bg-accent/70 text-foreground",
      )}
      onClick={() => onChange(option.id)}
    >
      <span className="relative inline-flex min-w-0 items-center">
        <span className="truncate">{option.label}</span>
        <PickerLeaderBadge
          show={leaderModifier !== null}
          index={index}
          hintAction="to set"
          hintTarget={option.label}
          testId={`model-reasoning-digit-${singleDigitLeaderDigitFor(index)}`}
          placement="trailing"
        />
      </span>
    </button>
  );
}
